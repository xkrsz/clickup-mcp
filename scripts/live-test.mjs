// Calls every tool once against a real ClickUp account through a deployed server.
//   CLICKUP_TOKEN=pk_... node scripts/live-test.mjs <workspace_id> <space_id> [url]
// Creates a private "MCP live test" List and Doc in the given Space and keeps them.
// Everything else it creates is deleted again. People-affecting tools (invites, guests,
// user edits) get nonexistent IDs or invalid emails, so ClickUp rejects them.
import { writeFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [workspaceId, spaceId, base = 'https://clickupmcp.k22i.com/mcp'] = process.argv.slice(2);
if (!process.env.CLICKUP_TOKEN || !workspaceId || !spaceId) {
  throw new Error('Usage: CLICKUP_TOKEN=pk_... node scripts/live-test.mjs <workspace_id> <space_id> [url]');
}

async function connect(query) {
  const url = new URL(base);
  url.search = new URLSearchParams({ workspace_id: workspaceId, ...query }).toString();
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${process.env.CLICKUP_TOKEN}` } },
  });
  const client = new Client({ name: 'live-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return client;
}

const full = await connect({});
const compact = await connect({ mode: 'compact' });
const toolNames = (await full.listTools()).tools.map((t) => t.name);
const compactNames = (await compact.listTools()).tools.map((t) => t.name);

const s = {}; // ids collected along the way
const results = [];
const now = Date.now();
const HOUR = 3600_000;
const FAKE_ID = 1; // no real user, guest or template has this id
const viewBody = (name, type = 'list') => ({ name, type });

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * expect: 'ok' (default) or 'reject' when the call is meant to reach ClickUp and be refused.
 * cleanup: true for extra calls that only tidy up and do not count toward coverage.
 */
async function step(name, args = {}, { expect = 'ok', save, client = full, cleanup = false, skipIf } = {}) {
  const resolved = typeof args === 'function' ? args() : args;
  if (skipIf?.()) {
    results.push({ name, outcome: 'SKIPPED', detail: 'prerequisite missing', cleanup });
    console.log(`SKIP  ${name}`);
    return undefined;
  }
  let outcome;
  let detail;
  let data;
  try {
    const result = await client.callTool({ name, arguments: resolved });
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
    data = parse(text);
    if (result.isError) {
      outcome = expect === 'reject' ? 'REJECTED_AS_EXPECTED' : 'FAIL';
      detail = text.slice(0, 400);
    } else {
      outcome = expect === 'reject' ? 'UNEXPECTED_OK' : 'PASS';
      detail = text.slice(0, 160);
      if (save) {
        try {
          save(data);
        } catch (error) {
          outcome = 'FAIL';
          detail = `could not read result: ${error.message}; ${text.slice(0, 300)}`;
        }
      }
    }
  } catch (error) {
    outcome = 'PROTOCOL_ERROR';
    detail = String(error.message).slice(0, 400);
  }
  results.push({ name, outcome, detail, cleanup, mode: client === compact ? 'compact' : 'full' });
  console.log(`${outcome.padEnd(20)} ${name}${outcome === 'PASS' ? '' : `  ${detail.replace(/\s+/g, ' ').slice(0, 220)}`}`);
  await new Promise((r) => setTimeout(r, 150));
  return data;
}

const tag = `mcp-live-${now.toString(36)}`;
const W = workspaceId;

// --- Account and workspace reads
await step('clickup_list_workspaces');
await step('clickup_get_authorized_user', {}, { save: (d) => (s.userId = d.user.id) });
await step('clickup_get_authorized_workspaces');
await step('clickup_get_workspace_plan');
await step('clickup_get_workspace_seats');
await step('clickup_get_custom_roles');
await step('clickup_get_custom_task_types');
await step('clickup_get_shared_hierarchy');
await step('clickup_get_spaces');
await step('clickup_get_workspace_hierarchy', { space_ids: [spaceId] });
await step('clickup_find_members', { query: '' });
await step('clickup_get_workspace_user', () => ({ user_id: s.userId }));
await step('clickup_get_workspace_custom_fields', {}, {
  save: (d) => (s.textField = d.fields?.find((f) => f.type === 'text' || f.type === 'short_text')?.id),
});
await step('clickup_get_folder_templates', {}, { save: (d) => (s.folderTemplate = d.templates?.[0]?.id) });
await step('clickup_get_list_templates', {}, { save: (d) => (s.listTemplate = d.templates?.[0]?.id) });
await step('clickup_get_task_templates', { page: 0 }, { save: (d) => (s.taskTemplate = d.templates?.[0]?.id) });
await step('clickup_get_time_entry_tags');
await step('clickup_get_running_time_entry');
await step('clickup_get_webhooks');
await step('clickup_get_goals');
await step('clickup_get_user_groups', { team_id: W });
await step('clickup_get_workspace_views');
await step('clickup_get_chat_channels', { limit: 5 });
await step('clickup_search_docs', { limit: 5 });
await step('clickup_get_comment_subtypes', { comment_type: 'post' });
await step('clickup_query_audit_logs', {
  body: { filter: { eventType: ['USER_LOGIN'] }, applicability: 'auth-and-security', pagination: { pageRows: 5 } },
});
await step('clickup_api_request', { method: 'GET', path: '/v2/user' });
// Official-only tools need OAuth; with a personal token the server should explain that.
await step('clickup_search', { keywords: 'test' }, { expect: 'reject' });

// --- The kept private List and Doc
await step('clickup_get_space', { space_id: spaceId });
await step('clickup_get_folderless_lists', { space_id: spaceId });
await step('clickup_get_folders', { space_id: spaceId });
await step('clickup_get_space_tags', { space_id: spaceId });
await step('clickup_get_space_custom_fields', { space_id: spaceId });
await step('clickup_get_space_views', { space_id: spaceId });
await step(
  'clickup_create_folderless_list',
  { space_id: spaceId, body: { name: 'MCP live test', markdown_content: 'Created by `scripts/live-test.mjs` in clickup-mcp.' } },
  { save: (d) => (s.listId = d.id) },
);
await step('clickup_update_acl', () => ({ object_type: 'list', object_id: s.listId, body: { private: true } }), {
  skipIf: () => !s.listId,
});
await step('clickup_get_list', () => ({ list_id: s.listId }), { skipIf: () => !s.listId });
await step('clickup_update_list', () => ({ list_id: s.listId, body: { name: 'MCP live test', content: 'Private test list for clickup-mcp.' } }), {
  skipIf: () => !s.listId,
});
await step('clickup_get_list_members', () => ({ list_id: s.listId }));
await step('clickup_get_list_custom_fields', () => ({ list_id: s.listId }));
await step('clickup_get_list_views', () => ({ list_id: s.listId }));
await step('clickup_create_list_comment', () => ({
  list_id: s.listId,
  body: { comment_text: 'List comment from the live test.', assignee: s.userId, notify_all: false },
}));
await step('clickup_get_list_comments', () => ({ list_id: s.listId }));

await step(
  'clickup_create_doc',
  () => ({ body: { name: 'MCP live test doc', parent: { id: String(s.listId), type: 6 }, visibility: 'PRIVATE', create_page: false } }),
  { save: (d) => (s.docId = d.id) },
);
await step('clickup_get_doc', () => ({ doc_id: s.docId }), { skipIf: () => !s.docId });
await step(
  'clickup_create_doc_page',
  () => ({ doc_id: s.docId, body: { name: 'Overview', content: '# Live test\n\nWritten through the MCP.', content_format: 'text/md' } }),
  { save: (d) => (s.pageId = d.id), skipIf: () => !s.docId },
);
await step(
  'clickup_edit_doc_page',
  () => ({ doc_id: s.docId, page_id: s.pageId, body: { content: '\n\n- appended line', content_edit_mode: 'append', content_format: 'text/md' } }),
  { skipIf: () => !s.pageId },
);
await step('clickup_get_doc_page', () => ({ doc_id: s.docId, page_id: s.pageId, content_format: 'text/md' }), { skipIf: () => !s.pageId });
await step('clickup_get_doc_pages', () => ({ doc_id: s.docId }), { skipIf: () => !s.docId });
await step('clickup_get_doc_page_listing', () => ({ doc_id: s.docId }), { skipIf: () => !s.docId });

// --- Tasks in the private List
const newTask = (name, extra = {}) => () => ({ list_id: s.listId, body: { name, markdown_content: `**${name}** from the live test.`, ...extra } });
await step('clickup_create_task', newTask('Live test task A', { tags: [tag], priority: 3 }), { save: (d) => (s.taskA = d.id) });
await step('clickup_create_task', newTask('Live test task B'), { save: (d) => (s.taskB = d.id), cleanup: true });
await step('clickup_create_task', newTask('Live test task C (merged away)'), { save: (d) => (s.taskC = d.id), cleanup: true });
await step('clickup_get_tasks', () => ({ list_id: s.listId, include_markdown_description: true }));
await step('clickup_get_task', () => ({ task_id: s.taskA, include_markdown_description: true }));
await step('clickup_update_task', () => ({
  task_id: s.taskA,
  // Per-user time estimates below need the user assigned.
  body: { description: 'Updated by the live test.', time_estimate: HOUR, assignees: { add: [s.userId], rem: [] } },
}));
await step('clickup_get_task_members', () => ({ task_id: s.taskA }));
await step('clickup_add_tag_to_task', () => ({ task_id: s.taskB, tag_name: tag }));
await step('clickup_remove_tag_from_task', () => ({ task_id: s.taskB, tag_name: tag }));
await step('clickup_add_dependency', () => ({ task_id: s.taskA, body: { depends_on: s.taskB } }));
await step('clickup_delete_dependency', () => ({ task_id: s.taskA, depends_on: s.taskB }));
await step('clickup_add_task_link', () => ({ task_id: s.taskA, links_to: s.taskB }));
await step('clickup_delete_task_link', () => ({ task_id: s.taskA, links_to: s.taskB }));
await step('clickup_set_custom_field_value', () => ({ task_id: s.taskA, field_id: s.textField, body: { value: 'live test' } }), {
  skipIf: () => !s.textField,
});
await step('clickup_remove_custom_field_value', () => ({ task_id: s.taskA, field_id: s.textField }), { skipIf: () => !s.textField });
await step('clickup_get_task_time_in_status', () => ({ task_id: s.taskA }));
await step('clickup_get_bulk_tasks_time_in_status', () => ({ task_ids: [s.taskA, s.taskB] }));
await step('clickup_replace_time_estimates_by_user', () => ({ task_id: s.taskA, body: [{ assignee: s.userId, time: HOUR }] }));
await step('clickup_update_time_estimates_by_user', () => ({ task_id: s.taskA, body: [{ assignee: s.userId, time: 2 * HOUR }] }));

await step('clickup_create_checklist', () => ({ task_id: s.taskA, body: { name: 'Live checklist' } }), {
  save: (d) => (s.checklistId = d.checklist.id),
});
await step('clickup_edit_checklist', () => ({ checklist_id: s.checklistId, body: { name: 'Live checklist (renamed)' } }));
await step('clickup_create_checklist_item', () => ({ checklist_id: s.checklistId, body: { name: 'Item one' } }), {
  save: (d) => (s.checklistItemId = d.checklist.items[0].id),
});
await step('clickup_edit_checklist_item', () => ({
  checklist_id: s.checklistId,
  checklist_item_id: s.checklistItemId,
  body: { resolved: true },
}));
await step('clickup_delete_checklist_item', () => ({ checklist_id: s.checklistId, checklist_item_id: s.checklistItemId }));

await step('clickup_create_task_comment', () => ({ task_id: s.taskA, body: { comment_text: 'Task comment from the live test.', notify_all: false } }), {
  save: (d) => (s.commentId = d.id),
});
await step('clickup_get_task_comments', () => ({ task_id: s.taskA }));
await step('clickup_update_comment', () => ({
  comment_id: s.commentId,
  body: { comment_text: 'Edited task comment.', assignee: s.userId, resolved: false },
}));
await step('clickup_create_threaded_comment', () => ({ comment_id: s.commentId, body: { comment_text: 'Threaded reply.', notify_all: false } }), {
  save: (d) => (s.replyId = d.id),
});
await step('clickup_get_threaded_comments', () => ({ comment_id: s.commentId }));
await step('clickup_delete_comment', () => ({ comment_id: s.replyId }));

await step('clickup_create_task_attachment', () => ({ task_id: s.taskA, filename: 'live-test.txt', file_text: 'hello from the live test\n' }));
await step('clickup_create_entity_attachment', () => ({
  entity_type: 'tasks',
  entity_id: s.taskA,
  filename: 'live-test-v3.txt',
  file_text: 'hello from the v3 attachment endpoint\n',
}));
await step('clickup_get_entity_attachments', () => ({ entity_type: 'tasks', entity_id: s.taskA }));

// --- Legacy time tracking
await step('clickup_track_time_legacy', () => ({ task_id: s.taskA, body: { start: now - 2 * HOUR, end: now - HOUR, time: HOUR } }));
await step('clickup_get_tracked_time_legacy', () => ({ task_id: s.taskA }), {
  save: (d) => (s.intervalId = d.data?.[0]?.intervals?.[0]?.id),
});
await step('clickup_edit_time_tracked_legacy', () => ({
  task_id: s.taskA,
  interval_id: s.intervalId,
  body: { start: now - 3 * HOUR, end: now - 2 * HOUR, time: HOUR },
}), { skipIf: () => !s.intervalId });
await step('clickup_delete_time_tracked_legacy', () => ({ task_id: s.taskA, interval_id: s.intervalId }), { skipIf: () => !s.intervalId });

// --- Time entries
await step('clickup_create_time_entry', () => ({
  body: { description: 'Live test entry', start: now - 5 * HOUR, duration: HOUR / 2, tid: s.taskA, billable: false },
}), { save: (d) => (s.timeEntryId = d.data.id) });
await step('clickup_get_time_entries', () => ({ start_date: now - 6 * HOUR, end_date: now, task_id: s.taskA }));
await step('clickup_get_time_entry', () => ({ timer_id: s.timeEntryId }));
await step('clickup_update_time_entry', () => ({ timer_id: s.timeEntryId, body: { description: 'Live test entry (edited)', tags: [] } }));
await step('clickup_get_time_entry_history', () => ({ timer_id: s.timeEntryId }));
await step('clickup_add_time_entry_tags', () => ({
  body: { time_entry_ids: [s.timeEntryId], tags: [{ name: tag, tag_fg: '#000000', tag_bg: '#ffffff' }] },
}));
await step('clickup_rename_time_entry_tag', () => ({ body: { name: tag, new_name: `${tag}-r`, tag_bg: '#ffffff', tag_fg: '#000000' } }));
await step('clickup_remove_time_entry_tags', () => ({ body: { time_entry_ids: [s.timeEntryId], tags: [{ name: `${tag}-r` }] } }));
await step('clickup_start_time_entry', () => ({ body: { tid: s.taskA, description: 'Live test timer' } }), {
  save: (d) => (s.timerId = d.data?.id),
});
await step('clickup_stop_time_entry');
await step('clickup_delete_time_entry', () => ({ timer_id: [s.timeEntryId, s.timerId].filter(Boolean).join(',') }));

// --- Throwaway Folder, List, views and templates
await step('clickup_create_folder', { space_id: spaceId, body: { name: 'MCP live test folder (temp)' } }, { save: (d) => (s.folderId = d.id) });
await step('clickup_get_folder', () => ({ folder_id: s.folderId }));
await step('clickup_update_folder', () => ({ folder_id: s.folderId, body: { name: 'MCP live test folder (temp, renamed)' } }));
await step('clickup_move_folder', () => ({ folder_id: s.folderId, body: { space_id: String(spaceId) } }));
await step('clickup_get_folder_custom_fields', () => ({ folder_id: s.folderId }));
await step('clickup_get_folder_views', () => ({ folder_id: s.folderId }));
await step('clickup_create_list', () => ({ folder_id: s.folderId, body: { name: 'Temp list' } }), { save: (d) => (s.tempListId = d.id) });
await step('clickup_get_lists', () => ({ folder_id: s.folderId }));
await step('clickup_move_task', () => ({ task_id: s.taskC, list_id: s.tempListId, body: { move_custom_fields: false } }));
await step('clickup_add_task_to_list', () => ({ list_id: s.tempListId, task_id: s.taskB }));
await step('clickup_remove_task_from_list', () => ({ list_id: s.tempListId, task_id: s.taskB }));
await step('clickup_merge_tasks', () => ({ task_id: s.taskA, body: { source_task_ids: [s.taskC] } }));
await step('clickup_create_task_from_template', () => ({ list_id: s.tempListId, template_id: s.taskTemplate, body: { name: 'From template' } }), {
  skipIf: () => !s.taskTemplate,
});
await step(
  'clickup_create_folder_list_from_template',
  () => ({ folder_id: s.folderId, template_id: s.listTemplate ?? `t-${FAKE_ID}`, body: { name: 'Temp list from template' } }),
  { expect: s.listTemplate ? 'ok' : 'reject' },
);
await step(
  'clickup_create_space_list_from_template',
  { space_id: spaceId, template_id: 't-1', body: { name: 'Should not exist' } },
  { expect: 'reject' },
);
await step(
  'clickup_create_folder_from_template',
  { space_id: spaceId, template_id: 't-1', body: { name: 'Should not exist' } },
  { expect: 'reject' },
);

await step('clickup_create_list_view', () => ({ list_id: s.tempListId, body: viewBody('Live list view') }), { save: (d) => (s.listViewId = d.view.id) });
await step('clickup_get_view', () => ({ view_id: s.listViewId }));
await step('clickup_update_view', () => ({
  view_id: s.listViewId,
  body: { name: 'Live list view (renamed)', type: 'list', parent: { id: String(s.tempListId), type: 6 } },
}));
await step('clickup_get_view_tasks', () => ({ view_id: s.listViewId, page: 0 }));
await step('clickup_create_folder_view', () => ({ folder_id: s.folderId, body: viewBody('Live folder view') }), {
  save: (d) => (s.folderViewId = d.view.id),
});
await step('clickup_create_space_view', { space_id: spaceId, body: viewBody('Live space view (temp)') }, { save: (d) => (s.spaceViewId = d.view.id) });
await step('clickup_create_workspace_view', { body: viewBody('Live workspace view (temp)') }, { save: (d) => (s.workspaceViewId = d.view.id) });
await step('clickup_create_list_view', () => ({ list_id: s.tempListId, body: viewBody('Live chat view', 'conversation') }), {
  save: (d) => (s.chatViewId = d.view.id),
  cleanup: true,
});
await step('clickup_create_chat_view_comment', () => ({ view_id: s.chatViewId, body: { comment_text: 'Chat view comment.', notify_all: false } }));
await step('clickup_get_chat_view_comments', () => ({ view_id: s.chatViewId }));
await step('clickup_delete_view', () => ({ view_id: s.listViewId }));
for (const key of ['folderViewId', 'spaceViewId', 'workspaceViewId', 'chatViewId']) {
  await step('clickup_delete_view', () => ({ view_id: s[key] }), { cleanup: true, skipIf: () => !s[key] });
}

// --- Space (throwaway; members without the right permission get a rejection)
await step(
  'clickup_create_space',
  {
    body: {
      name: 'MCP live test space (temp)',
      multiple_assignees: true,
      features: {
        due_dates: { enabled: true, start_date: false, remap_due_dates: false, remap_closed_due_date: false },
        time_tracking: { enabled: true },
        tags: { enabled: true },
        time_estimates: { enabled: true },
        checklists: { enabled: true },
        custom_fields: { enabled: true },
        remap_dependencies: { enabled: true },
        dependency_warning: { enabled: true },
        portfolios: { enabled: false },
      },
    },
  },
  { save: (d) => (s.tempSpaceId = d.id) },
);
const space = () => s.tempSpaceId ?? spaceId;
await step('clickup_update_space', () => ({
  space_id: s.tempSpaceId,
  body: { name: 'MCP live test space (temp, renamed)', color: '#7B68EE', private: true, multiple_assignees: true, features: {} },
}), { skipIf: () => !s.tempSpaceId });
await step('clickup_create_space_tag', () => ({ space_id: space(), body: { tag: { name: `${tag}-s`, tag_fg: '#ffffff', tag_bg: '#7B68EE' } } }));
await step('clickup_edit_space_tag', () => ({
  space_id: space(),
  tag_name: `${tag}-s`,
  body: { tag: { name: `${tag}-s`, fg_color: '#ffffff', bg_color: '#FF0000' } },
}));
await step('clickup_delete_space_tag', () => ({ space_id: space(), tag_name: `${tag}-s`, body: { tag: { name: `${tag}-s`, tag_fg: '#ffffff', tag_bg: '#FF0000' } } }));
// The task tag auto-created in the kept Space.
await step('clickup_api_request', () => ({ method: 'DELETE', path: `/v2/space/${spaceId}/tag/${tag}` }), { cleanup: true });

// --- Goals
await step('clickup_create_goal', () => ({
  body: { name: 'MCP live test goal', due_date: now + 30 * 24 * HOUR, description: 'Temp goal', multiple_owners: true, owners: [s.userId], color: '#32a852' },
}), { save: (d) => (s.goalId = d.goal.id) });
await step('clickup_get_goal', () => ({ goal_id: s.goalId }), { skipIf: () => !s.goalId });
await step('clickup_update_goal', () => ({
  goal_id: s.goalId,
  body: { name: 'MCP live test goal (renamed)', due_date: now + 31 * 24 * HOUR, description: 'Temp goal', rem_owners: [], add_owners: [], color: '#32a852' },
}), { skipIf: () => !s.goalId });
await step('clickup_create_key_result', () => ({
  goal_id: s.goalId,
  body: { name: 'Live KR', owners: [s.userId], type: 'number', steps_start: 0, steps_end: 10, unit: 'items', task_ids: [], list_ids: [] },
}), { save: (d) => (s.keyResultId = d.key_result.id), skipIf: () => !s.goalId });
await step('clickup_edit_key_result', () => ({ key_result_id: s.keyResultId, body: { steps_current: 5, note: 'halfway' } }), {
  skipIf: () => !s.keyResultId,
});
await step('clickup_delete_key_result', () => ({ key_result_id: s.keyResultId }), { skipIf: () => !s.keyResultId });
await step('clickup_delete_goal', () => ({ goal_id: s.goalId }), { skipIf: () => !s.goalId });

// --- Webhooks
await step('clickup_create_webhook', () => ({
  body: { endpoint: 'https://example.com/clickup-mcp-live-test', events: ['taskCreated'], list_id: Number(s.listId) },
}), { save: (d) => (s.webhookId = d.id) });
await step('clickup_update_webhook', () => ({
  webhook_id: s.webhookId,
  body: { endpoint: 'https://example.com/clickup-mcp-live-test-2', events: ['taskUpdated'], status: 'active' },
}), { skipIf: () => !s.webhookId });
await step('clickup_delete_webhook', () => ({ webhook_id: s.webhookId }), { skipIf: () => !s.webhookId });

// --- User groups (may need admin rights)
await step('clickup_create_user_group', () => ({ body: { name: 'MCP live test group', members: [s.userId] } }), {
  save: (d) => (s.groupId = d.id),
});
await step('clickup_update_user_group', () => ({ group_id: s.groupId, body: { name: 'MCP live test group (renamed)' } }), { skipIf: () => !s.groupId });
await step('clickup_delete_user_group', () => ({ group_id: s.groupId }), { skipIf: () => !s.groupId });

// --- People: only invalid targets, so nothing changes
await step('clickup_invite_user_to_workspace', { body: { email: 'not-an-email', admin: false } }, { expect: 'reject' });
await step('clickup_edit_user_on_workspace', { user_id: FAKE_ID, body: { username: 'x', admin: false, custom_role_id: 0 } }, { expect: 'reject' });
await step('clickup_remove_user_from_workspace', { user_id: FAKE_ID }, { expect: 'reject' });
await step('clickup_invite_guest_to_workspace', { body: { email: 'not-an-email' } }, { expect: 'reject' });
await step('clickup_get_guest', { guest_id: FAKE_ID }, { expect: 'reject' });
await step('clickup_edit_guest_on_workspace', { guest_id: FAKE_ID, body: { can_edit_tags: false } }, { expect: 'reject' });
await step('clickup_remove_guest_from_workspace', { guest_id: FAKE_ID }, { expect: 'reject' });
await step('clickup_add_guest_to_task', () => ({ task_id: s.taskA, guest_id: FAKE_ID, body: { permission_level: 'read' } }), { expect: 'reject' });
await step('clickup_remove_guest_from_task', () => ({ task_id: s.taskA, guest_id: FAKE_ID }), { expect: 'reject' });
await step('clickup_add_guest_to_list', () => ({ list_id: s.listId, guest_id: FAKE_ID, body: { permission_level: 'read' } }), { expect: 'reject' });
await step('clickup_remove_guest_from_list', () => ({ list_id: s.listId, guest_id: FAKE_ID }), { expect: 'reject' });
await step('clickup_add_guest_to_folder', () => ({ folder_id: s.folderId, guest_id: FAKE_ID, body: { permission_level: 'read' } }), { expect: 'reject' });
await step('clickup_remove_guest_from_folder', () => ({ folder_id: s.folderId, guest_id: FAKE_ID }), { expect: 'reject' });

// --- Chat
await step('clickup_create_chat_channel', { body: { name: `${tag}`, visibility: 'PRIVATE', description: 'Live test channel' } }, {
  save: (d) => (s.channelId = d.data?.id ?? d.id),
});
await step('clickup_get_chat_channel', () => ({ channel_id: s.channelId }));
await step('clickup_update_chat_channel', () => ({ channel_id: s.channelId, body: { topic: 'Live test topic' } }));
await step('clickup_get_chat_channel_members', () => ({ channel_id: s.channelId }));
await step('clickup_get_chat_channel_followers', () => ({ channel_id: s.channelId }));
await step('clickup_create_chat_message', () => ({ channel_id: s.channelId, body: { type: 'message', content: 'Hello from the live test', content_format: 'text/md' } }), {
  save: (d) => (s.messageId = d.data?.id ?? d.id),
});
await step('clickup_get_chat_messages', () => ({ channel_id: s.channelId }));
await step('clickup_update_chat_message', () => ({ message_id: s.messageId, body: { content: 'Hello (edited)', content_format: 'text/md' } }));
await step('clickup_create_chat_reaction', () => ({ message_id: s.messageId, body: { reaction: '+1' } }));
await step('clickup_get_chat_message_reactions', () => ({ message_id: s.messageId }));
await step('clickup_delete_chat_reaction', () => ({ message_id: s.messageId, reaction: '+1' }));
await step('clickup_create_chat_reply', () => ({ message_id: s.messageId, body: { type: 'message', content: 'A reply', content_format: 'text/md' } }), {
  save: (d) => (s.replyMessageId = d.data?.id ?? d.id),
});
await step('clickup_get_chat_message_replies', () => ({ message_id: s.messageId }));
await step('clickup_get_chat_message_tagged_users', () => ({ message_id: s.messageId }));
await step('clickup_delete_chat_message', () => ({ message_id: s.replyMessageId ?? s.messageId }));
await step('clickup_create_location_chat_channel', () => ({ body: { location: { id: String(s.tempListId), type: 'list' } } }), {
  save: (d) => (s.locationChannelId = d.data?.id ?? d.id),
});
await step('clickup_create_direct_message_chat_channel', { body: { user_ids: [] } });
await step('clickup_delete_chat_channel', () => ({ channel_id: s.channelId }));
await step('clickup_delete_chat_channel', () => ({ channel_id: s.locationChannelId }), { cleanup: true, skipIf: () => !s.locationChannelId });

// --- Search helpers and compact mode
await step('clickup_get_workspace_tasks', () => ({ list_ids: [s.listId], include_closed: true }));
await step('clickup_search_tasks', () => ({ query: 'live test', list_ids: [String(s.listId)] }));
await step('clickup_search_operations', { query: 'checklist' }, { client: compact });
await step('clickup_describe_operation', { name: 'clickup_get_task' }, { client: compact });
await step('clickup_call_operation', () => ({ name: 'clickup_get_task', arguments: { task_id: s.taskA } }), { client: compact });

// --- Tear down the throwaways
await step('clickup_delete_checklist', () => ({ checklist_id: s.checklistId }));
await step('clickup_delete_task', () => ({ task_id: s.taskB }));
await step('clickup_delete_list', () => ({ list_id: s.tempListId }));
await step('clickup_delete_folder', () => ({ folder_id: s.folderId }));
await step('clickup_delete_space', () => ({ space_id: s.tempSpaceId }), { skipIf: () => !s.tempSpaceId });

await full.close();
await compact.close();

const counted = results.filter((r) => !r.cleanup);
const called = new Set(counted.map((r) => r.name));
const missing = [...new Set([...toolNames, ...compactNames])].filter((n) => !called.has(n));
const tally = {};
for (const r of counted) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
const report = { workspaceId, spaceId, kept: { listId: s.listId, docId: s.docId, taskId: s.taskA }, tally, missing, results };
const out = `${process.env.TMPDIR ?? '/tmp'}/clickup-live-test.json`;
writeFileSync(out, JSON.stringify(report, null, 2));
console.log('\n', JSON.stringify({ tally, missing, kept: report.kept }), `\nreport: ${out}`);
