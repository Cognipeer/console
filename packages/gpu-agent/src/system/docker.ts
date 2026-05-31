/**
 * Thin wrapper around `dockerode` for the operations the reconciler needs.
 *
 * We pin GPU access via the explicit `--device` syntax of nvidia-container-runtime,
 * not the legacy NVIDIA_VISIBLE_DEVICES env. This way a deployment bound to one
 * MIG slice cannot accidentally see siblings.
 */

import Docker from 'dockerode';
import type { DeploymentSpec } from '@cognipeer/gpu-fleet-protocol';
import { logger } from '../logger';
import { getPlatformAdapter } from './inventory';

const docker = new Docker();

const CONTAINER_NAME_PREFIX = 'cognipeer-llm-';

export function deploymentContainerName(deploymentId: string): string {
  return `${CONTAINER_NAME_PREFIX}${deploymentId}`;
}

export interface ContainerSnapshot {
  id: string;
  name: string;
  deploymentId: string;
  image: string;
  state: string;
  status: string;
  restartCount: number;
}

export async function listCognipeerContainers(): Promise<ContainerSnapshot[]> {
  const all = await docker.listContainers({ all: true });
  return all
    .map((info) => {
      const name = info.Names[0]?.replace(/^\//, '') ?? '';
      if (!name.startsWith(CONTAINER_NAME_PREFIX)) return null;
      return {
        id: info.Id,
        name,
        deploymentId: name.slice(CONTAINER_NAME_PREFIX.length),
        image: info.Image,
        state: info.State,
        status: info.Status,
        restartCount: 0,
      } satisfies ContainerSnapshot;
    })
    .filter((c): c is ContainerSnapshot => c !== null);
}

export interface RestoredDeployment {
  deploymentId: string;
  containerId: string;
  running: boolean;
  spec: DeploymentSpec;
  restartCount: number;
}

/**
 * Inspect a cognipeer container and recover enough of its `DeploymentSpec` to
 * resume health probing without losing uptime. Called from the reconciler on
 * agent startup so a process restart (or host reboot) doesn't blank the
 * in-memory deployments map while the actual container keeps serving.
 *
 * Returns `null` if the container's labels are missing the deployment-id —
 * that means something else is squatting on our `cognipeer-llm-*` prefix and
 * we shouldn't touch it.
 */
export async function inspectRestoredDeployment(
  containerNameOrId: string,
): Promise<RestoredDeployment | null> {
  const container = docker.getContainer(containerNameOrId);
  const info = await container.inspect();
  const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
  const deploymentId = labels['cognipeer.deployment-id'];
  if (!deploymentId) return null;

  const runtime = (labels['cognipeer.runtime'] as DeploymentSpec['runtime'])
    ?? ('custom' as DeploymentSpec['runtime']);
  const modelName = labels['cognipeer.model'] ?? '';
  const sliceUuid = labels['cognipeer.slice-uuid'] ?? '';

  // Recover the port. PortBindings is authoritative (host-side); fall back to
  // ExposedPorts if the container was launched without a host mapping.
  const portBindings = info.HostConfig?.PortBindings ?? {};
  const exposedPorts = info.Config?.ExposedPorts ?? {};
  const portKey = Object.keys(portBindings)[0] ?? Object.keys(exposedPorts)[0] ?? '';
  const portMatch = /^(\d+)\//.exec(portKey);
  const port = portMatch ? Number.parseInt(portMatch[1], 10) : 0;

  const envArray: string[] = info.Config?.Env ?? [];
  const env: Record<string, string> = {};
  for (const entry of envArray) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  const binds: string[] = info.HostConfig?.Binds ?? [];
  const volumes: DeploymentSpec['volumes'] = binds.map((bind) => {
    // "/host/path:/container/path[:ro]" — split conservatively from the left so
    // a colon inside the host path doesn't blow up the parse.
    const parts = bind.split(':');
    const hostPath = parts[0] ?? '';
    const containerPath = parts[1] ?? '';
    const readOnly = parts[2] === 'ro';
    return { hostPath, containerPath, readOnly };
  });

  const restartName = info.HostConfig?.RestartPolicy?.Name ?? 'unless-stopped';
  const restart = (
    ['no', 'on-failure', 'always', 'unless-stopped'].includes(restartName)
      ? restartName
      : 'unless-stopped'
  ) as DeploymentSpec['restart'];

  const spec: DeploymentSpec = {
    deploymentId,
    sliceUuid,
    runtime,
    image: info.Config?.Image ?? '',
    modelName,
    args: info.Config?.Cmd ?? [],
    env,
    port,
    // healthPath is not stored on the container; the runtime adapter supplies
    // a sane default in `runHealthProbes` so we just persist whatever the
    // original spec had (or empty for unknown).
    healthPath: '',
    volumes,
    restart,
  };

  return {
    deploymentId,
    containerId: info.Id,
    running: Boolean(info.State?.Running),
    spec,
    restartCount: info.RestartCount ?? 0,
  };
}

/**
 * Wait for the docker daemon to be reachable. Used at agent boot — after a
 * host reboot systemd may start the agent before docker.sock is ready, and
 * the first call into dockerode would throw `connect ECONNREFUSED` (or
 * `ENOENT` on the socket). Without this wait the agent crashes and systemd's
 * Restart= directive flips into rate-limit mode.
 *
 * Returns once `docker.ping()` succeeds, or throws after `timeoutMs`.
 */
export async function waitForDockerReady(options: {
  timeoutMs?: number;
  pollIntervalMs?: number;
} = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let logged = false;
  while (Date.now() < deadline) {
    try {
      await docker.ping();
      if (logged) logger.info('docker daemon reachable');
      return;
    } catch (error) {
      lastError = error;
      if (!logged) {
        logger.warn('docker daemon not ready yet, waiting…', {
          error: error instanceof Error ? error.message : String(error),
        });
        logged = true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  throw new Error(
    `docker daemon did not become reachable within ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export interface PullProgressSnapshot {
  /** Aggregate percent across all layers, or null if docker hasn't reported sizes yet. */
  percent: number | null;
  bytesDownloaded: number;
  bytesTotal: number | null;
  status: string;
}

export interface PullEvent {
  status?: string;
  id?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
  errorDetail?: { message?: string; code?: number };
}

/**
 * Pull a docker image, periodically reporting aggregate progress.
 * `onProgress` is invoked at most every `progressIntervalMs` (default 2s)
 * to avoid flooding the event log — docker emits hundreds of "Downloading"
 * lines per second for large images.
 *
 * Pass `signal` (AbortSignal) to cancel an in-flight pull — required for
 * the `remove-deployment` flow so a slow pull doesn't keep running for a
 * deployment the operator has already deleted.
 */
export async function pullImage(
  image: string,
  options: {
    onProgress?: (s: PullProgressSnapshot) => void;
    progressIntervalMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  logger.info('docker pull', { image });
  const interval = options.progressIntervalMs ?? 2_000;
  // Per-layer running totals (`current` / `total` from docker's pull stream).
  const layers: Record<string, { current: number; total: number }> = {};
  let lastStatus = 'starting';
  let lastEmitted = 0;

  const maybeEmit = (force = false) => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmitted < interval) return;
    lastEmitted = now;
    let downloaded = 0;
    let total = 0;
    let knownTotal = true;
    for (const layer of Object.values(layers)) {
      downloaded += layer.current;
      if (layer.total > 0) total += layer.total;
      else knownTotal = false;
    }
    const percent = knownTotal && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;
    options.onProgress({
      percent,
      bytesDownloaded: downloaded,
      bytesTotal: knownTotal && total > 0 ? total : null,
      status: lastStatus,
    });
  };

  // dockerode's followProgress has a known footgun: when the docker
  // daemon emits a stream message like `{"errorDetail":{"message":"..."}}`
  // (no space left, no matching manifest, layer corrupt), it does NOT
  // surface this as the outer `innerErr` — the callback resolves cleanly
  // and the image silently isn't there. We track in-stream errors
  // ourselves and convert them into a real rejection.
  let streamError: string | null = null;
  let pullStream: NodeJS.ReadableStream | undefined;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    streamError = 'pull cancelled (remove-deployment received)';
    // Destroying the HTTP stream closes the connection to the docker
    // daemon, which stops downloading further layers. Pending followProgress
    // resolves with an error.
    const s = pullStream as unknown as { destroy?: (err?: Error) => void };
    if (s && typeof s.destroy === 'function') {
      s.destroy(new Error('aborted'));
    }
  };
  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error('pull cancelled before start');
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, {}, (err: unknown, stream: NodeJS.ReadableStream | undefined) => {
        if (err) return reject(err as Error);
        if (!stream) return reject(new Error('docker pull returned no stream'));
        pullStream = stream;
        // If aborted between pull() callback and followProgress (race), bail.
        if (aborted) {
          onAbort();
          return reject(new Error('pull cancelled'));
        }
        docker.modem.followProgress(
          stream,
          (innerErr: unknown) => {
            maybeEmit(true);
            if (innerErr) return reject(innerErr as Error);
            if (streamError) return reject(new Error(`docker pull failed: ${streamError}`));
            resolve();
          },
          (event: PullEvent) => {
            if (event.error || event.errorDetail?.message) {
              streamError = event.errorDetail?.message ?? event.error ?? 'unknown pull error';
              logger.warn('docker pull stream error', { image, error: streamError });
              return;
            }
            if (event.status) lastStatus = event.status;
            if (event.id && event.progressDetail) {
              const cur = event.progressDetail.current ?? 0;
              const tot = event.progressDetail.total ?? 0;
              if (cur > 0 || tot > 0) {
                layers[event.id] = { current: cur, total: tot };
                maybeEmit();
              }
            }
          },
        );
      });
    });
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

export async function applyDeploymentContainer(
  spec: DeploymentSpec,
  options: {
    onPullProgress?: (s: PullProgressSnapshot) => void;
    /** Cancels the in-flight pull so a delete during pull-in-progress is responsive. */
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const name = deploymentContainerName(spec.deploymentId);

  // Remove any pre-existing container with the same name. We can't update in
  // place (image/args/volume changes need recreate), and idempotency is more
  // important than uptime on Phase 1.
  try {
    const existing = docker.getContainer(name);
    const info = await existing.inspect();
    if (info.State.Running) {
      await existing.stop({ t: 15 }).catch(() => undefined);
    }
    await existing.remove({ force: true }).catch(() => undefined);
  } catch {
    // not found — fine
  }

  // Defensive: a Docker daemon restart in the middle of a pull leaves the
  // image partially fetched but unusable. `docker.createContainer` then
  // fails with the misleading "(HTTP 404) No such image" error even though
  // pull seemed to succeed. We always confirm the image is local after
  // pull and retry once if it isn't.
  await pullImage(spec.image, { onProgress: options.onPullProgress, signal: options.signal });
  try {
    await docker.getImage(spec.image).inspect();
  } catch {
    logger.warn('image missing after pull — retrying once', { image: spec.image });
    await pullImage(spec.image, { onProgress: options.onPullProgress, signal: options.signal });
    try {
      await docker.getImage(spec.image).inspect();
    } catch {
      // Retry also failed — surface a diagnostic error with the most
      // common root causes so the operator doesn't have to guess.
      const dfInfo = await docker
        .df()
        .then((df) => formatDiskSummary(df))
        .catch(() => 'unable to query disk usage');
      throw new Error(
        `docker pull of ${spec.image} reported success but the image is not local. ` +
          `Likely causes: (a) disk full — check \`df -h /var/lib/docker\`; ` +
          `(b) image has no manifest for this host's architecture; ` +
          `(c) registry auth required. Docker disk usage: ${dfInfo}`,
      );
    }
  }

  const envArray = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
  const binds = spec.volumes.map(
    (v) => `${v.hostPath}:${v.containerPath}${v.readOnly ? ':ro' : ''}`,
  );

  // GPU pass-through is platform-specific:
  //   - linux-nvidia : real `--gpus device=<uuid>` via nvidia-container-toolkit
  //   - macos        : no Docker GPU pass-through; containers run CPU-only and
  //                    use Metal indirectly when applicable (Ollama, MLX, …)
  //   - cpu-only     : no GPU pass-through at all
  //
  // Without this branch the create call fails with the generic Docker
  // "could not select device driver 'nvidia'" error any time a Mac/CPU host
  // tries to deploy with a non-null sliceUuid.
  const adapter = await getPlatformAdapter();
  const useNvidiaPassthrough =
    adapter.accelerator === 'nvidia-gpu' && Boolean(spec.sliceUuid);

  const container = await docker.createContainer({
    name,
    Image: spec.image,
    Cmd: spec.args,
    Env: envArray,
    ExposedPorts: { [`${spec.port}/tcp`]: {} },
    HostConfig: {
      Binds: binds,
      RestartPolicy: { Name: spec.restart === 'no' ? 'no' : spec.restart },
      PortBindings: {
        [`${spec.port}/tcp`]: [{ HostPort: String(spec.port) }],
      },
      DeviceRequests: useNvidiaPassthrough
        ? [
            {
              Driver: 'nvidia',
              Capabilities: [['gpu', 'compute', 'utility']],
              DeviceIDs: [spec.sliceUuid as string],
            },
          ]
        : undefined,
    },
    Labels: {
      'cognipeer.deployment-id': spec.deploymentId,
      'cognipeer.slice-uuid': spec.sliceUuid,
      'cognipeer.runtime': spec.runtime,
      'cognipeer.model': spec.modelName,
    },
  });
  await container.start();
  logger.info('container started', { name, image: spec.image });
  return container.id;
}

export async function stopDeploymentContainer(deploymentId: string): Promise<void> {
  const name = deploymentContainerName(deploymentId);
  try {
    const container = docker.getContainer(name);
    await container.stop({ t: 30 });
    logger.info('container stopped', { name });
  } catch (error) {
    logger.warn('stop container failed (likely not running)', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function removeDeploymentContainer(
  deploymentId: string,
  options: { reclaimImage?: boolean } = { reclaimImage: true },
): Promise<void> {
  const name = deploymentContainerName(deploymentId);
  let imageRef: string | null = null;
  try {
    const container = docker.getContainer(name);
    // Inspect FIRST so we can grab the image reference; once we `.remove()`
    // the container, that link is gone.
    const info = await container.inspect();
    imageRef = info.Image;
    await container.remove({ force: true });
    logger.info('container removed', { name });
  } catch (error) {
    logger.warn('remove container failed (likely not present)', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Optional image reclamation. We only delete the image when no other
  // container on this host references it — multiple deployments can share
  // the same vLLM image, deleting it would kill them. Disk-conscious
  // operators get freed space; redeploys re-pull the image.
  if (options.reclaimImage && imageRef) {
    try {
      const others = await docker.listContainers({
        all: true,
        filters: { ancestor: [imageRef] },
      });
      if (others.length === 0) {
        await docker.getImage(imageRef).remove({ force: false });
        logger.info('image reclaimed (no other containers referenced it)', { imageRef });
      } else {
        logger.info('image kept — still referenced', { imageRef, refs: others.length });
      }
    } catch (error) {
      logger.warn('image reclamation failed (continuing)', {
        imageRef,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function formatBytes(n: number | undefined): string {
  if (!n || n < 0) return '0';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${n} B`;
}

interface DfSummary {
  LayersSize?: number;
  Images?: Array<{ Size?: number; Containers?: number }>;
  Containers?: Array<{ SizeRw?: number }>;
}

function formatDiskSummary(df: DfSummary): string {
  const imagesSize = (df.Images ?? []).reduce((s, i) => s + (i.Size ?? 0), 0);
  const containersSize = (df.Containers ?? []).reduce((s, c) => s + (c.SizeRw ?? 0), 0);
  return `images=${formatBytes(imagesSize)} containers=${formatBytes(containersSize)} layers=${formatBytes(df.LayersSize)}`;
}

export async function readContainerLogs(deploymentId: string, tailLines: number): Promise<string> {
  const name = deploymentContainerName(deploymentId);
  try {
    const container = docker.getContainer(name);
    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      tail: tailLines,
      timestamps: true,
    });
    return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  } catch (error) {
    return `<failed to read logs: ${error instanceof Error ? error.message : String(error)}>`;
  }
}
