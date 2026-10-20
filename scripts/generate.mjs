// Generates src/generated/operations.json from the vendored ClickUp OpenAPI specs.
// Run with `npm run generate`. Refresh the specs first with `npm run spec:update`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const v2 = JSON.parse(readFileSync(join(root, 'spec/clickup-v2.json'), 'utf8'));
const v3 = loadYaml(readFileSync(join(root, 'spec/clickup-v3.yaml'), 'utf8'));

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const DESCRIPTION_LIMIT = 900;
const PROPERTY_DESCRIPTION_LIMIT = 400;

// Operations that make no sense for a caller who already holds a token.
const SKIP = new Set(['GetAccessToken']);

// operationId -> tool name, for IDs that don't snake_case into something readable.
const NAMES = {
  "GetTask'sTimeinStatus": 'get_task_time_in_status',
  "GetBulkTasks'TimeinStatus": 'get_bulk_tasks_time_in_status',
  GetAuthorizedTeams: 'get_authorized_workspaces',
  GetWorkspaceseats: 'get_workspace_seats',
  GetWorkspaceplan: 'get_workspace_plan',
  CreateUserGroup: 'create_user_group',
  UpdateTeam: 'update_user_group',
  DeleteTeam: 'delete_user_group',
  GetTeams1: 'get_user_groups',
  Gettrackedtime: 'get_tracked_time_legacy',
  Tracktime: 'track_time_legacy',
  Edittimetracked: 'edit_time_tracked_legacy',
  Deletetimetracked: 'delete_time_tracked_legacy',
  Gettimeentrieswithinadaterange: 'get_time_entries',
  Createatimeentry: 'create_time_entry',
  Getsingulartimeentry: 'get_time_entry',
  DeleteatimeEntry: 'delete_time_entry',
  UpdateatimeEntry: 'update_time_entry',
  Gettimeentryhistory: 'get_time_entry_history',
  Getrunningtimeentry: 'get_running_time_entry',
  Removetagsfromtimeentries: 'remove_time_entry_tags',
  Getalltagsfromtimeentries: 'get_time_entry_tags',
  Addtagsfromtimeentries: 'add_time_entry_tags',
  Changetagnamesfromtimeentries: 'rename_time_entry_tag',
  StartatimeEntry: 'start_time_entry',
  StopatimeEntry: 'stop_time_entry',
  GetAccessibleCustomFields: 'get_list_custom_fields',
  getFolderAvailableFields: 'get_folder_custom_fields',
  getSpaceAvailableFields: 'get_space_custom_fields',
  getTeamAvailableFields: 'get_workspace_custom_fields',
  SharedHierarchy: 'get_shared_hierarchy',
  GetFilteredTeamTasks: 'get_workspace_tasks',
  GetCustomItems: 'get_custom_task_types',
  GetTeamViews: 'get_workspace_views',
  CreateTeamView: 'create_workspace_view',
  GetUser: 'get_workspace_user',
  CreateTaskAttachment: 'create_task_attachment',
  searchDocsPublic: 'search_docs',
  createDocPublic: 'create_doc',
  getDocPublic: 'get_doc',
  getDocPageListingPublic: 'get_doc_page_listing',
  getDocPagesPublic: 'get_doc_pages',
  createPagePublic: 'create_doc_page',
  getPagePublic: 'get_doc_page',
  editPagePublic: 'edit_doc_page',
  publicPatchAcl: 'update_acl',
  queryAuditLog: 'query_audit_logs',
  getSubtypes: 'get_comment_subtypes',
  getParentEntityAttachments: 'get_entity_attachments',
  postEntityAttachment: 'create_entity_attachment',
  patchChatMessage: 'update_chat_message',
  createReplyMessage: 'create_chat_reply',
};

// OpenAPI tag -> toolset slug. Unlisted tags are slugified.
const TOOLSETS = {
  'Task Checklists': 'tasks',
  'Task Relationships': 'tasks',
  'Custom Task Types': 'tasks',
  Attachments: 'attachments',
  'Time Tracking (Legacy)': 'time_tracking',
  'Shared Hierarchy': 'spaces',
  Acls: 'access',
  'Privacy and access': 'access',
  Auditlogs: 'audit_logs',
  'Audit Logs': 'audit_logs',
  'Chat (Experimental)': 'chat',
  Members: 'users',
  Roles: 'users',
  Guests: 'users',
  'User Groups': 'users',
  Authorization: 'workspaces',
};

// Path parameters that identify the workspace. The server fills these in when the caller omits them.
const WORKSPACE_PARAMS = new Set(['team_id', 'team_Id', 'workspace_id']);

// Array query params ClickUp expects without the `[]` suffix.
const REPEAT_WITHOUT_BRACKETS = new Set(['task_ids', 'group_ids']);

// Spec mistakes confirmed against the live API, keyed by operationId then parameter name.
const ENTITY_TYPE_FIX = {
  schema: { type: 'string', enum: ['tasks', 'custom_fields'] },
  description: '`tasks` for a task, `custom_fields` for a Files Custom Field.',
};
const PARAM_FIXES = {
  // ClickUp wants exactly one of the two, not both.
  DeleteDependency: {
    depends_on: { required: false, description: 'ID of the task this task waits on. Give this or `dependency_of`.' },
    dependency_of: { required: false, description: 'ID of the task waiting on this task. Give this or `depends_on`.' },
  },
  // The spec says `attachments`; the API answers 404 to that and accepts `tasks`.
  getParentEntityAttachments: { entity_type: ENTITY_TYPE_FIX },
  postEntityAttachment: { entity_type: ENTITY_TYPE_FIX },
};

// Custom Field filters travel as one JSON-encoded query value, not as repeated keys.
const CUSTOM_FIELD_FILTER = {
  type: 'object',
  properties: {
    field_id: { type: 'string' },
    operator: { type: 'string', description: 'One of =, <, <=, >, >=, !=, IS NULL, IS NOT NULL, RANGE, ANY, ALL, NOT ANY, NOT ALL.' },
    value: { description: 'Value to compare against. Omit for IS NULL / IS NOT NULL.' },
  },
  required: ['field_id', 'operator'],
};
const JSON_QUERY_PARAMS = {
  custom_fields: { type: 'array', items: CUSTOM_FIELD_FILTER },
  custom_field: CUSTOM_FIELD_FILTER,
};

function snake(id) {
  return id
    .replace(/'/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_|_$/g, '');
}

function toolset(tag) {
  return TOOLSETS[tag] ?? snake(tag.replace(/\(.*\)/, ''));
}

function cleanText(text, limit) {
  if (!text) return undefined;
  let out = String(text)
    .replace(/\\\n/g, '\n')
    .replace(/\\\\/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\((?:ref|red|doc):[^)]*\)/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > limit) out = `${out.slice(0, limit).trimEnd()}…`;
  return out || undefined;
}

function pointer(doc, ref) {
  if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, key) => {
      if (node == null || !(key in node)) throw new Error(`unresolvable $ref: ${ref}`);
      return node[key];
    }, doc);
}

const DROP_KEYS = new Set([
  'example',
  'examples',
  'title',
  'xml',
  'contentEncoding',
  'externalDocs',
  'discriminator',
  'readOnly',
  'writeOnly',
  'nullable',
]);

// Converts an OpenAPI schema into self-contained JSON Schema: refs inlined, examples dropped,
// `nullable` folded into `type`, descriptions trimmed.
function clean(doc, schema, seen = []) {
  if (Array.isArray(schema)) return schema.map((s) => clean(doc, s, seen));
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    if (seen.includes(schema.$ref) || seen.length > 12) return { type: 'object' };
    const extra = { ...schema };
    delete extra.$ref;
    const resolved = clean(doc, pointer(doc, schema.$ref), [...seen, schema.$ref]);
    return { ...resolved, ...clean(doc, extra, seen) };
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_KEYS.has(key) || key.startsWith('x-')) continue;
    if (key === 'description') {
      const text = cleanText(value, PROPERTY_DESCRIPTION_LIMIT);
      if (text) out.description = text;
    } else if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(doc, v, seen)]));
    } else if (key === 'required') {
      if (Array.isArray(value) && value.length) out.required = value;
    } else if (key === 'items') {
      const items = clean(doc, value, seen);
      if (items && Object.keys(items).length) out.items = items;
    } else if (key === 'default' && value === null) {
      continue;
    } else if (value && typeof value === 'object') {
      out[key] = clean(doc, value, seen);
    } else {
      out[key] = value;
    }
  }
  if (schema.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  if (Array.isArray(out.allOf) && out.allOf.length === 1) {
    const [only] = out.allOf;
    delete out.allOf;
    return { ...only, ...out };
  }
  if (out.type === 'array' && !out.items) out.items = {};
  if (Array.isArray(out.required) && out.properties) {
    out.required = out.required.filter((name) => name in out.properties);
    if (!out.required.length) delete out.required;
  }
  return out;
}

function buildOperations(doc, base) {
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op || SKIP.has(op.operationId)) continue;
      const name = `clickup_${NAMES[op.operationId] ?? snake(op.operationId)}`;
      const rawParams = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) =>
        p.$ref ? pointer(doc, p.$ref) : p,
      );
      const params = [];
      for (const p of rawParams) {
        if (p.in === 'header' || p.in === 'cookie') continue;
        let schema = clean(doc, p.schema ?? { type: 'string' });
        let wire = p.name;
        let prop = p.name.replace(/\[\]$/, '');
        if (WORKSPACE_PARAMS.has(p.name) && p.in === 'path') prop = p.name === 'team_Id' ? 'team_id' : p.name;
        let array = schema.type === 'array';
        if (p.in === 'query' && JSON_QUERY_PARAMS[p.name]) {
          schema = JSON_QUERY_PARAMS[p.name];
          array = false;
        } else if (REPEAT_WITHOUT_BRACKETS.has(p.name)) {
          schema = { type: 'array', items: { type: 'string' } };
          array = true;
        } else if (array && p.in === 'query' && !wire.endsWith('[]')) {
          wire = `${wire}[]`;
        }
        const fix = PARAM_FIXES[op.operationId]?.[p.name] ?? {};
        if (fix.schema) schema = fix.schema;
        const description = fix.description ?? cleanText(p.description, PROPERTY_DESCRIPTION_LIMIT);
        params.push({
          prop,
          wire,
          in: p.in,
          required: fix.required ?? (Boolean(p.required) || p.in === 'path'),
          workspace: p.in === 'path' && WORKSPACE_PARAMS.has(p.name),
          array,
          schema: description ? { ...schema, description } : schema,
        });
      }

      let body;
      const content = op.requestBody?.content ?? {};
      if (content['application/json']) {
        body = {
          type: 'json',
          required: Boolean(op.requestBody.required),
          schema: clean(doc, content['application/json'].schema ?? { type: 'object' }),
        };
      } else if (content['multipart/form-data']) {
        body = { type: 'multipart', required: true };
      }

      const tag = op.tags?.[0] ?? 'Other';
      const summary = cleanText(op.summary, 200) ?? name;
      const details = cleanText(op.description, DESCRIPTION_LIMIT);
      ops.push({
        name,
        operationId: op.operationId,
        title: summary,
        description: details && details !== summary ? `${summary}.\n\n${details}` : summary,
        method: method.toUpperCase(),
        base,
        path,
        toolset: toolset(tag),
        params,
        body,
      });
    }
  }
  return ops;
}

const operations = [
  ...buildOperations(v2, 'https://api.clickup.com/api'),
  ...buildOperations(v3, 'https://api.clickup.com'),
].sort((a, b) => a.name.localeCompare(b.name));

const names = new Set();
for (const op of operations) {
  if (names.has(op.name)) throw new Error(`duplicate tool name ${op.name}`);
  if (!/^[a-z0-9_]{1,64}$/.test(op.name)) throw new Error(`invalid tool name ${op.name}`);
  for (const p of op.params) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(p.prop)) throw new Error(`invalid property name ${op.name}.${p.prop}`);
  }
  names.add(op.name);
}

const out = join(root, 'src/generated/operations.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({
    generatedFrom: { v2: v2.info.version, v3: v3.info.version },
    operations,
  }),
);

const toolsets = {};
for (const op of operations) toolsets[op.toolset] = (toolsets[op.toolset] ?? 0) + 1;
console.log(`wrote ${operations.length} operations to ${out}`);
console.log(toolsets);
