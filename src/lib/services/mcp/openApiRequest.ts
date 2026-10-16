/**
 * Request builder for OpenAPI-sourced MCP tools.
 *
 * Turns a tool's `httpPath` template plus the caller's `tools/call` arguments
 * into the upstream URL (and body). Pure — no DB, no network — so the rules
 * below are unit-testable on their own:
 *
 *  - `{placeholders}` are filled in the path template ONLY. The configured
 *    upstream base URL is used as stored; it is never templated.
 *  - Only arguments the tool declares are forwarded: the properties of its
 *    `inputSchema` (which is where the importers list path, query and body
 *    parameters), the parameters its operation declares in the spec by
 *    reference or on the path item, and every placeholder named by the path.
 *    Anything else the caller sent is dropped.
 *  - A path parameter must be a non-empty scalar. A value that would read as a
 *    relative path segment (`.` / `..`, also percent-decoded once, also after
 *    `\\`), or that carries control characters, is refused.
 *  - The finished URL is parsed again and must still sit on the base URL's
 *    origin, under the base path plus the static head of the template.
 *
 * Problems with the caller's arguments throw `McpToolInputError`, whose message
 * is safe to hand back to any caller. A broken server configuration (no usable
 * base URL) throws a plain `Error`.
 */

import { McpToolInputError } from './errors';

/** `{name}` in a path template. Braces never nest inside a name. */
const PLACEHOLDER = /\{([^{}]+)\}/g;
/** Anything left after substitution that still looks like a placeholder. */
const UNRESOLVED_PLACEHOLDER = /\{[^{}]*\}/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PATH_SEPARATORS = /[\\/]/;

export interface OpenApiRequestInput {
  /** The server's stored upstream base URL, used verbatim. */
  baseUrl: string | undefined;
  /** The tool's path template, e.g. `/users/{id}/orders`. */
  httpPath: string;
  /** The tool's `inputSchema` — its `properties` are the declared arguments. */
  inputSchema?: Record<string, unknown>;
  /**
   * More parameter names the operation declares (see `openApiSpecParameters`):
   * those written by reference or on the path item are not in the schema.
   */
  declaredNames?: readonly string[];
  args: Record<string, unknown> | undefined;
}

export interface OpenApiRequest {
  url: string;
  /**
   * The caller's `body` argument, present only when the tool declares one and
   * the caller sent a value. Whether the HTTP method carries a body is the
   * executor's call.
   */
  body?: unknown;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** Names of the path template's placeholders, in order of appearance. */
export function pathPlaceholderNames(httpPath: string): string[] {
  return [...httpPath.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

function declaredProperties(inputSchema: Record<string, unknown> | undefined): string[] {
  const properties = inputSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties as Record<string, unknown>);
}

function decodeOnce(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function hasDotSegment(value: string): boolean {
  return value.split(PATH_SEPARATORS).some((segment) => segment === '.' || segment === '..');
}

/**
 * The string to substitute for one path placeholder, before percent-encoding.
 * Refuses a missing, non-scalar or empty value, a control character, and a
 * dot segment in the value or in its once-percent-decoded form.
 */
function pathParameterValue(name: string, value: unknown): string {
  if (value === undefined || value === null) {
    throw new McpToolInputError(`Missing required path parameter "${name}"`);
  }
  if (
    typeof value !== 'string'
    && typeof value !== 'number'
    && typeof value !== 'boolean'
    && typeof value !== 'bigint'
  ) {
    throw new McpToolInputError(`Path parameter "${name}" must be a string, number or boolean`);
  }
  const raw = String(value);
  if (raw.length === 0) {
    throw new McpToolInputError(`Missing required path parameter "${name}"`);
  }

  const decoded = decodeOnce(raw);
  const spellings = decoded !== undefined && decoded !== raw ? [raw, decoded] : [raw];
  for (const spelling of spellings) {
    if (CONTROL_CHARS.test(spelling) || hasDotSegment(spelling)) {
      throw new McpToolInputError(`Invalid value for path parameter "${name}"`);
    }
  }
  return raw;
}

function encodePathParameter(name: string, value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    // A lone surrogate cannot be percent-encoded.
    throw new McpToolInputError(`Invalid value for path parameter "${name}"`);
  }
}

function substitutePath(template: string, args: Record<string, unknown>): string {
  const path = template.replace(PLACEHOLDER, (_match, name: string) =>
    encodePathParameter(name, pathParameterValue(name, hasOwn(args, name) ? args[name] : undefined)));
  if (UNRESOLVED_PLACEHOLDER.test(path)) {
    throw new McpToolInputError('Unresolved path parameter');
  }
  return path;
}

function parseBaseUrl(baseUrl: string | undefined): URL {
  if (!baseUrl || /[{}]/.test(baseUrl)) {
    // A configuration problem, not a caller one: the base URL is stored as the
    // operator saved it and is never filled in from tool arguments.
    throw new Error('The upstream base URL is not configured as a complete URL');
  }
  try {
    return new URL(baseUrl);
  } catch {
    throw new Error('The upstream base URL is not a valid URL');
  }
}

/**
 * Build the upstream request for one tool call. See the module comment for the
 * rules; throws `McpToolInputError` when the arguments break them.
 */
export function buildOpenApiRequest(input: OpenApiRequestInput): OpenApiRequest {
  const base = parseBaseUrl(input.baseUrl);
  const baseUrl = input.baseUrl as string;
  const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
    ? input.args
    : {};

  const placeholders = new Set(pathPlaceholderNames(input.httpPath));
  const schemaProperties = new Set(declaredProperties(input.inputSchema));
  const properties = new Set([...schemaProperties, ...(input.declaredNames ?? [])]);

  const path = substitutePath(input.httpPath, args);
  let url: URL;
  let requiredPrefix: string;
  try {
    url = new URL(`${baseUrl}${path}`);
    // The static head of the template, before its first placeholder.
    requiredPrefix = new URL(`${baseUrl}${input.httpPath.split('{', 1)[0]}`).pathname;
  } catch {
    throw new McpToolInputError('The request path is not valid');
  }

  // Defense in depth: whatever the values were, the result must still be the
  // operation the tool describes, on the host the operator configured.
  if (url.origin !== base.origin || !url.pathname.startsWith(requiredPrefix)) {
    throw new McpToolInputError('The request path resolves outside the configured operation');
  }

  // Declared, non-path, non-body arguments travel as query parameters, in the
  // order the caller sent them.
  for (const [name, value] of Object.entries(args)) {
    if (name === 'body' || placeholders.has(name) || !properties.has(name) || value === undefined) continue;
    url.searchParams.append(name, String(value));
  }

  const request: OpenApiRequest = { url: url.toString() };
  if (schemaProperties.has('body') && !placeholders.has('body') && hasOwn(args, 'body') && args.body) {
    request.body = args.body;
  }
  return request;
}
