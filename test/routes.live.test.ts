// Calls every generated operation against the real ClickUp API with an invalid token.
// v2 authenticates before routing, so a correct route answers 401. v3 first resolves the
// workspace, so set CLICKUP_PROBE_WORKSPACE to a real workspace ID (not a secret): a correct v3
// route then answers with a JSON auth error (ECODE JWT_* / OAUTH_*) and a wrong one with a plain
// "404 page not found". Run with `CLICKUP_PROBE_WORKSPACE=<id> npm run test:routes`.
import { describe, expect, it } from 'vitest';
import { ClickUpApiError, executeOperation } from '../src/clickup';
import { operations, type Operation } from '../src/operations';

const enabled = process.env.CLICKUP_PROBE === '1';

function sampleArgs(op: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const param of op.params) {
    if (!param.required || param.workspace) continue;
    const values = (param.schema.enum as unknown[] | undefined) ?? undefined;
    args[param.prop] = values?.[0] ?? (param.array ? ['1'] : '1');
  }
  if (op.body?.type === 'multipart') Object.assign(args, { filename: 'probe.txt', file_text: 'probe' });
  return args;
}

describe.skipIf(!enabled)('ClickUp routes', () => {
  it.each(operations.map((op) => [op.name, op] as const))('%s reaches an authenticated ClickUp route', async (_name, op) => {
    const ctx = { token: 'pk_0_INVALIDPROBETOKEN', defaultWorkspaceId: process.env.CLICKUP_PROBE_WORKSPACE ?? '1' };
    let status = 0;
    let body: unknown;
    try {
      await executeOperation(ctx, op, sampleArgs(op));
    } catch (error) {
      if (!(error instanceof ClickUpApiError)) throw error;
      status = error.status;
      body = error.body;
    }
    const ecode = typeof body === 'object' && body !== null ? String((body as { ECODE?: string }).ECODE ?? '') : '';
    const authenticated = status === 401 || /^(JWT|OAUTH)_/.test(ecode);
    expect(authenticated, `${op.method} ${op.path} -> ${status} ${JSON.stringify(body)}`).toBe(true);
  });
});
