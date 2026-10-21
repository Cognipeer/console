/**
 * The MCP protocol revision our MCP endpoints answer with. `initialize`
 * agrees on one; every later request over streamable HTTP names it in the
 * `MCP-Protocol-Version` header (2025-06-18 on). A tools/call result is shaped
 * for that revision — `structuredContent` and `resource_link` only reach a
 * client that speaks 2025-06-18 or later.
 */

/** Revisions our endpoints speak, oldest first. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'] as const;

export const LATEST_MCP_PROTOCOL_VERSION = '2025-11-25';

/** What a request without the header is taken to speak, as the spec says to assume. */
const HEADERLESS_MCP_PROTOCOL_VERSION = '2025-03-26';

function isSupported(value: unknown): value is string {
  return typeof value === 'string' && (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/** The revision `initialize` answers: the client's when we speak it, else our latest (the client then decides). */
export function negotiateMcpProtocolVersion(requested: unknown): string {
  return isSupported(requested) ? requested : LATEST_MCP_PROTOCOL_VERSION;
}

/** The revision a request speaks, from its `MCP-Protocol-Version` header. */
export function mcpProtocolVersionOf(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['mcp-protocol-version'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isSupported(value) ? value : HEADERLESS_MCP_PROTOCOL_VERSION;
}
