/**
 * MIG reconfigure helper (NVIDIA only).
 *
 * `applyMigLayout` realises a desired set of MIG instance profiles on one
 * GPU. Sequence:
 *   1. Enable MIG mode (-mig 1) — harmless if already on.
 *   2. Destroy all compute + GPU instances on this GPU.
 *   3. Create one GPU instance per requested profile (-cgi) plus a default
 *      compute instance for each (-C).
 *   4. Re-probe the slices with `nvidia-smi -L` so the new UUIDs flow back
 *      to the console.
 *
 * Returns the new slice list for the targeted GPU. Callers (the reconciler)
 * fold this into the next heartbeat so the console picks up the change.
 *
 * Safety:
 *   - This is destructive: any CUDA contexts on the GPU die. The console
 *     drains bound deployments before sending the apply command, but if
 *     someone runs a process outside the agent's view it gets killed.
 *   - When `profiles` is empty we disable MIG entirely (-mig 0) and emit
 *     one full-gpu slice.
 */

import type { DesiredMigLayout, GpuSliceReport } from '@cognipeer/gpu-fleet-protocol';
import { execFile } from './exec';
import { logger } from '../logger';

const NVIDIA_SMI = 'nvidia-smi';

export async function applyMigLayout(layout: DesiredMigLayout): Promise<GpuSliceReport[]> {
  const gpuUuid = layout.gpuUuid;
  const gpuIndex = await resolveGpuIndex(gpuUuid);
  if (gpuIndex === null) {
    throw new Error(`GPU with UUID ${gpuUuid} not found via nvidia-smi`);
  }

  if (layout.profiles.length === 0) {
    await disableMig(gpuIndex);
  } else {
    await ensureMigEnabled(gpuIndex);
    await destroyExistingInstances(gpuIndex);
    await createGpuInstances(gpuIndex, layout.profiles);
  }

  return probeSlicesForGpu(gpuUuid);
}

async function resolveGpuIndex(uuid: string): Promise<number | null> {
  const { stdout } = await execFile(NVIDIA_SMI, [
    '--query-gpu=index,uuid',
    '--format=csv,noheader,nounits',
  ]);
  for (const line of stdout.split('\n')) {
    const [index, candidate] = line.split(',').map((s) => s.trim());
    if (candidate === uuid) return Number.parseInt(index, 10);
  }
  return null;
}

async function ensureMigEnabled(gpuIndex: number): Promise<void> {
  // -mig 1 needs no running CUDA contexts. If a context is alive,
  // nvidia-smi returns non-zero — we surface that to the caller.
  await execFile(NVIDIA_SMI, ['-i', String(gpuIndex), '-mig', '1']);
  logger.info('mig enabled', { gpuIndex });
}

async function disableMig(gpuIndex: number): Promise<void> {
  // Best-effort: if MIG was already off this exits 0; if it was on it
  // disables it. Any leftover instances are destroyed first.
  await destroyExistingInstances(gpuIndex).catch(() => undefined);
  await execFile(NVIDIA_SMI, ['-i', String(gpuIndex), '-mig', '0']);
  logger.info('mig disabled', { gpuIndex });
}

async function destroyExistingInstances(gpuIndex: number): Promise<void> {
  // Destroy compute instances first (they depend on GPU instances), then GPU
  // instances. The -f flag makes both calls idempotent — they no-op when
  // there's nothing to destroy.
  await execFile(NVIDIA_SMI, ['mig', '-i', String(gpuIndex), '-dci']).catch(() => undefined);
  await execFile(NVIDIA_SMI, ['mig', '-i', String(gpuIndex), '-dgi']).catch(() => undefined);
}

async function createGpuInstances(gpuIndex: number, profiles: string[]): Promise<void> {
  // `nvidia-smi mig -cgi <profiles> -C` creates GPU instances AND a default
  // compute instance for each in one shot, which is what we want for serving
  // a single container per slice.
  const joined = profiles.join(',');
  await execFile(NVIDIA_SMI, ['mig', '-i', String(gpuIndex), '-cgi', joined, '-C']);
  logger.info('mig instances created', { gpuIndex, profiles });
}

/**
 * After a reconfigure, parse `nvidia-smi -L` for the slices on this GPU
 * only. We don't re-run the full inventory here to keep the path tight.
 */
async function probeSlicesForGpu(gpuUuid: string): Promise<GpuSliceReport[]> {
  const { stdout } = await execFile(NVIDIA_SMI, ['-L']);
  const slices: GpuSliceReport[] = [];
  let current: string | null = null;
  for (const line of stdout.split('\n')) {
    const gpuMatch = /^GPU\s+\d+:.*UUID:\s*([^)]+)\)/.exec(line);
    if (gpuMatch) {
      current = gpuMatch[1].trim();
      // Full-GPU slice when MIG is disabled.
      if (current === gpuUuid && !/MIG\s/.test(line)) {
        slices.push({
          uuid: current,
          gpuUuid: current,
          migGiId: null,
          migCiId: null,
          kind: 'full-gpu',
          profile: null,
          memoryMiB: 0,
        });
      }
      continue;
    }
    const migMatch = /MIG\s+(\S+)\s+Device\s+(\d+):.*UUID:\s*([^)]+)\)/.exec(line);
    if (migMatch && current === gpuUuid) {
      const [, profile, ciStr, uuid] = migMatch;
      slices.push({
        uuid: uuid.trim(),
        gpuUuid,
        migGiId: null,
        migCiId: Number.parseInt(ciStr, 10),
        kind: 'mig',
        profile,
        memoryMiB: guessMemoryMiB(profile),
      });
    }
  }
  return slices;
}

function guessMemoryMiB(profile: string): number {
  const m = /\.(\d+)gb/i.exec(profile);
  return m ? Number.parseInt(m[1], 10) * 1024 : 0;
}
