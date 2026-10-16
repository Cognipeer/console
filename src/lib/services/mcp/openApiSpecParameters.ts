/**
 * Parameter names an OpenAPI operation declares in the server's stored spec.
 *
 * The tool list built at import time lists, in each tool's `inputSchema`, the
 * parameters written inline on the operation. Parameters the spec declares by
 * reference (`$ref: '#/components/parameters/…'`) or once for all operations of
 * a path (`parameters` on the path item) are not in that list, yet they are as
 * much a part of the operation. `buildOpenApiRequest` forwards only declared
 * arguments, so the executor reads this list as well and a spec written either
 * way keeps working.
 *
 * Names only, computed once per stored spec and cached: the cache never holds
 * the spec itself.
 */

import type { IMcpServer, IMcpTool } from '@/lib/database';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAX_REF_DEPTH = 5;
const MAX_CACHED_SPECS = 64;

type SpecParameterSource = Pick<IMcpServer, '_id' | 'updatedAt' | 'openApiSpec'>;
type SpecOperationRef = Pick<IMcpTool, 'httpPath' | 'httpMethod'>;

/** `METHOD path` → the parameter names that operation declares. */
type OperationNames = Map<string, string[]>;

const cache = new Map<string, { stamp: string; operations: OperationNames }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** Follow a same-document JSON pointer (`#/components/parameters/Limit`). */
function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (!isRecord(node) || !hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

function parameterName(root: unknown, parameter: unknown, depth = 0): string | undefined {
  if (!isRecord(parameter)) return undefined;
  if (typeof parameter.$ref === 'string') {
    return depth < MAX_REF_DEPTH
      ? parameterName(root, resolveLocalRef(root, parameter.$ref), depth + 1)
      : undefined;
  }
  return typeof parameter.name === 'string' && parameter.name ? parameter.name : undefined;
}

function parameterNames(root: unknown, parameters: unknown): string[] {
  if (!Array.isArray(parameters)) return [];
  const names: string[] = [];
  for (const parameter of parameters) {
    const name = parameterName(root, parameter);
    if (name) names.push(name);
  }
  return names;
}

function collectOperations(spec: unknown): OperationNames {
  const operations: OperationNames = new Map();
  const paths = isRecord(spec) ? spec.paths : undefined;
  if (!isRecord(paths)) return operations;

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    const shared = parameterNames(spec, pathItem.parameters);
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const names = [...new Set([...shared, ...parameterNames(spec, operation.parameters)])];
      operations.set(`${method.toUpperCase()} ${path}`, names);
    }
  }
  return operations;
}

function stampOf(server: SpecParameterSource): string {
  const updated = server.updatedAt ? new Date(server.updatedAt).getTime() : '';
  return `${updated}:${server.openApiSpec?.length ?? 0}`;
}

/**
 * The parameter names the stored spec declares for one operation, `$ref`s and
 * path-level parameters included. Empty when the spec is missing, unreadable or
 * has no such operation.
 */
export function specDeclaredParameters(server: SpecParameterSource, tool: SpecOperationRef): string[] {
  if (!server.openApiSpec || !tool.httpPath || !tool.httpMethod) return [];
  const id = server._id === undefined || server._id === null ? '' : String(server._id);
  const stamp = stampOf(server);

  let entry = id ? cache.get(id) : undefined;
  if (!entry || entry.stamp !== stamp) {
    let operations: OperationNames;
    try {
      operations = collectOperations(JSON.parse(server.openApiSpec));
    } catch {
      operations = new Map();
    }
    entry = { stamp, operations };
    if (id) {
      cache.delete(id);
      cache.set(id, entry);
      // Least recently stored first out.
      while (cache.size > MAX_CACHED_SPECS) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
  }
  return entry.operations.get(`${tool.httpMethod.toUpperCase()} ${tool.httpPath}`) ?? [];
}

/** For tests: forget everything cached. */
export function resetSpecParameterCache(): void {
  cache.clear();
}
