/**
 * Linux + NVIDIA adapter. The original Phase 1 inventory code path lives here,
 * scoped to "host has nvidia-smi and Docker reachable on a Linux socket".
 */

import type { GpuDeviceInventory, GpuSliceReport } from '@cognipeer/gpu-fleet-protocol';
import { commandExists } from '../exec';
import {
  baseSystemInventory,
  defaultHostname,
  detectCloudMetadata,
  detectDistro,
  detectDocker,
  detectPreferredServiceAddress,
  safeRun,
} from './common';
import type { PlatformAdapter } from './types';

interface RawGpuCsvRow {
  index: string;
  uuid: string;
  name: string;
  memoryTotal: string;
  computeCapability: string;
  migMode: string;
}

async function probeGpus(): Promise<GpuDeviceInventory[]> {
  const csv = await safeRun('nvidia-smi', [
    '--query-gpu=index,uuid,name,memory.total,compute_cap,mig.mode.current',
    '--format=csv,noheader,nounits',
  ]);
  if (!csv) return [];
  return csv
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): RawGpuCsvRow => {
      const parts = line.split(',').map((s) => s.trim());
      return {
        index: parts[0] ?? '',
        uuid: parts[1] ?? '',
        name: parts[2] ?? '',
        memoryTotal: parts[3] ?? '0',
        computeCapability: parts[4] ?? '',
        migMode: parts[5] ?? 'Disabled',
      };
    })
    .map((r) => ({
      index: Number.parseInt(r.index, 10) || 0,
      uuid: r.uuid,
      productName: r.name,
      memoryTotalMiB: Number.parseInt(r.memoryTotal, 10) || 0,
      migEnabled: r.migMode.toLowerCase() === 'enabled',
      migCapable: /a100|h100|h200|b100/i.test(r.name),
      computeCapability: r.computeCapability || null,
    }));
}

function guessMemoryFromProfile(profile: string, fallbackMiB: number): number {
  const m = /\.(\d+)gb/i.exec(profile);
  if (!m) return fallbackMiB;
  return Number.parseInt(m[1], 10) * 1024;
}

async function probeSlices(gpus: GpuDeviceInventory[]): Promise<GpuSliceReport[]> {
  const output = await safeRun('nvidia-smi', ['-L']);
  if (!output) return [];
  const slices: GpuSliceReport[] = [];
  let currentGpu: GpuDeviceInventory | null = null;
  for (const line of output.split('\n')) {
    const gpuMatch = /^GPU\s+\d+:.*UUID:\s*([^)]+)\)/.exec(line);
    if (gpuMatch) {
      const uuid = gpuMatch[1].trim();
      currentGpu = gpus.find((g) => g.uuid === uuid) ?? null;
      if (currentGpu && !currentGpu.migEnabled) {
        slices.push({
          uuid: currentGpu.uuid,
          gpuUuid: currentGpu.uuid,
          migGiId: null,
          migCiId: null,
          kind: 'full-gpu',
          profile: null,
          memoryMiB: currentGpu.memoryTotalMiB,
        });
      }
      continue;
    }
    const migMatch = /MIG\s+(\S+)\s+Device\s+(\d+):.*UUID:\s*([^)]+)\)/.exec(line);
    if (migMatch && currentGpu) {
      const [, profile, ciStr, uuid] = migMatch;
      slices.push({
        uuid: uuid.trim(),
        gpuUuid: currentGpu.uuid,
        migGiId: null,
        migCiId: Number.parseInt(ciStr, 10),
        kind: 'mig',
        profile,
        memoryMiB: guessMemoryFromProfile(profile, currentGpu.memoryTotalMiB),
      });
    }
  }
  return slices;
}

async function probeNvidiaDriver(): Promise<string | null> {
  const out = await safeRun('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader']);
  return out?.split('\n')[0]?.trim() ?? null;
}

async function probeCuda(): Promise<string | null> {
  const out = await safeRun('nvidia-smi', []);
  if (!out) return null;
  const m = /CUDA Version:\s*([0-9.]+)/.exec(out);
  return m ? m[1] : null;
}

async function probeNvidiaContainerToolkit(): Promise<string | null> {
  if (!(await commandExists('nvidia-ctk'))) return null;
  const out = await safeRun('nvidia-ctk', ['--version']);
  if (!out) return null;
  const m = /v?([0-9]+\.[0-9]+\.[0-9]+)/.exec(out);
  return m ? m[1] : out.trim();
}

export const linuxNvidiaAdapter: PlatformAdapter = {
  id: 'linux-nvidia',
  accelerator: 'nvidia-gpu',
  gpuFramework: 'cuda',
  supportsMig: true,
  async collectInventory({ hostnameOverride, agentVersion }) {
    const [gpus, nvidiaDriver, cuda, docker, nvidiaCtk, distro, cloud] = await Promise.all([
      probeGpus(),
      probeNvidiaDriver(),
      probeCuda(),
      detectDocker(),
      probeNvidiaContainerToolkit(),
      detectDistro(),
      detectCloudMetadata(),
    ]);
    const slices = await probeSlices(gpus);
    const system = baseSystemInventory({
      agentVersion,
      dockerVersion: docker,
      nvidiaContainerToolkit: nvidiaCtk,
      nvidiaDriver,
      cuda,
    });
    system.os.distro = distro;

    return {
      inventory: {
        hostname: defaultHostname(hostnameOverride),
        system,
        gpus,
        accelerator: 'nvidia-gpu',
        gpuFramework: 'cuda',
        preferredServiceAddress: detectPreferredServiceAddress(cloud),
        labels: {},
        cloud,
      },
      slices,
    };
  },
};
