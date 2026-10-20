import { escapeHtml as escape, page } from './html';

export function landingPage(origin: string, toolCount: number, toolsets: string[]): string {
  const endpoint = `${origin}/mcp`;
  const claudeCode = `claude mcp add --transport http clickup ${endpoint}`;
  const claudeCodeToken = `claude mcp add --transport http clickup ${endpoint} \\
  --header "Authorization: Bearer pk_YOUR_TOKEN"`;
  const jsonConfig = JSON.stringify({ mcpServers: { clickup: { url: endpoint } } }, null, 2);
  const jsonConfigToken = JSON.stringify(
    { mcpServers: { clickup: { url: endpoint, headers: { Authorization: 'Bearer pk_YOUR_TOKEN' } } } },
    null,
    2,
  );

  return page(
    'ClickUp MCP',
    `<h1>ClickUp MCP</h1>
  <p>Remote MCP server for the entire public ClickUp REST API (v2 and v3): ${toolCount} tools for tasks, docs, chat, time tracking, goals, views, webhooks, guests, ACLs, audit logs and more. Things the public API can't do (keyword search across everything, reminders, doc page attachments, attachment downloads) pass through to ClickUp's official MCP server.</p>
  <p class="endpoint"><code>${escape(endpoint)}</code></p>

  <h2>Option 1: sign in with ClickUp (recommended)</h2>
  <p>Add the URL with no token. Your client opens a browser window to sign in to ClickUp and pick a workspace. This unlocks every tool, including the ones served by ClickUp's official MCP.</p>
  <p>Claude Code:</p>
  <pre><code>${escape(claudeCode)}</code></pre>
  <p>claude.ai and Claude Desktop: Settings → Connectors → Add custom connector, paste the URL.</p>
  <p>Cursor, Windsurf and other JSON-config clients:</p>
  <pre><code>${escape(jsonConfig)}</code></pre>

  <h2>Option 2: personal API token</h2>
  <p>For clients without OAuth support, or scripts. In ClickUp open <b>Settings → Apps → API Token</b> and copy the <code>pk_</code> token. Every REST tool works this way; the official-MCP pass-through tools don't, because ClickUp's MCP server only accepts its own sign-in.</p>
  <pre><code>${escape(claudeCodeToken)}</code></pre>
  <pre><code>${escape(jsonConfigToken)}</code></pre>
  <p>Clients that can't send headers can use <code>${escape(endpoint)}?token=pk_YOUR_TOKEN</code>. That URL is a credential.</p>

  <h2>URL options</h2>
  <table>
    <tr><td><code>?mode=compact</code></td><td>Expose helpers, pass-through tools and search/describe/call tools instead of every REST operation. Use it for clients with tool limits, such as Cursor.</td></tr>
    <tr><td><code>?readonly=1</code></td><td>Only expose tools that read.</td></tr>
    <tr><td><code>?toolsets=tasks,docs</code></td><td>Only expose these REST groups: ${toolsets.map((t) => `<code>${escape(t)}</code>`).join(', ')}.</td></tr>
    <tr><td><code>?workspace_id=123</code></td><td>Default workspace for tools that need one (also the <code>X-ClickUp-Workspace-Id</code> header). Without it the server uses your only workspace.</td></tr>
  </table>
  <p>Combine them: <code>${escape(endpoint)}?toolsets=tasks,comments&amp;readonly=1</code>.</p>

  <h2>Protocol</h2>
  <p>Streamable HTTP, MCP revision 2026-07-28 (stateless, no sessions); 2025-era clients are served through a stateless fallback. OAuth 2.1 with dynamic client registration and client ID metadata documents. The server stores only encrypted OAuth grants. Tool catalog: <a href="/tools.json">/tools.json</a>.</p>`,
  );
}
