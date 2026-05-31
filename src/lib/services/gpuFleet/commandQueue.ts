/**
 * Command queue helpers.
 *
 * Commands are enqueued by services (deployment apply, MIG reconfigure) and
 * drained by the agent through long-poll. The queue is per-host and FIFO.
 * Status transitions:
 *   pending -> delivered (agent picked it up via /commands)
 *   delivered -> completed | failed (agent reported via /events)
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type IGpuFleetCommand } from '@/lib/database';
import type { GpuFleetCommand } from '@cognipeer/gpu-fleet-protocol';

const log = createLogger('gpu-fleet:queue');

export async function enqueueCommand(args: {
  tenantDbName: string;
  tenantId: string;
  hostId: string;
  kind: GpuFleetCommand['kind'];
  payload: Record<string, unknown>;
  resourceRef?: string | null;
  createdBy: string;
}): Promise<IGpuFleetCommand> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const command = await db.enqueueGpuFleetCommand({
    id: randomUUID(),
    tenantId: args.tenantId,
    hostId: args.hostId,
    kind: args.kind,
    payload: args.payload,
    status: 'pending',
    attempts: 0,
    lastError: null,
    issuedAt: new Date(),
    deliveredAt: null,
    completedAt: null,
    resourceRef: args.resourceRef ?? null,
    createdBy: args.createdBy,
  });
  log.info('gpu-fleet command enqueued', {
    commandId: command.id,
    hostId: args.hostId,
    kind: args.kind,
  });
  return command;
}

/** Hydrate stored DB rows into the on-the-wire `GpuFleetCommand` shape. */
function toWireCommand(record: IGpuFleetCommand): GpuFleetCommand {
  return {
    id: record.id,
    kind: record.kind as GpuFleetCommand['kind'],
    issuedAt: record.issuedAt.toISOString(),
    ...record.payload,
  } as GpuFleetCommand;
}

export async function fetchPendingCommandsForAgent(args: {
  tenantDbName: string;
  hostId: string;
  limit?: number;
}): Promise<GpuFleetCommand[]> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const records = await db.listPendingGpuFleetCommands(args.hostId, args.limit ?? 16);
  if (records.length === 0) return [];

  const now = new Date();
  for (const record of records) {
    if (record.status === 'pending') {
      await db.updateGpuFleetCommandStatus(record.id, 'delivered', {
        deliveredAt: now,
        attemptsDelta: 1,
      });
    }
  }
  return records.map(toWireCommand);
}

export async function markCommandCompleted(
  tenantDbName: string,
  commandId: string,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  await db.updateGpuFleetCommandStatus(commandId, 'completed', { completedAt: new Date() });
}

export async function markCommandFailed(
  tenantDbName: string,
  commandId: string,
  error: string,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  await db.updateGpuFleetCommandStatus(commandId, 'failed', {
    completedAt: new Date(),
    lastError: error,
  });
}
