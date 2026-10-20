import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { testCtx, testEnv } from './env';
import { fakeClickUp, type RecordedRequest } from './fake-clickup';

const ORIGIN = 'https://clickup-mcp.example.workers.dev';
const env = testEnv();
const call = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init), env, testCtx);

let clickupRequests: RecordedRequest[];

beforeEach(() => {
  const api = fakeClickUp();
  clickupRequests = api.requests;
  vi.stubGlobal('fetch', api.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Era = 'legacy' | 'auto';

async function connect(era: Era, query = '', headers: Record<string, string> = { Authorization: 'Bearer pk_e2e' }) {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp${query}`), {
    requestInit: { headers },
    fetch: call,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode: era } });
  await client.connect(transport);
  return client;
}

const text = (result: { content?: unknown }) => (result.content as { type: string; text: string }[])[0].text;

describe.each<Era>(['auto', 'legacy'])('MCP over streamable HTTP (%s negotiation)', (era) => {
  it('negotiates the expected protocol era', async () => {
    const client = await connect(era);
    expect(client.getProtocolEra()).toBe(era === 'auto' ? 'modern' : 'legacy');
    expect(client.getServerVersion()?.name).toBe('clickup-mcp');
    await client.close();
  });

  it('lists every operation plus the helpers', async () => {
    const client = await connect(era);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(tools.length).toBeGreaterThan(170);
    expect(names).toContain('clickup_create_task');
    expect(names).toContain('clickup_search_tasks');
    expect(names).toContain('clickup_edit_doc_page');
    // Deterministic order (spec SHOULD): helpers first, then operations sorted by name.
    const operationNames = names.slice(names.indexOf('clickup_add_dependency'));
    expect(operationNames).toEqual([...operationNames].sort((a, b) => a.localeCompare(b)));
    await client.close();
  });

  it('calls ClickUp with the caller token', async () => {
    const client = await connect(era);
    const result = await client.callTool({ name: 'clickup_get_task', arguments: { task_id: 'abc' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ ok: true, path: '/api/v2/task/abc' });
    expect(clickupRequests.at(-1)!.headers.get('authorization')).toBe('pk_e2e');
    await client.close();
  });
});

describe('connection options', () => {
  it('accepts the token in the URL', async () => {
    const client = await connect('auto', '?token=pk_inurl', {});
    await client.callTool({ name: 'clickup_get_authorized_user', arguments: {} });
    expect(clickupRequests.at(-1)!.headers.get('authorization')).toBe('pk_inurl');
    await client.close();
  });

  it('challenges unauthenticated requests so clients start OAuth', async () => {
    const response = await call(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    const metadata = (await (await call(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string };
    expect(metadata.resource).toBe(`${ORIGIN}/mcp`);
    expect(clickupRequests).toHaveLength(0);
  });

  it('explains that official-only tools need OAuth on token connections', async () => {
    const client = await connect('auto');
    const result = await client.callTool({ name: 'clickup_search', arguments: { keywords: 'x' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/official MCP server.*OAuth/);
    await client.close();
  });

  it('read-only mode hides and refuses writes', async () => {
    const client = await connect('auto', '?readonly=1');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('clickup_get_task');
    expect(names).toContain('clickup_query_audit_logs');
    expect(names).not.toContain('clickup_create_task');
    expect(names).not.toContain('clickup_delete_task');
    const result = await client.callTool({ name: 'clickup_delete_task', arguments: { task_id: 'x' } });
    expect(result.isError).toBe(true);
    expect(clickupRequests).toHaveLength(0);
    await client.close();
  });

  it('filters by toolset', async () => {
    const client = await connect('auto', '?toolsets=docs');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('clickup_create_doc');
    expect(names).not.toContain('clickup_create_task');
    expect(names).toContain('clickup_search_tasks');
    await client.close();
  });

  it('uses the default workspace from the URL', async () => {
    const client = await connect('auto', '?workspace_id=4242');
    await client.callTool({ name: 'clickup_get_spaces', arguments: {} });
    expect(clickupRequests.at(-1)!.url.pathname).toBe('/api/v2/team/4242/space');
    await client.close();
  });

  it('compact mode searches, describes and calls operations', async () => {
    const client = await connect('auto', '?mode=compact');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['clickup_search_operations', 'clickup_describe_operation', 'clickup_call_operation']),
    );
    expect(names.length).toBeLessThan(12);

    const found = JSON.parse(text(await client.callTool({ name: 'clickup_search_operations', arguments: { query: 'checklist item' } })));
    expect(found.operations.map((o: { name: string }) => o.name)).toContain('clickup_create_checklist_item');

    const described = JSON.parse(
      text(await client.callTool({ name: 'clickup_describe_operation', arguments: { name: 'clickup_create_checklist_item' } })),
    );
    expect(described.inputSchema.required).toContain('checklist_id');

    const called = await client.callTool({
      name: 'clickup_call_operation',
      arguments: { name: 'clickup_create_checklist_item', arguments: { checklist_id: 'c1', body: { name: 'Step' } } },
    });
    expect(called.isError).toBeFalsy();
    expect(clickupRequests.at(-1)!.url.pathname).toBe('/api/v2/checklist/c1/checklist_item');
    await client.close();
  });

  it('rejects unknown tools with a protocol error', async () => {
    const client = await connect('auto');
    await expect(client.callTool({ name: 'clickup_nope', arguments: {} })).rejects.toThrow(/Unknown tool/);
    await client.close();
  });
});

describe('plain HTTP routes', () => {
  it('serves the landing page, health and tool catalog', async () => {
    const page = await call(`${ORIGIN}/`);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain(`${ORIGIN}/mcp`);
    expect(await (await call(`${ORIGIN}/health`)).json()).toMatchObject({ ok: true });
    const catalog = (await (await call(`${ORIGIN}/tools.json?readonly=1`)).json()) as {
      tools: { name: string }[];
    };
    expect(catalog.tools.some((t) => t.name === 'clickup_create_task')).toBe(false);
  });

  it('answers CORS preflight', async () => {
    const response = await call(`${ORIGIN}/mcp`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toContain('Mcp-Protocol-Version');
  });
});
