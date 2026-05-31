/**
 * Bulk deploy: spin up the same model on N hosts and bundle them into a
 * pool in one shot. This is the primary path for the "Qwen on 6 machines"
 * scenario — admins pick a model from the catalog, select target slices,
 * and the service does:
 *
 *   1. Resolve the library entry + runtime template.
 *   2. Create deployments one per (hostId, sliceUuid) pair.
 *   3. Create a pool that lists all deployment ids as members.
 *   4. Return the pool and individual deployments to the caller.
 *
 * Failures during step 2 are best-effort cleaned up: any deployments that
 * were created before the failure are deleted so the system doesn't end up
 * with orphans pinned to slices.
 */

import { createLogger } from '@/lib/core/logger';
import {
  getDatabase,
  type ILlmDeployment,
  type ILlmPool,
  type LlmDeploymentRuntime,
  type LlmPoolAlgorithm,
} from '@/lib/database';
import { createDeployment, deleteDeployment } from './deploymentService';
import {
  getModelLibraryEntry,
  renderRuntimeForLibraryEntry,
} from './modelLibrary';
import { createLlmPool } from './poolService';

const log = createLogger('gpu-fleet:bulk-deploy');

export interface BulkDeployTarget {
  hostId: string;
  sliceUuid: string;
  /** Optional override for the per-host deployment name (defaults to `<modelId>-<index>`). */
  name?: string;
}

export interface BulkDeployInput {
  tenantDbName: string;
  tenantId: string;
  /** Library model id to deploy. */
  modelLibraryId: string;
  /** Runtime key from the library entry (vllm/tgi/ollama/…). */
  runtimeKey: string;
  /** Hosts + slices to target. Order is preserved in the pool member list. */
  targets: BulkDeployTarget[];
  /** Pool name displayed in the UI. Pool key derived from this. */
  poolName: string;
  algorithm?: LlmPoolAlgorithm;
  /** Optional gpu count to substitute into the runtime template. Default 1. */
  gpuCountPerDeployment?: number;
  createdBy: string;
}

export interface BulkDeployResult {
  pool: ILlmPool;
  deployments: ILlmDeployment[];
}

export async function bulkDeployModel(input: BulkDeployInput): Promise<BulkDeployResult> {
  if (input.targets.length === 0) {
    throw new Error('At least one target host is required');
  }
  const entry = getModelLibraryEntry(input.modelLibraryId);
  if (!entry) throw new Error(`Unknown model '${input.modelLibraryId}'`);
  if (!(input.runtimeKey in entry.runtimes)) {
    throw new Error(`Runtime '${input.runtimeKey}' not available for ${entry.id}`);
  }
  const rendered = renderRuntimeForLibraryEntry(entry, input.runtimeKey, {
    gpuCount: input.gpuCountPerDeployment ?? 1,
  });

  const created: ILlmDeployment[] = [];
  try {
    for (let i = 0; i < input.targets.length; i += 1) {
      const target = input.targets[i];
      const deployment = await createDeployment({
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        hostId: target.hostId,
        sliceUuid: target.sliceUuid,
        name: target.name?.trim() || `${entry.id}-${i + 1}`,
        runtime: rendered.runtime as LlmDeploymentRuntime,
        image: rendered.image,
        modelName: entry.hfRepo ?? entry.id,
        args: rendered.args,
        env: rendered.env,
        port: rendered.port,
        healthPath: rendered.healthPath,
        createdBy: input.createdBy,
      });
      created.push(deployment);
    }
  } catch (error) {
    log.warn('bulk deploy failed mid-flight, rolling back', {
      created: created.length,
      total: input.targets.length,
      error: error instanceof Error ? error.message : String(error),
    });
    // Best-effort cleanup. We swallow individual delete errors because the
    // primary error is what the caller cares about.
    for (const deployment of created) {
      await deleteDeployment({
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        deploymentId: deployment.id,
        updatedBy: input.createdBy,
      }).catch(() => undefined);
    }
    throw error;
  }

  // Build a unique pool name — append a numeric suffix when a previous pool
  // with the same slugified key already exists.
  const baseName = input.poolName.trim() || `${entry.id} pool`;
  const pool = await createPoolWithUniqueName({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    baseName,
    modelName: entry.hfRepo ?? entry.id,
    modelLibraryId: entry.id,
    algorithm: input.algorithm,
    createdBy: input.createdBy,
  });
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  await db.updateLlmPool(input.tenantId, pool.key, {
    deploymentIds: created.map((d) => d.id),
  });
  const refreshed = (await db.findLlmPoolByKey(input.tenantId, pool.key))!;
  log.info('bulk deploy complete', {
    poolKey: pool.key,
    modelId: entry.id,
    count: created.length,
  });
  return { pool: refreshed, deployments: created };
}

async function createPoolWithUniqueName(args: {
  tenantDbName: string;
  tenantId: string;
  baseName: string;
  modelName: string;
  modelLibraryId: string;
  algorithm?: LlmPoolAlgorithm;
  createdBy: string;
}): Promise<ILlmPool> {
  // Try the original name first, then -2, -3, … until a free slug is found.
  // We deliberately do this in-app rather than racing the DB unique constraint
  // because the slug we generate is what the URL will surface.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = attempt === 0 ? args.baseName : `${args.baseName} ${attempt + 1}`;
    try {
      return await createLlmPool({
        tenantDbName: args.tenantDbName,
        tenantId: args.tenantId,
        name,
        modelName: args.modelName,
        modelLibraryId: args.modelLibraryId,
        algorithm: args.algorithm,
        createdBy: args.createdBy,
      });
    } catch (error) {
      if (error instanceof Error && /already exists/.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error('Could not allocate a unique pool name');
}
