/**
 * LLM deployment service — CRUD plus the desired-state plumbing that pushes
 * commands to the bound host.
 *
 * Auto-registration of an `IInferenceServer` record happens later (in the
 * event ingestor) once the agent reports the deployment healthy. Keeping the
 * registration on the *healthy* transition (not on create) ensures the model
 * catalog never points at an endpoint that isn't actually serving.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import {
  getDatabase,
  type ILlmDeployment,
  type LlmDeploymentRuntime,
} from '@/lib/database';
import type { DeploymentSpec } from '@cognipeer/gpu-fleet-protocol';
import { enqueueCommand } from './commandQueue';

const log = createLogger('gpu-fleet:deployment');

const VLLM_DEFAULT_HEALTH_PATH = '/health';
const VLLM_DEFAULT_PORT = 8000;

export interface CreateDeploymentInput {
  tenantDbName: string;
  tenantId: string;
  hostId: string;
  sliceUuid: string;
  name: string;
  runtime: LlmDeploymentRuntime;
  image: string;
  modelName: string;
  args?: string[];
  env?: Record<string, string>;
  port?: number;
  healthPath?: string;
  volumes?: ILlmDeployment['volumes'];
  restart?: ILlmDeployment['restart'];
  createdBy: string;
}

/**
 * Build a default spec for one of the known runtimes. Admins can still
 * override every field; this just keeps the happy path short for the
 * `vllm/vllm-openai` image on an A100 slice.
 */
function defaultArgsForRuntime(runtime: LlmDeploymentRuntime, modelName: string): string[] {
  switch (runtime) {
    case 'vllm':
      return ['--model', modelName, '--host', '0.0.0.0', '--port', String(VLLM_DEFAULT_PORT)];
    case 'tgi':
      return ['--model-id', modelName, '--port', String(VLLM_DEFAULT_PORT)];
    case 'ollama':
      return [];
    case 'custom':
    default:
      return [];
  }
}

export async function createDeployment(
  input: CreateDeploymentInput,
): Promise<ILlmDeployment> {
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);

  const host = await db.findGpuHostById(input.hostId);
  if (!host || host.tenantId !== input.tenantId) {
    throw new Error('Host not found');
  }
  const slice = await db.findGpuSliceByUuid(input.sliceUuid);
  if (!slice || slice.hostId !== input.hostId) {
    throw new Error('Slice not found on this host');
  }
  if (slice.assignedDeploymentId) {
    throw new Error('Slice is already bound to another deployment');
  }

  // Reject runtime/accelerator mismatches up front. vLLM and TGI need CUDA
  // — neither will start on Apple Silicon or CPU hosts. Without this guard
  // the user wastes a 10GB image pull only to hit the generic "could not
  // select device driver 'nvidia'" error from Docker. Suggest the right
  // alternative in the error message.
  const NVIDIA_ONLY: Array<typeof input.runtime> = ['vllm', 'tgi'];
  if (NVIDIA_ONLY.includes(input.runtime) && host.accelerator !== 'nvidia-gpu') {
    throw new Error(
      `Runtime '${input.runtime}' requires an NVIDIA GPU host, but '${host.name}' is `
        + `${host.accelerator}. Pick the 'ollama' runtime for Apple Silicon / CPU hosts, or deploy this `
        + 'model on a different host.',
    );
  }

  const deployment = await db.createLlmDeployment({
    id: randomUUID(),
    tenantId: input.tenantId,
    hostId: input.hostId,
    sliceUuid: input.sliceUuid,
    name: input.name.trim(),
    runtime: input.runtime,
    image: input.image,
    modelName: input.modelName,
    args: input.args ?? defaultArgsForRuntime(input.runtime, input.modelName),
    env: input.env ?? {},
    port: input.port ?? VLLM_DEFAULT_PORT,
    healthPath: input.healthPath ?? VLLM_DEFAULT_HEALTH_PATH,
    volumes: input.volumes ?? [],
    restart: input.restart ?? 'unless-stopped',
    desiredState: 'running',
    actualState: 'pending',
    containerId: null,
    lastHealthyAt: null,
    lastError: null,
    inferenceServerKey: null,
    createdBy: input.createdBy,
  });
  await db.setGpuSliceAssignment(input.sliceUuid, deployment.id);

  await enqueueApplyDeployment({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    deployment,
    createdBy: input.createdBy,
  });

  log.info('llm-deployment created', { deploymentId: deployment.id, hostId: input.hostId });
  return deployment;
}

export async function stopDeployment(args: {
  tenantDbName: string;
  tenantId: string;
  deploymentId: string;
  updatedBy: string;
}): Promise<ILlmDeployment | null> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const deployment = await db.findLlmDeploymentById(args.deploymentId);
  if (!deployment || deployment.tenantId !== args.tenantId) return null;

  await db.updateLlmDeployment(args.deploymentId, { desiredState: 'stopped' });
  await enqueueCommand({
    tenantDbName: args.tenantDbName,
    tenantId: args.tenantId,
    hostId: deployment.hostId,
    kind: 'stop-deployment',
    payload: { deploymentId: args.deploymentId },
    resourceRef: args.deploymentId,
    createdBy: args.updatedBy,
  });
  return db.findLlmDeploymentById(args.deploymentId);
}

export async function deleteDeployment(args: {
  tenantDbName: string;
  tenantId: string;
  deploymentId: string;
  updatedBy: string;
}): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const deployment = await db.findLlmDeploymentById(args.deploymentId);
  if (!deployment || deployment.tenantId !== args.tenantId) return false;

  // If the deployment was never even queued for application (no apply
  // command yet — unusual but possible after a partial create), short-
  // circuit and just purge locally. There's nothing on the host to remove.
  if (deployment.actualState === 'pending' && !deployment.containerId) {
    if (deployment.sliceUuid) {
      await db.setGpuSliceAssignment(deployment.sliceUuid, null).catch(() => undefined);
    }
    return db.deleteLlmDeployment(args.deploymentId);
  }

  // Two-phase delete:
  //   1. Mark row as `removing` so the UI shows the right state and any
  //      retry/redeploy actions can be disabled. Idempotent — re-clicks
  //      don't queue duplicate commands.
  //   2. Enqueue remove-deployment for the agent. The agent will cancel
  //      any in-flight pull/start for this deployment and remove the
  //      container, then emit `command-completed`. The event ingestor
  //      (handleRemoveDeploymentCompleted) does the final row + slice
  //      purge.
  if (deployment.actualState !== 'removing') {
    await db.updateLlmDeployment(args.deploymentId, {
      desiredState: 'stopped',
      actualState: 'removing',
    });
    await enqueueCommand({
      tenantDbName: args.tenantDbName,
      tenantId: args.tenantId,
      hostId: deployment.hostId,
      kind: 'remove-deployment',
      payload: { deploymentId: args.deploymentId, reclaimImage: true },
      resourceRef: args.deploymentId,
      createdBy: args.updatedBy,
    });
  }
  return true;
}

/**
 * Restart an existing deployment without losing its config. We send a
 * remove-deployment + apply-deployment pair so the agent rebuilds the
 * container with the SAME args (no need to re-pick from the model
 * library). Useful when:
 *   - vLLM crashed and the operator wants to retry without re-specifying
 *   - The image was upgraded and the operator wants a fresh container
 *   - GPU got stuck and a clean restart clears the state
 */
export async function restartDeployment(args: {
  tenantDbName: string;
  tenantId: string;
  deploymentId: string;
  updatedBy: string;
}): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const deployment = await db.findLlmDeploymentById(args.deploymentId);
  if (!deployment || deployment.tenantId !== args.tenantId) return false;

  // Mark as draining so the UI shows the transition; the agent's
  // remove-deployment will tear the container down, then apply-deployment
  // rebuilds it. The slice stays bound to this deployment id throughout.
  await db.updateLlmDeployment(args.deploymentId, { actualState: 'draining' });

  // Restart MUST NOT reclaim the image — otherwise the next apply-deployment
  // re-pulls a multi-GB image just to rebuild a container we already had.
  await enqueueCommand({
    tenantDbName: args.tenantDbName,
    tenantId: args.tenantId,
    hostId: deployment.hostId,
    kind: 'remove-deployment',
    payload: { deploymentId: args.deploymentId, reclaimImage: false },
    resourceRef: args.deploymentId,
    createdBy: args.updatedBy,
  });
  await enqueueCommand({
    tenantDbName: args.tenantDbName,
    tenantId: args.tenantId,
    hostId: deployment.hostId,
    kind: 'apply-deployment',
    payload: {
      spec: {
        deploymentId: args.deploymentId,
        name: deployment.name,
        runtime: deployment.runtime,
        image: deployment.image,
        modelName: deployment.modelName,
        args: deployment.args,
        env: deployment.env,
        port: deployment.port,
        healthPath: deployment.healthPath,
        volumes: deployment.volumes,
        restart: deployment.restart,
        sliceUuid: deployment.sliceUuid,
      },
    },
    resourceRef: args.deploymentId,
    createdBy: args.updatedBy,
  });
  return true;
}

/**
 * Called by the event ingestor when the agent confirms `remove-deployment`
 * completed. Drops the row + releases the slice — but only for a true
 * delete (`desiredState === 'stopped'`). On restart, `desiredState`
 * stays `running` and the next queued apply-deployment will rebuild the
 * container; we MUST keep the row + slice binding so the apply can find
 * its target.
 */
export async function purgeRemovedDeployment(
  tenantDbName: string,
  deploymentId: string,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const deployment = await db.findLlmDeploymentById(deploymentId);
  if (!deployment) return;
  // Restart in progress — keep the row.
  if (deployment.desiredState === 'running') return;

  // Remove the deployment from any auto-published pool BEFORE we drop the
  // deployment row. Without this the pool row keeps a dangling deploymentId,
  // collides on the next redeploy of the same model name, and orphaned
  // provider/model rows accumulate in Model Hub.
  try {
    const { cleanupAutoPublishedPoolForDeployment } = await import('./autoRegister');
    await cleanupAutoPublishedPoolForDeployment({
      tenantDbName,
      tenantId: deployment.tenantId,
      deploymentId,
    });
  } catch (error) {
    log.warn('auto-pool cleanup failed (continuing)', {
      deploymentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (deployment.sliceUuid) {
    await db.setGpuSliceAssignment(deployment.sliceUuid, null).catch(() => undefined);
  }
  await db.deleteLlmDeployment(deploymentId).catch(() => undefined);
}

export async function listDeploymentsByHost(
  tenantDbName: string,
  hostId: string,
): Promise<ILlmDeployment[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listLlmDeploymentsByHost(hostId);
}

/**
 * Compose the wire-level `DeploymentSpec` the agent expects and enqueue an
 * `apply-deployment` command. Called both from createDeployment and from
 * the reconciler when desired state drifts.
 */
export async function enqueueApplyDeployment(args: {
  tenantDbName: string;
  tenantId: string;
  deployment: ILlmDeployment;
  createdBy: string;
}): Promise<void> {
  const spec: DeploymentSpec = {
    deploymentId: args.deployment.id,
    sliceUuid: args.deployment.sliceUuid ?? '',
    runtime: args.deployment.runtime,
    image: args.deployment.image,
    modelName: args.deployment.modelName,
    args: args.deployment.args,
    env: args.deployment.env,
    port: args.deployment.port,
    healthPath: args.deployment.healthPath,
    volumes: args.deployment.volumes,
    restart: args.deployment.restart,
  };
  await enqueueCommand({
    tenantDbName: args.tenantDbName,
    tenantId: args.tenantId,
    hostId: args.deployment.hostId,
    kind: 'apply-deployment',
    payload: { spec: spec as unknown as Record<string, unknown> },
    resourceRef: args.deployment.id,
    createdBy: args.createdBy,
  });
}
