import { FILE_INPUT_PROPERTIES, type Operation } from './operations';

export const API_ORIGIN = 'https://api.clickup.com';
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 8_000;

/** An error whose message is safe and useful to show the model. */
export class ToolError extends Error {}

export class ClickUpApiError extends ToolError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`ClickUp API returned ${status} for ${method} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

export interface RequestSpec {
  method: string;
  /** Absolute URL on api.clickup.com. */
  url: string;
  body?: BodyInit;
  contentType?: string;
}

export interface ClickUpContext {
  token: string;
  /** Workspace configured by the caller through the URL or a header. */
  defaultWorkspaceId?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function authorizationHeader(token: string): string {
  // Personal tokens go in raw; OAuth access tokens use the Bearer scheme.
  return token.startsWith('pk_') ? token : `Bearer ${token}`;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS);
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset * 1000 - Date.now();
    if (ms > 0) return Math.min(ms, MAX_RETRY_WAIT_MS);
  }
  return Math.min(500 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function clickupRequest(ctx: ClickUpContext, spec: RequestSpec): Promise<unknown> {
  const doFetch = ctx.fetch ?? fetch;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = new URL(spec.url);
  if (url.origin !== API_ORIGIN) throw new ToolError(`Refusing to call ${url.origin}; only ${API_ORIGIN} is allowed.`);

  const headers: Record<string, string> = {
    Authorization: authorizationHeader(ctx.token),
    Accept: 'application/json',
    'User-Agent': 'clickup-mcp (+https://github.com/xkrsz/clickup-mcp)',
  };
  if (spec.contentType) headers['Content-Type'] = spec.contentType;

  // GETs are safe to retry on 5xx. Anything is safe to retry on 429 because ClickUp rejected it before doing work.
  for (let attempt = 0; ; attempt++) {
    const response = await doFetch(url.toString(), { method: spec.method, headers, body: spec.body });
    const retryable = response.status === 429 || (spec.method === 'GET' && [502, 503, 504].includes(response.status));
    if (retryable && attempt < MAX_ATTEMPTS - 1 && !(spec.body instanceof ReadableStream)) {
      await response.body?.cancel();
      await sleep(retryDelay(response, attempt));
      continue;
    }
    const body = await parseBody(response);
    if (!response.ok) throw new ClickUpApiError(response.status, spec.method, url.pathname, body);
    return body;
  }
}

export function apiGet(ctx: ClickUpContext, path: string, query?: Record<string, string | string[] | undefined>) {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  return clickupRequest(ctx, { method: 'GET', url: url.toString() });
}

interface Workspace {
  id: string;
  name: string;
}

const workspaceCache = new Map<string, { at: number; workspaces: Workspace[] }>();
const WORKSPACE_CACHE_MS = 5 * 60_000;

async function cacheKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listWorkspaces(ctx: ClickUpContext): Promise<Workspace[]> {
  const key = await cacheKey(ctx.token);
  const cached = workspaceCache.get(key);
  if (cached && Date.now() - cached.at < WORKSPACE_CACHE_MS) return cached.workspaces;
  const result = (await apiGet(ctx, '/api/v2/team')) as { teams?: { id: string; name: string }[] };
  const workspaces = (result.teams ?? []).map((t) => ({ id: String(t.id), name: t.name }));
  workspaceCache.set(key, { at: Date.now(), workspaces });
  return workspaces;
}

export async function resolveWorkspaceId(ctx: ClickUpContext, explicit?: unknown): Promise<string> {
  if (explicit !== undefined && explicit !== null && explicit !== '') return String(explicit);
  if (ctx.defaultWorkspaceId) return ctx.defaultWorkspaceId;
  const workspaces = await listWorkspaces(ctx);
  if (workspaces.length === 1) return workspaces[0].id;
  if (workspaces.length === 0) throw new ToolError('This token has no ClickUp workspaces.');
  throw new ToolError(
    `This token can access ${workspaces.length} workspaces, so pass workspace_id/team_id explicitly: ${workspaces
      .map((w) => `${w.name} (${w.id})`)
      .join(', ')}.`,
  );
}

function queryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function fileFromArgs(args: Record<string, unknown>, doFetch: typeof fetch = fetch): Promise<File> {
  const filename = typeof args.filename === 'string' && args.filename ? args.filename : undefined;
  if (!filename) throw new ToolError('filename is required.');
  const sources = ['file_base64', 'file_text', 'file_url'].filter((k) => typeof args[k] === 'string' && args[k] !== '');
  if (sources.length !== 1) throw new ToolError('Provide exactly one of file_base64, file_text or file_url.');
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  let type = typeof args.content_type === 'string' ? args.content_type : MIME_TYPES[extension] ?? 'application/octet-stream';
  let bytes: Uint8Array<ArrayBuffer>;
  if (sources[0] === 'file_base64') {
    const base64 = String(args.file_base64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    try {
      bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    } catch {
      throw new ToolError('file_base64 is not valid base64.');
    }
  } else if (sources[0] === 'file_text') {
    bytes = new TextEncoder().encode(String(args.file_text));
    if (typeof args.content_type !== 'string' && !MIME_TYPES[extension]) type = 'text/plain';
  } else {
    const url = new URL(String(args.file_url));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ToolError('file_url must be http(s).');
    const response = await doFetch(url.toString());
    if (!response.ok) throw new ToolError(`Downloading file_url failed with ${response.status}.`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (typeof args.content_type !== 'string' && !MIME_TYPES[extension]) {
      type = response.headers.get('content-type')?.split(';')[0] ?? type;
    }
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new ToolError('File is larger than the 50 MB upload limit.');
  return new File([bytes], filename, { type });
}

export async function executeOperation(
  ctx: ClickUpContext,
  op: Operation,
  rawArgs: Record<string, unknown> | undefined,
): Promise<unknown> {
  const args = { ...(rawArgs ?? {}) };
  const known = new Set<string>(op.params.map((p) => p.prop));
  if (op.body?.type === 'json') known.add('body');
  if (op.body?.type === 'multipart') for (const key of Object.keys(FILE_INPUT_PROPERTIES)) known.add(key);

  // Models often flatten body fields to the top level. Fold them back into the body instead of failing.
  if (op.body?.type === 'json') {
    const stray = Object.keys(args).filter((key) => !known.has(key));
    if (stray.length) {
      const body = (args.body && typeof args.body === 'object' ? { ...(args.body as object) } : {}) as Record<string, unknown>;
      for (const key of stray) {
        if (!(key in body)) body[key] = args[key];
        delete args[key];
      }
      args.body = body;
    }
    if (typeof args.body === 'string') {
      try {
        args.body = JSON.parse(args.body);
      } catch {
        throw new ToolError('body must be a JSON object.');
      }
    }
  }

  let path = op.path;
  const url = new URL(op.base + '/');
  const query = url.searchParams;
  for (const param of op.params) {
    let value = args[param.prop];
    if (param.workspace) value = await resolveWorkspaceId(ctx, value);
    if (value === undefined || value === null || value === '') {
      if (param.required) throw new ToolError(`Missing required parameter "${param.prop}".`);
      continue;
    }
    if (param.in === 'path') {
      path = path.replace(`{${param.wire}}`, encodeURIComponent(queryValue(value)));
    } else if (param.array) {
      for (const item of Array.isArray(value) ? value : [value]) query.append(param.wire, queryValue(item));
    } else {
      query.append(param.wire, queryValue(value));
    }
  }
  url.pathname = new URL(op.base).pathname.replace(/\/$/, '') + path;

  const spec: RequestSpec = { method: op.method, url: url.toString() };
  if (op.body?.type === 'json') {
    spec.body = JSON.stringify(args.body ?? {});
    spec.contentType = 'application/json';
  } else if (op.body?.type === 'multipart') {
    const form = new FormData();
    const file = await fileFromArgs(args, ctx.fetch);
    // Both API versions take the file as "attachment"; v3 also reads the name from "filename".
    form.append('attachment', file, file.name);
    if (!op.base.endsWith('/api')) form.append('filename', file.name);
    spec.body = form;
  }
  return clickupRequest(ctx, spec);
}
