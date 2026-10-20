import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The OAuth provider imports WorkerEntrypoint only for instanceof checks; Node can't load cloudflare:*.
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers-stub.ts', import.meta.url)) },
  },
  test: {
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
