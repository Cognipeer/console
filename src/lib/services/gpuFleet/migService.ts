/**
 * MIG reconfigure orchestration.
 *
 * Reconfiguring a GPU is destructive: every container bound to a slice on
 * that GPU dies. The console handles this by:
 *
 *   1. Finding deployments currently bound to slices on the target GPU.
 *   2. Flagging them as `draining` in the DB so the UI shows the transition.
 *   3. Enqueuing a single `apply-mig-profile` command that bundles the
 *      drain list — the agent stops those containers, then reconfigures.
 *   4. Emitting `mig-layout-applied` once nvidia-smi calls succeed; the
 *      event ingestor purges stale slice rows and the next heartbeat
 *      brings the new layout in.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, type ILlmDeployment } from '@/lib/database';
import type { DesiredMigLayout } from '@cognipeer/gpu-fleet-protocol';
import { enqueueCommand } from './commandQueue';

const log = createLogger('gpu-fleet:mig');

export interface ApplyMigLayoutInput {
  tenantDbName: string;
  tenantId: string;
  hostId: string;
  layout: DesiredMigLayout;
  createdBy: string;
}

export async function applyMigLayout(input: ApplyMigLayoutInput): Promise<{
  drainedDeploymentIds: string[];
  commandId: string;
}> {
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);

  const host = await db.findGpuHostById(input.hostId);
  if (!host || host.tenantId !== input.tenantId) {
    throw new Error('Host not found');
  }

  // Find all deployments pinned to a slice on this GPU.
  const slices = await db.listGpuSlicesByHost(input.hostId);
  const sliceUuidsOnGpu = new Set(
    slices.filter((s) => s.gpuUuid === input.layout.gpuUuid).map((s) => s.uuid),
  );
  const deployments = await db.listLlmDeploymentsByHost(input.hostId);
  const drain = deployments.filter(
    (d): d is ILlmDeployment =>
      d.sliceUuid !== null && sliceUuidsOnGpu.has(d.sliceUuid),
  );

  for (const deployment of drain) {
    await db.updateLlmDeployment(deployment.id, {
      actualState: 'draining',
      desiredState: 'stopped',
    });
  }

  const command = await enqueueCommand({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    hostId: input.hostId,
    kind: 'apply-mig-profile',
    payload: {
      layout: input.layout as unknown as Record<string, unknown>,
      drainDeploymentIds: drain.map((d) => d.id),
    },
    resourceRef: input.layout.gpuUuid,
    createdBy: input.createdBy,
  });

  log.info('mig reconfigure scheduled', {
    hostId: input.hostId,
    gpuUuid: input.layout.gpuUuid,
    profiles: input.layout.profiles,
    drained: drain.length,
  });

  return {
    drainedDeploymentIds: drain.map((d) => d.id),
    commandId: command.id,
  };
}
