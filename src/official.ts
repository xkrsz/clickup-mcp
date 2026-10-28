// Pass-through to ClickUp's official MCP server for capabilities the public REST API lacks
// (universal search, reminders, doc page attachments, signed attachment downloads, the operator
// catalog). The official server only accepts tokens from its own OAuth server, so these tools
// exist only on connections that signed in through /authorize. ClickUp's REST API refuses those
// same tokens, so without a REST token on the grant the official tools replace the REST ones.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ToolDefinition } from './operations';

export const OFFICIAL_MCP_URL = 'https://mcp.clickup.com/mcp';

/** Official tools whose job a REST-backed tool here already does. Everything else passes through. */
export const COVERED_BY_REST = new Set([
  'clickup_add_tag_to_task',
  'clickup_add_task_dependency',
  'clickup_add_task_link',
  'clickup_add_task_to_list',
  'clickup_add_time_entry',
  'clickup_attach_task_file',
  'clickup_create_comment',
  'clickup_create_document',
  'clickup_create_document_page',
  'clickup_create_folder',
  'clickup_create_list',
  'clickup_create_list_in_folder',
  'clickup_create_task',
  'clickup_create_task_comment',
  'clickup_delete_comment',
  'clickup_delete_task',
  'clickup_filter_tasks',
  'clickup_find_member_by_name',
  'clickup_get_bulk_tasks_time_in_status',
  'clickup_get_chat_channel_messages',
  'clickup_get_chat_channels',
  'clickup_get_chat_message_replies',
  'clickup_get_current_time_entry',
  'clickup_get_custom_fields',
  'clickup_get_document_pages',
  'clickup_get_folder',
  'clickup_get_list',
  'clickup_get_task',
  'clickup_get_task_comments',
  'clickup_get_task_time_in_status',
  'clickup_get_threaded_comments',
  'clickup_get_time_entries',
  'clickup_get_workspace_hierarchy',
  'clickup_get_workspace_members',
  'clickup_list_document_pages',
  'clickup_merge_tasks',
  'clickup_move_task',
  'clickup_remove_tag_from_task',
  'clickup_remove_task_dependency',
  'clickup_remove_task_from_list',
  'clickup_remove_task_link',
  'clickup_resolve_assignees',
  'clickup_send_chat_message',
  'clickup_start_time_tracking',
  'clickup_stop_time_tracking',
  'clickup_update_comment',
  'clickup_update_document_page',
  'clickup_update_folder',
  'clickup_update_list',
  'clickup_update_task',
]);

/** Gap tools known when this was written, used to explain why they're missing on token connections. */
export const KNOWN_OFFICIAL_ONLY = new Set([
  'clickup_search',
  'clickup_create_reminder',
  'clickup_search_reminders',
  'clickup_update_reminder',
  'clickup_list_document_page_attachments',
  'clickup_download_document_page_attachment',
  'clickup_download_task_attachment',
  'clickup_request_attachment_upload',
  'clickup_get_operators',
  'clickup_execute_operator',
  'clickup_get_schema',
]);

/**
 * Official tools that do the job of a REST-backed tool with a different name. Used when REST
 * refuses the connection's token: a call to the REST name gets pointed at these. REST tools whose
 * name matches an official tool (clickup_create_task, clickup_add_task_link, ...) route directly.
 */
export const OFFICIAL_ALTERNATIVES: Record<string, string[]> = {
  // Helpers
  clickup_list_workspaces: ['clickup_get_workspace_hierarchy', 'clickup_get_user'],
  clickup_search_tasks: ['clickup_search', 'clickup_filter_tasks'],
  clickup_find_members: ['clickup_find_member_by_name', 'clickup_get_workspace_members', 'clickup_resolve_assignees'],
  clickup_api_request: ['clickup_get_operators', 'clickup_execute_operator'],
  clickup_search_operations: ['clickup_get_operators'],
  clickup_describe_operation: ['clickup_get_operators'],
  // Tasks
  clickup_get_tasks: ['clickup_filter_tasks'],
  clickup_get_workspace_tasks: ['clickup_filter_tasks'],
  clickup_get_view_tasks: ['clickup_filter_tasks'],
  clickup_add_dependency: ['clickup_add_task_dependency'],
  clickup_delete_dependency: ['clickup_remove_task_dependency'],
  clickup_delete_task_link: ['clickup_remove_task_link'],
  clickup_create_task_attachment: ['clickup_attach_task_file', 'clickup_request_attachment_upload'],
  clickup_get_list_custom_fields: ['clickup_get_custom_fields'],
  clickup_get_folder_custom_fields: ['clickup_get_custom_fields'],
  clickup_get_space_custom_fields: ['clickup_get_custom_fields'],
  clickup_get_workspace_custom_fields: ['clickup_get_custom_fields'],
  // Comments
  clickup_create_list_comment: ['clickup_create_comment'],
  clickup_create_threaded_comment: ['clickup_create_comment'],
  clickup_create_chat_view_comment: ['clickup_create_comment'],
  // Hierarchy and people
  clickup_get_spaces: ['clickup_get_workspace_hierarchy'],
  clickup_get_folders: ['clickup_get_workspace_hierarchy'],
  clickup_get_lists: ['clickup_get_workspace_hierarchy'],
  clickup_get_folderless_lists: ['clickup_get_workspace_hierarchy'],
  clickup_create_folderless_list: ['clickup_create_list'],
  clickup_get_authorized_user: ['clickup_get_user'],
  clickup_get_authorized_workspaces: ['clickup_get_user', 'clickup_get_workspace_hierarchy'],
  clickup_get_workspace_user: ['clickup_get_workspace_members', 'clickup_find_member_by_name'],
  clickup_get_list_members: ['clickup_get_workspace_members'],
  clickup_get_task_members: ['clickup_get_workspace_members'],
  // Views and statuses go through the operator catalog
  clickup_get_view: ['clickup_execute_operator'],
  clickup_update_view: ['clickup_execute_operator'],
  clickup_get_workspace_views: ['clickup_execute_operator'],
  clickup_get_space_views: ['clickup_execute_operator'],
  clickup_get_folder_views: ['clickup_execute_operator'],
  clickup_get_list_views: ['clickup_execute_operator'],
  clickup_create_workspace_view: ['clickup_execute_operator'],
  clickup_create_space_view: ['clickup_execute_operator'],
  clickup_create_folder_view: ['clickup_execute_operator'],
  clickup_create_list_view: ['clickup_execute_operator'],
  // Time tracking
  clickup_create_time_entry: ['clickup_add_time_entry'],
  clickup_start_time_entry: ['clickup_start_time_tracking'],
  clickup_stop_time_entry: ['clickup_stop_time_tracking'],
  clickup_get_running_time_entry: ['clickup_get_current_time_entry'],
  // Docs
  clickup_search_docs: ['clickup_search'],
  clickup_create_doc: ['clickup_create_document'],
  clickup_get_doc_page_listing: ['clickup_list_document_pages'],
  clickup_get_doc_pages: ['clickup_get_document_pages'],
  clickup_get_doc_page: ['clickup_get_document_pages'],
  clickup_create_doc_page: ['clickup_create_document_page'],
  clickup_edit_doc_page: ['clickup_update_document_page'],
  // Chat
  clickup_get_chat_messages: ['clickup_get_chat_channel_messages'],
  clickup_create_chat_message: ['clickup_send_chat_message'],
  clickup_create_chat_reply: ['clickup_send_chat_message'],
  clickup_create_direct_message_chat_channel: ['clickup_send_chat_message'],
  clickup_create_chat_reaction: ['clickup_react_to_chat_message'],
  clickup_delete_chat_reaction: ['clickup_react_to_chat_message'],
};

/**
 * REST-shaped arguments for an official tool: the JSON body's fields move to the top level, which is
 * where the official tools take them. Only when the official schema has no `body` of its own.
 */
export function flattenBody(args: Record<string, unknown>, tool: Pick<ToolDefinition, 'inputSchema'>): Record<string, unknown> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  const body = args.body;
  if ('body' in properties || !body || typeof body !== 'object' || Array.isArray(body)) return args;
  const { body: _, ...rest } = args;
  for (const [key, value] of Object.entries(body)) if (!(key in rest)) rest[key] = value;
  return rest;
}

export interface OfficialContext {
  token: string;
  fetch?: typeof fetch;
}

export class OfficialMcpError extends Error {}

const READ_NAME = /^clickup_(get|list|search|download|resolve|find)(_|$)/;

export function isReadOnlyOfficialTool(tool: Pick<ToolDefinition, 'name'> & { annotations?: { readOnlyHint?: boolean } }): boolean {
  return tool.annotations?.readOnlyHint ?? READ_NAME.test(tool.name);
}

async function withClient<T>(ctx: OfficialContext, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(OFFICIAL_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${ctx.token}` } },
    fetch: ctx.fetch ?? ((input, init) => fetch(input, init)),
  });
  const client = new Client({ name: 'clickup-mcp', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/401|unauthori[sz]ed|invalid_token/i.test(message)) {
      throw new OfficialMcpError(
        "ClickUp's official MCP server rejected this connection's sign-in. Reconnect this MCP server to sign in to ClickUp again.",
      );
    }
    throw new OfficialMcpError(`Could not reach ClickUp's official MCP server: ${message}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

interface OfficialTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

let cached: { at: number; tools: OfficialTool[] } | undefined;
const CACHE_MS = 30 * 60_000;

/** The official server's live tool list, or the last good one. Undefined when it was never reachable. */
async function listOfficial(ctx: OfficialContext): Promise<OfficialTool[] | undefined> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.tools;
  try {
    const listed = (await withClient(ctx, async (client) => (await client.listTools()).tools)) as OfficialTool[];
    const tools = [...listed].sort((a, b) => a.name.localeCompare(b.name));
    cached = { at: Date.now(), tools };
    return tools;
  } catch (error) {
    console.error('official tools/list failed', error instanceof Error ? error.message : error);
    return cached?.tools;
  }
}

function toDefinition(tool: OfficialTool, note?: string): ToolDefinition {
  const readOnly = isReadOnlyOfficialTool(tool);
  const title = tool.title ?? tool.annotations?.title ?? tool.name;
  return {
    name: tool.name,
    title,
    description: note ? `${tool.description ?? ''}\n\n${note}`.trim() : tool.description ?? '',
    inputSchema: tool.inputSchema,
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: tool.annotations?.destructiveHint ?? !readOnly,
      idempotentHint: tool.annotations?.idempotentHint ?? readOnly,
      openWorldHint: true,
    },
  };
}

/** Official tools with no REST-backed equivalent here, as advertised by the official server. */
export async function officialGapTools(ctx: OfficialContext, ownToolNames: Set<string>): Promise<ToolDefinition[]> {
  const tools = (await listOfficial(ctx)) ?? [];
  return tools
    .filter((tool) => !COVERED_BY_REST.has(tool.name) && !ownToolNames.has(tool.name))
    .map((tool) => toDefinition(tool, "Served by ClickUp's official MCP server (no public REST endpoint)."));
}

/**
 * Legacy aliases ClickUp keeps for old clients, left out of tools/list when the official tools stand
 * in for REST (calls to them still route). Keeps the list within clients that cap tool counts.
 */
const HIDDEN_ALIASES = new Set(['clickup_create_task_comment']);

/**
 * Every official tool, for connections whose REST access is refused. `listed` is what tools/list
 * advertises; `all` also has the hidden aliases, for routing.
 * @throws OfficialMcpError when the official server's list has never been reachable
 */
export async function officialToolset(ctx: OfficialContext): Promise<{ listed: ToolDefinition[]; all: ToolDefinition[] }> {
  const tools = await listOfficial(ctx);
  if (!tools) throw new OfficialMcpError("Could not load the tool list from ClickUp's official MCP server. Try again in a moment.");
  const all = tools.map((tool) => toDefinition(tool));
  return { listed: all.filter((tool) => !HIDDEN_ALIASES.has(tool.name)), all };
}

export function resetOfficialToolCache() {
  cached = undefined;
}

export async function callOfficialTool(ctx: OfficialContext, name: string, args: Record<string, unknown>) {
  return withClient(ctx, (client) => client.callTool({ name, arguments: args }));
}
