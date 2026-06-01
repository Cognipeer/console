/**
 * Live FUSE mounts for sandbox volumes.
 *
 * Azure Blob -> blobfuse2, S3 -> mount-s3. Best-effort: if the mount tool or
 * credentials are unavailable, falls back to a plain (ephemeral) host directory
 * so the sandbox still runs — a warning is logged.
 *
 * Credentials come from the agent environment:
 *   Azure: AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY
 *   S3:    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SandboxVolumeMountSpec } from '@cognipeer/sandbox-protocol';
import { run } from './exec';
import { logger } from '../logger';

export interface MountResult {
  hostPath: string;
  mounted: boolean;
}

function hostDirFor(workRoot: string, instanceId: string, mountPath: string): string {
  const safe = mountPath.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(workRoot, instanceId, safe || 'root');
}

export async function mountVolume(
  workRoot: string,
  instanceId: string,
  mount: SandboxVolumeMountSpec,
): Promise<MountResult> {
  const hostPath = hostDirFor(workRoot, instanceId, mount.mountPath);
  await fs.mkdir(hostPath, { recursive: true });

  try {
    if (mount.provider === 'azure-blob') {
      const account = process.env.AZURE_STORAGE_ACCOUNT;
      const key = process.env.AZURE_STORAGE_KEY;
      if (!account || !key) throw new Error('azure-credentials-missing');
      const res = await run('blobfuse2', [
        'mount',
        hostPath,
        `--container-name=${mount.container}`,
        '--no-symlinks=true',
        ...(mount.subpath ? [`--subdirectory=${mount.subpath || mount.prefix}`] : [`--subdirectory=${mount.prefix}`]),
      ], { timeoutMs: 30_000 });
      if (res.code !== 0) throw new Error(`blobfuse2: ${res.stderr}`);
    } else if (mount.provider === 's3') {
      const res = await run('mount-s3', [
        mount.container,
        hostPath,
        `--prefix=${(mount.subpath || mount.prefix).replace(/\/?$/, '/')}`,
        '--allow-delete',
        '--allow-overwrite',
      ], { timeoutMs: 30_000 });
      if (res.code !== 0) throw new Error(`mount-s3: ${res.stderr}`);
    }
    logger.info('volume mounted', { instanceId, provider: mount.provider, hostPath });
    return { hostPath, mounted: true };
  } catch (error) {
    logger.warn('volume mount failed; using ephemeral dir', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { hostPath, mounted: false };
  }
}

export async function unmount(hostPath: string): Promise<void> {
  await run('fusermount', ['-u', hostPath], { timeoutMs: 15_000 }).catch(() => undefined);
}
