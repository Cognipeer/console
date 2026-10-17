/**
 * BullMQ rejects a job id with ':' — a dedup key must reach `queue.add` as a
 * colon-free id, on both publish and invoke, and stay stable (same key, same id).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class {
    add = hoisted.add;
    close = vi.fn();
  },
  QueueEvents: class {
    close = vi.fn();
  },
  Worker: class {},
}));
vi.mock('ioredis', () => ({
  Redis: class {
    disconnect = vi.fn();
  },
}));
vi.mock('@/lib/core/cluster/nodeRegistry', () => ({ getThisNodeName: () => 'node-a' }));

import { BullMQQueueProvider, sanitizeBullmqJobId } from '@/lib/core/queue/bullmqQueueProvider';

describe('BullMQ dedup key', () => {
  let provider: BullMQQueueProvider;

  beforeEach(async () => {
    hoisted.add.mockReset();
    hoisted.add.mockResolvedValue({ id: 'job-1', waitUntilFinished: vi.fn().mockResolvedValue('ok') });
    provider = new BullMQQueueProvider({ redisUrl: 'redis://x', prefix: 'console:q:', defaultAttempts: 3, defaultBackoffMs: 1000 });
    await provider.init();
  });

  it('replaces ":" so BullMQ accepts the job id', () => {
    expect(sanitizeBullmqJobId('trigger:abc:2026-10-17T10:00:00.000Z')).toBe('trigger_abc_2026-10-17T10_00_00.000Z');
    expect(sanitizeBullmqJobId('ar_run1_2')).toBe('ar_run1_2');
    expect(sanitizeBullmqJobId(undefined)).toBeUndefined();
  });

  it('publish passes the sanitized id as jobId', async () => {
    await provider.publish('agent-runs', 'run', { runId: 'r1' }, { dedupKey: 'ar:r1:1' });
    expect(hoisted.add.mock.calls[0][2].jobId).toBe('ar_r1_1');
  });

  it('invoke passes the sanitized id as jobId', async () => {
    await provider.invoke('agent', 'chat', { a: 1 }, { dedupKey: 'x:y' });
    expect(hoisted.add.mock.calls[0][2].jobId).toBe('x_y');
  });

  it('without a dedup key BullMQ generates the id', async () => {
    await provider.publish('agent-runs', 'run', { runId: 'r1' });
    expect(hoisted.add.mock.calls[0][2].jobId).toBeUndefined();
  });
});
