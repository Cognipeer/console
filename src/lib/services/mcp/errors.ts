/**
 * Errors raised while validating a tools/call request (unknown tool, bad or
 * missing arguments). They map to JSON-RPC "invalid params" and their message
 * is safe to return to any caller, anonymous public callers included.
 */
export class McpToolInputError extends Error {
  readonly rpcCode = -32602;

  constructor(message: string) {
    super(message);
    this.name = 'McpToolInputError';
  }
}

export function isMcpToolInputError(error: unknown): error is McpToolInputError {
  return error instanceof McpToolInputError;
}

/**
 * The upstream an MCP server fronts answered with an HTTP error status. The
 * message keeps the upstream's own text for callers that may see it (it is
 * masked and bounded where it is thrown); `status` lets a surface that must not
 * show that text — the public endpoints — report the failure without it.
 */
export class McpUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'McpUpstreamError';
  }
}

export function isMcpUpstreamError(error: unknown): error is McpUpstreamError {
  return error instanceof McpUpstreamError;
}

/** Settings a server cannot be saved with (an auth type its source does not support). Its message is safe to return. */
export class McpServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpServerConfigError';
  }
}

export function isMcpServerConfigError(error: unknown): error is McpServerConfigError {
  return error instanceof McpServerConfigError;
}
