// Pass-through to ClickUp's official MCP server for capabilities the public REST API lacks
// (universal search, reminders, doc page attachments, signed attachment downloads, the operator
// catalog). The official server only accepts tokens from its own OAuth server, so these tools
// exist only on connections that signed in through /authorize.
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

let cached: { at: number; tools: ToolDefinition[] } | undefined;
const CACHE_MS = 30 * 60_000;

/** Official tools with no REST-backed equivalent here, as advertised by the official server. */
export async function officialGapTools(ctx: OfficialContext, ownToolNames: Set<string>): Promise<ToolDefinition[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.tools.filter((t) => !ownToolNames.has(t.name));
  try {
    const listed = await withClient(ctx, async (client) => (await client.listTools()).tools);
    const tools = listed
      .filter((tool) => !COVERED_BY_REST.has(tool.name))
      .map((tool) => {
        const readOnly = isReadOnlyOfficialTool(tool);
        return {
          name: tool.name,
          title: tool.title ?? tool.annotations?.title ?? tool.name,
          description: `${tool.description ?? ''}\n\nServed by ClickUp's official MCP server (no public REST endpoint).`.trim(),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          annotations: {
            title: tool.title ?? tool.annotations?.title ?? tool.name,
            readOnlyHint: readOnly,
            destructiveHint: tool.annotations?.destructiveHint ?? !readOnly,
            idempotentHint: tool.annotations?.idempotentHint ?? readOnly,
            openWorldHint: true,
          },
        } satisfies ToolDefinition;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    cached = { at: Date.now(), tools };
    return tools.filter((t) => !ownToolNames.has(t.name));
  } catch (error) {
    console.error('official tools/list failed', error instanceof Error ? error.message : error);
    return cached?.tools.filter((t) => !ownToolNames.has(t.name)) ?? [];
  }
}

export function resetOfficialToolCache() {
  cached = undefined;
}

export async function callOfficialTool(ctx: OfficialContext, name: string, args: Record<string, unknown>) {
  return withClient(ctx, (client) => client.callTool({ name, arguments: args }));
}
