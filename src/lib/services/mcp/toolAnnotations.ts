/**
 * MCP tool annotations (`ToolAnnotations` in the MCP spec).
 *
 * Strict clients — OpenAI's MCP connector among them — reject a server whose
 * `tools/list` entries omit `readOnlyHint` / `destructiveHint` /
 * `openWorldHint`, because they use those hints to decide whether a call needs
 * user approval. Console tools are stored without hints (and upstream servers
 * may not send any), so every `tools/list` surface runs its descriptors
 * through `describeMcpTool` to guarantee a fully-populated block.
 */

import type { IMcpTool, IMcpToolAnnotations, McpSourceType } from '@/lib/database';

/** Every hint present — what strict MCP clients validate against. */
export interface ResolvedMcpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ResolvedMcpToolAnnotations;
}

interface AnnotatableTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: IMcpToolAnnotations;
  httpMethod?: string;
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']);
const DESTRUCTIVE_METHODS = new Set(['DELETE', 'PUT', 'PATCH']);

/** Fill in whatever the tool didn't declare, biasing towards the safe answer. */
export function resolveToolAnnotations(
  tool: AnnotatableTool,
  defaults: IMcpToolAnnotations = {},
): ResolvedMcpToolAnnotations {
  const declared = tool.annotations ?? {};
  const method = tool.httpMethod?.toUpperCase();

  const readOnlyHint = declared.readOnlyHint
    ?? defaults.readOnlyHint
    ?? (method ? READ_ONLY_METHODS.has(method) : false);

  const destructiveHint = declared.destructiveHint
    ?? defaults.destructiveHint
    // A read-only tool can never be destructive; without a hint assume the worst.
    ?? (readOnlyHint ? false : (method ? DESTRUCTIVE_METHODS.has(method) : true));

  const idempotentHint = declared.idempotentHint
    ?? defaults.idempotentHint
    ?? (readOnlyHint || (method ? IDEMPOTENT_METHODS.has(method) : false));

  const openWorldHint = declared.openWorldHint ?? defaults.openWorldHint ?? true;

  return {
    title: declared.title ?? defaults.title ?? tool.name,
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint,
  };
}

/** Map a stored/discovered tool to a spec-complete `tools/list` entry. */
export function describeMcpTool(
  tool: AnnotatableTool,
  defaults?: IMcpToolAnnotations,
): McpToolDescriptor {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    annotations: resolveToolAnnotations(tool, defaults),
  };
}

export function describeMcpTools(
  tools: Array<IMcpTool | AnnotatableTool>,
  defaults?: IMcpToolAnnotations,
): McpToolDescriptor[] {
  return tools.map((tool) => describeMcpTool(tool, defaults));
}

/**
 * Fallback hints for servers created before annotations were stored.
 * Internal providers (knowledge base, agent observability) are read-only
 * console-local capabilities; proxied sources get no assumption.
 */
export function defaultAnnotationsForSource(
  sourceType: McpSourceType | undefined,
): IMcpToolAnnotations | undefined {
  if (sourceType !== 'internal') return undefined;
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}
