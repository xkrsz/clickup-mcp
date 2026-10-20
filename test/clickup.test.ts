import { describe, expect, it } from 'vitest';
import { ClickUpApiError, executeOperation, ToolError, type ClickUpContext } from '../src/clickup';
import { helperTools } from '../src/helpers';
import { operationsByName } from '../src/operations';
import { fakeClickUp } from './fake-clickup';

const op = (name: string) => operationsByName.get(name)!;
const helper = (name: string) => helperTools.find((t) => t.name === name)!;
const ctxWith = (fetch: typeof globalThis.fetch, extra: Partial<ClickUpContext> = {}): ClickUpContext => ({
  token: 'pk_test',
  fetch,
  sleep: async () => {},
  ...extra,
});

describe('executeOperation', () => {
  it('sends personal tokens raw and OAuth tokens as Bearer', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_get_task'), { task_id: 'abc' });
    await executeOperation(ctxWith(api.fetch, { token: 'oauth-token' }), op('clickup_get_task'), { task_id: 'abc' });
    expect(api.requests[0].headers.get('authorization')).toBe('pk_test');
    expect(api.requests[1].headers.get('authorization')).toBe('Bearer oauth-token');
  });

  it('builds v2 paths and query strings', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_get_task'), {
      task_id: 'DEV-12',
      custom_task_ids: true,
      team_id: 9001,
      include_subtasks: true,
    });
    const { url, method } = api.requests[0];
    expect(method).toBe('GET');
    expect(url.origin + url.pathname).toBe('https://api.clickup.com/api/v2/task/DEV-12');
    expect(url.searchParams.get('custom_task_ids')).toBe('true');
    expect(url.searchParams.get('team_id')).toBe('9001');
  });

  it('repeats array query parameters with brackets where ClickUp expects them', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_get_tasks'), {
      list_id: '42',
      statuses: ['to do', 'in progress'],
      assignees: ['1'],
    });
    await executeOperation(ctxWith(api.fetch), op('clickup_get_bulk_tasks_time_in_status'), { task_ids: ['a', 'b'] });
    expect(api.requests[0].url.searchParams.getAll('statuses[]')).toEqual(['to do', 'in progress']);
    expect(api.requests[0].url.searchParams.getAll('assignees[]')).toEqual(['1']);
    expect(api.requests[1].url.searchParams.getAll('task_ids')).toEqual(['a', 'b']);
  });

  it('serializes object query values as JSON', async () => {
    const api = fakeClickUp();
    const filter = [{ field_id: 'f1', operator: '=', value: '1' }];
    await executeOperation(ctxWith(api.fetch), op('clickup_get_tasks'), { list_id: '42', custom_fields: filter });
    expect(JSON.parse(api.requests[0].url.searchParams.get('custom_fields')!)).toEqual(filter);
  });

  it('lets delete_dependency take either direction alone', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_delete_dependency'), { task_id: 'a', depends_on: 'b' });
    expect(api.requests[0].url.searchParams.get('depends_on')).toBe('b');
    expect(api.requests[0].url.searchParams.has('dependency_of')).toBe(false);
  });

  it('sends JSON bodies and folds stray top-level fields into the body', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_create_task'), {
      list_id: '42',
      name: 'Write tests',
      body: { priority: 2 },
    });
    const req = api.requests[0];
    expect(req.method).toBe('POST');
    expect(req.url.pathname).toBe('/api/v2/list/42/task');
    expect(req.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(req.body as string)).toEqual({ priority: 2, name: 'Write tests' });
  });

  it('accepts a JSON string body', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_update_task'), { task_id: 't1', body: '{"name":"Renamed"}' });
    expect(JSON.parse(api.requests[0].body as string)).toEqual({ name: 'Renamed' });
  });

  it('fills the workspace when the token has exactly one', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch, { token: 'pk_single' }), op('clickup_get_spaces'), {});
    expect(api.requests.map((r) => r.url.pathname)).toEqual(['/api/v2/team', '/api/v2/team/9001/space']);
  });

  it('prefers the configured default workspace', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch, { defaultWorkspaceId: '777' }), op('clickup_search_docs'), {});
    expect(api.requests.map((r) => r.url.pathname)).toEqual(['/api/v3/workspaces/777/docs']);
  });

  it('asks for a workspace when the token has several', async () => {
    const api = fakeClickUp((req) =>
      req.url.pathname === '/api/v2/team'
        ? Response.json({ teams: [{ id: '1', name: 'One' }, { id: '2', name: 'Two' }] })
        : undefined,
    );
    await expect(executeOperation(ctxWith(api.fetch, { token: 'pk_multi' }), op('clickup_get_spaces'), {})).rejects.toThrow(
      /One \(1\), Two \(2\)/,
    );
  });

  it('builds v3 paths', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_move_task'), { workspace_id: '9001', task_id: 't1', list_id: 'l2' });
    expect(api.requests[0].method).toBe('PUT');
    expect(api.requests[0].url.pathname).toBe('/api/v3/workspaces/9001/tasks/t1/home_list/l2');
  });

  it('rejects missing required path parameters before calling ClickUp', async () => {
    const api = fakeClickUp();
    await expect(executeOperation(ctxWith(api.fetch), op('clickup_get_task'), {})).rejects.toThrow(ToolError);
    expect(api.requests).toHaveLength(0);
  });

  it('uploads task attachments as multipart', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_create_task_attachment'), {
      task_id: 't1',
      filename: 'notes.md',
      file_text: '# hello',
    });
    const form = api.requests[0].body as FormData;
    const file = form.get('attachment') as File;
    expect(file.name).toBe('notes.md');
    expect(file.type).toBe('text/markdown');
    expect(await file.text()).toBe('# hello');
  });

  it('decodes base64 uploads for v3 entity attachments', async () => {
    const api = fakeClickUp();
    await executeOperation(ctxWith(api.fetch), op('clickup_create_entity_attachment'), {
      workspace_id: '9001',
      entity_type: 'tasks',
      entity_id: 't1',
      filename: 'a.png',
      file_base64: btoa('PNGDATA'),
    });
    expect(api.requests[0].url.pathname).toBe('/api/v3/workspaces/9001/tasks/t1/attachments');
    const form = api.requests[0].body as FormData;
    expect(form.get('filename')).toBe('a.png');
    const file = form.get('attachment') as File;
    expect(file.type).toBe('image/png');
    expect(await file.text()).toBe('PNGDATA');
  });

  it('retries 429 responses and then succeeds', async () => {
    let calls = 0;
    const api = fakeClickUp(() => (++calls === 1 ? new Response('slow down', { status: 429 }) : undefined));
    const result = await executeOperation(ctxWith(api.fetch), op('clickup_create_task'), { list_id: '1', body: { name: 'x' } });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: true });
  });

  it('does not retry failed writes on 5xx', async () => {
    const api = fakeClickUp(() => new Response('boom', { status: 503 }));
    await expect(
      executeOperation(ctxWith(api.fetch), op('clickup_create_task'), { list_id: '1', body: { name: 'x' } }),
    ).rejects.toBeInstanceOf(ClickUpApiError);
    expect(api.requests).toHaveLength(1);
  });

  it('surfaces ClickUp error bodies', async () => {
    const api = fakeClickUp(() => Response.json({ err: 'Task not found', ECODE: 'ITEM_013' }, { status: 404 }));
    await expect(executeOperation(ctxWith(api.fetch), op('clickup_get_task'), { task_id: 'nope' })).rejects.toThrow(
      /404 for GET \/api\/v2\/task\/nope: .*Task not found/,
    );
  });
});

describe('helper tools', () => {
  it('builds the workspace hierarchy', async () => {
    const api = fakeClickUp((req) => {
      const path = req.url.pathname;
      if (path === '/api/v2/team/9001/space') return Response.json({ spaces: [{ id: 's1', name: 'Eng' }] });
      if (path === '/api/v2/space/s1/folder')
        return Response.json({ folders: [{ id: 'f1', name: 'Sprints', lists: [{ id: 'l1', name: 'Sprint 1', task_count: 3 }] }] });
      if (path === '/api/v2/space/s1/list') return Response.json({ lists: [{ id: 'l2', name: 'Backlog' }] });
      return undefined;
    });
    const result = await helper('clickup_get_workspace_hierarchy').run(ctxWith(api.fetch, { token: 'pk_tree' }), {}, { readonly: false });
    expect(result).toEqual({
      workspace_id: '9001',
      spaces: [
        {
          id: 's1',
          name: 'Eng',
          folders: [{ id: 'f1', name: 'Sprints', lists: [{ id: 'l1', name: 'Sprint 1', task_count: 3 }] }],
          lists: [{ id: 'l2', name: 'Backlog' }],
        },
      ],
    });
  });

  it('searches tasks across pages and reports completeness', async () => {
    const api = fakeClickUp((req) => {
      if (req.url.pathname !== '/api/v2/team/9001/task') return undefined;
      const page = Number(req.url.searchParams.get('page'));
      const tasks =
        page === 0
          ? [
              { id: 'a', name: 'Fix login bug', status: { status: 'open' }, url: 'u/a' },
              { id: 'b', name: 'Write docs', text_content: 'login flow docs', status: { status: 'open' }, url: 'u/b' },
            ]
          : [{ id: 'c', name: 'Unrelated', status: { status: 'open' }, url: 'u/c' }];
      return Response.json({ tasks, last_page: page === 1 });
    });
    const result = (await helper('clickup_search_tasks').run(
      ctxWith(api.fetch, { token: 'pk_search' }),
      { query: 'LOGIN', space_ids: ['s1'] },
      { readonly: false },
    )) as { matches: { id: string }[]; complete: boolean; pages_scanned: number };
    expect(result.matches.map((m) => m.id)).toEqual(['a', 'b']);
    expect(result.complete).toBe(true);
    expect(result.pages_scanned).toBe(2);
    const first = api.requests.find((r) => r.url.pathname === '/api/v2/team/9001/task')!;
    expect(first.url.searchParams.getAll('space_ids[]')).toEqual(['s1']);
  });

  it('finds members by fragment', async () => {
    const api = fakeClickUp();
    const result = await helper('clickup_find_members').run(ctxWith(api.fetch, { token: 'pk_m' }), { query: 'grace' }, { readonly: false });
    expect(result).toEqual({
      workspace_id: '9001',
      members: [{ id: 2, username: 'Grace Hopper', email: 'grace@acme.test', initials: 'GH', role: 3 }],
    });
  });

  it('normalizes raw request paths and enforces read-only mode', async () => {
    const api = fakeClickUp();
    const raw = helper('clickup_api_request');
    await raw.run(ctxWith(api.fetch), { method: 'GET', path: '/api/v2/task/x', query: { include_subtasks: true } }, { readonly: true });
    await raw.run(ctxWith(api.fetch), { method: 'GET', path: 'v3/workspaces/1/docs' }, { readonly: false });
    expect(api.requests.map((r) => r.url.pathname + r.url.search)).toEqual([
      '/api/v2/task/x?include_subtasks=true',
      '/api/v3/workspaces/1/docs',
    ]);
    await expect(raw.run(ctxWith(api.fetch), { method: 'DELETE', path: '/v2/task/x' }, { readonly: true })).rejects.toThrow(/read-only/);
    await expect(raw.run(ctxWith(api.fetch), { method: 'GET', path: '/v2/../evil' }, { readonly: false })).rejects.toThrow(ToolError);
    await expect(raw.run(ctxWith(api.fetch), { method: 'GET', path: 'https://evil.test/v2/x' }, { readonly: false })).rejects.toThrow(
      ToolError,
    );
  });
});
