/**
 * What discovery reads from an upstream MCP server — shared by the remote
 * (HTTP) client and the stdio runner so both read `initialize` and
 * `tools/list` the same way.
 */

import type { IMcpTool, IMcpToolAnnotations } from '@/lib/database';

/** Server instructions longer than this are cut — they ride in every client's system prompt. */
export const MCP_INSTRUCTIONS_MAX_CHARS = 8_000;

/**
 * How many `tools/list` pages discovery follows. A server that keeps handing
 * out new cursors past this is cut off rather than followed forever.
 */
export const MAX_TOOL_LIST_PAGES = 50;

export interface McpDiscovery {
  tools: IMcpTool[];
  /**
   * The server's `instructions`: a string when it sent some, `null` when it
   * answered `initialize` without any, `undefined` when that is not known
   * (the handshake failed or the source cannot report it).
   */
  instructions?: string | null;
}

/** Trimmed and bounded instructions text, or `undefined` when there is none. */
export function normalizeMcpInstructions(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > MCP_INSTRUCTIONS_MAX_CHARS ? text.slice(0, MCP_INSTRUCTIONS_MAX_CHARS) : text;
}

/** Why an API body's `instructions` is unacceptable, or null when it is fine (a string, or null to clear). */
export function mcpInstructionsInputError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'instructions must be a string or null';
  if (value.trim().length > MCP_INSTRUCTIONS_MAX_CHARS) {
    return `instructions must be at most ${MCP_INSTRUCTIONS_MAX_CHARS} characters`;
  }
  return null;
}

/** The `instructions` of an `initialize` result: `null` when the server sent none. */
export function readInitializeInstructions(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  return normalizeMcpInstructions((result as { instructions?: unknown }).instructions) ?? null;
}

interface RawTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
}

/** One `tools/list` result: its tools in stored form, and the cursor of the next page if there is one. */
export function readToolListPage(result: unknown): { tools: IMcpTool[]; nextCursor?: string } {
  if (!result || typeof result !== 'object') return { tools: [] };
  const page = result as { tools?: unknown; nextCursor?: unknown };
  const tools = (Array.isArray(page.tools) ? page.tools as RawTool[] : [])
    .filter((t): t is RawTool & { name: string } => typeof t?.name === 'string' && t.name !== '')
    .map((t) => {
      const title = typeof t.title === 'string' ? t.title.trim() : '';
      return {
        name: t.name,
        ...(title ? { title } : {}),
        description: typeof t.description === 'string' && t.description ? t.description : t.name,
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object'
          ? t.inputSchema as Record<string, unknown>
          : { type: 'object', properties: {} },
        ...(t.annotations && typeof t.annotations === 'object'
          ? { annotations: t.annotations as IMcpToolAnnotations }
          : {}),
      };
    });
  return {
    tools,
    ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}),
  };
}
