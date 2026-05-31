/**
 * Handshake & auth payloads.
 *
 * Two registration paths:
 *
 *   A) Single-host (legacy): admin pre-creates host in UI → gets one-time
 *      registration token → agent calls /handshake with it.
 *   B) Fleet: admin enables tenant-wide fleet token → same token bakes into
 *      install script for many hosts → each agent calls /fleet-handshake
 *      and the console auto-creates a `pending_claim` host. Admin claims
 *      from the UI to promote it to a working host.
 *
 * Both paths return the same long-lived agent token, used as Bearer on every
 * subsequent request.
 */

import type { HostInventory } from './inventory';
import type { GpuSliceReport } from './slice';

export interface HandshakeRequest {
  /** One-time registration token shown in the console UI. */
  registrationToken: string;
  /** Agent version (e.g. "0.1.0"). */
  agentVersion: string;
  inventory: HostInventory;
  /** Slices the agent already sees at startup (post-reboot resume). */
  slices: GpuSliceReport[];
}

/** POST /api/gpu/agent/:tenantSlug/fleet-handshake */
export interface FleetHandshakeRequest {
  /** Tenant-wide fleet token. */
  fleetToken: string;
  agentVersion: string;
  inventory: HostInventory;
  slices: GpuSliceReport[];
}

export interface FleetHandshakeResponse {
  hostId: string;
  agentToken: string;
  /** Always 'pending_claim' for fleet-handshake responses. */
  status: 'pending_claim';
  heartbeatIntervalSeconds: number;
  commandPollWaitSeconds: number;
  tenantId: string;
  tenantSlug: string;
}

export interface HandshakeResponse {
  /** Server-assigned host id (uuid). */
  hostId: string;
  /** Long-lived Bearer token for subsequent calls. */
  agentToken: string;
  /** Heartbeat cadence the agent should use (seconds). */
  heartbeatIntervalSeconds: number;
  /** Long-poll wait window for the commands endpoint (seconds). */
  commandPollWaitSeconds: number;
  /** Bound tenant. Slug goes in URLs; id is informational. */
  tenantId: string;
  tenantSlug: string;
}

/**
 * Phase 1 uses opaque bearer tokens (256-bit random hex). The console stores
 * a SHA-256 hash and looks the host up by hash on every request, which gives
 * us cheap revocation by overwriting the hash. We may move to signed JWTs
 * once the host count makes lookup-per-request the bottleneck.
 */
