/**
 * Command queue: enqueue + drain + mark complete/failed. The interesting
 * behaviour is the "delivered" state transition on poll — agents shouldn't
 * see the same command twice unless they retry.
 */

import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return { ...actual, getDatabase: vi.fn() };
});
import { getDatabase, type IGpuFleetCommand } from '@/lib/database';

import {
  enqueueCommand,
  fetchPendingCommandsForAgent,
  markCommandCompleted,
  markCommandFailed,
} from '@/lib/services/gpuFleet/commandQueue';

let db: MockDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as Mock).mockResolvedValue(db);
});

function makeCommand(id: string, status: IGpuFleetCommand['status'] = 'pending'): IGpuFleetCommand {
  return {
    id,
    tenantId: 't1',
    hostId: 'h1',
    kind: 'apply-deployment',
    payload: {},
    status,
    attempts: 0,
    lastError: null,
    issuedAt: new Date(),
    deliveredAt: null,
    completedAt: null,
    resourceRef: null,
    createdBy: 'user-1',
  };
}

describe('commandQueue', () => {
  it('enqueueCommand inserts with status pending', async () => {
    db.enqueueGpuFleetCommand.mockImplementation(async (cmd) => ({ ...cmd } as IGpuFleetCommand));
    const command = await enqueueCommand({
      tenantDbName: 't',
      tenantId: 't1',
      hostId: 'h1',
      kind: 'apply-deployment',
      payload: { foo: 'bar' },
      createdBy: 'u1',
    });
    expect(command.status).toBe('pending');
    expect(db.enqueueGpuFleetCommand).toHaveBeenCalled();
  });

  it('fetchPendingCommandsForAgent flips pending → delivered and bumps attempts', async () => {
    const a = makeCommand('a', 'pending');
    db.listPendingGpuFleetCommands.mockResolvedValue([a]);

    const result = await fetchPendingCommandsForAgent({
      tenantDbName: 't',
      hostId: 'h1',
    });
    expect(result.length).toBe(1);
    expect(db.updateGpuFleetCommandStatus).toHaveBeenCalledWith(
      'a',
      'delivered',
      expect.objectContaining({ attemptsDelta: 1 }),
    );
  });

  it('does not re-increment attempts on commands already in delivered state (retry path)', async () => {
    const retried = makeCommand('retry', 'delivered');
    db.listPendingGpuFleetCommands.mockResolvedValue([retried]);
    await fetchPendingCommandsForAgent({ tenantDbName: 't', hostId: 'h1' });
    expect(db.updateGpuFleetCommandStatus).not.toHaveBeenCalled();
  });

  it('markCommandCompleted/Failed transition status correctly', async () => {
    await markCommandCompleted('t', 'cmd-1');
    expect(db.updateGpuFleetCommandStatus).toHaveBeenCalledWith('cmd-1', 'completed', expect.any(Object));

    await markCommandFailed('t', 'cmd-2', 'boom');
    expect(db.updateGpuFleetCommandStatus).toHaveBeenCalledWith(
      'cmd-2',
      'failed',
      expect.objectContaining({ lastError: 'boom' }),
    );
  });
});
