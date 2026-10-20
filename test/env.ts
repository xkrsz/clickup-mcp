import type { Env } from '../src/oauth';

/** Just enough of KVNamespace for the OAuth provider. */
export function memoryKV(): KVNamespace {
  const store = new Map<string, { value: string; metadata?: unknown; expiresAt?: number }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  const decode = (value: string, type: unknown) => {
    const kind = typeof type === 'string' ? type : (type as { type?: string } | undefined)?.type ?? 'text';
    if (kind === 'json') return JSON.parse(value);
    if (kind === 'arrayBuffer') return new TextEncoder().encode(value).buffer;
    return value;
  };
  const kv = {
    async get(key: string, type?: unknown) {
      const entry = live(key);
      return entry ? decode(entry.value, type) : null;
    },
    async getWithMetadata(key: string, type?: unknown) {
      const entry = live(key);
      return { value: entry ? decode(entry.value, type) : null, metadata: entry?.metadata ?? null, cacheStatus: null };
    },
    async put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      const expiresAt = options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : options?.expiration
          ? options.expiration * 1000
          : undefined;
      store.set(key, { value: text, metadata: options?.metadata, expiresAt });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      const keys = [...store.keys()].filter((k) => live(k) && (!options?.prefix || k.startsWith(options.prefix))).sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const limit = options?.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      const done = start + limit >= keys.length;
      return {
        keys: page.map((name) => ({ name, metadata: store.get(name)?.metadata })),
        list_complete: done,
        cursor: done ? undefined : String(start + limit),
        cacheStatus: null,
      };
    },
  };
  return kv as unknown as KVNamespace;
}

export function testEnv(): Env {
  return { OAUTH_KV: memoryKV(), CONSENT_SECRET: 'test-consent-secret-0123456789abcdef' } as Env;
}

export const testCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
