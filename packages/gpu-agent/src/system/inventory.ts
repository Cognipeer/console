/**
 * Public inventory entry point — picks the right `PlatformAdapter` and
 * delegates. Kept as a thin wrapper so the rest of the agent doesn't import
 * adapter files directly.
 */

import type { GpuSliceReport, HostInventory } from '@cognipeer/gpu-fleet-protocol';
import { detectPlatformAdapter } from './platform/detect';
import type { PlatformAdapter } from './platform/types';

let cachedAdapter: PlatformAdapter | null = null;

export async function getPlatformAdapter(): Promise<PlatformAdapter> {
  if (!cachedAdapter) cachedAdapter = await detectPlatformAdapter();
  return cachedAdapter;
}

export async function collectInventory(args: {
  hostnameOverride: string | null;
  agentVersion: string;
}): Promise<{ inventory: HostInventory; slices: GpuSliceReport[] }> {
  const adapter = await getPlatformAdapter();
  return adapter.collectInventory(args);
}
