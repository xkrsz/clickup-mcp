import generated from './generated/operations.json';

export type JsonSchema = Record<string, unknown>;

export interface OperationParam {
  prop: string;
  wire: string;
  in: 'path' | 'query';
  required: boolean;
  workspace: boolean;
  array: boolean;
  schema: JsonSchema;
}

export interface Operation {
  name: string;
  operationId: string;
  title: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  base: string;
  path: string;
  toolset: string;
  params: OperationParam[];
  body?: { type: 'json'; required: boolean; schema: JsonSchema } | { type: 'multipart'; required: boolean };
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
}

export const operations = generated.operations as unknown as Operation[];
export const specVersions = generated.generatedFrom;
export const operationsByName = new Map(operations.map((op) => [op.name, op]));
export const toolsets = [...new Set(operations.map((op) => op.toolset))].sort();

// POST endpoints that only read.
const READ_ONLY_POSTS = new Set(['queryAuditLog']);

export function isReadOnly(op: Operation): boolean {
  return op.method === 'GET' || READ_ONLY_POSTS.has(op.operationId);
}

export const FILE_INPUT_PROPERTIES: Record<string, JsonSchema> = {
  filename: { type: 'string', description: 'File name to store in ClickUp, including the extension.' },
  file_base64: { type: 'string', description: 'File contents, base64 encoded. Provide exactly one of file_base64, file_text or file_url.' },
  file_text: { type: 'string', description: 'File contents as plain UTF-8 text.' },
  file_url: { type: 'string', description: 'Public URL the server downloads the file from.' },
  content_type: { type: 'string', description: 'MIME type. Defaults to one inferred from the file name.' },
};

const WORKSPACE_NOTE =
  'Workspace ID (ClickUp also calls it team_id). Optional: defaults to the workspace configured on the MCP URL, or to your only workspace.';

export function inputSchemaFor(op: Operation): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const param of op.params) {
    if (param.workspace) {
      properties[param.prop] = { ...param.schema, description: WORKSPACE_NOTE };
      continue;
    }
    properties[param.prop] = param.schema;
    if (param.required) required.push(param.prop);
  }
  if (op.body?.type === 'json') {
    properties.body = { ...op.body.schema, description: 'JSON request body sent to ClickUp.' };
    if (op.body.required && op.body.schema.required) required.push('body');
  } else if (op.body?.type === 'multipart') {
    Object.assign(properties, FILE_INPUT_PROPERTIES);
    required.push('filename');
  }
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

export function annotationsFor(op: Operation): ToolAnnotations {
  const readOnly = isReadOnly(op);
  return {
    title: op.title,
    readOnlyHint: readOnly,
    destructiveHint: op.method === 'DELETE' || /^clickup_(remove|delete)_/.test(op.name),
    idempotentHint: op.method !== 'POST' || readOnly,
    openWorldHint: true,
  };
}

export function toolFor(op: Operation): ToolDefinition {
  return {
    name: op.name,
    title: op.title,
    description: `${op.description}\n\nClickUp API: ${op.method} ${op.path}`,
    inputSchema: inputSchemaFor(op),
    annotations: annotationsFor(op),
  };
}

export const operationTools: ToolDefinition[] = operations.map(toolFor);
