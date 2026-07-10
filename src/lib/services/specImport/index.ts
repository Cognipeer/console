/**
 * Spec Import & Normalization
 *
 * Turns a variety of API descriptions into a single canonical OpenAPI 3.0
 * JSON string that the MCP / Tool OpenAPI parsers can consume:
 *
 *   - OpenAPI / Swagger as JSON            → passed through (re-serialized)
 *   - OpenAPI / Swagger as YAML            → parsed and re-serialized to JSON
 *   - Postman Collection v2.x (JSON/YAML)  → converted to an OpenAPI 3.0 spec
 *
 * Auto-detection is used by default; callers may pass a hint to disambiguate.
 * The whole pipeline is pure (no network) so it is safe to run server-side on
 * user-supplied content.
 */

import YAML from 'yaml';
import slugify from 'slugify';

export type SpecFormatHint = 'auto' | 'openapi' | 'postman';
export type DetectedFormat = 'openapi-json' | 'openapi-yaml' | 'postman';

export interface NormalizeResult {
  /** Canonical OpenAPI 3.0 specification serialized as JSON. */
  openApiJson: string;
  /** How the input was interpreted. */
  detectedFormat: DetectedFormat;
}

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };

// ── Flexible parsing (JSON first, then YAML) ────────────────────────────────

function parseFlexible(raw: string): { obj: Record<string, unknown>; wasYaml: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Specification is empty');
  }

  // JSON is a strict subset of YAML, but parse it directly first so we can
  // report the source format accurately and give crisp JSON errors.
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object') return { obj, wasYaml: false };
  } catch {
    // fall through to YAML
  }

  try {
    const obj = YAML.parse(trimmed);
    if (obj && typeof obj === 'object') return { obj: obj as Record<string, unknown>, wasYaml: true };
    throw new Error('Specification did not parse to an object');
  } catch (err) {
    throw new Error(
      `Could not parse specification as JSON or YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Detection ───────────────────────────────────────────────────────────────

function looksLikePostman(obj: Record<string, unknown>): boolean {
  if (Array.isArray(obj.item)) {
    const info = obj.info as Record<string, unknown> | undefined;
    if (info) {
      if (info._postman_id) return true;
      if (typeof info.schema === 'string' && info.schema.includes('getpostman.com')) return true;
    }
    // A top-level `item` array with no OpenAPI markers is almost certainly Postman.
    if (!obj.openapi && !obj.swagger && !obj.paths) return true;
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function normalizeApiSpec(raw: string, hint: SpecFormatHint = 'auto'): NormalizeResult {
  const { obj, wasYaml } = parseFlexible(raw);

  const isPostman =
    hint === 'postman' || (hint === 'auto' && looksLikePostman(obj));

  if (isPostman) {
    const spec = convertPostmanToOpenApi(obj);
    return { openApiJson: JSON.stringify(spec), detectedFormat: 'postman' };
  }

  // OpenAPI / Swagger path.
  if (!obj.openapi && !obj.swagger && !obj.paths) {
    throw new Error(
      'Unrecognized specification: expected an OpenAPI/Swagger document (with "openapi"/"swagger"/"paths") or a Postman collection (with "item").',
    );
  }

  return {
    openApiJson: JSON.stringify(obj),
    detectedFormat: wasYaml ? 'openapi-yaml' : 'openapi-json',
  };
}

// ── Postman → OpenAPI conversion ────────────────────────────────────────────

interface PostmanUrlObject {
  raw?: string;
  protocol?: string;
  host?: string[] | string;
  path?: Array<string | { value?: string }> | string;
  query?: Array<{ key?: string; value?: string; description?: string; disabled?: boolean }>;
  variable?: Array<{ key?: string; value?: string; description?: string }>;
}

interface PostmanRequest {
  method?: string;
  url?: PostmanUrlObject | string;
  description?: string;
  header?: Array<{ key?: string; value?: string; description?: string; disabled?: boolean }>;
  body?: {
    mode?: string;
    raw?: string;
    options?: { raw?: { language?: string } };
  };
}

interface PostmanItem {
  name?: string;
  description?: string;
  item?: PostmanItem[];
  request?: PostmanRequest | string;
}

type OpenApiOperation = Record<string, unknown>;

function resolveVariables(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{([^}]+)\}\}/g, (match, name) => {
    const key = String(name).trim();
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}

function normalizeUrl(
  url: PostmanUrlObject | string | undefined,
  vars: Record<string, string>,
): { baseUrl: string; path: string; query: Array<{ key: string; value?: string; description?: string }>; pathVars: Record<string, string | undefined> } {
  const pathVars: Record<string, string | undefined> = {};
  const query: Array<{ key: string; value?: string; description?: string }> = [];

  const obj: PostmanUrlObject =
    typeof url === 'string' ? { raw: url } : url ?? {};

  // Collect declared path-variable descriptions.
  for (const v of obj.variable ?? []) {
    if (v.key) pathVars[v.key] = v.description;
  }
  for (const q of obj.query ?? []) {
    if (q.key && !q.disabled) query.push({ key: q.key, value: q.value, description: q.description });
  }

  // Determine host/protocol.
  let baseUrl = '';
  let segments: string[] = [];

  const hostStr = Array.isArray(obj.host) ? obj.host.join('.') : obj.host;
  if (hostStr) {
    // A host segment can be a `{{baseUrl}}` variable that already resolves to a
    // full origin (scheme + host); only prepend a protocol when it is absent.
    const resolvedHost = resolveVariables(hostStr, vars).replace(/\/+$/, '');
    baseUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(resolvedHost)
      ? resolvedHost
      : `${obj.protocol || 'https'}://${resolvedHost}`;
    const rawSegs = Array.isArray(obj.path)
      ? obj.path.map((s) => (typeof s === 'string' ? s : s?.value ?? ''))
      : typeof obj.path === 'string'
        ? obj.path.split('/')
        : [];
    segments = rawSegs.filter((s) => s !== '');
  } else if (obj.raw) {
    // Parse the raw URL string (may contain {{vars}}).
    const resolved = resolveVariables(obj.raw, vars);
    const withoutQuery = resolved.split('?')[0];
    try {
      const u = new URL(withoutQuery);
      baseUrl = `${u.protocol}//${u.host}`;
      segments = u.pathname.split('/').filter((s) => s !== '');
    } catch {
      // Relative or template base (e.g. "{{baseUrl}}/users/:id" left unresolved).
      const parts = withoutQuery.split('/').filter((s) => s !== '');
      // First segment is treated as the base if it still looks like a host/template.
      if (parts.length && (parts[0].includes('{{') || parts[0].includes('.') || parts[0].includes('://'))) {
        baseUrl = parts.shift() ?? '';
      }
      segments = parts;
    }
  }

  // Convert `:param` segments to `{param}` and register path params.
  const pathSegments = segments.map((seg) => {
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      if (!(name in pathVars)) pathVars[name] = undefined;
      return `{${name}}`;
    }
    return seg;
  });

  const path = '/' + pathSegments.join('/');
  return { baseUrl, path: path === '/' ? '/' : path, query, pathVars };
}

function buildRequestBodySchema(body: PostmanRequest['body']): Record<string, unknown> | undefined {
  if (!body || !body.raw) return undefined;
  const lang = body.options?.raw?.language;
  if (body.mode !== 'raw') return { type: 'object', description: 'Request body' };

  if (lang === 'json' || !lang) {
    try {
      const parsed = JSON.parse(body.raw);
      const example = parsed;
      const schema: Record<string, unknown> = { type: 'object', description: 'Request body' };
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        schema.properties = Object.fromEntries(
          Object.keys(parsed).map((k) => [k, { type: inferJsonType((parsed as Record<string, unknown>)[k]) }]),
        );
      }
      schema.example = example;
      return schema;
    } catch {
      return { type: 'string', description: 'Raw request body' };
    }
  }
  return { type: 'string', description: 'Raw request body' };
}

function inferJsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'string';
  switch (typeof value) {
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

export function convertPostmanToOpenApi(collection: Record<string, unknown>): Record<string, unknown> {
  const info = (collection.info as Record<string, unknown>) || {};
  const title = (info.name as string) || 'Imported Postman Collection';
  const description = (info.description as string) || undefined;

  // Collection-level variables for {{var}} resolution.
  const vars: Record<string, string> = {};
  for (const v of (collection.variable as Array<{ key?: string; value?: string }>) ?? []) {
    if (v.key) vars[v.key] = v.value ?? '';
  }

  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  const baseUrlCounts = new Map<string, number>();
  const usedOperationIds = new Set<string>();

  const walk = (items: PostmanItem[] | undefined, folderPrefix: string) => {
    for (const item of items ?? []) {
      if (item.item) {
        walk(item.item, folderPrefix ? `${folderPrefix} / ${item.name ?? ''}` : item.name ?? '');
        continue;
      }
      const request: PostmanRequest | undefined =
        typeof item.request === 'string' ? { url: item.request, method: 'GET' } : item.request;
      if (!request) continue;

      const method = (request.method || 'GET').toLowerCase();
      const { baseUrl, path, query, pathVars } = normalizeUrl(request.url, vars);
      if (baseUrl) baseUrlCounts.set(baseUrl, (baseUrlCounts.get(baseUrl) ?? 0) + 1);

      const parameters: Array<Record<string, unknown>> = [];
      for (const [name, desc] of Object.entries(pathVars)) {
        parameters.push({
          name,
          in: 'path',
          required: true,
          description: desc || `Path parameter: ${name}`,
          schema: { type: 'string' },
        });
      }
      for (const q of query) {
        parameters.push({
          name: q.key,
          in: 'query',
          required: false,
          description: q.description || `Query parameter: ${q.key}`,
          schema: { type: 'string' },
          ...(q.value ? { example: q.value } : {}),
        });
      }

      const operation: OpenApiOperation = {
        summary: item.name || `${method.toUpperCase()} ${path}`,
        description: item.description || request.description || undefined,
        operationId: uniqueOperationId(method, item.name || path, usedOperationIds),
        ...(parameters.length ? { parameters } : {}),
      };

      if (['post', 'put', 'patch', 'delete'].includes(method)) {
        const schema = buildRequestBodySchema(request.body);
        if (schema) {
          operation.requestBody = {
            required: false,
            content: { 'application/json': { schema } },
          };
        }
      }

      if (!paths[path]) paths[path] = {};
      // Avoid clobbering when two requests share a method+path.
      if (paths[path][method]) {
        const altPath = `${path}#${Object.keys(paths).length}`;
        paths[altPath] = { [method]: operation };
      } else {
        paths[path][method] = operation;
      }
    }
  };

  walk(collection.item as PostmanItem[], '');

  // Pick the most common base URL as the server.
  let serverUrl = '';
  let best = 0;
  for (const [url, count] of baseUrlCounts) {
    if (count > best) {
      best = count;
      serverUrl = url;
    }
  }

  const spec: Record<string, unknown> = {
    openapi: '3.0.0',
    info: {
      title,
      version: '1.0.0',
      ...(description ? { description } : {}),
    },
    paths,
  };
  if (serverUrl) spec.servers = [{ url: serverUrl }];

  return spec;
}

function uniqueOperationId(method: string, name: string, used: Set<string>): string {
  const base = slugify(`${method}_${name}`, SLUG_OPTIONS) || `${method}_op`;
  let candidate = base;
  let i = 1;
  while (used.has(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}
