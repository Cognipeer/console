/**
 * Sandbox event ingestor: watermark dedup + per-kind state mutations.
 */

import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return { ...actual, getDatabase: vi.fn() };
});
import { getDatabase, type ISandboxRunner } from '@/lib/database';
import type { SandboxEvent } from '@cognipeer/sandbox-protocol';
import { ingestEvents } from '@/lib/services/sandbox/eventIngestor';

let db: MockDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as Mock).mockResolvedValue(db);
});

function makeRunner(lastEventSequence: number): ISandboxRunner {
  return {
    id: 'r1',
    tenantId: 't1',
    name: 'runner-1',
    status: 'online',
    labels: {},
    inventory: null,
    agentTokenHash: 'x',
    agentTokenVersion: 1,
    registrationTokenHash: null,
    registrationTokenExpiresAt: null,
    lastSeenAt: null,
    lastEventSequence,
    terminalEnabled: true,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('sandbox eventIngestor', () => {
  it('skips events at or below the watermark, accepts newer ones', async () => {
    db.appendSandboxEvent.mockResolvedValue({ inserted: true });
    const runner = makeRunner(5);
    const events: SandboxEvent[] = [
      { kind: 'command-accepted', commandId: 'c1', sequence: 3, occurredAt: new Date().toISOString() },
      { kind: 'command-accepted', commandId: 'c2', sequence: 6, occurredAt: new Date().toISOString() },
      { kind: 'command-accepted', commandId: 'c3', sequence: 7, occurredAt: new Date().toISOString() },
    ];

    const result = await ingestEvents({ tenantDbName: 't', tenantId: 't1', runner, events });

    expect(result.accepted).toBe(2);
    expect(result.highWatermark).toBe(7);
    // Only the two newer events were appended.
    expect(db.appendSandboxEvent).toHaveBeenCalledTimes(2);
    // Watermark persisted on the runner.
    expect(db.updateSandboxRunner).toHaveBeenCalledWith('r1', expect.objectContaining({ lastEventSequence: 7 }));
  });

  it('does not advance the watermark when nothing new arrives', async () => {
    const runner = makeRunner(10);
    const events: SandboxEvent[] = [
      { kind: 'command-accepted', commandId: 'c1', sequence: 9, occurredAt: new Date().toISOString() },
    ];
    const result = await ingestEvents({ tenantDbName: 't', tenantId: 't1', runner, events });
    expect(result.accepted).toBe(0);
    expect(db.appendSandboxEvent).not.toHaveBeenCalled();
    expect(db.updateSandboxRunner).not.toHaveBeenCalled();
  });

  it('applies state mutations: command-completed + instance-state-changed', async () => {
    db.appendSandboxEvent.mockResolvedValue({ inserted: true });
    const runner = makeRunner(0);
    const events: SandboxEvent[] = [
      { kind: 'command-completed', commandId: 'cmd-9', sequence: 1, occurredAt: new Date().toISOString() },
      {
        kind: 'instance-state-changed',
        instanceId: 'inst-1',
        state: 'running',
        containerId: 'abc123',
        sequence: 2,
        occurredAt: new Date().toISOString(),
      },
    ];

    await ingestEvents({ tenantDbName: 't', tenantId: 't1', runner, events });

    expect(db.updateSandboxCommandStatus).toHaveBeenCalledWith('cmd-9', 'completed', expect.any(Object));
    expect(db.updateSandboxInstance).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ actualState: 'running', containerId: 'abc123' }),
    );
  });
});
