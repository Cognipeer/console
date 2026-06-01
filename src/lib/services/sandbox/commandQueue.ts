/**
 * Sandbox lifecycle command queue.
 *
 * Commands are enqueued by the console (create/start/stop/delete/terminal) and
 * drained by the runner agent through long-poll. Per-runner FIFO. Status:
 *   pending   -> delivered  (agent picked it up via /commands)
 *   delivered -> completed | failed (agent reported via /events)
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { ISandboxCommand } from '@/lib/database/provider.interface';
import type { SandboxCommand, SandboxCommandKind } from '@cognipeer/sandbox-protocol';

const log = createLogger('sandbox:queue');

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export async function enqueueCommand(args: {
  tenantDbName: string;
  tenantId: string;
  runnerId: string;
  instanceId?: string | null;
  kind: SandboxCommandKind;
  payload: Record<string, unknown>;
  createdBy: string;
}): Promise<ISandboxCommand> {
  const db = await withTenantDb(args.tenantDbName);
  const command = await db.enqueueSandboxCommand({
    id: randomUUID(),
    tenantId: args.tenantId,
    runnerId: args.runnerId,
    instanceId: args.instanceId ?? null,
    kind: args.kind,
    payload: args.payload,
    status: 'pending',
    attempts: 0,
    lastError: null,
    issuedAt: new Date(),
    deliveredAt: null,
    completedAt: null,
    createdBy: args.createdBy,
  });
  log.info('sandbox command enqueued', { commandId: command.id, runnerId: args.runnerId, kind: args.kind });
  return command;
}

/** Hydrate a stored row into the on-the-wire `SandboxCommand` shape. */
function toWireCommand(record: ISandboxCommand): SandboxCommand {
  return {
    id: record.id,
    kind: record.kind as SandboxCommandKind,
    issuedAt: record.issuedAt.toISOString(),
    ...record.payload,
  } as SandboxCommand;
}

export async function fetchPendingCommandsForAgent(args: {
  tenantDbName: string;
  runnerId: string;
  limit?: number;
}): Promise<SandboxCommand[]> {
  const db = await withTenantDb(args.tenantDbName);
  const records = await db.listPendingSandboxCommands(args.runnerId, args.limit ?? 16);
  if (records.length === 0) return [];
  const now = new Date();
  for (const record of records) {
    if (record.status === 'pending') {
      await db.updateSandboxCommandStatus(record.id, 'delivered', {
        deliveredAt: now,
        attemptsDelta: 1,
      });
    }
  }
  return records.map(toWireCommand);
}

export async function markCommandCompleted(tenantDbName: string, commandId: string): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  await db.updateSandboxCommandStatus(commandId, 'completed', { completedAt: new Date() });
}

export async function markCommandFailed(
  tenantDbName: string,
  commandId: string,
  error: string,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  await db.updateSandboxCommandStatus(commandId, 'failed', {
    completedAt: new Date(),
    lastError: error,
  });
}
