/**
 * HTTP envelope types — request/response shapes for each endpoint under
 * /api/gpu/agent/*. Keep these in lockstep with the routes in
 * src/server/api/plugins/gpu-agent.ts.
 */

import type { GpuFleetCommand } from './command';
import type { DeploymentRuntimeStatus } from './deployment';
import type { GpuFleetEvent } from './event';
import type { HostInventory } from './inventory';
import type { GpuSliceReport } from './slice';

export const GPU_AGENT_API_PREFIX = '/api/gpu/agent';

/** Build a tenant-scoped agent URL, e.g. `/api/gpu/agent/acme/heartbeat`. */
export function gpuAgentPath(tenantSlug: string, path: string): string {
  const trimmed = path.startsWith('/') ? path : `/${path}`;
  return `${GPU_AGENT_API_PREFIX}/${encodeURIComponent(tenantSlug)}${trimmed}`;
}

/** POST /api/gpu/agent/heartbeat */
export interface HeartbeatRequest {
  /** Last command id the agent processed (used for ack & ordering checks). */
  lastProcessedCommandId: string | null;
  /** Light state digest — full state ships on long-poll if it changed. */
  agentVersion: string;
  uptimeSeconds: number;
  slices: GpuSliceReport[];
  deployments: DeploymentRuntimeStatus[];
  /** Whether the agent has detected hardware drift since last handshake. */
  inventoryDirty: boolean;
  /**
   * Optional fresh inventory snapshot. The agent attaches this on the first
   * heartbeat after startup (cheap once, gives the console authoritative
   * accelerator + toolchain info after driver installs) and any time it
   * detects inventory drift. Heartbeats without this field are still valid;
   * the console treats it as a no-op for inventory state.
   */
  inventory?: HostInventory;
}

export interface HeartbeatResponse {
  /** True when the console wants a fresh inventory on the next request. */
  requestInventoryRefresh: boolean;
  /** Agent token version expected by the server; mismatch = client should re-handshake. */
  expectedTokenVersion: number;
}

/** POST /api/gpu/agent/inventory — pushed on drift or when console asks. */
export interface InventoryRefreshRequest {
  inventory: HostInventory;
  slices: GpuSliceReport[];
}

export interface InventoryRefreshResponse {
  accepted: true;
}

/**
 * GET /api/gpu/agent/commands?wait=<seconds>
 *
 * Long-poll. If there are pending commands the server returns immediately;
 * otherwise it holds the connection open until `wait` seconds elapse and
 * returns an empty list. Agent must reconnect on every response.
 */
export interface CommandPollResponse {
  commands: GpuFleetCommand[];
}

/** POST /api/gpu/agent/events */
export interface EventBatchRequest {
  events: GpuFleetEvent[];
}

export interface EventBatchResponse {
  accepted: number;
  /** Highest sequence number the console has now seen. */
  highWatermark: number;
}
