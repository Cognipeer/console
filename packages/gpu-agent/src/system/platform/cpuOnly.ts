/**
 * Pure-CPU fallback adapter. Picked when no GPU is detected. Useful for:
 *   - Tiny on-prem deployments serving small models with llama.cpp.
 *   - Developer machines that just need to register and run light workloads.
 */

import { totalmem } from 'node:os';
import type { GpuSliceReport } from '@cognipeer/gpu-fleet-protocol';
import {
  baseSystemInventory,
  defaultHostname,
  detectDistro,
  detectDocker,
  detectCloudMetadata,
  detectPreferredServiceAddress,
} from './common';
import type { PlatformAdapter } from './types';

const MIB = 1024 * 1024;

export const cpuOnlyAdapter: PlatformAdapter = {
  id: 'cpu-only',
  accelerator: 'cpu',
  gpuFramework: 'none',
  supportsMig: false,
  async collectInventory({ hostnameOverride, agentVersion }) {
    const [docker, distro] = await Promise.all([detectDocker(), detectDistro()]);
    const memMiB = Math.round(totalmem() / MIB);
    // Expose the whole machine as a single "slice" so the same deployment
    // scheduler can target it. The slice uuid is stable per host.
    const slices: GpuSliceReport[] = [
      {
        uuid: `cpu-${process.platform}-${memMiB}`,
        gpuUuid: 'cpu',
        migGiId: null,
        migCiId: null,
        kind: 'full-gpu',
        profile: null,
        memoryMiB: memMiB,
      },
    ];
    const system = baseSystemInventory({
      agentVersion,
      dockerVersion: docker,
      nvidiaContainerToolkit: null,
    });
    system.os.distro = distro;
    const cloud = await detectCloudMetadata();
    return {
      inventory: {
        hostname: defaultHostname(hostnameOverride),
        system,
        gpus: [],
        accelerator: 'cpu',
        gpuFramework: 'none',
        preferredServiceAddress: detectPreferredServiceAddress(cloud),
        labels: {},
        cloud: cloud ?? { provider: 'self' },
      },
      slices,
    };
  },
};
