/**
 * macOS + Apple Silicon adapter.
 *
 * The agent here is mostly for development on M-series machines and for
 * small on-prem deployments where one Mac mini serves Ollama. The GPU is
 * the integrated SoC: one logical "device" per machine, no partitioning,
 * Metal framework, MPS for ML workloads.
 *
 * We expose it as a single full-gpu slice whose memoryMiB matches the
 * machine's unified memory (since on Apple Silicon RAM == VRAM).
 */

import { totalmem } from 'node:os';
import type { GpuDeviceInventory, GpuSliceReport } from '@cognipeer/gpu-fleet-protocol';
import {
  baseSystemInventory,
  defaultHostname,
  detectDocker,
  detectPreferredServiceAddress,
  safeRun,
} from './common';
import type { PlatformAdapter } from './types';

const MIB = 1024 * 1024;

interface SystemProfilerGpu {
  sppci_model?: string;
  spdisplays_metalfamily?: string;
  spdisplays_vendor?: string;
  spdisplays_cores?: string;
}

async function probeAppleGpu(): Promise<GpuDeviceInventory[]> {
  const json = await safeRun('system_profiler', ['SPDisplaysDataType', '-json']);
  if (!json) {
    return [
      {
        index: 0,
        uuid: 'apple-gpu-0',
        productName: 'Apple Silicon GPU',
        memoryTotalMiB: Math.round(totalmem() / MIB),
        migEnabled: false,
        migCapable: false,
        computeCapability: null,
      },
    ];
  }
  try {
    const parsed = JSON.parse(json) as { SPDisplaysDataType?: SystemProfilerGpu[] };
    const list = parsed.SPDisplaysDataType ?? [];
    return list.slice(0, 1).map((entry, i): GpuDeviceInventory => ({
      index: i,
      uuid: `apple-gpu-${i}`,
      productName: entry.sppci_model ?? 'Apple Silicon GPU',
      // Unified memory: report system RAM, since VRAM is shared.
      memoryTotalMiB: Math.round(totalmem() / MIB),
      migEnabled: false,
      migCapable: false,
      computeCapability: entry.spdisplays_metalfamily ?? null,
    }));
  } catch {
    return [];
  }
}

function fullGpuSlice(gpu: GpuDeviceInventory): GpuSliceReport {
  return {
    uuid: gpu.uuid,
    gpuUuid: gpu.uuid,
    migGiId: null,
    migCiId: null,
    kind: 'full-gpu',
    profile: null,
    memoryMiB: gpu.memoryTotalMiB,
  };
}

export const macosAppleSiliconAdapter: PlatformAdapter = {
  id: 'macos-apple-silicon',
  accelerator: 'apple-silicon',
  gpuFramework: 'metal',
  supportsMig: false,
  async collectInventory({ hostnameOverride, agentVersion }) {
    const [gpus, docker] = await Promise.all([probeAppleGpu(), detectDocker()]);
    const slices = gpus.map(fullGpuSlice);
    const system = baseSystemInventory({
      agentVersion,
      dockerVersion: docker,
      nvidiaContainerToolkit: null,
    });
    system.os.distro = 'macOS';
    return {
      inventory: {
        hostname: defaultHostname(hostnameOverride),
        system,
        gpus,
        accelerator: 'apple-silicon',
        gpuFramework: 'metal',
        preferredServiceAddress: detectPreferredServiceAddress(null),
        labels: {},
        cloud: { provider: 'self' },
      },
      slices,
    };
  },
};
