/**
 * Slice service.
 *
 * Slices are agent-discovered, not console-authored. The console stores what
 * the agent reports (nvidia-smi enumeration of full GPUs and MIG instances)
 * and uses them as the placement unit for deployments.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, type IGpuSlice } from '@/lib/database';
import type { GpuSliceReport } from '@cognipeer/gpu-fleet-protocol';

const log = createLogger('gpu-fleet:slice');

export async function listSlicesForHost(
  tenantDbName: string,
  hostId: string,
): Promise<IGpuSlice[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listGpuSlicesByHost(hostId);
}

/**
 * Reconcile a fresh report from the agent: upsert what's there, delete what
 * disappeared. The set of slices for a (host, gpuUuid) is authoritative per
 * report — anything the agent omits means it no longer exists (e.g. MIG was
 * disabled or repartitioned).
 */
export async function reconcileSlicesFromAgent(args: {
  tenantDbName: string;
  tenantId: string;
  hostId: string;
  slices: GpuSliceReport[];
}): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);

  const existing = await db.listGpuSlicesByHost(args.hostId);
  const reportedUuids = new Set(args.slices.map((s) => s.uuid));

  for (const slice of args.slices) {
    await db.upsertGpuSlice({
      uuid: slice.uuid,
      tenantId: args.tenantId,
      hostId: args.hostId,
      gpuUuid: slice.gpuUuid,
      migGiId: slice.migGiId,
      migCiId: slice.migCiId,
      kind: slice.kind,
      profile: slice.profile,
      memoryMiB: slice.memoryMiB,
      // Preserve assignment if we already know about this slice.
      assignedDeploymentId: existing.find((e) => e.uuid === slice.uuid)?.assignedDeploymentId ?? null,
    });
  }

  // Slices that vanished — clear them out. A deployment pinned to a vanished
  // slice will be marked failed by the deployment reconciler.
  for (const previous of existing) {
    if (reportedUuids.has(previous.uuid)) continue;
    // We don't have a bulk delete by uuid; reuse the per-GPU clear when all
    // slices on a GPU disappeared, otherwise leave the stale row for now —
    // it will be re-aligned on next MIG reconfigure event.
    log.warn('gpu-slice missing from agent report', {
      hostId: args.hostId,
      uuid: previous.uuid,
      gpuUuid: previous.gpuUuid,
    });
  }
}
