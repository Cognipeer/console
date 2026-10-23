/**
 * Errors raised while validating a tools/call request (unknown tool, bad or
 * missing arguments). Their message is safe to return to any caller, anonymous
 * public callers included. REST surfaces answer them with 400; JSON-RPC
 * surfaces see `McpUnknownToolError` below.
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
 * A tools/call naming a tool the server does not advertise. Over JSON-RPC this
 * is the one input error that stays a protocol error (-32602); every other
 * input error is returned as a tool result with `isError: true`, so the model
 * reads the message and can correct its arguments (MCP 2025-11-25, SEP-1303).
 */
export class McpUnknownToolError extends McpToolInputError {
  constructor(message = 'Unknown tool') {
    super(message);
    this.name = 'McpUnknownToolError';
  }
}

export function isMcpUnknownToolError(error: unknown): error is McpUnknownToolError {
  return error instanceof McpUnknownToolError;
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
