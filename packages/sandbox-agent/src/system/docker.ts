/**
 * Thin dockerode wrapper for sandbox container lifecycle.
 *
 * Each sandbox is a container named `cognipeer-sandbox-<instanceId>` running the
 * template's base image (whose entrypoint launches the toolbox daemon). The
 * /workspace volume is bind-mounted from a host FUSE mount; the toolbox port
 * and preview ports are published; resource limits and isolation runtime are
 * applied from the spec.
 */

import Docker from 'dockerode';
import type { SandboxInstanceSpec } from '@cognipeer/sandbox-protocol';
import { logger } from '../logger';

const docker = new Docker();

export const INSTANCE_LABEL = 'cognipeer.sandbox.instanceId';

export function containerName(instanceId: string): string {
  return `cognipeer-sandbox-${instanceId}`;
}

const RUNTIME_FOR_ISOLATION: Record<string, string | undefined> = {
  runc: undefined, // docker default
  gvisor: 'runsc',
  kata: 'kata-runtime',
};

export interface CreateOptions {
  spec: SandboxInstanceSpec;
  /** Resolved host paths for each volume mount (mountPath -> hostPath). */
  binds: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
}

export async function pullImage(image: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
    });
  });
}

export async function createAndStart(opts: CreateOptions): Promise<string> {
  const { spec, binds } = opts;
  const runtime = RUNTIME_FOR_ISOLATION[spec.isolation];

  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  const exposed: Record<string, Record<string, never>> = {};
  for (const p of [spec.toolboxPort, ...spec.previewPorts.map((pp) => pp.port)]) {
    exposed[`${p}/tcp`] = {};
    portBindings[`${p}/tcp`] = [{ HostPort: '0' }]; // ephemeral host port
  }

  // Only pull when the image isn't already present locally — skips a slow,
  // failing registry round-trip for locally-built images.
  let present = false;
  try {
    await docker.getImage(spec.image).inspect();
    present = true;
  } catch {
    present = false;
  }
  if (!present) {
    try {
      await pullImage(spec.image);
    } catch (error) {
      logger.warn('image pull failed (continuing if present locally)', {
        image: spec.image,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const container = await docker.createContainer({
    name: containerName(spec.instanceId),
    Image: spec.image,
    Env: Object.entries({ ...spec.env, TOOLBOX_PORT: String(spec.toolboxPort), SANDBOX_ROOT: '/workspace' }).map(
      ([k, v]) => `${k}=${v}`,
    ),
    Entrypoint: spec.entrypoint,
    Labels: { ...spec.labels, [INSTANCE_LABEL]: spec.instanceId },
    ExposedPorts: exposed,
    HostConfig: {
      Binds: binds.map((b) => `${b.hostPath}:${b.containerPath}${b.readOnly ? ':ro' : ''}`),
      PortBindings: portBindings,
      Memory: spec.resources.memoryMb ? spec.resources.memoryMb * 1024 * 1024 : undefined,
      NanoCpus: spec.resources.cpuCores ? Math.round(spec.resources.cpuCores * 1e9) : undefined,
      PidsLimit: spec.resources.pids,
      Runtime: runtime,
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });

  await container.start();
  logger.info('sandbox container started', { instanceId: spec.instanceId, containerId: container.id });
  return container.id;
}

async function findContainer(instanceId: string): Promise<Docker.Container | null> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${INSTANCE_LABEL}=${instanceId}`] },
  });
  if (list.length === 0) return null;
  return docker.getContainer(list[0].Id);
}

export async function startInstance(instanceId: string): Promise<void> {
  const c = await findContainer(instanceId);
  if (c) await c.start().catch(() => undefined);
}

export async function stopInstance(instanceId: string): Promise<void> {
  const c = await findContainer(instanceId);
  if (c) await c.stop({ t: 5 }).catch(() => undefined);
}

export async function removeInstance(instanceId: string): Promise<void> {
  const c = await findContainer(instanceId);
  if (c) await c.remove({ force: true }).catch(() => undefined);
}

export async function readLogs(instanceId: string, tail: number): Promise<string> {
  const c = await findContainer(instanceId);
  if (!c) return '';
  const buf = (await c.logs({ stdout: true, stderr: true, tail })) as unknown as Buffer;
  return buf.toString('utf8');
}

export async function getContainerId(instanceId: string): Promise<string | null> {
  const c = await findContainer(instanceId);
  return c ? c.id : null;
}
