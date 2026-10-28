# clickup-mcp

An MCP server that gives Claude (or any other MCP client) access to all of ClickUp: tasks, docs, chat, time tracking, goals, views, custom fields, webhooks, guests, and the rest of the public API. It runs on Cloudflare Workers.

ClickUp's official MCP server covers a subset of the API and is flaky in places. This one generates one tool per operation from ClickUp's own OpenAPI specs (v2 and v3), so it covers everything public, and passes the few things only the official server can do through to it.

There's a hosted instance at `https://clickupmcp.k22i.com/mcp` you can use right away, or you can run your own copy on a free Cloudflare account.

## Use the hosted server

You need a ClickUp account and an AI app that supports remote MCP servers ("connectors"). No install, no API keys.

### Claude (claude.ai or the Claude desktop app)

1. Open **Settings → Connectors**.
2. Click **Add custom connector**.
3. Name it `ClickUp` and paste this URL:
   ```
   https://clickupmcp.k22i.com/mcp
   ```
4. Click **Add**, then **Connect**. A browser window opens.
5. Click **Continue to ClickUp**, sign in, and pick the workspace Claude may use.
6. Back in a chat, ask something like "What's on my plate in ClickUp this week?"

On Team and Enterprise plans an organization owner may have to add the connector first.

### Claude Code

```sh
claude mcp add --transport http clickup https://clickupmcp.k22i.com/mcp
```

Then run `/mcp` inside Claude Code and pick `clickup` to sign in.

### Cursor, Windsurf and other apps with a JSON config

```json
{
  "mcpServers": {
    "clickup": { "url": "https://clickupmcp.k22i.com/mcp?mode=compact" }
  }
}
```

`mode=compact` keeps the tool list short for apps that cap the number of tools (Cursor does). See [URL options](#url-options).

Signing in gives you ClickUp's official MCP tools. ClickUp's REST API doesn't accept that sign-in, so the REST-backed tools need a personal token as well (below) or a [REST OAuth app](#optional-clickup-rest-oauth-app) on the server. See [When ClickUp's REST API refuses the sign-in](#when-clickups-rest-api-refuses-the-sign-in).

### Using a personal API token instead of signing in

For apps without OAuth sign-in, or for scripts. In ClickUp open **Settings → Apps → API Token** and copy the token that starts with `pk_`. Every REST tool works this way. The tools passed through to ClickUp's official server don't, because that server only accepts its own sign-in.

```sh
claude mcp add --transport http clickup https://clickupmcp.k22i.com/mcp \
  --header "Authorization: Bearer pk_YOUR_TOKEN"
```

```json
{
  "mcpServers": {
    "clickup": {
      "url": "https://clickupmcp.k22i.com/mcp",
      "headers": { "Authorization": "Bearer pk_YOUR_TOKEN" }
    }
  }
}
```

Apps that can't set headers can use `https://clickupmcp.k22i.com/mcp?token=pk_YOUR_TOKEN`. Treat that URL like a password.

### What the hosted server stores

Your ClickUp sign-in token is kept encrypted in Cloudflare KV, and only the token your AI app holds can decrypt it. Whether ClickUp's REST API accepts that token is cached for a day under a SHA-256 hash of it. Request URLs aren't logged, because they can contain `?token=`. Your ClickUp data passes through the Worker on its way to your AI app. If you'd rather it pass through your own infrastructure, [self-host](#self-host).

## URL options

Add these to the server URL. Combine them with `&`, for example `https://clickupmcp.k22i.com/mcp?toolsets=tasks,comments&readonly=1`.

| Option | Effect |
| --- | --- |
| `?mode=compact` | Helpers plus `clickup_search_operations` / `clickup_describe_operation` / `clickup_call_operation` instead of one tool per operation (about 170). For apps that cap tool counts. |
| `?readonly=1` | Only operations that read. `clickup_api_request` refuses anything but GET. |
| `?toolsets=tasks,docs` | Only these operation groups. The landing page at `/` lists them. |
| `?workspace_id=123` | Default workspace (also the `X-ClickUp-Workspace-Id` header). Without it, a token with one workspace uses that one. |

The full catalog is about 57k tokens of tool definitions. Claude Code and claude.ai load MCP tools on demand, so that's fine there. For other apps consider `mode=compact` or `toolsets`.

## Tools

Every public ClickUp REST operation is a tool: checklists, custom field values, goals and key results, views, webhooks, guests, user groups, templates, spaces and tags, time tracking, docs, chat, ACLs, audit logs, and the v3 task move. On top of that there are five hand-written helpers:

| Tool | What it does |
| --- | --- |
| `clickup_list_workspaces` | Workspaces the token can access |
| `clickup_get_workspace_hierarchy` | Spaces, Folders and Lists as one tree |
| `clickup_search_tasks` | Text search over tasks. ClickUp has no public search endpoint, so it pages the filtered task list and matches locally |
| `clickup_find_members` | Member lookup by name, email or initials |
| `clickup_api_request` | Raw call to any `/v2/` or `/v3/` endpoint |

Some features exist only in ClickUp's official MCP server, with no public REST endpoint. When you connect by signing in, those tools pass through to `mcp.clickup.com`:

| Official tool | What it does |
| --- | --- |
| `clickup_search` | Keyword search across tasks, docs, chat, whiteboards, dashboards and attachments |
| `clickup_create_reminder`, `clickup_search_reminders`, `clickup_update_reminder` | Personal reminders |
| `clickup_list_document_page_attachments`, `clickup_download_document_page_attachment` | Files embedded in doc pages |
| `clickup_download_task_attachment` | Signed download URL, including for private attachments |
| `clickup_request_attachment_upload` | Upload ticket for large local files |
| `clickup_get_operators`, `clickup_execute_operator`, `clickup_get_schema` | ClickUp's Unified API operator catalog |

The pass-through list comes from the official server's live `tools/list` minus the tools in `COVERED_BY_REST` (`src/official.ts`), so new official-only tools show up without a deploy.

### When ClickUp's REST API refuses the sign-in

ClickUp's REST API doesn't accept tokens from the official MCP's sign-in. It answers `401 {"err":"Oauth token not found","ECODE":"OAUTH_019"}`. So on a connection that signed in, with no personal token and no [REST OAuth app](#optional-clickup-rest-oauth-app), every REST-backed tool would fail. The server checks once per token with `GET /api/v2/user` (at sign-in, or on the first request for older grants) and caches the answer for 24 hours. When REST says no, `tools/list` returns the official server's tools instead of the REST-backed ones, in every mode (`mode=compact` too, since the official list is short; `toolsets` doesn't apply). `readonly=1` still filters writes. The legacy alias `clickup_create_task_comment` stays out of the list but still works.

Calls to REST tool names from a list pinned before the switch go to the official tool of the same name, with `body` fields moved to the top level. Other REST names return an error that names the official replacement. Here's how the REST tools map:

| Job | REST tool (personal token or REST OAuth) | Official tool (sign-in only) |
| --- | --- | --- |
| Tasks | `clickup_create_task`, `clickup_get_task`, `clickup_update_task`, `clickup_delete_task`, `clickup_move_task`, `clickup_merge_tasks`, `clickup_add_task_to_list`, `clickup_remove_task_from_list` | Same names |
| Find tasks | `clickup_search_tasks`, `clickup_get_tasks`, `clickup_get_workspace_tasks`, `clickup_get_view_tasks` | `clickup_search`, `clickup_filter_tasks` |
| Task links | `clickup_add_task_link`, `clickup_delete_task_link` | `clickup_add_task_link`, `clickup_remove_task_link` |
| Dependencies | `clickup_add_dependency`, `clickup_delete_dependency` | `clickup_add_task_dependency`, `clickup_remove_task_dependency` |
| Tags | `clickup_add_tag_to_task`, `clickup_remove_tag_from_task`, `clickup_create_space_tag` | Same names |
| Comments | `clickup_create_task_comment`, `clickup_create_list_comment`, `clickup_create_threaded_comment`, `clickup_get_task_comments`, `clickup_get_threaded_comments`, `clickup_update_comment`, `clickup_delete_comment` | `clickup_create_comment`, then the same names |
| People | `clickup_find_members`, `clickup_get_workspace_user`, `clickup_get_list_members`, `clickup_get_task_members`, `clickup_get_authorized_user` | `clickup_find_member_by_name`, `clickup_get_workspace_members`, `clickup_resolve_assignees`, `clickup_get_user` |
| Hierarchy | `clickup_get_workspace_hierarchy`, `clickup_get_spaces`, `clickup_get_folders`, `clickup_get_lists`, `clickup_get_folder`, `clickup_get_list` | `clickup_get_workspace_hierarchy`, `clickup_get_folder`, `clickup_get_list` |
| Lists and Folders | `clickup_create_folderless_list`, `clickup_create_list` (in a Folder), `clickup_update_list`, `clickup_create_folder`, `clickup_update_folder` | `clickup_create_list` (in a Space), `clickup_create_list_in_folder`, then the same names |
| Custom fields | `clickup_get_list_custom_fields` and the folder, space and workspace variants | `clickup_get_custom_fields` |
| Time | `clickup_create_time_entry`, `clickup_start_time_entry`, `clickup_stop_time_entry`, `clickup_get_running_time_entry`, `clickup_get_time_entries`, `clickup_get_task_time_in_status`, `clickup_get_bulk_tasks_time_in_status` | `clickup_add_time_entry`, `clickup_start_time_tracking`, `clickup_stop_time_tracking`, `clickup_get_current_time_entry`, then the same names |
| Attachments | `clickup_create_task_attachment` | `clickup_attach_task_file`, `clickup_request_attachment_upload` |
| Docs | `clickup_create_doc`, `clickup_get_doc_page_listing`, `clickup_get_doc_pages`, `clickup_create_doc_page`, `clickup_edit_doc_page`, `clickup_search_docs` | `clickup_create_document`, `clickup_list_document_pages`, `clickup_get_document_pages`, `clickup_create_document_page`, `clickup_update_document_page`, `clickup_search` |
| Chat | `clickup_get_chat_channels`, `clickup_get_chat_messages`, `clickup_get_chat_message_replies`, `clickup_create_chat_message`, `clickup_create_chat_reply`, `clickup_update_chat_message`, reactions | `clickup_get_chat_channels`, `clickup_get_chat_channel_messages`, `clickup_get_chat_message_replies`, `clickup_send_chat_message`, `clickup_update_chat_message`, `clickup_react_to_chat_message` |
| Views, statuses, bulk task changes, archiving, forms, creating custom fields | View tools, `clickup_update_space`, `clickup_api_request` | `clickup_execute_operator` (list the operations with `clickup_get_operators`) |

Nothing official covers checklists, goals, webhooks, guests and invites, user groups, templates, deleting Spaces, Folders or Lists, editing or deleting time entries, custom roles and task types, plan and seats, audit logs, ACLs, the shared hierarchy, or raw `clickup_api_request` calls. For those, the connection needs a token REST accepts: a personal token on the URL (`?token=pk_...`, which takes over all REST calls) or the REST OAuth app below.

## Self-host

You need Node.js 22 or newer and a Cloudflare account. The free Workers plan is enough.

```sh
git clone https://github.com/xkrsz/clickup-mcp.git
cd clickup-mcp
npm install
npx wrangler login
npm run deploy
```

The first deploy creates the `OAUTH_KV` namespace and prints your URL, something like `https://clickup-mcp.<your-subdomain>.workers.dev`. Your MCP endpoint is that plus `/mcp`. Open the base URL in a browser to get a landing page with copy-paste setup for that address.

Then set a consent secret, so people who already approved a client aren't asked again on every sign-in:

```sh
openssl rand -hex 32 | npx wrangler secret put CONSENT_SECRET
```

The server works without it. It just shows the consent screen every time.

Nothing else needs configuring. The Worker registers itself with ClickUp's OAuth server on first sign-in (dynamic client registration), so there's no ClickUp app to create and no client secret to manage. OAuth tokens are bound to whichever hostname the request came in on, so workers.dev and custom domains both work.

### Optional: ClickUp REST OAuth app

Without it, signed-in connections get [the official tools only](#when-clickups-rest-api-refuses-the-sign-in). With it, sign-in continues to ClickUp's own OAuth screen after the official one, and the REST tools work too.

1. In ClickUp (as a Workspace owner or admin) open **Settings → Apps → Create new app**.
2. Set the redirect URL to `https://<your-host>/oauth/callback/rest`, for example `https://clickupmcp.k22i.com/oauth/callback/rest`.
3. Store the client ID and secret:
   ```sh
   npx wrangler secret put CLICKUP_CLIENT_ID
   npx wrangler secret put CLICKUP_CLIENT_SECRET
   ```
   Add `--config wrangler.local.jsonc` if you deploy with one.

People then pick workspaces twice: once for the official MCP, once for the REST app. Declining the second screen still finishes the sign-in, with the official tools only. Existing connections keep their old grant until they reconnect. ClickUp's REST OAuth tokens don't expire, but the grant still ends when the official token does.

### Custom domain, or a specific Cloudflare account

Keep deployment-specific settings out of the committed `wrangler.jsonc` by copying it to `wrangler.local.jsonc` (gitignored). `npm run deploy` uses that file when it exists.

```jsonc
{
  // ...everything from wrangler.jsonc, plus:
  "account_id": "your-cloudflare-account-id",
  "routes": [{ "pattern": "clickup.example.com", "custom_domain": true }],
  // Pin the namespace so a fresh checkout doesn't create a new one and lose existing sign-ins.
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "your-kv-namespace-id" }]
}
```

The domain has to be a zone on the same Cloudflare account.

## How it works

- `spec/` holds ClickUp's OpenAPI files. `scripts/generate.mjs` turns them into `src/generated/operations.json`: refs inlined, examples dropped, readable snake_case names, workspace path params made optional, and a few spec mistakes corrected against the live API.
- Tool arguments: path and query params are top-level, the JSON body goes in `body`. Body fields passed at the top level are folded into `body`. Array query params are sent the way ClickUp expects (`statuses[]=a&statuses[]=b`, `task_ids=a&task_ids=b`). Custom Field filters are JSON-encoded.
- File uploads (`clickup_create_task_attachment`, `clickup_create_entity_attachment`) take `filename` plus one of `file_base64`, `file_text` or `file_url`.
- 429s are retried using ClickUp's rate-limit reset header. GET 5xx responses are retried. Writes are never retried after a 5xx.
- Transport is Streamable HTTP on MCP revision 2026-07-28 (stateless, `server/discover`, no sessions) via `createMcpHandler` from `@modelcontextprotocol/server` 2.x. 2025-era clients that still send `initialize` get the SDK's stateless fallback.
- Sign-in: the Worker is an OAuth 2.1 authorization server (`@cloudflare/workers-oauth-provider`, with dynamic client registration and client ID metadata documents). Its consent page sends you to the OAuth server of ClickUp's official MCP as a public client with PKCE. The ClickUp token it gets back is stored encrypted in the grant's props in KV, and only the MCP client's token can decrypt it. That token calls the official MCP server. ClickUp's REST API refuses it, so REST tools use, in order: a personal token on the URL or `X-ClickUp-Token` header, the token from the [REST OAuth app](#optional-clickup-rest-oauth-app) when one is configured, or nothing, in which case the official tools replace them (`src/rest-access.ts`).
- Worker invocation logs are off because request URLs can contain `?token=`.

## Development

```sh
npm install
npm run check          # typecheck, unit tests, MCP e2e for both protocol eras, full OAuth flow against a fake ClickUp
npm run dev            # wrangler dev on :8787
npm run deploy         # regenerate and deploy
npm run spec:update    # pull the latest ClickUp OpenAPI specs, then run generate
```

`npm run test:routes` calls every operation against the real API with an invalid token and checks that each one hits an existing, authenticated route rather than a 404. Set `CLICKUP_PROBE_WORKSPACE` to a real workspace ID, because v3 resolves the workspace before authenticating.

`scripts/live-test.mjs` goes further: it calls every exposed tool once against a deployment with a real token, in both full and compact mode.

```sh
CLICKUP_TOKEN=pk_... node scripts/live-test.mjs <workspace_id> <space_id> [mcp_url]
```

It creates a private "MCP live test" List with a Doc in the given Space and keeps them. Folders, tasks, views, goals, webhooks, chat channels and the temp Space it creates get deleted again. Invite, guest and user-edit tools only get invalid emails or nonexistent IDs, so ClickUp rejects them without touching real people. The per-call report goes to `$TMPDIR/clickup-live-test.json`. `scripts/mcp-call.mjs` calls a single tool the same way.

## License

MIT
