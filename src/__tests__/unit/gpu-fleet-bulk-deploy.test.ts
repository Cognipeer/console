/**
 * Bulk deploy: makes a pool + N deployments, rolls back on partial failure.
 *
 * We stub the two seams (`createDeployment` and the pool service) so the
 * test focuses on the orchestration, not the underlying DB shape.
 */

import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return { ...actual, getDatabase: vi.fn() };
});
import { getDatabase, type ILlmDeployment, type ILlmPool } from '@/lib/database';

vi.mock('@/lib/services/gpuFleet/deploymentService', () => ({
  createDeployment: vi.fn(),
  deleteDeployment: vi.fn().mockResolvedValue(true),
  stopDeployment: vi.fn().mockResolvedValue(null),
  listDeploymentsByHost: vi.fn(),
  enqueueApplyDeployment: vi.fn(),
}));
vi.mock('@/lib/services/gpuFleet/poolService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/gpuFleet/poolService')>(
    '@/lib/services/gpuFleet/poolService',
  );
  return {
    ...actual,
    createLlmPool: vi.fn(),
  };
});

import { bulkDeployModel } from '@/lib/services/gpuFleet/bulkDeploy';
import { createDeployment, deleteDeployment } from '@/lib/services/gpuFleet/deploymentService';
import { createLlmPool } from '@/lib/services/gpuFleet/poolService';

let db: MockDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as Mock).mockResolvedValue(db);
});

function fakeDeployment(id: string): ILlmDeployment {
  return {
    _id: id,
    id,
    tenantId: 't1',
    hostId: `host-${id}`,
    sliceUuid: `slice-${id}`,
    name: id,
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
    actualState: 'pending',
    containerId: null,
    lastHealthyAt: null,
    lastError: null,
    inferenceServerKey: null,
    createdBy: 'u',
  };
}

function fakePool(deploymentIds: string[] = []): ILlmPool {
  return {
    _id: 'p',
    tenantId: 't1',
    key: 'qwen3-8b-pool',
    name: 'qwen2.5-7b pool',
    description: null,
    modelName: 'Qwen/Qwen2.5-7B-Instruct',
    modelLibraryId: 'qwen3-8b',
    algorithm: 'round-robin',
    status: 'active',
    deploymentIds,
    weights: {},
    providerKey: null,
    modelKey: null,
    createdBy: 'u',
  };
}

describe('bulkDeployModel', () => {
  it('rejects empty targets', async () => {
    await expect(
      bulkDeployModel({
        tenantDbName: 't',
        tenantId: 't1',
        modelLibraryId: 'qwen3-8b',
        runtimeKey: 'vllm',
        targets: [],
        poolName: 'p',
        createdBy: 'u',
      }),
    ).rejects.toThrow(/at least one target/i);
  });

  it('rejects an unknown model id', async () => {
    await expect(
      bulkDeployModel({
        tenantDbName: 't',
        tenantId: 't1',
        modelLibraryId: 'bogus',
        runtimeKey: 'vllm',
        targets: [{ hostId: 'h1', sliceUuid: 's1' }],
        poolName: 'p',
        createdBy: 'u',
      }),
    ).rejects.toThrow(/Unknown model/);
  });

  it('creates a pool and attaches all deployments on success', async () => {
    (createDeployment as Mock).mockImplementation(async ({ hostId }: { hostId: string }) =>
      fakeDeployment(hostId),
    );
    (createLlmPool as Mock).mockResolvedValue(fakePool());
    db.findLlmPoolByKey.mockResolvedValue(fakePool(['host-h1', 'host-h2']));

    const result = await bulkDeployModel({
      tenantDbName: 't',
      tenantId: 't1',
      modelLibraryId: 'qwen3-8b',
      runtimeKey: 'vllm',
      targets: [
        { hostId: 'h1', sliceUuid: 's1' },
        { hostId: 'h2', sliceUuid: 's2' },
      ],
      poolName: 'qwen pool',
      createdBy: 'u',
    });
    expect(result.deployments).toHaveLength(2);
    expect(result.pool.deploymentIds).toEqual(['host-h1', 'host-h2']);
  });

  it('rolls back created deployments when one fails mid-flight', async () => {
    (createDeployment as Mock)
      .mockImplementationOnce(async () => fakeDeployment('h1'))
      .mockImplementationOnce(async () => {
        throw new Error('host h2 unreachable');
      });

    await expect(
      bulkDeployModel({
        tenantDbName: 't',
        tenantId: 't1',
        modelLibraryId: 'qwen3-8b',
        runtimeKey: 'vllm',
        targets: [
          { hostId: 'h1', sliceUuid: 's1' },
          { hostId: 'h2', sliceUuid: 's2' },
        ],
        poolName: 'p',
        createdBy: 'u',
      }),
    ).rejects.toThrow(/host h2 unreachable/);

    // h1 already created → must be rolled back.
    expect(deleteDeployment).toHaveBeenCalledTimes(1);
  });
});
