/**
 * GPU fleet — host lifecycle.
 *
 * Hosts represent GPU machines admins have onboarded to the console. The flow:
 *   1. Admin creates a host row → console issues a one-time registration token
 *   2. Agent calls handshake → console swaps registration token for an agent token
 *   3. Heartbeats keep `lastHeartbeatAt`/`status` fresh
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import {
  getDatabase,
  type GpuHostAccelerator,
  type GpuHostGpuFramework,
  type IGpuHost,
} from '@/lib/database';
import type { AcceleratorKind, GpuFrameworkKind, HostInventory } from '@cognipeer/gpu-fleet-protocol';
import {
  generateAgentToken,
  generateRegistrationToken,
  hashToken,
  tokensMatchByHash,
} from './agentAuth';

const log = createLogger('gpu-fleet:host');

/** Registration tokens expire one hour after issuance. */
const REGISTRATION_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Hosts that haven't pinged within this window are marked offline. */
export const HEARTBEAT_STALE_THRESHOLD_MS = 60 * 1000;

export interface CreateGpuHostInput {
  tenantDbName: string;
  tenantId: string;
  name: string;
  provider?: IGpuHost['provider'];
  labels?: Record<string, string>;
  createdBy: string;
}

export interface CreateGpuHostResult {
  host: IGpuHost;
  /** Raw registration token — returned ONCE, never persisted in cleartext. */
  registrationToken: string;
  registrationTokenExpiresAt: Date;
}

function defaultsForNewHost(): {
  accelerator: GpuHostAccelerator;
  gpuFramework: GpuHostGpuFramework;
} {
  return { accelerator: 'cpu', gpuFramework: 'none' };
}

function mapAcceleratorToFramework(accelerator: AcceleratorKind, fallback: GpuFrameworkKind): GpuHostGpuFramework {
  switch (accelerator) {
    case 'nvidia-gpu':
      return 'cuda';
    case 'amd-gpu':
      return 'rocm';
    case 'apple-silicon':
      return 'metal';
    case 'cpu':
      return 'none';
    default:
      return (fallback ?? 'none') as GpuHostGpuFramework;
  }
}

export async function createGpuHost(input: CreateGpuHostInput): Promise<CreateGpuHostResult> {
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);

  const registrationToken = generateRegistrationToken();
  const expiresAt = new Date(Date.now() + REGISTRATION_TOKEN_TTL_MS);

  const defaults = defaultsForNewHost();
  const host = await db.createGpuHost({
    id: randomUUID(),
    tenantId: input.tenantId,
    name: input.name.trim(),
    provider: input.provider ?? 'self',
    status: 'pending',
    accelerator: defaults.accelerator,
    gpuFramework: defaults.gpuFramework,
    serviceAddress: null,
    terminalEnabled: false,
    agentTokenHash: null,
    agentTokenVersion: 1,
    registrationTokenHash: hashToken(registrationToken),
    registrationTokenExpiresAt: expiresAt,
    inventory: null,
    labels: input.labels ?? {},
    lastHeartbeatAt: null,
    lastEventSequence: 0,
    agentVersion: null,
    createdBy: input.createdBy,
  });

  log.info('gpu-host created', { hostId: host.id, tenantId: input.tenantId, name: host.name });
  return { host, registrationToken, registrationTokenExpiresAt: expiresAt };
}

export async function listGpuHosts(
  tenantDbName: string,
  tenantId: string,
): Promise<IGpuHost[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listGpuHosts({ tenantId });
}

export async function getGpuHost(
  tenantDbName: string,
  hostId: string,
): Promise<IGpuHost | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findGpuHostById(hostId);
}

export async function deleteGpuHost(
  tenantDbName: string,
  hostId: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  // Cascade: remove every row that references this host. Without this
  // sweep, deleting a host leaves orphan deployments + commands + slice
  // assignments in the tenant DB. Slices in particular are nasty because
  // their UUID (the nvidia-smi GPU id) is stable across host re-registers
  // — an orphan assignment bleeds into the next agent install.
  const deployments = await db.listLlmDeploymentsByHost(hostId);
  for (const d of deployments) {
    if (d.sliceUuid) {
      await db.setGpuSliceAssignment(d.sliceUuid, null).catch(() => undefined);
    }
    await db.deleteLlmDeployment(d.id).catch(() => undefined);
  }
  await db.deleteGpuSlicesForHost(hostId).catch(() => undefined);
  await db.deleteGpuFleetCommandsForHost(hostId).catch(() => undefined);
  await db.deleteGpuFleetEventsForHost(hostId).catch(() => undefined);
  return db.deleteGpuHost(hostId);
}

export interface RotateRegistrationTokenResult {
  registrationToken: string;
  expiresAt: Date;
}

/**
 * Admin-triggered rotation — issues a fresh registration token even if the
 * host already paired. Use case: device lost / token compromised. Also bumps
 * the agent token version so the currently-connected agent must re-handshake.
 */
export async function rotateRegistrationToken(
  tenantDbName: string,
  hostId: string,
): Promise<RotateRegistrationTokenResult> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const host = await db.findGpuHostById(hostId);
  if (!host) throw new Error('Host not found');

  const registrationToken = generateRegistrationToken();
  const expiresAt = new Date(Date.now() + REGISTRATION_TOKEN_TTL_MS);

  await db.updateGpuHost(hostId, {
    registrationTokenHash: hashToken(registrationToken),
    registrationTokenExpiresAt: expiresAt,
    agentTokenHash: null,
    agentTokenVersion: host.agentTokenVersion + 1,
    status: 'pending',
  });

  log.info('gpu-host registration rotated', { hostId, newTokenVersion: host.agentTokenVersion + 1 });
  return { registrationToken, expiresAt };
}

export interface CompleteHandshakeResult {
  host: IGpuHost;
  agentToken: string;
}

/**
 * Exchange a registration token for a fresh agent token. Idempotent in the
 * sense that calling again with the SAME registration token will fail
 * (single-use); admins must rotate to get a new one.
 */
export async function completeHandshake(args: {
  tenantDbName: string;
  registrationToken: string;
  agentVersion: string;
  inventory: HostInventory;
}): Promise<CompleteHandshakeResult> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);

  const regHash = hashToken(args.registrationToken);
  const host = await db.findGpuHostByRegistrationTokenHash(regHash);
  if (!host) {
    throw new Error('Invalid or already-consumed registration token');
  }
  if (!tokensMatchByHash(args.registrationToken, host.registrationTokenHash ?? '')) {
    throw new Error('Invalid registration token');
  }
  if (host.registrationTokenExpiresAt && host.registrationTokenExpiresAt.getTime() < Date.now()) {
    throw new Error('Registration token expired');
  }

  const agentToken = generateAgentToken();
  await db.updateGpuHost(host.id, {
    agentTokenHash: hashToken(agentToken),
    registrationTokenHash: null,
    registrationTokenExpiresAt: null,
    inventory: args.inventory as unknown as Record<string, unknown>,
    agentVersion: args.agentVersion,
    status: 'online',
    lastHeartbeatAt: new Date(),
  });

  const refreshed = (await db.findGpuHostById(host.id))!;
  log.info('gpu-host handshake complete', { hostId: host.id, agentVersion: args.agentVersion });
  return { host: refreshed, agentToken };
}

/**
 * Look up the host bound to a bearer token. Returns null when the token is
 * invalid; we deliberately collapse "no such host" and "wrong token" into
 * the same null to avoid leaking host existence.
 */
export async function authenticateAgent(
  tenantDbName: string,
  bearerToken: string,
): Promise<IGpuHost | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const hash = hashToken(bearerToken);
  const host = await db.findGpuHostByAgentTokenHash(hash);
  if (!host) return null;
  if (!host.agentTokenHash) return null;
  if (!tokensMatchByHash(bearerToken, host.agentTokenHash)) return null;
  return host;
}

export async function touchHostHeartbeat(
  tenantDbName: string,
  hostId: string,
  agentVersion: string | null,
  inventory?: HostInventory | null,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const current = await db.findGpuHostById(hostId);
  if (!current) return;
  // pending_claim hosts stay in that state until an admin claims them — never
  // promote to 'online' implicitly. For everything else, heartbeat means online.
  const nextStatus = current.status === 'pending_claim' ? 'pending_claim' : 'online';
  const patch: Parameters<typeof db.updateGpuHost>[1] = {
    lastHeartbeatAt: new Date(),
    agentVersion: agentVersion ?? undefined,
    status: nextStatus,
  };
  // If the agent ships a fresh inventory (e.g. after a driver install +
  // reboot), reflect the new accelerator / framework / inventory blob on
  // the host row. Without this, a host registered before its NVIDIA driver
  // was loaded stays `accelerator='cpu'` forever — and the UI hides every
  // CUDA runtime from it. Inventory is authoritative.
  if (inventory) {
    if (inventory.accelerator && inventory.accelerator !== current.accelerator) {
      patch.accelerator = inventory.accelerator;
    }
    const expectedFramework = mapAcceleratorToFramework(inventory.accelerator, inventory.gpuFramework);
    if (expectedFramework !== current.gpuFramework) {
      patch.gpuFramework = expectedFramework;
    }
    patch.inventory = inventory as unknown as Record<string, unknown>;
  }
  await db.updateGpuHost(hostId, patch);
}

// ── Fleet (self-registration) ────────────────────────────────────────────

export interface FleetHandshakeResult {
  host: IGpuHost;
  agentToken: string;
}

/**
 * Self-registration via tenant-wide fleet token. Creates a host row in
 * `pending_claim`. The agent token is issued immediately so the host can
 * keep heartbeating, but the host cannot receive commands until an admin
 * promotes it via `claimPendingHost`.
 */
export async function completeFleetHandshake(args: {
  tenantDbName: string;
  tenantId: string;
  fleetToken: string;
  agentVersion: string;
  inventory: HostInventory;
  createdBy?: string;
}): Promise<FleetHandshakeResult> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);

  const settings = await db.getGpuFleetSettings(args.tenantId);
  if (!settings || !settings.fleetTokenHash) {
    throw new Error('Fleet registration is not enabled for this tenant');
  }
  if (!tokensMatchByHash(args.fleetToken, settings.fleetTokenHash)) {
    throw new Error('Invalid fleet token');
  }

  // Dedup: if a host already exists for this tenant with the same cloud
  // instance id (preferred — durable across reboots/agent reinstalls) or
  // the same hostname, REUSE it instead of creating a duplicate row.
  // Without this, every agent re-install creates `t4-test-01`,
  // `t4-test-01_02`, `t4-test-01_03`, … and the operator ends up clicking
  // an offline ghost host in the UI.
  const cloudInstanceId = args.inventory.cloud?.instanceId ?? null;
  const allHosts = await db.listGpuHosts({ tenantId: args.tenantId });
  const reusable = allHosts.find((h) => {
    const inv = (h.inventory ?? {}) as { cloud?: { instanceId?: string }; hostname?: string };
    if (cloudInstanceId && inv.cloud?.instanceId === cloudInstanceId) return true;
    if (h.name === args.inventory.hostname) return true;
    return false;
  });

  const agentToken = generateAgentToken();
  if (reusable) {
    // Rotate the agent token and refresh inventory + status. Keep the
    // host in its existing `online` / `pending_claim` state — the admin
    // already claimed it (or didn't), and re-registering shouldn't undo
    // that decision.
    //
    // IMPORTANT: reset lastEventSequence to 0. When the operator wipes
    // the agent state dir (common during reinstalls), the agent loses its
    // persisted sequence counter and starts at 1 again. Without this
    // reset, every event the new agent emits with sequence ≤ watermark
    // gets silently discarded by `ingestAgentEvents` ("dedupe replays"),
    // leaving the UI stuck on "pending" with no progress.
    // Don't overwrite a manually-set serviceAddress on re-handshake.
    // Operators sometimes pin a specific public IP / DNS name (via the
    // PATCH endpoint); re-installing the agent shouldn't undo that. Only
    // accept the agent's auto-detected address when (a) we never had one
    // OR (b) it matches the previous inventory (meaning the user never
    // intervened).
    const previousAutoAddress = (reusable.inventory as { preferredServiceAddress?: string | null } | null)
      ?.preferredServiceAddress ?? null;
    const userPinnedAddress = reusable.serviceAddress != null
      && reusable.serviceAddress !== previousAutoAddress;
    const nextServiceAddress = userPinnedAddress
      ? reusable.serviceAddress
      : args.inventory.preferredServiceAddress;

    await db.updateGpuHost(reusable.id, {
      accelerator: args.inventory.accelerator,
      gpuFramework: mapAcceleratorToFramework(args.inventory.accelerator, args.inventory.gpuFramework),
      serviceAddress: nextServiceAddress,
      agentTokenHash: hashToken(agentToken),
      agentTokenVersion: (reusable.agentTokenVersion ?? 1) + 1,
      inventory: args.inventory as unknown as Record<string, unknown>,
      labels: args.inventory.labels ?? {},
      lastHeartbeatAt: new Date(),
      agentVersion: args.agentVersion,
      lastEventSequence: 0,
    });
    const refreshed = await db.findGpuHostById(reusable.id);
    log.info('fleet handshake re-used existing host (dedup)', {
      hostId: reusable.id,
      hostname: args.inventory.hostname,
      cloudInstanceId,
      via: cloudInstanceId ? 'cloud-instance-id' : 'hostname',
    });
    return { host: refreshed!, agentToken };
  }

  const host = await db.createGpuHost({
    id: randomUUID(),
    tenantId: args.tenantId,
    name: args.inventory.hostname || 'unclaimed-host',
    provider: args.inventory.cloud?.provider ?? 'self',
    status: 'pending_claim',
    accelerator: args.inventory.accelerator,
    gpuFramework: mapAcceleratorToFramework(args.inventory.accelerator, args.inventory.gpuFramework),
    serviceAddress: args.inventory.preferredServiceAddress,
    terminalEnabled: false,
    agentTokenHash: hashToken(agentToken),
    agentTokenVersion: 1,
    registrationTokenHash: null,
    registrationTokenExpiresAt: null,
    inventory: args.inventory as unknown as Record<string, unknown>,
    labels: args.inventory.labels ?? {},
    lastHeartbeatAt: new Date(),
    lastEventSequence: 0,
    agentVersion: args.agentVersion,
    createdBy: args.createdBy ?? 'fleet-self-register',
  });

  log.info('gpu-host self-registered via fleet token', {
    hostId: host.id,
    hostname: args.inventory.hostname,
    accelerator: args.inventory.accelerator,
  });
  return { host, agentToken };
}

export interface ClaimPendingHostInput {
  tenantDbName: string;
  tenantId: string;
  hostId: string;
  /** Admin-supplied display name (overrides the auto-set hostname). */
  name?: string;
  labels?: Record<string, string>;
  /** Admin override of the agent-suggested service address. */
  serviceAddress?: string | null;
  terminalEnabled?: boolean;
  claimedBy: string;
}

export async function claimPendingHost(input: ClaimPendingHostInput): Promise<IGpuHost> {
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  const host = await db.findGpuHostById(input.hostId);
  if (!host || host.tenantId !== input.tenantId) {
    throw new Error('Host not found');
  }
  if (host.status !== 'pending_claim') {
    throw new Error(`Host is in status '${host.status}', not pending_claim`);
  }

  const patch: Parameters<typeof db.updateGpuHost>[1] = {
    status: 'online',
    labels: { ...host.labels, ...(input.labels ?? {}) },
  };
  if (input.name && input.name.trim().length > 0) patch.name = input.name.trim();
  if (input.serviceAddress !== undefined) patch.serviceAddress = input.serviceAddress;
  if (input.terminalEnabled !== undefined) patch.terminalEnabled = input.terminalEnabled;

  await db.updateGpuHost(input.hostId, patch);
  log.info('gpu-host claimed', { hostId: input.hostId, claimedBy: input.claimedBy });
  return (await db.findGpuHostById(input.hostId))!;
}

export async function rejectPendingHost(args: {
  tenantDbName: string;
  tenantId: string;
  hostId: string;
}): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const host = await db.findGpuHostById(args.hostId);
  if (!host || host.tenantId !== args.tenantId) return false;
  if (host.status !== 'pending_claim') {
    throw new Error(`Cannot reject host in status '${host.status}'`);
  }
  return db.deleteGpuHost(args.hostId);
}

export async function listPendingClaimHosts(
  tenantDbName: string,
  tenantId: string,
): Promise<IGpuHost[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listGpuHosts({ tenantId, status: 'pending_claim' });
}
