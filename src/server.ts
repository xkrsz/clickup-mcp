import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import { executeOperation, ToolError, type ClickUpContext } from './clickup';
import { helperTools, type HelperTool } from './helpers';
import {
  callOfficialTool,
  COVERED_BY_REST,
  isReadOnlyOfficialTool,
  KNOWN_OFFICIAL_ONLY,
  OfficialMcpError,
  officialGapTools,
} from './official';
import {
  isReadOnly,
  operations,
  operationsByName,
  operationTools,
  toolFor,
  type Operation,
  type ToolDefinition,
} from './operations';

export const SERVER_NAME = 'clickup-mcp';
export const SERVER_VERSION = '1.0.0';
const MAX_RESULT_CHARS = 400_000;

export interface ServerConfig {
  /** Token for the REST API: a personal pk_ token, or the OAuth token below. */
  token?: string;
  /** Present when the connection signed in with OAuth; enables ClickUp's official MCP tools. */
  official?: { token: string };
  defaultWorkspaceId?: string;
  mode: 'full' | 'compact';
  /** Operation toolsets to expose. Undefined exposes all of them. */
  toolsets?: Set<string>;
  readonly: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const INSTRUCTIONS = `Full ClickUp REST API (v2 and v3) as MCP tools. Each clickup_* tool maps to one ClickUp endpoint; path and query parameters are top-level arguments and JSON request bodies go in \`body\`.

Tips:
- "Workspace" and "team" are the same thing in ClickUp; team_id = workspace_id. Workspace arguments are optional when the token has one workspace or the URL sets a default.
- Start with clickup_get_workspace_hierarchy to find Space, Folder and List IDs, clickup_search_tasks to find tasks by text, and clickup_find_members for user IDs.
- Dates are Unix timestamps in milliseconds.
- Task descriptions: send markdown in markdown_content (create) or markdown_description (update) rather than description.
- Custom task IDs (e.g. DEV-123) need custom_task_ids=true plus team_id.
- clickup_api_request reaches any endpoint without a dedicated tool.
- On OAuth connections, tools with no public REST endpoint (clickup_search for keyword search across tasks, docs and chat; reminders; doc page attachments; attachment downloads; the operator catalog) are served by ClickUp's official MCP server.`;

const searchOperationsTool: ToolDefinition = {
  name: 'clickup_search_operations',
  title: 'Search ClickUp operations',
  description:
    'Search the catalog of ClickUp API operations by keyword (e.g. "checklist", "time entry", "doc page"). Returns operation names to pass to clickup_describe_operation and clickup_call_operation.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords. Omit to list every operation.' },
      toolset: { type: 'string', description: 'Restrict to one toolset, e.g. tasks, docs, chat, time_tracking.' },
    },
  },
  annotations: { title: 'Search ClickUp operations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const describeOperationTool: ToolDefinition = {
  name: 'clickup_describe_operation',
  title: 'Describe a ClickUp operation',
  description: 'Return the description and full input schema of one ClickUp operation found with clickup_search_operations.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  annotations: { title: 'Describe a ClickUp operation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const callOperationTool: ToolDefinition = {
  name: 'clickup_call_operation',
  title: 'Call a ClickUp operation',
  description:
    'Run one ClickUp operation by name. `arguments` follows the schema from clickup_describe_operation: path and query parameters at the top level, the JSON body under `body`.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Operation name, e.g. clickup_create_task.' },
      arguments: { type: 'object', description: 'Arguments for the operation.' },
    },
    required: ['name'],
  },
  annotations: { title: 'Call a ClickUp operation', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

function allowedOperations(config: ServerConfig): Operation[] {
  return operations.filter((op) => (!config.toolsets || config.toolsets.has(op.toolset)) && (!config.readonly || isReadOnly(op)));
}

function publicTool(tool: ToolDefinition) {
  const { name, title, description, inputSchema, annotations } = tool;
  return { name, title, description, inputSchema, annotations };
}

const ownToolNames = new Set([
  ...helperTools.map((t) => t.name),
  ...operationTools.map((t) => t.name),
  searchOperationsTool.name,
  describeOperationTool.name,
  callOperationTool.name,
]);

async function officialTools(config: ServerConfig): Promise<ToolDefinition[]> {
  if (!config.official) return [];
  const tools = await officialGapTools({ token: config.official.token, fetch: config.fetch }, ownToolNames);
  return config.readonly ? tools.filter(isReadOnlyOfficialTool) : tools;
}

/** Tools backed by this server: helpers plus REST operations (or the compact meta tools). */
export function listTools(config: ServerConfig): ToolDefinition[] {
  // Helpers are always listed. clickup_api_request refuses non-GET methods itself in read-only mode.
  const helpers = helperTools;
  if (config.mode === 'compact') {
    return [...helpers, searchOperationsTool, describeOperationTool, callOperationTool].map(publicTool);
  }
  const allowed = new Set(allowedOperations(config).map((op) => op.name));
  return [...helpers.map(publicTool), ...operationTools.filter((tool) => allowed.has(tool.name))];
}

function textResult(value: unknown, isError = false) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${text.length - MAX_RESULT_CHARS} characters; narrow the request with filters or pagination]`;
  }
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

function searchOperations(config: ServerConfig, args: Record<string, unknown>) {
  const terms = String(args.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const toolset = typeof args.toolset === 'string' && args.toolset ? args.toolset : undefined;
  const matches = allowedOperations(config).filter((op) => {
    if (toolset && op.toolset !== toolset) return false;
    const haystack = `${op.name} ${op.title} ${op.path} ${op.toolset} ${op.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return {
    operations: matches.map((op) => ({ name: op.name, title: op.title, method: op.method, path: op.path, toolset: op.toolset })),
  };
}

function findOperation(config: ServerConfig, name: string): Operation | undefined {
  const op = operationsByName.get(name);
  return op && allowedOperations(config).includes(op) ? op : undefined;
}

async function runTool(config: ServerConfig, tool: { helper: HelperTool } | { op: Operation }, args: Record<string, unknown>) {
  if (!config.token) {
    return textResult(
      'No ClickUp credentials on this connection. Sign in with OAuth when your MCP client prompts, or configure the header "Authorization: Bearer pk_..." (your ClickUp personal API token from Settings > Apps), or append ?token=pk_... to the server URL.',
      true,
    );
  }
  const ctx: ClickUpContext = {
    token: config.token,
    defaultWorkspaceId: config.defaultWorkspaceId,
    fetch: config.fetch,
    sleep: config.sleep,
  };
  try {
    const result =
      'helper' in tool ? await tool.helper.run(ctx, args, { readonly: config.readonly }) : await executeOperation(ctx, tool.op, args);
    return textResult(result ?? { ok: true });
  } catch (error) {
    if (error instanceof ToolError) return textResult(error.message, true);
    throw error;
  }
}

async function callOfficial(config: ServerConfig & { official: { token: string } }, name: string, args: Record<string, unknown>) {
  const tools = await officialTools({ ...config, readonly: false });
  const tool = tools.find((t) => t.name === name);
  if (config.readonly && (!tool || !isReadOnlyOfficialTool(tool))) {
    return textResult(`Tool "${name}" is disabled on this connection (read-only mode).`, true);
  }
  const properties = (tool?.inputSchema.properties ?? {}) as Record<string, unknown>;
  const forwarded = { ...args };
  if (config.defaultWorkspaceId && forwarded.workspace_id === undefined && 'workspace_id' in properties) {
    forwarded.workspace_id = config.defaultWorkspaceId;
  }
  try {
    return await callOfficialTool({ token: config.official.token, fetch: config.fetch }, name, forwarded);
  } catch (error) {
    if (error instanceof OfficialMcpError) return textResult(error.message, true);
    throw error;
  }
}

async function callTool(config: ServerConfig, name: string, args: Record<string, unknown>) {
  if (config.mode === 'compact') {
    if (name === searchOperationsTool.name) return textResult(searchOperations(config, args));
    if (name === describeOperationTool.name || name === callOperationTool.name) {
      const op = findOperation(config, String(args.name ?? ''));
      if (!op) return textResult(`Unknown or disabled operation "${args.name}". Use clickup_search_operations.`, true);
      if (name === describeOperationTool.name) return textResult(toolFor(op));
      const opArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
      return runTool(config, { op }, opArgs as Record<string, unknown>);
    }
  }
  const helper = helperTools.find((tool) => tool.name === name);
  if (helper) return runTool(config, { helper }, args);
  const op = findOperation(config, name);
  if (op) return runTool(config, { op }, args);
  if (operationsByName.has(name)) {
    return textResult(`Tool "${name}" is disabled on this connection (read-only mode or toolset filter).`, true);
  }
  if (name.startsWith('clickup_') && !COVERED_BY_REST.has(name)) {
    if (config.official) return callOfficial({ ...config, official: config.official }, name, args);
    if (KNOWN_OFFICIAL_ONLY.has(name)) {
      return textResult(
        `${name} is served by ClickUp's official MCP server, which only accepts ClickUp sign-in. Connect to this server with OAuth (no pk_ token in the URL or Authorization header) to use it.`,
        true,
      );
    }
  }
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
}

export function createServer(config: ServerConfig): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'ClickUp (full API)' },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      // The list depends on the caller's sign-in (official MCP tools), so shared caches must not reuse it.
      cacheHints: { 'tools/list': { ttlMs: 30 * 60_000, cacheScope: 'private' } },
    },
  );
  server.setRequestHandler('tools/list', async () => {
    const own = listTools(config);
    const official = await officialTools(config);
    // Helpers first, then official gap tools, then REST operations in name order.
    const helperCount = config.mode === 'compact' ? own.length : helperTools.length;
    return { tools: [...own.slice(0, helperCount), ...official, ...own.slice(helperCount)] as never };
  });
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(config, name, (args ?? {}) as Record<string, unknown>) as never;
  });
  return server;
}
