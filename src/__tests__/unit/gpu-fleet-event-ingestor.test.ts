/**
 * Event ingestor — the side of the system that turns agent-emitted events
 * into console-side state changes. We test:
 *
 *   - replay dedup (sequence already seen → skipped)
 *   - command completion / failure propagation
 *   - deployment state transitions (healthy / unhealthy / stopped / failed)
 *   - mig-layout-applied purges stale slice rows
 */

import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return { ...actual, getDatabase: vi.fn() };
});
import { getDatabase } from '@/lib/database';

import { ingestAgentEvents } from '@/lib/services/gpuFleet/eventIngestor';
import type { GpuFleetEvent } from '@cognipeer/gpu-fleet-protocol';

let db: MockDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as Mock).mockResolvedValue(db);
});

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 't1';
const HOST_ID = 'h1';

const HOST = {
  id: HOST_ID,
  tenantId: TENANT_ID,
  name: 'gpu-01',
  provider: 'azure' as const,
  status: 'online' as const,
  accelerator: 'nvidia-gpu' as const,
  gpuFramework: 'cuda' as const,
  serviceAddress: '10.0.0.1',
  terminalEnabled: false,
  agentTokenHash: 'h',
  agentTokenVersion: 1,
  registrationTokenHash: null,
  registrationTokenExpiresAt: null,
  inventory: null,
  labels: {},
  lastHeartbeatAt: null,
  lastEventSequence: 0,
  agentVersion: '0.1.0',
  createdBy: 'u',
};

describe('ingestAgentEvents', () => {
  it('returns zero when host does not exist', async () => {
    db.findGpuHostById.mockResolvedValue(null);
    const result = await ingestAgentEvents({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      hostId: HOST_ID,
      events: [],
    });
    expect(result).toEqual({ accepted: 0, highWatermark: 0 });
  });

  it('deduplicates events whose sequence is already covered by the watermark', async () => {
    db.findGpuHostById.mockResolvedValue({ ...HOST, lastEventSequence: 5 });
    const events: GpuFleetEvent[] = [
      { kind: 'agent-error', sequence: 3, occurredAt: new Date().toISOString(), source: 's', error: 'old' },
      { kind: 'agent-error', sequence: 7, occurredAt: new Date().toISOString(), source: 's', error: 'new' },
    ];
    const result = await ingestAgentEvents({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      hostId: HOST_ID,
      events,
    });
    expect(result.accepted).toBe(1);
    expect(result.highWatermark).toBe(7);
    expect(db.appendGpuFleetEvent).toHaveBeenCalledTimes(1);
  });

  it('marks commands completed/failed from the corresponding events', async () => {
    db.findGpuHostById.mockResolvedValue(HOST);
    const events: GpuFleetEvent[] = [
      { kind: 'command-completed', sequence: 1, occurredAt: new Date().toISOString(), commandId: 'c1' },
      { kind: 'command-failed', sequence: 2, occurredAt: new Date().toISOString(), commandId: 'c2', error: 'oops', retryable: false },
    ];
    await ingestAgentEvents({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      hostId: HOST_ID,
      events,
    });
    expect(db.updateGpuFleetCommandStatus).toHaveBeenCalledWith('c1', 'completed', expect.any(Object));
    expect(db.updateGpuFleetCommandStatus).toHaveBeenCalledWith(
      'c2',
      'failed',
      expect.objectContaining({ lastError: 'oops' }),
    );
  });

  it('flips deployment state on deployment-state-changed events', async () => {
    db.findGpuHostById.mockResolvedValue(HOST);
    db.findLlmDeploymentById.mockResolvedValue({
      _id: 'd1',
      id: 'd1',
      tenantId: TENANT_ID,
      hostId: HOST_ID,
      sliceUuid: 's1',
      name: 'qwen-1',
      runtime: 'vllm',
      image: 'vllm/vllm-openai:v0.6.4',
      modelName: 'Qwen/Qwen2.5-7B-Instruct',
      args: [],
      env: {},
      port: 8000,
      healthPath: '/health',
      volumes: [],
      restart: 'unless-stopped',
      desiredState: 'running',
      actualState: 'starting',
      containerId: null,
      lastHealthyAt: null,
      lastError: null,
      inferenceServerKey: null,
      createdBy: 'u',
    });

    const events: GpuFleetEvent[] = [
      {
        kind: 'deployment-state-changed',
        sequence: 1,
        occurredAt: new Date().toISOString(),
        deploymentId: 'd1',
        state: 'healthy',
        containerId: 'c-abc',
      },
    ];
    await ingestAgentEvents({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      hostId: HOST_ID,
      events,
    });
    const patch = db.updateLlmDeployment.mock.calls[0][1];
    expect(patch.actualState).toBe('healthy');
    expect(patch.containerId).toBe('c-abc');
  });

  it('purges stale slice rows when mig-layout-applied is received', async () => {
    db.findGpuHostById.mockResolvedValue(HOST);
    const events: GpuFleetEvent[] = [
      {
        kind: 'mig-layout-applied',
        sequence: 1,
        occurredAt: new Date().toISOString(),
        gpuUuid: 'gpu-abc',
        sliceUuids: ['mig-1', 'mig-2'],
      },
    ];
    await ingestAgentEvents({
      tenantDbName: TENANT_DB,
      tenantId: TENANT_ID,
      hostId: HOST_ID,
      events,
    });
    expect(db.deleteGpuSlicesForGpu).toHaveBeenCalledWith(HOST_ID, 'gpu-abc');
  });
});
