/**
 * Remote terminal (PTY) protocol for sandboxes.
 *
 * Session lifecycle:
 *   1. Admin/agent opens a terminal targeting a running sandbox instance.
 *   2. Console enqueues an `open-terminal-session` lifecycle command.
 *   3. Runner agent picks it up, opens a WebSocket back to the console at
 *      `/api/sandbox/agent/:tenantSlug/terminal/:sessionId/agent`, and attaches
 *      a PTY inside the sandbox container (via the toolbox daemon).
 *   4. Browser opens a WebSocket to
 *      `/api/sandbox/terminal/:sessionId/browser`; the console multiplexes.
 *   5. Either side disconnects → console reaps the session, closes the peer,
 *      agent kills the PTY.
 */

export interface OpenTerminalSessionPayload {
  sessionId: string;
  /** Target sandbox instance the PTY is attached to. */
  instanceId: string;
  /** Working directory the shell starts in (defaults to /workspace). */
  cwd?: string;
  /** Hard cap; the agent enforces locally too. */
  ttlSeconds: number;
  cols: number;
  rows: number;
  /** Optional shell command; defaults to the image's login shell. */
  shell?: string;
}

/**
 * Wire frames carried over the terminal WebSocket. Tagged union so both ends
 * decode without out-of-band schema. JSON over text frames.
 */
export type TerminalFrame =
  | { type: 'stdin'; data: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit'; code: number | null; reason: string }
  | { type: 'ping' }
  | { type: 'pong' };

/** POST /api/sandbox/instances/:id/terminal */
export interface OpenTerminalRequest {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface OpenTerminalResponse {
  sessionId: string;
  /** WS path (relative to console origin) the browser should connect to. */
  websocketPath: string;
  expiresAt: string;
}
