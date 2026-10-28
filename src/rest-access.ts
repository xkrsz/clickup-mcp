// Whether ClickUp's REST API accepts a token. Tokens from the official MCP's OAuth server work on
// mcp.clickup.com but REST answers them with 401 OAUTH_019, so OAuth connections check once per
// token and fall back to the official tools when REST says no. Results are cached in KV under a
// hash of the token; the token itself is never stored or logged here.
import { API_ORIGIN, authorizationHeader } from './clickup';

export type RestAccess = 'accepted' | 'rejected';

const KEY_PREFIX = 'rest-access:';
/** Long enough that a connection's tool list stays put, short enough to notice ClickUp changing its mind. */
export const REST_ACCESS_TTL_SECONDS = 24 * 3600;
// Edge-cache KV reads; the value for a token only changes when the TTL runs out.
const READ_CACHE_SECONDS = 300;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function restAccessKey(token: string): Promise<string> {
  return KEY_PREFIX + (await sha256Hex(token));
}

/** What a GET /api/v2/user response says about the token, or undefined when it says nothing (5xx, 429). */
export function classifyRestResponse(status: number): RestAccess | undefined {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 401 || status === 403) return 'rejected';
  return undefined;
}

export async function rememberRestAccess(kv: KVNamespace, token: string, access: RestAccess): Promise<void> {
  await kv.put(await restAccessKey(token), access, { expirationTtl: REST_ACCESS_TTL_SECONDS });
}

/**
 * Cached answer, or one cheap probe. When the probe is inconclusive the result is "rejected" and
 * nothing is cached: on an OAuth connection the official tools always work, broken REST tools don't.
 */
export async function restAccess(token: string, kv: KVNamespace | undefined, doFetch: typeof fetch = fetch): Promise<RestAccess> {
  const key = await restAccessKey(token);
  const cached = await kv?.get(key, { cacheTtl: READ_CACHE_SECONDS });
  if (cached === 'accepted' || cached === 'rejected') return cached;
  let access: RestAccess | undefined;
  try {
    const response = await doFetch(`${API_ORIGIN}/api/v2/user`, {
      headers: { Authorization: authorizationHeader(token), Accept: 'application/json' },
    });
    await response.body?.cancel();
    access = classifyRestResponse(response.status);
    if (!access) console.warn('REST access probe inconclusive', response.status);
  } catch (error) {
    console.warn('REST access probe failed', error instanceof Error ? error.message : error);
  }
  if (!access) return 'rejected';
  if (kv) await kv.put(key, access, { expirationTtl: REST_ACCESS_TTL_SECONDS });
  return access;
}
