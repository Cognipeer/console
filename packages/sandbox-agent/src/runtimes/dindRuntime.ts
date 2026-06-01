/**
 * Docker-in-Docker runtime: materialises sandboxes as Docker containers with
 * live FUSE-mounted volumes.
 */

import type { SandboxInstanceSpec } from '@cognipeer/sandbox-protocol';
import type { AgentConfig } from '../config';
import type { SandboxRuntime } from './index';
import * as docker from '../system/docker';
import { mountVolume } from '../system/fuse';
import { logger } from '../logger';

export function createDindRuntime(cfg: AgentConfig): SandboxRuntime {
  return {
    async create(spec: SandboxInstanceSpec) {
      const binds: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }> = [];
      for (const mount of spec.volumeMounts) {
        const result = await mountVolume(cfg.workRoot, spec.instanceId, mount);
        binds.push({ hostPath: result.hostPath, containerPath: mount.mountPath, readOnly: mount.readOnly });
      }
      const containerId = await docker.createAndStart({ spec, binds });
      return { containerId };
    },
    async start(instanceId: string) {
      await docker.startInstance(instanceId);
    },
    async stop(instanceId: string) {
      await docker.stopInstance(instanceId);
    },
    async remove(instanceId: string) {
      await docker.removeInstance(instanceId);
      logger.info('sandbox removed', { instanceId });
    },
    async logs(instanceId: string, tail: number) {
      return docker.readLogs(instanceId, tail);
    },
  };
}
