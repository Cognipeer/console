/**
 * Ingests events reported by a runner agent.
 *
 * Dedup strategy: a per-runner monotonic `sequence` watermark
 * (runner.lastEventSequence) plus a UNIQUE(runnerId, sequence) backstop in the
 * event log. Events at or below the watermark are skipped (replay protection
 * for agent restarts). Mutations are applied per event kind.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { ISandboxRunner } from '@/lib/database/provider.interface';
import type { SandboxEvent, SandboxInstanceState } from '@cognipeer/sandbox-protocol';
import { resolveExecResult } from './execBridge';

const log = createLogger('sandbox:events');

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export async function ingestEvents(args: {
  tenantDbName: string;
  tenantId: string;
  runner: ISandboxRunner;
  events: SandboxEvent[];
}): Promise<{ accepted: number; highWatermark: number }> {
  const db = await withTenantDb(args.tenantDbName);
  const sorted = [...args.events].sort((a, b) => a.sequence - b.sequence);
  let watermark = args.runner.lastEventSequence;
  let accepted = 0;

  for (const event of sorted) {
    if (event.sequence <= watermark) continue; // replay / duplicate

    const { inserted } = await db.appendSandboxEvent({
      id: randomUUID(),
      tenantId: args.tenantId,
      runnerId: args.runner.id,
      sequence: event.sequence,
      kind: event.kind,
      payload: event as unknown as Record<string, unknown>,
      occurredAt: new Date(event.occurredAt),
      receivedAt: new Date(),
    });
    if (!inserted) continue;

    accepted += 1;
    watermark = Math.max(watermark, event.sequence);
    await applyMutation(args.tenantDbName, event);
  }

  if (watermark > args.runner.lastEventSequence) {
    await db.updateSandboxRunner(args.runner.id, { lastEventSequence: watermark, lastSeenAt: new Date() });
  }

  return { accepted, highWatermark: watermark };
}

async function applyMutation(tenantDbName: string, event: SandboxEvent): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  switch (event.kind) {
    case 'command-completed':
      await db.updateSandboxCommandStatus(event.commandId, 'completed', { completedAt: new Date() });
      break;
    case 'command-failed':
      await db.updateSandboxCommandStatus(event.commandId, 'failed', {
        completedAt: new Date(),
        lastError: event.error,
      });
      break;
    case 'instance-state-changed':
      await db.updateSandboxInstance(event.instanceId, {
        actualState: event.state as SandboxInstanceState,
        containerId: event.containerId,
        ...(event.message ? { lastError: event.message } : {}),
      });
      break;
    case 'exec-result':
      resolveExecResult(event.execId, {
        exitCode: event.exitCode,
        stdout: event.stdout,
        stderr: event.stderr,
      });
      break;
    case 'image-pull-progress':
    case 'log-snapshot':
    case 'agent-error':
    case 'command-accepted':
      log.debug('sandbox event', { kind: event.kind });
      break;
    default:
      break;
  }
}
