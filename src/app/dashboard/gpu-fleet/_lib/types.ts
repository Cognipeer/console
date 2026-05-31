/**
 * Client-side view models for GPU fleet UI. These mirror the sanitized
 * payload shapes the gpu-fleet API plugin returns. Keep in sync with
 * `sanitizeHost` and friends on the server.
 */

import type { ModelLibraryEntry } from '@/lib/services/gpuFleet';

export interface HostView {
  id: string;
  name: string;
  provider: 'azure' | 'aws' | 'gcp' | 'self';
  status: 'pending' | 'pending_claim' | 'online' | 'offline' | 'draining' | 'archived';
  accelerator: 'nvidia-gpu' | 'apple-silicon' | 'amd-gpu' | 'cpu';
  gpuFramework: 'cuda' | 'rocm' | 'metal' | 'none';
  serviceAddress: string | null;
  terminalEnabled: boolean;
  labels: Record<string, string>;
  inventory: Record<string, unknown> | null;
  lastHeartbeatAt: string | Date | null;
  agentVersion: string | null;
  paired: boolean;
  awaitingRegistration: boolean;
  createdAt: string | Date | null;
}

export interface SliceView {
  uuid: string;
  hostId: string;
  gpuUuid: string;
  kind: 'full-gpu' | 'mig';
  profile: string | null;
  memoryMiB: number;
  assignedDeploymentId: string | null;
}

export interface DeploymentView {
  id: string;
  hostId: string;
  sliceUuid: string | null;
  name: string;
  runtime: 'vllm' | 'tgi' | 'ollama' | 'custom';
  image: string;
  modelName: string;
  port: number;
  desiredState: 'running' | 'stopped';
  actualState:
    | 'pending'
    | 'pulling'
    | 'starting'
    | 'healthy'
    | 'unhealthy'
    | 'stopped'
    | 'failed'
    | 'draining'
    | 'removing';
  containerId: string | null;
  lastHealthyAt: string | Date | null;
  lastError: string | null;
}

export interface FleetSettingsView {
  agentDistributionMode: 'console-served' | 'external-url';
  agentDistributionExternalUrlTemplate: string | null;
  terminalSessionTtlSeconds: number;
  fleetTokenSet: boolean;
  fleetTokenRotatedAt: string | Date | null;
  availableBundles: Array<{ platform: string; sizeBytes: number; mtime: string }>;
}

export interface InstallSnippetView {
  curl: string;
  consoleUrl: string;
  tenantSlug: string;
  fleetToken: string;
  assetUrl: string;
  installerUrl: string;
}

export type { ModelLibraryEntry };

export interface PoolView {
  key: string;
  name: string;
  description: string | null;
  modelName: string;
  modelLibraryId: string | null;
  algorithm: 'round-robin' | 'least-busy' | 'weighted-static' | 'random';
  status: 'active' | 'disabled';
  deploymentIds: string[];
  weights: Record<string, number>;
  providerKey: string | null;
  modelKey: string | null;
  createdAt: string | Date | null;
}

export interface BulkDeployTarget {
  hostId: string;
  sliceUuid: string;
  name?: string;
}
