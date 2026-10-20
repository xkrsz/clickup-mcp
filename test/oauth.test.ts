import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetOfficialToolCache } from '../src/official';
import { testCtx, testEnv } from './env';
import { fakeClickUp, type RecordedRequest } from './fake-clickup';
import { fakeOfficial, OFFICIAL_CODE, OFFICIAL_TOKEN } from './fake-official';

const ORIGIN = 'https://clickup-mcp.example.workers.dev';
const CLIENT_REDIRECT = 'https://client.test/callback';

let official: ReturnType<typeof fakeOfficial>;
let restRequests: RecordedRequest[];
let env: ReturnType<typeof testEnv>;

const call = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init), env, testCtx);

beforeEach(() => {
  env = testEnv();
  official = fakeOfficial();
  const rest = fakeClickUp();
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

/** Runs the whole browser flow and returns an access token for this server. */
async function signIn(): Promise<string> {
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
  const back = new URL(callback.headers.get('location')!);
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
