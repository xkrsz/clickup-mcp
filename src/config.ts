import type { GrantProps } from './oauth';
import type { ServerConfig } from './server';

const TRUE = new Set(['1', 'true', 'yes', 'on']);

/** A personal token passed directly, which skips OAuth. */
export function directToken(request: Request): string | undefined {
  const auth = request.headers.get('authorization')?.trim().replace(/^bearer\s+/i, '');
  if (auth) return auth.startsWith('pk_') ? auth : undefined;
  return request.headers.get('x-clickup-token')?.trim() || new URL(request.url).searchParams.get('token')?.trim() || undefined;
}

export function configFromRequest(request: Request, grant?: GrantProps): ServerConfig {
  const params = new URL(request.url).searchParams;
  const toolsetParam = params.get('toolsets') ?? params.get('toolset');
  const requested = toolsetParam
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // A personal token on the URL or header still wins for REST calls on OAuth connections.
  const personal = request.headers.get('x-clickup-token')?.trim() || params.get('token')?.trim() || undefined;
  return {
    token: grant ? personal ?? grant.clickupToken : directToken(request),
    official: grant ? { token: grant.clickupToken } : undefined,
    defaultWorkspaceId:
      request.headers.get('x-clickup-workspace-id')?.trim() || params.get('workspace_id')?.trim() || params.get('workspace')?.trim() || undefined,
    mode: params.get('mode') === 'compact' ? 'compact' : 'full',
    toolsets: requested?.length ? new Set(requested) : undefined,
    readonly: TRUE.has((params.get('readonly') ?? params.get('read_only') ?? '').toLowerCase()),
  };
}
