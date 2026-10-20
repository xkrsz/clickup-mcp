import { createMcpHandler, Server } from '@modelcontextprotocol/server';

export const OFFICIAL_TOKEN = 'official-access-token';
export const OFFICIAL_CODE = 'official-auth-code';

/** Stand-in for mcp.clickup.com: its OAuth endpoints and an MCP server with a few tools. */
export function fakeOfficial() {
  const calls: { name: string; args: unknown }[] = [];
  const tokenRequests: URLSearchParams[] = [];

  const mcp = createMcpHandler(() => {
    const server = new Server({ name: 'clickup-official', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'clickup_search',
          description: 'Search across all workspace content.',
          inputSchema: { type: 'object', properties: { keywords: { type: 'string' }, workspace_id: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'clickup_create_reminder',
          description: 'Create a personal reminder.',
          inputSchema: { type: 'object', properties: { title: { type: 'string' }, due_date: { type: 'string' } }, required: ['title'] },
        },
        {
          name: 'clickup_get_task',
          description: 'Covered by REST here; must not be passed through.',
          inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } },
        },
      ] as never,
    }));
    server.setRequestHandler('tools/call', async (request) => {
      calls.push({ name: request.params.name, args: request.params.arguments });
      return { content: [{ type: 'text', text: JSON.stringify({ official: request.params.name, args: request.params.arguments }) }] };
    });
    return server;
  });

  async function handle(url: URL, init?: RequestInit, input?: RequestInfo | URL): Promise<Response | undefined> {
    if (url.origin !== 'https://mcp.clickup.com') return undefined;
    if (url.pathname === '/oauth/register') return Response.json({ client_id: 'upstream-client-id' }, { status: 201 });
    if (url.pathname === '/oauth/token') {
      const body = new URLSearchParams(String(init?.body ?? ''));
      tokenRequests.push(body);
      if (body.get('code') !== OFFICIAL_CODE || !body.get('code_verifier')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: OFFICIAL_TOKEN, token_type: 'Bearer' });
    }
    if (url.pathname === '/mcp') {
      const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
      if (request.headers.get('authorization') !== `Bearer ${OFFICIAL_TOKEN}`) {
        return Response.json({ error: 'invalid_token' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
      }
      return mcp.fetch(request);
    }
    return new Response('not found', { status: 404 });
  }

  return { handle, calls, tokenRequests };
}
