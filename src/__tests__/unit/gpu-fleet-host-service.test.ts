/**
 * Host lifecycle: single-host handshake, fleet self-registration, claim
 * promotion, rejection, heartbeat behaviour vs pending_claim.
 *
 * Each test wires a fresh mock DB and primes only the calls the unit
 * actually makes — anything else falls back to db.mock defaults (returns
 * null/[]/true), which makes failure messages localised to the code path
 * under test.
 */

import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';
import { hashToken } from '@/lib/services/gpuFleet/agentAuth';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return { ...actual, getDatabase: vi.fn() };
});

import { getDatabase } from '@/lib/database';
import {
  authenticateAgent,
  claimPendingHost,
  completeFleetHandshake,
  completeHandshake,
  createGpuHost,
  rejectPendingHost,
  touchHostHeartbeat,
} from '@/lib/services/gpuFleet/hostService';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

let db: MockDb;

function primeDb(): MockDb {
  const mock = createMockDb();
  (getDatabase as Mock).mockResolvedValue(mock);
  return mock;
}

const HOST_BASE = {
  _id: 'host-1',
  id: 'host-1',
  tenantId: TENANT_ID,
  name: 'gpu-01',
  provider: 'azure' as const,
  status: 'pending' as const,
  accelerator: 'nvidia-gpu' as const,
  gpuFramework: 'cuda' as const,
  serviceAddress: '10.0.0.5',
  terminalEnabled: false,
  agentTokenHash: null,
  agentTokenVersion: 1,
  registrationTokenHash: null,
  registrationTokenExpiresAt: null,
  inventory: null,
  labels: {},
  lastHeartbeatAt: null,
  lastEventSequence: 0,
  agentVersion: null,
  createdBy: USER_ID,
};

const INVENTORY = {
  hostname: 'gpu-01',
  system: {
    os: { platform: 'linux', release: '5.15', distro: 'Ubuntu 22.04', arch: 'x64' },
    cpu: { model: 'Xeon', cores: 24, threads: 48 },
    memoryTotalMiB: 256_000,
    toolchain: { nvidiaDriver: '550', cuda: '12.4', docker: '24.0', nvidiaContainerToolkit: '1.16', agent: '0.1.0' },
  },
  gpus: [],
  accelerator: 'nvidia-gpu' as const,
  gpuFramework: 'cuda' as const,
  preferredServiceAddress: '10.0.0.5',
  labels: {},
  cloud: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db = primeDb();
});

describe('createGpuHost', () => {
  it('creates a host in pending status and returns a one-shot registration token', async () => {
    db.createGpuHost.mockResolvedValue({ ...HOST_BASE, status: 'pending' });

    const result = await createGpuHost({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      name: 'gpu-01',
      createdBy: USER_ID,
    });

    expect(result.registrationToken.startsWith('gpuref_')).toBe(true);
    expect(result.host.status).toBe('pending');
    const passedToDb = db.createGpuHost.mock.calls[0][0];
    expect(passedToDb.registrationTokenHash).toBe(hashToken(result.registrationToken));
    expect(passedToDb.registrationTokenExpiresAt).toBeInstanceOf(Date);
  });
});

describe('completeHandshake (single-host)', () => {
  it('rejects unknown registration tokens', async () => {
    db.findGpuHostByRegistrationTokenHash.mockResolvedValue(null);
    await expect(
      completeHandshake({
        tenantDbName: TENANT_DB,
        registrationToken: 'gpuref_unknown',
        agentVersion: '0.1.0',
        inventory: INVENTORY,
      }),
    ).rejects.toThrow(/Invalid|consumed/i);
  });

  it('rejects an expired registration token even if hash matches', async () => {
    const raw = 'gpuref_expired';
    db.findGpuHostByRegistrationTokenHash.mockResolvedValue({
      ...HOST_BASE,
      registrationTokenHash: hashToken(raw),
      registrationTokenExpiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      completeHandshake({
        tenantDbName: TENANT_DB,
        registrationToken: raw,
        agentVersion: '0.1.0',
        inventory: INVENTORY,
      }),
    ).rejects.toThrow(/expired/i);
  });

  it('issues a fresh agent token and clears the registration token on success', async () => {
    const raw = 'gpuref_good';
    const expiresAt = new Date(Date.now() + 60_000);
    db.findGpuHostByRegistrationTokenHash.mockResolvedValue({
      ...HOST_BASE,
      registrationTokenHash: hashToken(raw),
      registrationTokenExpiresAt: expiresAt,
    });
    db.findGpuHostById.mockResolvedValue({ ...HOST_BASE, status: 'online' });

    const result = await completeHandshake({
      tenantDbName: TENANT_DB,
      registrationToken: raw,
      agentVersion: '0.1.0',
      inventory: INVENTORY,
    });
    expect(result.agentToken.startsWith('gpuat_')).toBe(true);
    const patch = db.updateGpuHost.mock.calls[0][1];
    expect(patch.agentTokenHash).toBe(hashToken(result.agentToken));
    expect(patch.registrationTokenHash).toBeNull();
    expect(patch.status).toBe('online');
  });
});

describe('completeFleetHandshake (multi-host)', () => {
  it('refuses when fleet token is not configured', async () => {
    db.getGpuFleetSettings.mockResolvedValue(null);
    await expect(
      completeFleetHandshake({
        tenantDbName: TENANT_DB,
        tenantId: TENANT_ID,
        fleetToken: 'gpuflt_abc',
        agentVersion: '0.1.0',
        inventory: INVENTORY,
      }),
    ).rejects.toThrow(/not enabled/i);
  });

  it('rejects mismatching fleet tokens', async () => {
    db.getGpuFleetSettings.mockResolvedValue({
      tenantId: TENANT_ID,
      fleetTokenHash: hashToken('gpuflt_right'),
      fleetTokenRotatedAt: null,
      fleetTokenRotatedBy: null,
      agentDistributionMode: 'console-served',
      agentDistributionExternalUrlTemplate: null,
      terminalSessionTtlSeconds: 1800,
    });
    await expect(
      completeFleetHandshake({
        tenantDbName: TENANT_DB,
        tenantId: TENANT_ID,
        fleetToken: 'gpuflt_wrong',
        agentVersion: '0.1.0',
        inventory: INVENTORY,
      }),
    ).rejects.toThrow(/Invalid fleet token/);
  });

  it('creates a host in pending_claim with agentToken issued', async () => {
    const raw = 'gpuflt_match';
    db.getGpuFleetSettings.mockResolvedValue({
      tenantId: TENANT_ID,
      fleetTokenHash: hashToken(raw),
      fleetTokenRotatedAt: null,
      fleetTokenRotatedBy: null,
      agentDistributionMode: 'console-served',
      agentDistributionExternalUrlTemplate: null,
      terminalSessionTtlSeconds: 1800,
    });
    db.createGpuHost.mockResolvedValue({ ...HOST_BASE, status: 'pending_claim' });

    const result = await completeFleetHandshake({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      fleetToken: raw,
      agentVersion: '0.1.0',
      inventory: INVENTORY,
    });
    expect(result.agentToken.startsWith('gpuat_')).toBe(true);
    const passed = db.createGpuHost.mock.calls[0][0];
    expect(passed.status).toBe('pending_claim');
    expect(passed.agentTokenHash).toBe(hashToken(result.agentToken));
  });
});

describe('claimPendingHost', () => {
  it('rejects claims for non-pending_claim hosts', async () => {
    db.findGpuHostById.mockResolvedValue({ ...HOST_BASE, status: 'online' });
    await expect(
      claimPendingHost({
        tenantDbName: TENANT_DB,
        tenantId: TENANT_ID,
        hostId: 'host-1',
        claimedBy: USER_ID,
      }),
    ).rejects.toThrow(/status 'online'/);
  });

  it('promotes pending_claim to online with admin-supplied fields', async () => {
    db.findGpuHostById.mockResolvedValueOnce({ ...HOST_BASE, status: 'pending_claim' });
    db.findGpuHostById.mockResolvedValueOnce({ ...HOST_BASE, status: 'online', name: 'gpu-prod-01' });

    const claimed = await claimPendingHost({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      hostId: 'host-1',
      name: 'gpu-prod-01',
      terminalEnabled: true,
      labels: { env: 'prod' },
      claimedBy: USER_ID,
    });
    expect(claimed.status).toBe('online');
    const patch = db.updateGpuHost.mock.calls[0][1];
    expect(patch.status).toBe('online');
    expect(patch.name).toBe('gpu-prod-01');
    expect(patch.terminalEnabled).toBe(true);
    expect(patch.labels).toMatchObject({ env: 'prod' });
  });
});

describe('rejectPendingHost', () => {
  it('refuses to reject hosts that are not pending_claim', async () => {
    db.findGpuHostById.mockResolvedValue({ ...HOST_BASE, status: 'online' });
    await expect(
      rejectPendingHost({ tenantDbName: TENANT_DB, tenantId: TENANT_ID, hostId: 'host-1' }),
    ).rejects.toThrow(/Cannot reject/);
  });

  it('deletes a pending_claim host', async () => {
    db.findGpuHostById.mockResolvedValue({ ...HOST_BASE, status: 'pending_claim' });
    db.deleteGpuHost.mockResolvedValue(true);
    const ok = await rejectPendingHost({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      hostId: 'host-1',
    });
    expect(ok).toBe(true);
    expect(db.deleteGpuHost).toHaveBeenCalledWith('host-1');
  });
});

describe('touchHostHeartbeat', () => {
  it('keeps pending_claim sticky (does not auto-promote)', async () => {
    db.findGpuHostById.mockResolvedValue({ ...HOST_BASE, status: 'pending_claim' });
    await touchHostHeartbeat(TENANT_DB, 'host-1', '0.1.0');
    const patch = db.updateGpuHost.mock.calls[0][1];
    expect(patch.status).toBe('pending_claim');
  });

  it('flips offline back to online on heartbeat', async () => {
    db.findGpuHostById.mockResolvedValue({ ...HOST_BASE, status: 'offline' });
    await touchHostHeartbeat(TENANT_DB, 'host-1', '0.1.0');
    const patch = db.updateGpuHost.mock.calls[0][1];
    expect(patch.status).toBe('online');
  });
});

describe('authenticateAgent', () => {
  it('returns null when no host has the given token hash', async () => {
    db.findGpuHostByAgentTokenHash.mockResolvedValue(null);
    const host = await authenticateAgent(TENANT_DB, 'gpuat_xxx');
    expect(host).toBeNull();
  });

  it('returns the host when the token hash matches', async () => {
    const raw = 'gpuat_match';
    db.findGpuHostByAgentTokenHash.mockResolvedValue({
      ...HOST_BASE,
      agentTokenHash: hashToken(raw),
      status: 'online',
    });
    const host = await authenticateAgent(TENANT_DB, raw);
    expect(host?.id).toBe('host-1');
  });

  it('refuses tokens that look right but hash differently (defensive)', async () => {
    const stored = hashToken('gpuat_stored');
    db.findGpuHostByAgentTokenHash.mockResolvedValue({
      ...HOST_BASE,
      agentTokenHash: stored,
    });
    const host = await authenticateAgent(TENANT_DB, 'gpuat_different');
    expect(host).toBeNull();
  });
});
