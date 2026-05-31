/**
 * Event ingestor — applies agent-reported events to console state.
 *
 * Events arrive in batches via POST /api/gpu/agent/events. Each one is:
 *   1. Persisted in `gpu_fleet_events` (append-only audit log).
 *   2. Optionally turned into a state mutation (deployment state, command
 *      completion, slice refresh).
 *
 * Sequence numbers from the agent are monotonic per host. Any gap means we
 * lost an event — logged loudly but not blocking (best-effort design).
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { GpuFleetEvent } from '@cognipeer/gpu-fleet-protocol';
import { markCommandCompleted, markCommandFailed } from './commandQueue';
import {
  ensureInferenceServerForDeployment,
  removeInferenceServerForDeployment,
} from './autoRegister';

const log = createLogger('gpu-fleet:events');

export interface IngestEventsResult {
  accepted: number;
  highWatermark: number;
}

export async function ingestAgentEvents(args: {
  tenantDbName: string;
  tenantId: string;
  hostId: string;
  events: GpuFleetEvent[];
}): Promise<IngestEventsResult> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const host = await db.findGpuHostById(args.hostId);
  if (!host) {
    return { accepted: 0, highWatermark: 0 };
  }

  let watermark = host.lastEventSequence ?? 0;
  let accepted = 0;

  for (const event of args.events) {
    if (event.sequence <= watermark) continue; // dedupe replays

    try {
      await db.appendGpuFleetEvent({
        tenantId: args.tenantId,
        hostId: args.hostId,
        sequence: event.sequence,
        kind: event.kind,
        occurredAt: new Date(event.occurredAt),
        payload: event as unknown as Record<string, unknown>,
      });
    } catch (error) {
      // The (hostId, sequence) UNIQUE constraint can fire if the same
      // sequence was already inserted by a previous agent incarnation
      // (operator wiped agent state dir → agent restarts sequence at 1
      // while old events with seq=1 are still in the table). Skip the
      // duplicate so the rest of the batch is processed; the watermark
      // bump below ensures we move past it. Any other error is fatal.
      const msg = error instanceof Error ? error.message : String(error);
      if (/UNIQUE|duplicate key/i.test(msg)) {
        watermark = Math.max(watermark, event.sequence);
        continue;
      }
      throw error;
    }
    await applyEvent(args.tenantDbName, args.tenantId, args.hostId, event);
    watermark = event.sequence;
    accepted += 1;
  }

  if (watermark !== host.lastEventSequence) {
    await db.updateGpuHost(args.hostId, { lastEventSequence: watermark });
  }
  return { accepted, highWatermark: watermark };
}

async function applyEvent(
  tenantDbName: string,
  tenantId: string,
  hostId: string,
  event: GpuFleetEvent,
): Promise<void> {
  switch (event.kind) {
    case 'command-completed': {
      // Look the command up BEFORE marking completed so we can branch on
      // its kind. For remove-deployment, the row + slice purge happens
      // here — not eagerly in deleteDeployment — so the UI shows the
      // deployment until the host actually confirms removal.
      const { getDatabase } = await import('@/lib/database');
      const db = await getDatabase();
      await db.switchToTenant(tenantDbName);
      const cmd = await db.findGpuFleetCommandById(event.commandId);
      await markCommandCompleted(tenantDbName, event.commandId);
      if (cmd?.kind === 'remove-deployment') {
        const deploymentId = (cmd.payload as { deploymentId?: string } | null)?.deploymentId
          ?? cmd.resourceRef
          ?? null;
        if (deploymentId) {
          const { purgeRemovedDeployment } = await import('./deploymentService');
          await purgeRemovedDeployment(tenantDbName, deploymentId);
          log.info('deployment purged after agent confirmed removal', { deploymentId });
        }
      }
      return;
    }
    case 'command-failed':
      await markCommandFailed(tenantDbName, event.commandId, event.error);
      return;
    case 'deployment-state-changed':
      await applyDeploymentStateChange(tenantDbName, event);
      return;
    case 'mig-layout-applied':
      // Drop slices that belong to this GPU. The agent's next heartbeat
      // ships the authoritative list; we don't re-create from sliceUuids
      // alone because we don't know memoryMiB/profile here.
      await purgeSlicesForGpu(tenantDbName, hostId, event.gpuUuid);
      log.info('mig-layout-applied: slices purged, awaiting heartbeat refresh', {
        hostId,
        gpuUuid: event.gpuUuid,
        newSliceCount: event.sliceUuids.length,
      });
      return;
    case 'agent-error':
      log.warn('agent-error event', { hostId, source: event.source, error: event.error });
      return;
    case 'command-accepted':
    case 'log-snapshot':
    case 'image-pull-progress':
      // Already persisted in event log; nothing else to mutate.
      return;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }
  void tenantId;
}

async function purgeSlicesForGpu(
  tenantDbName: string,
  hostId: string,
  gpuUuid: string,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  await db.deleteGpuSlicesForGpu(hostId, gpuUuid);
}

async function applyDeploymentStateChange(
  tenantDbName: string,
  event: Extract<GpuFleetEvent, { kind: 'deployment-state-changed' }>,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const deployment = await db.findLlmDeploymentById(event.deploymentId);
  if (!deployment) return;
  // Don't let a late 'failed' event (from an aborted pull) overwrite
  // the 'removing' state we set in deleteDeployment. The operator has
  // already decided to delete this deployment — surfacing "failed" in
  // the UI while we're cleaning up would be a confusing mid-state.
  if (deployment.actualState === 'removing' && event.state === 'failed') {
    return;
  }
  await db.updateLlmDeployment(event.deploymentId, {
    actualState: event.state,
    containerId: event.containerId,
    lastHealthyAt: event.state === 'healthy' ? new Date() : deployment.lastHealthyAt,
    lastError: event.state === 'failed' || event.state === 'unhealthy' ? event.message ?? null : null,
  });

  // Auto-fetch container logs on first transition into failed/unhealthy.
  // Without this, the operator has to manually click "Get logs" to see
  // why vLLM crashed — log-snapshot events already flow through the
  // event log, so this only costs one extra command.
  if (
    (event.state === 'failed' || event.state === 'unhealthy') &&
    deployment.actualState !== event.state &&
    deployment.containerId // container existed, so it has logs
  ) {
    try {
      const { enqueueCommand } = await import('./commandQueue');
      await enqueueCommand({
        tenantDbName,
        tenantId: deployment.tenantId,
        hostId: deployment.hostId,
        kind: 'collect-logs',
        payload: { deploymentId: event.deploymentId, tailLines: 200 },
        resourceRef: event.deploymentId,
        createdBy: 'auto-fetch-on-failure',
      });
    } catch (err) {
      log.warn('auto-fetch logs on failure: enqueue failed', {
        deploymentId: event.deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (event.state === 'healthy') {
    const host = await db.findGpuHostById(deployment.hostId);
    if (host) {
      try {
        await ensureInferenceServerForDeployment({
          tenantDbName,
          tenantId: deployment.tenantId,
          deployment: (await db.findLlmDeploymentById(event.deploymentId))!,
          host,
          actorUserId: 'gpu-fleet:auto-register',
        });
      } catch (error) {
        log.warn('auto-register inference-server failed', {
          deploymentId: event.deploymentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Also auto-publish to Model Hub so the operator can hit the
      // deployment from the OpenAI SDK + Playground without having to
      // manually create a pool. Single-member pool is created if none
      // exists yet. Failures are non-fatal — server already registered.
      try {
        const { publishDeploymentToModelHub } = await import('./autoRegister');
        const freshDeployment = await db.findLlmDeploymentById(event.deploymentId);
        if (freshDeployment) {
          // Best-effort console URL: env var first, then localhost on the
          // configured port. Pool proxy is INTERNAL — Model Hub calls it
          // back to the same console process, so localhost works unless
          // someone explicitly fronts the platform with a public hostname.
          const port = process.env.PORT ?? '3000';
          const consoleBaseUrl =
            process.env.PUBLIC_BASE_URL?.replace(/\/$/, '')
            ?? `http://localhost:${port}`;
          await publishDeploymentToModelHub({
            tenantDbName,
            tenantId: deployment.tenantId,
            deployment: freshDeployment,
            consoleBaseUrl,
            actorUserId: 'gpu-fleet:auto-register',
            modality: 'llm',
          });
        }
      } catch (error) {
        log.warn('auto-publish to model hub failed', {
          deploymentId: event.deploymentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (event.state === 'stopped' || event.state === 'failed') {
    const fresh = await db.findLlmDeploymentById(event.deploymentId);
    if (fresh?.inferenceServerKey) {
      try {
        await removeInferenceServerForDeployment({ tenantDbName, deployment: fresh });
      } catch (error) {
        log.warn('auto-unregister inference-server failed', {
          deploymentId: event.deploymentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
