import { API_ORIGIN, apiGet, clickupRequest, listWorkspaces, resolveWorkspaceId, ToolError, type ClickUpContext } from './clickup';
import type { JsonSchema, ToolDefinition } from './operations';

export interface HelperTool extends ToolDefinition {
  /** Whether the tool can change ClickUp data for some inputs. */
  mutates: boolean;
  run: (ctx: ClickUpContext, args: Record<string, unknown>, options: { readonly: boolean }) => Promise<unknown>;
}

const workspaceProp: JsonSchema = {
  type: 'string',
  description: 'Workspace ID. Optional: defaults to the workspace configured on the MCP URL, or to your only workspace.',
};

type Named = { id: string; name: string };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const listSummary = (l: Record<string, any>) => ({
  id: l.id,
  name: l.name,
  ...(l.task_count != null ? { task_count: l.task_count } : {}),
  ...(l.archived ? { archived: true } : {}),
});

const hierarchy: HelperTool = {
  name: 'clickup_get_workspace_hierarchy',
  title: 'Get workspace hierarchy',
  description:
    'Return the Spaces, Folders and Lists of a workspace as one tree with IDs and names. Use it to find the list_id, folder_id or space_id other tools need.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: workspaceProp,
      space_ids: { type: 'array', items: { type: 'string' }, description: 'Only include these Spaces.' },
      include_archived: { type: 'boolean', description: 'Include archived Spaces, Folders and Lists. Default false.' },
    },
  },
  annotations: { title: 'Get workspace hierarchy', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  mutates: false,
  async run(ctx, args) {
    const workspaceId = await resolveWorkspaceId(ctx, args.workspace_id);
    const archived = args.include_archived ? 'true' : 'false';
    const { spaces = [] } = (await apiGet(ctx, `/api/v2/team/${workspaceId}/space`, { archived })) as { spaces?: Named[] };
    const wanted = Array.isArray(args.space_ids) ? new Set(args.space_ids.map(String)) : undefined;
    const selected = spaces.filter((s) => !wanted || wanted.has(String(s.id)));
    const tree = await mapLimit(selected, 4, async (space) => {
      const [folders, lists] = await Promise.all([
        apiGet(ctx, `/api/v2/space/${space.id}/folder`, { archived }) as Promise<{ folders?: Record<string, any>[] }>,
        apiGet(ctx, `/api/v2/space/${space.id}/list`, { archived }) as Promise<{ lists?: Record<string, any>[] }>,
      ]);
      return {
        id: space.id,
        name: space.name,
        folders: (folders.folders ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          ...(f.hidden ? { hidden: true } : {}),
          lists: (f.lists ?? []).map(listSummary),
        })),
        lists: (lists.lists ?? []).map(listSummary),
      };
    });
    return { workspace_id: workspaceId, spaces: tree };
  },
};

const taskSummary = (t: Record<string, any>) => ({
  id: t.id,
  custom_id: t.custom_id ?? undefined,
  name: t.name,
  status: t.status?.status,
  url: t.url,
  list: t.list ? { id: t.list.id, name: t.list.name } : undefined,
  assignees: (t.assignees ?? []).map((a: Record<string, any>) => a.username ?? a.email ?? a.id),
  priority: t.priority?.priority ?? undefined,
  due_date: t.due_date ?? undefined,
  date_updated: t.date_updated,
  parent: t.parent ?? undefined,
});

const searchTasks: HelperTool = {
  name: 'clickup_search_tasks',
  title: 'Search tasks',
  description:
    "Find tasks in a workspace whose name, description, ID or custom ID contains every word of `query` (case-insensitive). ClickUp's public API has no text search, so this pages through the filtered workspace task list (100 tasks per page, most recently updated first) and matches locally. `complete: false` means the scan stopped at max_pages before reaching the end. Narrow it with space_ids, list_ids, statuses or assignees.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to match. Empty matches every task the filters return.' },
      workspace_id: workspaceProp,
      space_ids: { type: 'array', items: { type: 'string' } },
      list_ids: { type: 'array', items: { type: 'string' } },
      folder_ids: { type: 'array', items: { type: 'string' } },
      statuses: { type: 'array', items: { type: 'string' } },
      assignees: { type: 'array', items: { type: 'string' }, description: 'User IDs.' },
      tags: { type: 'array', items: { type: 'string' } },
      include_closed: { type: 'boolean', description: 'Include closed tasks. Default false.' },
      subtasks: { type: 'boolean', description: 'Include subtasks. Default true.' },
      search_description: { type: 'boolean', description: 'Also match the task description. Default true.' },
      max_pages: { type: 'integer', minimum: 1, maximum: 20, description: 'Pages of 100 tasks to scan. Default 5.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum matches to return. Default 50.' },
    },
    required: ['query'],
  },
  annotations: { title: 'Search tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  mutates: false,
  async run(ctx, args) {
    const workspaceId = await resolveWorkspaceId(ctx, args.workspace_id);
    const terms = String(args.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const maxPages = Math.min(Math.max(Number(args.max_pages ?? 5), 1), 20);
    const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
    const searchDescription = args.search_description !== false;
    const arr = (key: string) => (Array.isArray(args[key]) ? (args[key] as unknown[]).map(String) : undefined);
    const query = {
      order_by: 'updated',
      include_closed: args.include_closed ? 'true' : 'false',
      subtasks: args.subtasks === false ? 'false' : 'true',
      'space_ids[]': arr('space_ids'),
      'list_ids[]': arr('list_ids'),
      'project_ids[]': arr('folder_ids'),
      'statuses[]': arr('statuses'),
      'assignees[]': arr('assignees'),
      'tags[]': arr('tags'),
    };
    const matches: ReturnType<typeof taskSummary>[] = [];
    let scanned = 0;
    let pages = 0;
    let complete = false;
    for (let page = 0; page < maxPages && matches.length < limit; page++) {
      const result = (await apiGet(ctx, `/api/v2/team/${workspaceId}/task`, { ...query, page: String(page) })) as {
        tasks?: Record<string, any>[];
        last_page?: boolean;
      };
      const tasks = result.tasks ?? [];
      pages++;
      scanned += tasks.length;
      for (const task of tasks) {
        const haystack = [task.name, task.id, task.custom_id, searchDescription ? task.text_content ?? task.description : '']
          .filter(Boolean)
          .join('\n')
          .toLowerCase();
        if (terms.every((term) => haystack.includes(term))) {
          matches.push(taskSummary(task));
          if (matches.length >= limit) break;
        }
      }
      if (result.last_page || tasks.length === 0) {
        complete = true;
        break;
      }
    }
    return { workspace_id: workspaceId, matches, scanned_tasks: scanned, pages_scanned: pages, complete };
  },
};

const findMembers: HelperTool = {
  name: 'clickup_find_members',
  title: 'Find workspace members',
  description:
    'List workspace members, optionally filtered by a name, username, email or initials fragment. Returns user IDs for assignees, watchers and mentions.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Case-insensitive fragment. Omit to list everyone.' },
      workspace_id: workspaceProp,
    },
  },
  annotations: { title: 'Find workspace members', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  mutates: false,
  async run(ctx, args) {
    const workspaceId = await resolveWorkspaceId(ctx, args.workspace_id);
    const { teams = [] } = (await apiGet(ctx, '/api/v2/team')) as { teams?: Record<string, any>[] };
    const team = teams.find((t) => String(t.id) === workspaceId);
    if (!team) throw new ToolError(`Workspace ${workspaceId} is not accessible with this token.`);
    const needle = String(args.query ?? '').toLowerCase().trim();
    const members = (team.members ?? [])
      .map((m: Record<string, any>) => m.user ?? {})
      .filter((u: Record<string, any>) =>
        !needle || [u.username, u.email, u.initials].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)),
      )
      .map((u: Record<string, any>) => ({ id: u.id, username: u.username, email: u.email, initials: u.initials, role: u.role }));
    return { workspace_id: workspaceId, members };
  },
};

const listMyWorkspaces: HelperTool = {
  name: 'clickup_list_workspaces',
  title: 'List workspaces',
  description: 'List the workspaces (teams) this token can access, as id and name pairs. Workspace ID and team_id are the same value.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'List workspaces', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  mutates: false,
  async run(ctx) {
    return { workspaces: await listWorkspaces(ctx), default_workspace_id: ctx.defaultWorkspaceId };
  },
};

const apiRequest: HelperTool = {
  name: 'clickup_api_request',
  title: 'Call any ClickUp API endpoint',
  description:
    'Send a request to any ClickUp REST endpoint, for endpoints that have no dedicated tool yet. `path` starts with /v2/ or /v3/, for example /v2/task/abc123 or /v3/workspaces/123/docs. Prefer the dedicated tools when one exists.',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', description: 'API path beginning with /v2/ or /v3/.' },
      query: {
        type: 'object',
        description: 'Query parameters. Array values repeat the key.',
        additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }] },
      },
      body: { description: 'JSON request body.' },
    },
    required: ['method', 'path'],
  },
  annotations: { title: 'Call any ClickUp API endpoint', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  mutates: true,
  async run(ctx, args, options) {
    const method = String(args.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ToolError(`Unsupported method ${method}.`);
    if (options.readonly && method !== 'GET') throw new ToolError('This MCP connection is read-only; only GET requests are allowed.');
    let path = String(args.path ?? '').trim();
    if (path.startsWith(API_ORIGIN)) path = path.slice(API_ORIGIN.length);
    path = path.replace(/^\/?(api\/)?/, '/');
    if (!/^\/v[23]\//.test(path)) throw new ToolError('path must start with /v2/ or /v3/.');
    if (path.includes('..') || path.includes('?') || path.includes('#')) throw new ToolError('Pass query parameters in `query`, not in `path`.');
    const url = new URL(`/api${path}`, API_ORIGIN);
    for (const [key, value] of Object.entries((args.query as Record<string, unknown>) ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null) url.searchParams.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
      }
    }
    const hasBody = args.body !== undefined && method !== 'GET';
    return clickupRequest(ctx, {
      method,
      url: url.toString(),
      body: hasBody ? (typeof args.body === 'string' ? args.body : JSON.stringify(args.body)) : undefined,
      contentType: hasBody ? 'application/json' : undefined,
    });
  },
};

export const helperTools: HelperTool[] = [listMyWorkspaces, hierarchy, searchTasks, findMembers, apiRequest];
