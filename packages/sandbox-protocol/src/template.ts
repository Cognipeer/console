/**
 * Sandbox template + resolved instance spec.
 *
 * A template is the reusable, admin-defined recipe (base image, runtime,
 * isolation, resources, volume mounts). When the console launches an instance
 * it resolves the template into a `SandboxInstanceSpec` — the concrete,
 * self-contained payload handed to the runner agent over the lifecycle channel.
 *
 * This package is fully independent of the GPU fleet protocol; it shares no
 * types with it.
 */

export type SandboxRuntimeKind = 'node' | 'python' | 'multi' | 'custom';

/** Container/runtime isolation. `runc` is the plug-and-play default. */
export type SandboxIsolation = 'runc' | 'gvisor' | 'kata';

/**
 * Storage backend for a persistent volume.
 *  - `azure-blob` / `s3`: object storage, mounted live via FUSE on the runner.
 *  - `local`: a directory on the runner host (no cloud creds). Good for
 *    development and self-contained deployments.
 */
export type SandboxStorageProvider = 'azure-blob' | 's3' | 'local';

export interface SandboxResourceLimits {
  /** Fractional CPU cores (e.g. 1.5). */
  cpuCores?: number;
  memoryMb?: number;
  diskMb?: number;
  /** Max process count (fork-bomb guard). */
  pids?: number;
}

/**
 * A persistent volume mount. For `azure-blob`/`s3` it is surfaced through a
 * live FUSE mount (blobfuse2 / mountpoint-s3); for `local` it is a plain host
 * directory bind-mount. Credentials are NOT carried here — the runner agent is
 * configured with them.
 */
export interface SandboxVolumeMountSpec {
  /** Absolute mount path inside the sandbox, e.g. "/workspace". */
  mountPath: string;
  provider: SandboxStorageProvider;
  /** Azure Blob container / S3 bucket / local volume name. */
  container: string;
  /** Key prefix within the container/bucket (or sub-directory for local). */
  prefix: string;
  /** Optional sub-path within the volume for multi-tenant sharing. */
  subpath?: string;
  readOnly?: boolean;
}

export interface SandboxPreviewPort {
  /** Port a user-launched service listens on inside the sandbox. */
  port: number;
  /** Optional UI label, e.g. "dev server". */
  label?: string;
}

/** Admin-defined reusable template. */
export interface SandboxTemplateSpec {
  id: string;
  name: string;
  baseImage: string;
  runtime: SandboxRuntimeKind;
  isolation: SandboxIsolation;
  resources: SandboxResourceLimits;
  env: Record<string, string>;
  /** Optional ENTRYPOINT override; defaults to the toolbox daemon launcher. */
  entrypoint?: string[];
  /** Port the in-sandbox toolbox daemon listens on. */
  toolboxPort: number;
  previewPorts?: SandboxPreviewPort[];
  volumeMounts?: SandboxVolumeMountSpec[];
}

/**
 * Fully-resolved spec the console sends to the runner agent to materialise a
 * container. Self-contained: the agent needs nothing else to create the box.
 */
export interface SandboxInstanceSpec {
  instanceId: string;
  templateId: string;
  image: string;
  runtime: SandboxRuntimeKind;
  isolation: SandboxIsolation;
  resources: SandboxResourceLimits;
  /** Merged template + per-instance environment variables. */
  env: Record<string, string>;
  entrypoint?: string[];
  toolboxPort: number;
  previewPorts: SandboxPreviewPort[];
  volumeMounts: SandboxVolumeMountSpec[];
  /** Labels stamped on the container for crash/restart recovery. */
  labels: Record<string, string>;
}
