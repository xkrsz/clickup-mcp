import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/oauth';
import { resetOfficialToolCache } from '../src/official';
import { restAccessKey } from '../src/rest-access';
import { testCtx, testEnv } from './env';
import { fakeClickUp, oauthTokenNotFound, type RecordedRequest } from './fake-clickup';
import { fakeOfficial, OFFICIAL_CODE, OFFICIAL_TOKEN } from './fake-official';

const ORIGIN = 'https://clickup-mcp.example.workers.dev';
const CLIENT_REDIRECT = 'https://client.test/callback';
const REST_APP = { CLICKUP_CLIENT_ID: 'rest-app-id', CLICKUP_CLIENT_SECRET: 'rest-app-secret' };
const REST_CODE = 'rest-auth-code';
const REST_TOKEN = 'rest-oauth-token';

let official: ReturnType<typeof fakeOfficial>;
let restRequests: RecordedRequest[];
let env: Env;
/** Whether api.clickup.com refuses the official MCP token, as the real one does. */
let restRefusesMcpToken: boolean;

const call = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init), env, testCtx);

beforeEach(() => {
  env = testEnv();
  official = fakeOfficial();
  restRefusesMcpToken = false;
  const rest = fakeClickUp((req) => {
    if (req.url.pathname === '/api/v2/oauth/token') {
      const body = new URLSearchParams(String(req.body ?? ''));
      const valid = body.get('client_id') === REST_APP.CLICKUP_CLIENT_ID && body.get('client_secret') === REST_APP.CLICKUP_CLIENT_SECRET;
      return valid && body.get('code') === REST_CODE
        ? Response.json({ access_token: REST_TOKEN })
        : Response.json({ err: 'Code not found', ECODE: 'OAUTH_014' }, { status: 401 });
    }
    if (restRefusesMcpToken && req.headers.get('authorization') === `Bearer ${OFFICIAL_TOKEN}`) return oauthTokenNotFound();
    if (req.url.pathname === '/api/v2/user') return Response.json({ user: { id: 1, username: 'Ada Lovelace', email: 'ada@acme.test' } });
    return undefined;
  });
  restRequests = rest.requests;
  resetOfficialToolCache();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return (await official.handle(url, init, input)) ?? rest.fetch(input, init);
  });
});

afterEach(() => vi.unstubAllGlobals());

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Runs the whole browser flow and returns an access token for this server. `rest` is how the user
 * answers ClickUp's REST OAuth screen when the Worker chains to it.
 */
async function signIn(options: { rest?: 'approve' | 'deny' } = {}): Promise<string> {
  const registration = await call(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test <Client>',
      redirect_uris: [CLIENT_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(registration.status).toBe(201);
  const { client_id } = (await registration.json()) as { client_id: string };

  const verifier = 'test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const authorizeUrl = new URL(`${ORIGIN}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${ORIGIN}/mcp`,
  }).toString();

  // 1. Consent page.
  const consent = await call(authorizeUrl);
  expect(consent.status).toBe(200);
  expect(consent.headers.get('x-frame-options')).toBe('DENY');
  const html = await consent.text();
  expect(html).toContain('Test &#60;Client&#62;');
  expect(html).toContain('client.test');
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];

  // 2. Approve: redirected to ClickUp's MCP OAuth server.
  const approve = await call(authorizeUrl, {
    method: 'POST',
    headers: { cookie: cookiesFrom(consent), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle, decision: 'approve' }),
  });
  expect(approve.status).toBe(302);
  const upstream = new URL(approve.headers.get('location')!);
  expect(upstream.origin + upstream.pathname).toBe('https://mcp.clickup.com/oauth/authorize');
  expect(upstream.searchParams.get('client_id')).toBe('upstream-client-id');
  expect(upstream.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/oauth/callback`);
  expect(upstream.searchParams.get('code_challenge_method')).toBe('S256');

  // 3. ClickUp redirects back with a code.
  const callback = await call(
    `${ORIGIN}/oauth/callback?code=${OFFICIAL_CODE}&state=${encodeURIComponent(upstream.searchParams.get('state')!)}`,
    { headers: { cookie: cookiesFrom(approve) } },
  );
  expect(callback.status).toBe(302);
  let back = new URL(callback.headers.get('location')!);

  // 3b. Optional second hop through ClickUp's REST OAuth app.
  if (options.rest) {
    expect(back.origin + back.pathname).toBe('https://app.clickup.com/api');
    expect(back.searchParams.get('client_id')).toBe(REST_APP.CLICKUP_CLIENT_ID);
    expect(back.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/oauth/callback/rest`);
    const state = encodeURIComponent(back.searchParams.get('state')!);
    const answer = options.rest === 'approve' ? `code=${REST_CODE}` : 'error=access_denied';
    const restCallback = await call(`${ORIGIN}/oauth/callback/rest?${answer}&state=${state}`, { headers: { cookie: cookiesFrom(callback) } });
    expect(restCallback.status).toBe(302);
    back = new URL(restCallback.headers.get('location')!);
  }
  expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
  expect(back.searchParams.get('state')).toBe('client-state');
  expect(official.tokenRequests[0].get('code_verifier')).toBeTruthy();

  // 4. The MCP client redeems its code.
  const token = await call(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      redirect_uri: CLIENT_REDIRECT,
      client_id,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string; refresh_token?: string };
  expect(body.access_token).not.toContain(OFFICIAL_TOKEN);
  expect(body.refresh_token).toBeTruthy();
  return body.access_token;
}

async function connect(accessToken: string, query = '') {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp${query}`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: call,
  });
  const client = new Client({ name: 'oauth-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return client;
}

const text = (result: { content?: unknown }) => (result.content as { text: string }[])[0].text;

describe('OAuth connections', () => {
  it('signs in through ClickUp and exposes official-only tools next to the REST tools', async () => {
    const client = await connect(await signIn());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('clickup_search');
    expect(names).toContain('clickup_create_reminder');
    expect(names).toContain('clickup_create_checklist');
    expect(names.filter((n) => n === 'clickup_get_task')).toHaveLength(1);

    const searched = await client.callTool({ name: 'clickup_search', arguments: { keywords: 'launch' } });
    expect(JSON.parse(text(searched))).toEqual({ official: 'clickup_search', args: { keywords: 'launch' } });

    // REST tools stay on the REST API, authenticated with the same ClickUp sign-in.
    await client.callTool({ name: 'clickup_get_task', arguments: { task_id: 'abc' } });
    expect(official.calls.map((c) => c.name)).toEqual(['clickup_search']);
    expect(restRequests.at(-1)!.url.pathname).toBe('/api/v2/task/abc');
    expect(restRequests.at(-1)!.headers.get('authorization')).toBe(`Bearer ${OFFICIAL_TOKEN}`);
    await client.close();
  });

  it('fills the default workspace on forwarded calls and enforces read-only mode', async () => {
    const accessToken = await signIn();
    const readonly = await connect(accessToken, '?readonly=1&workspace_id=777');
    const names = (await readonly.listTools()).tools.map((t) => t.name);
    expect(names).toContain('clickup_search');
    expect(names).not.toContain('clickup_create_reminder');
    const refused = await readonly.callTool({ name: 'clickup_create_reminder', arguments: { title: 'x' } });
    expect(refused.isError).toBe(true);
    await readonly.callTool({ name: 'clickup_search', arguments: { keywords: 'x' } });
    expect(official.calls.at(-1)).toEqual({ name: 'clickup_search', args: { keywords: 'x', workspace_id: '777' } });
    await readonly.close();
  });

  it('prefers a personal token on the URL for REST calls', async () => {
    const client = await connect(await signIn(), '?token=pk_override');
    await client.callTool({ name: 'clickup_get_task', arguments: { task_id: 'abc' } });
    expect(restRequests.at(-1)!.headers.get('authorization')).toBe('pk_override');
    await client.close();
  });

  it('returns the client to its redirect URI when the user cancels', async () => {
    const registration = await call(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    const { client_id } = (await registration.json()) as { client_id: string };
    const url = `${ORIGIN}/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&state=s1`;
    const consent = await call(url);
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];
    const denied = await call(url, {
      method: 'POST',
      headers: { cookie: cookiesFrom(consent), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle, decision: 'deny' }),
    });
    const location = new URL(denied.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('s1');
  });

  it('refuses a consent post without the browser cookie', async () => {
    const registration = await call(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    const { client_id } = (await registration.json()) as { client_id: string };
    const url = `${ORIGIN}/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&state=s1`;
    const handle = (await (await call(url)).text()).match(/name="handle" value="([^"]+)"/)![1];
    const forged = await call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle, decision: 'approve' }),
    });
    expect(forged.status).toBe(400);
    expect(forged.headers.get('location')).toBeNull();
  });
});

const userProbes = () => restRequests.filter((r) => r.url.pathname === '/api/v2/user');

describe('OAuth connections when ClickUp REST refuses the MCP token', () => {
  beforeEach(() => {
    restRefusesMcpToken = true;
  });

  it('lists the official tools in place of the REST-backed ones, the same way every time', async () => {
    const client = await connect(await signIn());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'clickup_add_task_link',
      'clickup_create_reminder',
      'clickup_create_task',
      'clickup_filter_tasks',
      'clickup_find_member_by_name',
      'clickup_get_task',
      'clickup_get_workspace_hierarchy',
      'clickup_search',
    ]);
    // The official schema, not the REST one.
    expect(tools.find((t) => t.name === 'clickup_create_task')!.inputSchema.required).toEqual(['name', 'list_id']);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(names);
    // One probe, at sign-in; MCP requests read the cached answer.
    expect(userProbes()).toHaveLength(1);
    expect(restRequests).toHaveLength(1);
    await client.close();
  });

  it('routes REST tool names to their official twins and explains the rest', async () => {
    const client = await connect(await signIn());

    // A REST-shaped call from a tool list pinned before the switch: the body is flattened.
    await client.callTool({ name: 'clickup_create_task', arguments: { list_id: 'L1', body: { name: 'Ship it' } } });
    expect(official.calls.at(-1)).toEqual({ name: 'clickup_create_task', args: { list_id: 'L1', name: 'Ship it' } });

    await client.callTool({ name: 'clickup_add_task_link', arguments: { task_id: 'a', links_to: 'b' } });
    expect(official.calls.at(-1)).toEqual({ name: 'clickup_add_task_link', args: { task_id: 'a', links_to: 'b' } });

    await client.callTool({ name: 'clickup_call_operation', arguments: { name: 'clickup_get_task', arguments: { task_id: 't1' } } });
    expect(official.calls.at(-1)).toEqual({ name: 'clickup_get_task', args: { task_id: 't1' } });

    // Hidden legacy alias: not listed, still callable.
    await client.callTool({ name: 'clickup_create_task_comment', arguments: { task_id: 't1', comment_text: 'hi' } });
    expect(official.calls.at(-1)!.name).toBe('clickup_create_task_comment');

    const search = await client.callTool({ name: 'clickup_search_tasks', arguments: { query: 'launch' } });
    expect(search.isError).toBe(true);
    expect(text(search)).toMatch(/needs ClickUp's REST API.*Use clickup_search or clickup_filter_tasks instead/);

    const members = await client.callTool({ name: 'clickup_find_members', arguments: {} });
    expect(text(members)).toContain('Use clickup_find_member_by_name instead');

    const checklist = await client.callTool({ name: 'clickup_create_checklist', arguments: { task_id: 't1' } });
    expect(checklist.isError).toBe(true);
    expect(text(checklist)).toMatch(/no direct equivalent.*clickup_execute_operator/);

    await expect(client.callTool({ name: 'clickup_nope', arguments: {} })).rejects.toThrow(/Unknown tool/);
    expect(restRequests.filter((r) => r.url.pathname !== '/api/v2/user')).toHaveLength(0);
    await client.close();
  });

  it('applies read-only mode and lists the same official tools in compact mode', async () => {
    const accessToken = await signIn();
    const compact = await connect(accessToken, '?mode=compact');
    const compactNames = (await compact.listTools()).tools.map((t) => t.name);
    expect(compactNames).toContain('clickup_create_task');
    expect(compactNames).not.toContain('clickup_search_operations');
    await compact.close();

    const readonly = await connect(accessToken, '?readonly=1');
    const names = (await readonly.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['clickup_filter_tasks', 'clickup_find_member_by_name', 'clickup_get_task', 'clickup_get_workspace_hierarchy', 'clickup_search']);
    const refused = await readonly.callTool({ name: 'clickup_create_task', arguments: { name: 'x', list_id: 'L1' } });
    expect(refused.isError).toBe(true);
    expect(official.calls).toHaveLength(0);
    await readonly.close();
  });

  it('keeps the REST tools when a personal token is on the URL', async () => {
    const client = await connect(await signIn(), '?token=pk_override');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('clickup_search_tasks');
    expect(names).toContain('clickup_search');
    expect(userProbes()).toHaveLength(1);
    await client.close();
  });

  it('probes grants made before the check once, and caches the answer under a hash of the token', async () => {
    const accessToken = await signIn();
    const key = await restAccessKey(OFFICIAL_TOKEN);
    expect(await env.OAUTH_KV.get(key)).toBe('rejected');
    await env.OAUTH_KV.delete(key);

    const client = await connect(accessToken);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('clickup_add_task_link');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('clickup_search_tasks');
    expect(userProbes()).toHaveLength(2);
    expect(userProbes().at(-1)!.headers.get('authorization')).toBe(`Bearer ${OFFICIAL_TOKEN}`);
    expect(await env.OAUTH_KV.get(key)).toBe('rejected');
    const keys = (await env.OAUTH_KV.list()).keys.map((k) => k.name);
    expect(keys.some((k) => k.includes(OFFICIAL_TOKEN))).toBe(false);
    await client.close();
  });

  it('errors instead of listing nothing when the official server is unreachable', async () => {
    const accessToken = await signIn();
    const down = official.handle;
    official.handle = async (url, init, input) => (url.pathname === '/mcp' ? new Response('down', { status: 503 }) : down(url, init, input));
    const client = await connect(accessToken);
    await expect(client.listTools()).rejects.toThrow(/official MCP server/);
    await client.close();
  });
});

describe('OAuth connections with a ClickUp REST OAuth app configured', () => {
  beforeEach(() => {
    env = { ...env, ...REST_APP };
    restRefusesMcpToken = true;
  });

  it('chains a REST sign-in and uses that token for the REST tools', async () => {
    const client = await connect(await signIn({ rest: 'approve' }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('clickup_search_tasks');
    expect(names).toContain('clickup_search');
    expect(names.filter((n) => n === 'clickup_create_task')).toHaveLength(1);

    await client.callTool({ name: 'clickup_add_task_link', arguments: { task_id: 'a', links_to: 'b' } });
    expect(restRequests.at(-1)!.url.pathname).toBe('/api/v2/task/a/link/b');
    expect(restRequests.at(-1)!.headers.get('authorization')).toBe(`Bearer ${REST_TOKEN}`);
    expect(official.calls).toHaveLength(0);

    // Official-only tools still use the official token.
    await client.callTool({ name: 'clickup_search', arguments: { keywords: 'x' } });
    expect(official.calls.map((c) => c.name)).toEqual(['clickup_search']);
    await client.close();
  });

  it('still completes the sign-in with the official tools when the user declines the REST step', async () => {
    const client = await connect(await signIn({ rest: 'deny' }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('clickup_add_task_link');
    expect(names).not.toContain('clickup_search_tasks');
    await client.close();
  });

  it('skips the REST step when REST already accepts the MCP token', async () => {
    restRefusesMcpToken = false;
    const client = await connect(await signIn());
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('clickup_search_tasks');
    await client.close();
  });
});
