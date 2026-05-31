/**
 * Pick the right adapter for the host the agent is running on.
 *
 * Order matters: probe NVIDIA first (most specific), then Apple Silicon,
 * fall back to CPU. The env var `COGNIPEER_PLATFORM_FORCE` lets developers
 * pin a specific adapter regardless of detection — useful for testing the
 * macOS path on a Linux box or vice versa.
 */

import { platform, arch } from 'node:os';
import { commandExists } from '../exec';
import { cpuOnlyAdapter } from './cpuOnly';
import { linuxNvidiaAdapter } from './linuxNvidia';
import { macosAppleSiliconAdapter } from './macosAppleSilicon';
import type { PlatformAdapter } from './types';

const ADAPTERS: Record<string, PlatformAdapter> = {
  [linuxNvidiaAdapter.id]: linuxNvidiaAdapter,
  [macosAppleSiliconAdapter.id]: macosAppleSiliconAdapter,
  [cpuOnlyAdapter.id]: cpuOnlyAdapter,
};

export async function detectPlatformAdapter(): Promise<PlatformAdapter> {
  const forced = process.env.COGNIPEER_PLATFORM_FORCE;
  if (forced && ADAPTERS[forced]) return ADAPTERS[forced];

  const osPlatform = platform();
  if (osPlatform === 'darwin' && arch() === 'arm64') {
    return macosAppleSiliconAdapter;
  }
  if (osPlatform === 'linux' && (await commandExists('nvidia-smi'))) {
    return linuxNvidiaAdapter;
  }
  return cpuOnlyAdapter;
}
