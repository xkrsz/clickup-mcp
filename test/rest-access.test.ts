import { describe, expect, it, vi } from 'vitest';
import { REST_ACCESS_TTL_SECONDS, restAccess, restAccessKey } from '../src/rest-access';
import { memoryKV } from './env';
import { fakeClickUp, oauthTokenNotFound } from './fake-clickup';

const MCP_TOKEN = 'mcp-issued-token';

describe('REST access check', () => {
  it('probes GET /api/v2/user once and caches a refusal for the TTL', async () => {
    const kv = memoryKV();
    const put = vi.spyOn(kv, 'put');
    const api = fakeClickUp(() => oauthTokenNotFound());
    expect(await restAccess(MCP_TOKEN, kv, api.fetch)).toBe('rejected');
    expect(await restAccess(MCP_TOKEN, kv, api.fetch)).toBe('rejected');
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].url.pathname).toBe('/api/v2/user');
    expect(api.requests[0].headers.get('authorization')).toBe(`Bearer ${MCP_TOKEN}`);
    expect(put).toHaveBeenCalledWith(await restAccessKey(MCP_TOKEN), 'rejected', { expirationTtl: REST_ACCESS_TTL_SECONDS });
  });

  it('caches acceptance per token', async () => {
    const kv = memoryKV();
    const api = fakeClickUp((req) => (req.headers.get('authorization') === `Bearer ${MCP_TOKEN}` ? oauthTokenNotFound() : undefined));
    expect(await restAccess('rest-token', kv, api.fetch)).toBe('accepted');
    expect(await restAccess(MCP_TOKEN, kv, api.fetch)).toBe('rejected');
    expect(await restAccess('rest-token', kv, api.fetch)).toBe('accepted');
    expect(api.requests).toHaveLength(2);
  });

  it('keys the cache by a hash, never the token', async () => {
    const key = await restAccessKey(MCP_TOKEN);
    expect(key).toMatch(/^rest-access:[0-9a-f]{64}$/);
    expect(key).not.toContain(MCP_TOKEN);
  });

  it('falls back to the official tools without caching when the probe says nothing', async () => {
    const kv = memoryKV();
    const flaky = fakeClickUp(() => new Response('upstream error', { status: 503 }));
    expect(await restAccess(MCP_TOKEN, kv, flaky.fetch)).toBe('rejected');
    expect(await kv.get(await restAccessKey(MCP_TOKEN))).toBeNull();

    const offline = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    expect(await restAccess(MCP_TOKEN, kv, offline)).toBe('rejected');

    const healthy = fakeClickUp();
    expect(await restAccess(MCP_TOKEN, kv, healthy.fetch)).toBe('accepted');
    expect(healthy.requests).toHaveLength(1);
  });

  it('expires the cached answer', async () => {
    const kv = memoryKV();
    const api = fakeClickUp(() => oauthTokenNotFound());
    await restAccess(MCP_TOKEN, kv, api.fetch);
    vi.useFakeTimers({ now: Date.now() + (REST_ACCESS_TTL_SECONDS + 1) * 1000 });
    try {
      await restAccess(MCP_TOKEN, kv, api.fetch);
    } finally {
      vi.useRealTimers();
    }
    expect(api.requests).toHaveLength(2);
  });
});
