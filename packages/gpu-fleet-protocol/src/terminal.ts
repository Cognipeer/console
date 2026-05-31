/**
 * Remote terminal protocol.
 *
 * Session lifecycle:
 *   1. UI (admin) opens a terminal in the console with a target sandbox.
 *   2. Console enqueues an `open-terminal-session` command.
 *   3. Agent picks it up via long-poll, opens a dedicated WebSocket back
 *      to the console at `/api/gpu/agent/:tenantSlug/terminal/:sessionId`.
 *   4. Browser opens a WebSocket to the same URL (different role); the
 *      console multiplexes the two streams.
 *   5. Either side disconnects → console reaps the session and closes the
 *      other side; agent kills the underlying shell.
 *
 * Security:
 *   - `gpu-fleet.terminal` service permission required on the admin role.
 *   - `IGpuHost.terminalEnabled` must be true on the target host (per-host
 *     opt-in by the operator who claimed it).
 *   - Session TTL bounded by `IGpuFleetSettings.terminalSessionTtlSeconds`.
 *   - Every command is line-logged into `gpu_fleet_events` for audit.
 */

/**
 * Where the shell is opened on the host.
 *
 * - `host`             : `/bin/bash` (or sh) inside the agent process — full host access.
 * - `docker-debug`     : Ephemeral `docker run -it --rm cognipeer/debug-shell` sandbox.
 *                       Mounts /host:ro and includes nvidia-smi + curl. Default.
 * - `deployment-exec`  : `docker exec -it <containerId>` into an existing deployment.
 *                       Useful for inspecting vLLM logs from inside.
 */
export type TerminalSandbox = 'host' | 'docker-debug' | 'deployment-exec';

export interface OpenTerminalSessionPayload {
  sessionId: string;
  sandbox: TerminalSandbox;
  /** Required when sandbox === 'deployment-exec'. */
  deploymentId?: string;
  /** Hard cap; agent enforces locally too. */
  ttlSeconds: number;
  /** Initial terminal size; resize messages flow over the WS once open. */
  cols: number;
  rows: number;
}

/**
 * Wire frames the WebSocket carries. Tagged union so both sides can decode
 * without out-of-band schema knowledge. JSON over text frames; raw IO over
 * binary frames is reserved for future bandwidth optimisation.
 */
export type TerminalFrame =
  | { type: 'stdin'; data: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit'; code: number | null; reason: string }
  | { type: 'ping' }
  | { type: 'pong' };

/** Posted to /api/gpu-fleet/hosts/:hostId/terminal — opens a session. */
export interface OpenTerminalRequest {
  sandbox: TerminalSandbox;
  deploymentId?: string;
  cols?: number;
  rows?: number;
}

export interface OpenTerminalResponse {
  sessionId: string;
  /** WS URL the browser should connect to. Relative to the console origin. */
  websocketPath: string;
  expiresAt: string;
}
