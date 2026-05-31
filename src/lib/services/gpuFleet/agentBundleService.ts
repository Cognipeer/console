/**
 * Console-served agent bundle distribution.
 *
 * The console can host the agent tarballs from its own filesystem so on-prem
 * customers don't need an external CDN. The bundle directory is just a
 * folder containing per-platform tarballs:
 *
 *   data/agent-bundles/linux-x64/cognipeer-gpu-agent-latest.tar.gz
 *   data/agent-bundles/linux-arm64/cognipeer-gpu-agent-latest.tar.gz
 *   data/agent-bundles/darwin-arm64/cognipeer-gpu-agent-latest.tar.gz
 *
 * `BundleNotFound` is surfaced so the API layer can return a clean 404 (rather
 * than a generic 500) when a build hasn't been deployed yet.
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';

const log = createLogger('gpu-fleet:bundles');

export type AgentPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-arm64' | 'darwin-x64';

export const SUPPORTED_PLATFORMS: AgentPlatform[] = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
];

export class BundleNotFound extends Error {
  constructor(public readonly platform: string) {
    super(`No agent bundle available for platform '${platform}'`);
    this.name = 'BundleNotFound';
  }
}

/** Filesystem root that holds the per-platform tarballs. */
export function getBundleRoot(): string {
  const explicit = process.env.COGNIPEER_AGENT_BUNDLE_DIR;
  if (explicit) return resolve(explicit);
  // Default: same data dir SQLite uses, sibling folder.
  const cfg = getConfig();
  const dataDir = cfg.database.dataDir ?? './data';
  return resolve(dataDir, 'agent-bundles');
}

export function isSupportedPlatform(value: string): value is AgentPlatform {
  return (SUPPORTED_PLATFORMS as string[]).includes(value);
}

function bundlePath(platform: AgentPlatform): string {
  return join(getBundleRoot(), platform, 'cognipeer-gpu-agent-latest.tar.gz');
}

/**
 * Dev fallback: locate the most recent tarball produced by
 * `npm run package --workspace=@cognipeer/gpu-agent`. Since the agent is a
 * pure-JS bundle (single index.cjs that needs Node 20+), the same artifact
 * runs on every platform. This lets developers test the install flow without
 * staging per-platform tarballs under `data/agent-bundles/`.
 *
 * Returns the most recently mtime'd file matching the package output naming.
 */
function findDevReleaseTarball(): string | null {
  const releaseDir = resolve(process.cwd(), 'packages', 'gpu-agent', 'release');
  if (!existsSync(releaseDir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(releaseDir)) {
    if (!name.startsWith('cognipeer-gpu-agent-') || !name.endsWith('.tar.gz')) continue;
    const full = join(releaseDir, name);
    const stat = statSync(full);
    if (!best || stat.mtimeMs > best.mtime) {
      best = { path: full, mtime: stat.mtimeMs };
    }
  }
  return best?.path ?? null;
}

export interface BundleInfo {
  platform: AgentPlatform;
  path: string;
  sizeBytes: number;
  mtime: Date;
}

/** In-memory set of dev-fallback paths we've already warned about. The
 * settings page polls `listAvailableBundles` every few seconds — without
 * this, we'd repeat the same warning 4× per poll. */
const warnedDevPaths = new Set<string>();

export function describeBundle(platform: AgentPlatform): BundleInfo {
  const path = bundlePath(platform);
  if (existsSync(path)) {
    const stat = statSync(path);
    return { platform, path, sizeBytes: stat.size, mtime: stat.mtime };
  }

  // Dev fallback: serve the most recent `npm run package` output. We
  // warn once per (path + platform) pair so operators notice when they're
  // running against the unstaged path, without polling spam.
  const dev = findDevReleaseTarball();
  if (dev) {
    const key = `${platform}::${dev}`;
    if (!warnedDevPaths.has(key)) {
      log.warn('serving agent bundle from packages/gpu-agent/release (dev fallback)', {
        platform,
        path: dev,
      });
      warnedDevPaths.add(key);
    }
    const stat = statSync(dev);
    return { platform, path: dev, sizeBytes: stat.size, mtime: stat.mtime };
  }

  throw new BundleNotFound(platform);
}

export function readBundleStream(platform: AgentPlatform): {
  stream: Readable;
  info: BundleInfo;
} {
  const info = describeBundle(platform);
  return { stream: createReadStream(info.path), info };
}

export function listAvailableBundles(): BundleInfo[] {
  return SUPPORTED_PLATFORMS
    .map((p) => {
      try {
        return describeBundle(p);
      } catch {
        return null;
      }
    })
    .filter((b): b is BundleInfo => b !== null);
}
