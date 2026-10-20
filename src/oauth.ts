// OAuth sign-in. MCP clients authorize against this Worker; the Worker asks for consent, then
// signs the user in through the OAuth server of ClickUp's official MCP (mcp.clickup.com) and keeps
// that token, encrypted, in the grant's props. The token calls both the official MCP server and,
// as a Bearer token, the REST API.
import { AuthorizationError, authorizationErrorRedirect, CimdFetchError, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { escapeHtml, page } from './html';

export const UPSTREAM_ISSUER = 'https://mcp.clickup.com';
const UPSTREAM_RESOURCE = 'https://mcp.clickup.com';
const UPSTREAM_SCOPE = 'read write';
export const CALLBACK_PATH = '/oauth/callback';

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** 32+ random characters; signs the remembered-consent cookie. */
  CONSENT_SECRET?: string;
}

export interface GrantProps {
  /** Access token issued by ClickUp's MCP OAuth server. */
  clickupToken: string;
  /** Epoch ms when that token expires, when ClickUp said. */
  clickupTokenExpiresAt?: number;
  clickupUser?: { id: number | string; username?: string; email?: string };
}

interface UpstreamClient {
  client_id: string;
}

interface Pending {
  verifier: string;
}

function remember(env: Env) {
  return env.CONSENT_SECRET && env.CONSENT_SECRET.length >= 32 ? { secret: env.CONSENT_SECRET } : undefined;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function s256(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

/** Registers this Worker with ClickUp's MCP OAuth server once per redirect URI (RFC 7591). */
async function upstreamClient(env: Env, redirectUri: string, doFetch: typeof fetch): Promise<UpstreamClient> {
  const key = `upstream-client:${redirectUri}`;
  const stored = await env.OAUTH_KV.get<UpstreamClient>(key, 'json');
  if (stored?.client_id) return stored;
  const response = await doFetch(`${UPSTREAM_ISSUER}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: `ClickUp MCP (${new URL(redirectUri).host})`,
      client_uri: new URL(redirectUri).origin,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      scope: UPSTREAM_SCOPE,
    }),
  });
  if (!response.ok) throw new Error(`ClickUp client registration failed: ${response.status} ${await response.text()}`);
  const client = (await response.json()) as UpstreamClient;
  if (!client.client_id) throw new Error('ClickUp client registration returned no client_id');
  await env.OAUTH_KV.put(key, JSON.stringify({ client_id: client.client_id }));
  return client;
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  return page(
    `Connect ${name} to ClickUp`,
    `<h1>Connect ${name} to ClickUp?</h1>
<p>${origin} It will be able to read and change everything your ClickUp account can, through this MCP server.</p>
<p>Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${
  details.redirectIsLoopback
    ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>'
    : ''
}
<p>Next you'll sign in to ClickUp and pick a workspace.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve" class="primary">Continue to ClickUp</button>
  <button name="decision" value="deny">Cancel</button>
</form>`,
  );
}

function errorPage(message: string, status = 400): Response {
  return new Response(page('Sign-in failed', `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p>Start connecting again from your MCP client.</p>`), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function startUpstream(env: Env, request: Request, authRequest: Awaited<ReturnType<OAuthHelpers['parseAuthRequest']>>, headers: Headers | undefined, doFetch: typeof fetch) {
  const oauth = env.OAUTH_PROVIDER;
  const redirectUri = new URL(CALLBACK_PATH, request.url).toString();
  const client = await upstreamClient(env, redirectUri, doFetch);
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const upstream = await oauth.beginUpstream(authRequest, { data: { verifier } satisfies Pending, headers });
  const url = new URL(`${UPSTREAM_ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state: upstream.state,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
    scope: UPSTREAM_SCOPE,
    resource: UPSTREAM_RESOURCE,
  }).toString();
  upstream.headers.set('Location', url.toString());
  return new Response(null, { status: 302, headers: upstream.headers });
}

export async function handleAuthorize(request: Request, env: Env, doFetch: typeof fetch = fetch): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const rememberOptions = remember(env);
      if (rememberOptions && (await oauth.isConsentRemembered(request, authRequest, rememberOptions))) {
        return startUpstream(env, request, authRequest, undefined, doFetch);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { remember: remember(env) });
      return startUpstream(env, request, approved.request, approved.headers, doFetch);
    }
    return new Response('Method not allowed', { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return errorPage(error.description);
    if (error instanceof CimdFetchError) return errorPage('This app could not be verified.');
    throw error;
  }
}

export async function handleCallback(request: Request, env: Env, doFetch: typeof fetch = fetch): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let resumed;
  try {
    resumed = await oauth.finishUpstream<Pending>(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return errorPage(error.description);
    throw error;
  }
  const { request: original, data, headers } = resumed;
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  if (params.get('error') || !code) {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }

  const redirectUri = new URL(CALLBACK_PATH, request.url).toString();
  const client = await upstreamClient(env, redirectUri, doFetch);
  const tokenResponse = await doFetch(`${UPSTREAM_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: data.verifier,
      resource: UPSTREAM_RESOURCE,
    }),
  });
  if (!tokenResponse.ok) {
    console.error('upstream token exchange failed', tokenResponse.status);
    return errorPage(`ClickUp did not issue a token (HTTP ${tokenResponse.status}).`, 502);
  }
  const token = (await tokenResponse.json()) as { access_token?: string; expires_in?: number };
  if (!token.access_token) return errorPage('ClickUp did not issue a token.', 502);

  // Identify the user for the grant. If the REST API refuses this token, the grant still works for
  // the official MCP tools; REST tools then need a personal token on the URL.
  let user: GrantProps['clickupUser'];
  try {
    const me = await doFetch('https://api.clickup.com/api/v2/user', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (me.ok) {
      const body = (await me.json()) as { user?: { id: number; username?: string; email?: string } };
      if (body.user) user = { id: body.user.id, username: body.user.username, email: body.user.email };
    } else {
      console.warn('REST API rejected the MCP OAuth token', me.status);
    }
  } catch {
    // Network trouble here shouldn't block sign-in.
  }

  const props: GrantProps = {
    clickupToken: token.access_token,
    clickupTokenExpiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    clickupUser: user,
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: user ? String(user.id) : `anon-${crypto.randomUUID()}`,
    metadata: { label: user?.username ?? user?.email ?? 'ClickUp user' },
    scope: original.scope,
    props,
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}
