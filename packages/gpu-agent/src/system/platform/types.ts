/**
 * Platform adapter contract.
 *
 * Each supported (OS, accelerator) combination implements `PlatformAdapter`.
 * The reconciler stays platform-agnostic and asks the adapter for whatever
 * it needs: a fresh inventory snapshot, the list of slices, and the
 * concrete docker/runtime behaviour.
 *
 * Adding a new platform = new file under `./adapters/`, exporting an
 * adapter factory, plus a `match` line in `./detect.ts`.
 */

import type { GpuDeviceInventory, GpuSliceReport, HostInventory } from '@cognipeer/gpu-fleet-protocol';

export interface PlatformAdapter {
  readonly id: string;
  readonly accelerator: HostInventory['accelerator'];
  readonly gpuFramework: HostInventory['gpuFramework'];

  /** Build the inventory snapshot the console expects on handshake. */
  collectInventory(args: { hostnameOverride: string | null; agentVersion: string }): Promise<{
    inventory: HostInventory;
    slices: GpuSliceReport[];
  }>;

  /**
   * True when the adapter can apply a MIG / partitioning operation. Phase 1
   * only the NVIDIA adapter returns true; others should reject the command.
   */
  readonly supportsMig: boolean;
}

export type GpuProbe = () => Promise<GpuDeviceInventory[]>;
export type SliceProbe = (gpus: GpuDeviceInventory[]) => Promise<GpuSliceReport[]>;
