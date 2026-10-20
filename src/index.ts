import { OAuthError, OAuthProvider, type TokenExchangeCallbackOptions } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { landingPage } from './landing';
import { CALLBACK_PATH, handleAuthorize, handleCallback, type Env, type GrantProps } from './oauth';
import { toolsets } from './operations';
import { configFromRequest, directToken } from './config';
import { createServer, listTools, SERVER_VERSION } from './server';

const mcp = createMcpHandler(
  ({ requestInfo, authInfo }) => createServer(configFromRequest(requestInfo!, authInfo?.extra?.grant as GrantProps | undefined)),
  { onerror: (error) => console.error('mcp error', error.message) },
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID, X-ClickUp-Token, X-ClickUp-Workspace-Id',
  'Access-Control-Expose-Headers': 'Mcp-Protocol-Version, Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};

function withCors(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) out.headers.set(key, value);
  return out;
}

async function serveMcp(request: Request, grant?: GrantProps): Promise<Response> {
  return withCors(await mcp.fetch(request, grant ? { authInfo: { token: 'oauth', clientId: 'oauth', scopes: [], extra: { grant } } } : undefined));
}

const isMcpPath = (path: string) => path === '/mcp' || path === '/mcp/';

// Keep the downstream grant no longer than ClickUp's token lives (ClickUp's MCP OAuth issues no refresh tokens).
function tokenExchangeCallback({ grantType, props }: TokenExchangeCallbackOptions) {
  const expiresAt = (props as GrantProps | undefined)?.clickupTokenExpiresAt;
  if (!expiresAt) return;
  const remaining = Math.floor((expiresAt - Date.now()) / 1000);
  if (remaining < 60) throw new OAuthError('invalid_grant', { description: 'ClickUp sign-in expired; sign in again.' });
  if (grantType === 'authorization_code') return { refreshTokenTTL: remaining, accessTokenTTL: Math.min(remaining, 3600) };
  return { accessTokenTTL: Math.min(remaining, 3600) };
}

// OAuth tokens are bound to `${origin}/mcp`, so each hostname the Worker answers on gets its own
// provider. Self-hosted deployments work on workers.dev or a custom domain without configuration.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: {
        fetch: (request, _env, ctx) => serveMcp(request, (ctx as ExecutionContext<GrantProps>).props),
      },
      defaultHandler: {
        fetch: (request, env) => routes(request, env),
      },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ['clickup'],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'ClickUp MCP' },
      accessTokenTTL: 3600,
      refreshTokenTTL: 365 * 86400,
      refreshTokenIdleTTL: 90 * 86400,
      tokenExchangeCallback,
    });
    providers.set(origin, provider);
  }
  return provider;
}

async function routes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/authorize') return handleAuthorize(request, env);
  if (url.pathname === CALLBACK_PATH) return handleCallback(request, env);
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Not found', { status: 404 });
  if (url.pathname === '/') {
    return new Response(landingPage(url.origin, listTools({ mode: 'full', readonly: false }).length, toolsets), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    });
  }
  if (url.pathname === '/health') return Response.json({ ok: true, version: SERVER_VERSION });
  if (url.pathname === '/tools.json') {
    return withCors(Response.json({ tools: listTools(configFromRequest(request)) }, { headers: { 'Cache-Control': 'public, max-age=300' } }));
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && isMcpPath(url.pathname)) return new Response(null, { status: 204, headers: CORS_HEADERS });
    // Personal tokens bypass OAuth entirely; everything else, including unauthenticated MCP
    // requests that should receive the OAuth challenge, goes through the provider.
    if (isMcpPath(url.pathname) && directToken(request)) return serveMcp(request);
    const response = await providerFor(url.origin).fetch(request, env, ctx);
    return isMcpPath(url.pathname) ? withCors(response) : response;
  },
};
