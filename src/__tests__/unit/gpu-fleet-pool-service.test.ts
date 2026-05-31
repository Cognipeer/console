/**
 * Pool member selection algorithms — round-robin, random, weighted-static,
 * least-busy. These must be deterministic enough to test without flakiness;
 * the random/weighted branches are gated on Math.random which we stub.
 */

import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return { ...actual, getDatabase: vi.fn() };
});
import { getDatabase } from '@/lib/database';

import { selectPoolMember, type SelectableMember } from '@/lib/services/gpuFleet/poolService';
import type { ILlmDeployment, ILlmPool } from '@/lib/database';

let db: MockDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as Mock).mockResolvedValue(db);
});

function makePool(overrides: Partial<ILlmPool> = {}): ILlmPool {
  return {
    tenantId: 't1',
    key: 'qwen-pool',
    name: 'Qwen Pool',
    description: null,
    modelName: 'Qwen/Qwen2.5-72B-Instruct',
    modelLibraryId: 'qwen3-32b',
    algorithm: 'round-robin',
    status: 'active',
    deploymentIds: [],
    weights: {},
    providerKey: null,
    modelKey: null,
    createdBy: 'user-1',
    ...overrides,
  };
}

function makeMember(id: string, address = '10.0.0.1', infKey: string | null = null): SelectableMember {
  return {
    deployment: {
      _id: id,
      id,
      tenantId: 't1',
      hostId: `host-${id}`,
      sliceUuid: null,
      name: `deployment-${id}`,
      runtime: 'vllm',
      image: 'vllm/vllm-openai:v0.6.4',
      modelName: 'Qwen/Qwen2.5-72B-Instruct',
      args: [],
      env: {},
      port: 8000,
      healthPath: '/health',
      volumes: [],
      restart: 'unless-stopped',
      desiredState: 'running',
      actualState: 'healthy',
      containerId: null,
      lastHealthyAt: null,
      lastError: null,
      inferenceServerKey: infKey,
      createdBy: 'user-1',
    } as ILlmDeployment,
    hostAddress: address,
  };
}

describe('selectPoolMember', () => {
  it('returns null when there are no candidates', async () => {
    const choice = await selectPoolMember(makePool(), []);
    expect(choice).toBeNull();
  });

  describe('round-robin', () => {
    it('cycles through members in order', async () => {
      const pool = makePool({ key: 'rr-test', algorithm: 'round-robin' });
      const a = makeMember('a');
      const b = makeMember('b');
      const c = makeMember('c');
      const picks: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const m = await selectPoolMember(pool, [a, b, c]);
        picks.push(m!.deployment.id);
      }
      expect(picks).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    });

    it('keeps a separate cursor per pool key', async () => {
      const poolX = makePool({ key: 'rr-x' });
      const poolY = makePool({ key: 'rr-y' });
      const a = makeMember('a');
      const b = makeMember('b');
      // Interleave both pools — neither should affect the other's cursor.
      const x1 = await selectPoolMember(poolX, [a, b]);
      const y1 = await selectPoolMember(poolY, [a, b]);
      const x2 = await selectPoolMember(poolX, [a, b]);
      const y2 = await selectPoolMember(poolY, [a, b]);
      expect([x1, x2].map((m) => m!.deployment.id)).toEqual(['a', 'b']);
      expect([y1, y2].map((m) => m!.deployment.id)).toEqual(['a', 'b']);
    });
  });

  describe('random', () => {
    it('always returns a candidate from the input set', async () => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const pool = makePool({ algorithm: 'random' });
      const members = [makeMember('a'), makeMember('b'), makeMember('c')];
      const m = await selectPoolMember(pool, members);
      expect(members.map((x) => x.deployment.id)).toContain(m!.deployment.id);
      spy.mockRestore();
    });
  });

  describe('weighted-static', () => {
    it('respects weights when picking', async () => {
      const pool = makePool({
        algorithm: 'weighted-static',
        weights: { a: 1, b: 3 }, // b should win 75% of the time
      });
      const a = makeMember('a');
      const b = makeMember('b');
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5); // total=4 → pick=2 → falls in b
      const choice = await selectPoolMember(pool, [a, b]);
      expect(choice!.deployment.id).toBe('b');
      spy.mockRestore();
    });

    it('falls back to the first candidate when all weights are zero', async () => {
      const pool = makePool({ algorithm: 'weighted-static', weights: { a: 0, b: 0 } });
      const choice = await selectPoolMember(pool, [makeMember('a'), makeMember('b')]);
      expect(choice!.deployment.id).toBe('a');
    });
  });

  describe('least-busy', () => {
    it('falls back to round-robin when no metrics are available', async () => {
      // No inferenceServerKey on any deployment → all scores are Infinity.
      const pool = makePool({ algorithm: 'least-busy', key: 'lb-no-metrics' });
      const a = makeMember('a');
      const b = makeMember('b');
      const first = await selectPoolMember(pool, [a, b]);
      const second = await selectPoolMember(pool, [a, b]);
      expect([first!.deployment.id, second!.deployment.id].sort()).toEqual(['a', 'b']);
    });

    it('picks the member with the lowest numRequestsRunning', async () => {
      const pool = makePool({ algorithm: 'least-busy', key: 'lb-real' });
      const a = makeMember('a', '10.0.0.1', 'srv-a');
      const b = makeMember('b', '10.0.0.2', 'srv-b');

      db.listInferenceServerMetrics.mockImplementation(async (key: string) => {
        const running = key === 'srv-a' ? 5 : 1;
        return [
          {
            _id: 'm',
            tenantId: 't1',
            serverKey: key,
            timestamp: new Date(),
            numRequestsRunning: running,
            createdAt: new Date(),
          },
        ];
      });

      const choice = await selectPoolMember(pool, [a, b]);
      expect(choice!.deployment.id).toBe('b');
    });

    it('breaks ties via round-robin so equal queue depths spread load', async () => {
      const pool = makePool({ algorithm: 'least-busy', key: 'lb-ties' });
      const a = makeMember('a', '10.0.0.1', 'srv-a');
      const b = makeMember('b', '10.0.0.2', 'srv-b');
      db.listInferenceServerMetrics.mockResolvedValue([
        {
          _id: 'm',
          tenantId: 't1',
          serverKey: 'srv-x',
          timestamp: new Date(),
          numRequestsRunning: 2,
          createdAt: new Date(),
        },
      ]);
      const picks = [
        (await selectPoolMember(pool, [a, b]))!.deployment.id,
        (await selectPoolMember(pool, [a, b]))!.deployment.id,
      ];
      // RR over the tied set hits both deployments once across two calls.
      expect(picks.sort()).toEqual(['a', 'b']);
    });
  });
});
