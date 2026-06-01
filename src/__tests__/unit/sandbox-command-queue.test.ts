/**
 * Sandbox command queue: enqueue, drain (pending -> delivered), complete/fail.
 */

import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return { ...actual, getDatabase: vi.fn() };
});
import { getDatabase, type ISandboxCommand } from '@/lib/database';

import {
  enqueueCommand,
  fetchPendingCommandsForAgent,
  markCommandCompleted,
  markCommandFailed,
} from '@/lib/services/sandbox/commandQueue';

let db: MockDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as Mock).mockResolvedValue(db);
});

function makeCommand(id: string, status: ISandboxCommand['status'] = 'pending'): ISandboxCommand {
  return {
    id,
    tenantId: 't1',
    runnerId: 'r1',
    instanceId: 'i1',
    kind: 'create-sandbox',
    payload: { spec: { instanceId: 'i1' } },
    status,
    attempts: 0,
    lastError: null,
    issuedAt: new Date(),
    deliveredAt: null,
    completedAt: null,
    createdBy: 'user-1',
  };
}

describe('sandbox commandQueue', () => {
  it('enqueueCommand inserts with status pending', async () => {
    db.enqueueSandboxCommand.mockImplementation(async (cmd) => ({ ...cmd }) as ISandboxCommand);
    const command = await enqueueCommand({
      tenantDbName: 't',
      tenantId: 't1',
      runnerId: 'r1',
      kind: 'start-sandbox',
      payload: { instanceId: 'i1' },
      createdBy: 'u1',
    });
    expect(command.status).toBe('pending');
    expect(db.enqueueSandboxCommand).toHaveBeenCalled();
  });

  it('fetchPendingCommandsForAgent flips pending -> delivered and returns wire shape', async () => {
    const pending = makeCommand('c1', 'pending');
    db.listPendingSandboxCommands.mockResolvedValue([pending]);

    const wire = await fetchPendingCommandsForAgent({ tenantDbName: 't', runnerId: 'r1' });

    expect(db.updateSandboxCommandStatus).toHaveBeenCalledWith(
      'c1',
      'delivered',
      expect.objectContaining({ attemptsDelta: 1 }),
    );
    expect(wire[0]).toMatchObject({ id: 'c1', kind: 'create-sandbox' });
    // Payload fields are spread onto the wire command.
    expect((wire[0] as { spec?: unknown }).spec).toBeDefined();
  });

  it('does not re-deliver an already delivered command', async () => {
    db.listPendingSandboxCommands.mockResolvedValue([makeCommand('c2', 'delivered')]);
    await fetchPendingCommandsForAgent({ tenantDbName: 't', runnerId: 'r1' });
    expect(db.updateSandboxCommandStatus).not.toHaveBeenCalled();
  });

  it('markCommandCompleted / markCommandFailed set terminal status', async () => {
    await markCommandCompleted('t', 'c1');
    expect(db.updateSandboxCommandStatus).toHaveBeenCalledWith('c1', 'completed', expect.any(Object));

    await markCommandFailed('t', 'c3', 'boom');
    expect(db.updateSandboxCommandStatus).toHaveBeenCalledWith(
      'c3',
      'failed',
      expect.objectContaining({ lastError: 'boom' }),
    );
  });
});
