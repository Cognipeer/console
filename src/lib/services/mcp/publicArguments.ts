/**
 * The arguments of a tool call from an anonymous caller (the public
 * endpoints), fitted to the tool's advertised input schema before the call
 * runs:
 *
 *  - a top-level key the schema does not declare is dropped, unless the schema
 *    accepts extra keys (`additionalProperties: true` or a schema of its own);
 *  - a string longer than `maxChars`, at any depth, refuses the call;
 *  - so does nesting deeper than any tool needs.
 *
 * The OpenAPI executor already forwards declared parameters only; this gives
 * the other sources (remote MCP, stdio, sandbox, composite, internal) the same
 * footing for public callers. Token callers are left as they are.
 */

import { McpToolInputError } from './errors';

/** Deepest nesting of objects and arrays a public call's arguments may have. */
const MAX_ARGUMENT_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The declared top-level property names, or null when the schema does not restrict them. */
function declaredKeys(inputSchema: unknown): Set<string> | null {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return null;
  const extra = inputSchema.additionalProperties;
  if (extra === true || isRecord(extra)) return null;
  return new Set(Object.keys(inputSchema.properties));
}

function assertBounded(value: unknown, maxChars: number): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const { value: current, depth } = pending.pop()!;
    if (typeof current === 'string') {
      if (current.length > maxChars) {
        throw new McpToolInputError(`An argument is longer than ${maxChars} characters`);
      }
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (depth >= MAX_ARGUMENT_DEPTH) {
      throw new McpToolInputError(`Arguments are nested deeper than ${MAX_ARGUMENT_DEPTH} levels`);
    }
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) pending.push({ value: child, depth: depth + 1 });
  }
}

export function fitPublicToolArguments(
  inputSchema: unknown,
  args: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> {
  const allowed = declaredKeys(inputSchema);
  const fitted = allowed
    ? Object.fromEntries(Object.entries(args).filter(([key]) => allowed.has(key)))
    : args;
  assertBounded(fitted, maxChars);
  return fitted;
}
