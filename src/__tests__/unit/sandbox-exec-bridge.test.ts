/**
 * Exec bridge: the in-server request/response correlation used by the client
 * token API. An `exec-result` event must resolve the awaiting promise.
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
import { awaitExecResult, resolveExecResult } from '@/lib/services/sandbox/execBridge';

let db: MockDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as Mock).mockResolvedValue(db);
});

function runner(): ISandboxRunner {
  return {
    id: 'r1', tenantId: 't1', name: 'r', status: 'online', labels: {}, inventory: null,
    agentTokenHash: 'h', agentTokenVersion: 1, registrationTokenHash: null, registrationTokenExpiresAt: null,
    lastSeenAt: null, lastEventSequence: 0, terminalEnabled: true, createdBy: 'u', createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('sandbox execBridge', () => {
  it('an exec-result event resolves the awaiting promise', async () => {
    db.appendSandboxEvent.mockResolvedValue({ inserted: true });
    const waiter = awaitExecResult('exec-7', 5000);

    const events: SandboxEvent[] = [
      {
        kind: 'exec-result', execId: 'exec-7', instanceId: 'i1',
        exitCode: 0, stdout: 'hello\n', stderr: '',
        sequence: 1, occurredAt: new Date().toISOString(),
      },
    ];
    await ingestEvents({ tenantDbName: 't', tenantId: 't1', runner: runner(), events });

    const result = await waiter;
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hello\n', stderr: '' });
  });

  it('times out when no result arrives', async () => {
    const result = await awaitExecResult('exec-missing', 30);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it('resolveExecResult is a no-op for unknown execId', () => {
    expect(() => resolveExecResult('nope', { exitCode: 0, stdout: '', stderr: '' })).not.toThrow();
  });
});
