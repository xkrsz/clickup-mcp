// Calls one tool on a ClickUp MCP deployment. Usage:
//   CLICKUP_TOKEN=pk_... node scripts/mcp-call.mjs <tool> '<json args>' [url]
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [name, json = '{}', url = 'https://clickupmcp.k22i.com/mcp'] = process.argv.slice(2);
if (!process.env.CLICKUP_TOKEN) throw new Error('Set CLICKUP_TOKEN');
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.CLICKUP_TOKEN}` } },
});
const client = new Client({ name: 'mcp-call', version: '1' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(transport);
const result = await client.callTool({ name, arguments: JSON.parse(json) });
console.log(result.isError ? 'ERROR:' : 'OK:', result.content?.[0]?.text);
await client.close();
