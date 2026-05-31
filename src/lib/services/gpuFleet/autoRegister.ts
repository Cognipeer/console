/**
 * Auto-register deployments + pools into the rest of the platform.
 *
 * Triggered by the event ingestor when a deployment transitions to healthy.
 *
 * Hierarchy of what gets created:
 *
 *   IInferenceServer (vLLM/llamacpp metric scraper)
 *     • Always created on first healthy event.
 *     • baseUrl = http://<host.serviceAddress>:<deployment.port>
 *     • Removed when the deployment is stopped/deleted.
 *
 *   IProvider + IModel (Model Hub registration)
 *     • Created lazily on pool publication or via the explicit
 *       `publishPoolToModelHub` API. NOT implicit per deployment to keep
 *       the catalog clean.
 *     • Pool's IProvider points at /api/internal/gpu-pool/<poolKey>/v1.
 */

import slugify from 'slugify';
import { createLogger } from '@/lib/core/logger';
import {
  getDatabase,
  type IGpuHost,
  type ILlmDeployment,
  type ILlmPool,
} from '@/lib/database';
import { encryptObject } from '@/lib/utils/crypto';

const log = createLogger('gpu-fleet:auto-register');

function buildInferenceServerType(
  runtime: ILlmDeployment['runtime'],
): 'vllm' | 'llamacpp' {
  // For Phase 1 we only flag vLLM containers as 'vllm'. Anything else gets
  // 'llamacpp' so the poller falls back to the generic metric path. New
  // explicit types will be added when we extend IInferenceServer.
  return runtime === 'vllm' ? 'vllm' : 'llamacpp';
}

export async function ensureInferenceServerForDeployment(args: {
  tenantDbName: string;
  tenantId: string;
  deployment: ILlmDeployment;
  host: IGpuHost;
  actorUserId: string;
}): Promise<string | null> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);

  if (args.deployment.inferenceServerKey) {
    // Already registered — refresh status to active in case it was disabled.
    const existing = await db.findInferenceServerByKey(
      args.tenantId,
      args.deployment.inferenceServerKey,
    );
    if (existing) {
      await db.updateInferenceServer(String(existing._id), { status: 'active' });
      return existing.key;
    }
  }

  if (!args.host.serviceAddress) {
    log.warn('cannot auto-register inference server: host has no serviceAddress', {
      hostId: args.host.id,
    });
    return null;
  }

  const key = `gpu-${slugify(args.deployment.name, { lower: true, strict: true })}-${args.deployment.id.slice(0, 8)}`;
  const created = await db.createInferenceServer({
    tenantId: args.tenantId,
    key,
    name: args.deployment.name,
    type: buildInferenceServerType(args.deployment.runtime),
    baseUrl: `http://${args.host.serviceAddress}:${args.deployment.port}`,
    pollIntervalSeconds: 60,
    status: 'active',
    metadata: {
      source: 'gpu-fleet',
      deploymentId: args.deployment.id,
      hostId: args.host.id,
      runtime: args.deployment.runtime,
      modelName: args.deployment.modelName,
    },
    createdBy: args.actorUserId,
  });
  await db.updateLlmDeployment(args.deployment.id, { inferenceServerKey: created.key });
  log.info('auto-registered inference server', {
    deploymentId: args.deployment.id,
    inferenceServerKey: created.key,
  });
  return created.key;
}

/**
 * Auto-publish a single deployment to the Model Hub by creating a
 * single-member pool around it and immediately publishing that pool.
 * Called from the event ingestor on the first `healthy` transition so
 * the operator doesn't have to manually wire up a pool just to use a
 * model they've deployed.
 *
 * Idempotent: if a pool already references this deployment, we just
 * make sure it's published; we don't make a second pool.
 */
export async function publishDeploymentToModelHub(args: {
  tenantDbName: string;
  tenantId: string;
  deployment: ILlmDeployment;
  consoleBaseUrl: string;
  actorUserId: string;
  modality?: 'llm' | 'embedding' | 'stt' | 'tts' | 'ocr';
}): Promise<{ poolKey: string; providerKey: string; modelKey: string } | null> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);

  // Is this deployment already in a pool?
  const existingPools = await db.listLlmPools(args.tenantId);
  const existing = existingPools.find((p) => p.deploymentIds.includes(args.deployment.id));
  let pool: ILlmPool | null = existing ?? null;

  if (!pool) {
    // Pool name is suffixed with the first 8 chars of the deploymentId so
    // every redeploy (delete + recreate of "qwen3-8b", say) gets its OWN
    // pool + provider + model row in Model Hub. Without the suffix the
    // second deploy collides with the orphaned pool from the first one,
    // `createLlmPool` throws "Pool 'qwen3-8b-auto' already exists", and
    // the catch in eventIngestor silently swallows it — leaving the new
    // deployment unpublished and the playground tab greyed out.
    const shortId = args.deployment.id.slice(0, 8);
    const { createLlmPool, attachDeploymentToPool } = await import('./poolService');
    pool = await createLlmPool({
      tenantDbName: args.tenantDbName,
      tenantId: args.tenantId,
      name: `${args.deployment.name}-auto-${shortId}`,
      modelName: args.deployment.modelName,
      modelLibraryId: null,
      algorithm: 'round-robin',
      createdBy: args.actorUserId,
    });
    await attachDeploymentToPool({
      tenantDbName: args.tenantDbName,
      tenantId: args.tenantId,
      poolKey: pool.key,
      deploymentId: args.deployment.id,
    });
    // Re-read to get the up-to-date `deploymentIds`.
    pool = (await db.findLlmPoolByKey(args.tenantId, pool.key))!;
    log.info('auto-created single-member pool for deployment', {
      deploymentId: args.deployment.id,
      poolKey: pool.key,
    });
  }

  // Already published? skip the mint + publish.
  if (pool.modelKey && pool.providerKey) {
    return { poolKey: pool.key, providerKey: pool.providerKey, modelKey: pool.modelKey };
  }

  // Mint a tenant API token for the auto-registered Provider. Owner =
  // the auto-register actor (audit log shows the source).
  const { createApiTokenSecret, getApiTokenPrefix, hashApiToken } = await import(
    '@/lib/services/apiTokens/tokenHashing'
  );
  const bearerToken = createApiTokenSecret();
  await db.createApiToken({
    tenantId: args.tenantId,
    userId: args.actorUserId,
    label: `gpu-pool/${pool.key} (auto)`,
    tokenHash: hashApiToken(bearerToken),
    tokenPrefix: getApiTokenPrefix(bearerToken),
  });

  const result = await publishPoolToModelHub({
    tenantDbName: args.tenantDbName,
    tenantId: args.tenantId,
    poolKey: pool.key,
    consoleBaseUrl: args.consoleBaseUrl,
    bearerToken,
    modality: args.modality ?? 'llm',
    actorUserId: args.actorUserId,
  });
  return { poolKey: pool.key, providerKey: result.providerKey, modelKey: result.modelKey };
}

/**
 * Detach a deployment from any pool that referenced it, and — when the pool
 * was the single-member one this module auto-created — cascade-delete the
 * pool together with its provider + model rows in the Model Hub.
 *
 * Manual / multi-member pools are left intact (just detached): the operator
 * may want the pool to keep existing so they can attach a replacement
 * deployment to it later without losing their model key.
 *
 * Idempotent: calling for a deployment that was never published is a no-op.
 */
export async function cleanupAutoPublishedPoolForDeployment(args: {
  tenantDbName: string;
  tenantId: string;
  deploymentId: string;
}): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);

  const pools = await db.listLlmPools(args.tenantId);
  const containing = pools.find((p) => p.deploymentIds.includes(args.deploymentId));
  if (!containing) return;

  const remaining = containing.deploymentIds.filter((id) => id !== args.deploymentId);
  await db.updateLlmPool(args.tenantId, containing.key, { deploymentIds: remaining });

  // Cascade only when (a) nobody else is in the pool, and (b) the key
  // matches the auto-published shape we mint above. Anything else is admin-
  // owned and stays put.
  const looksAuto = /-auto-[0-9a-f]{6,}$/i.test(containing.key);
  if (!looksAuto || remaining.length > 0) return;

  if (containing.providerKey) {
    const provider = await db.findProviderByKey(args.tenantId, containing.providerKey);
    if (provider) {
      await db.deleteProvider(String(provider._id)).catch(() => undefined);
    }
  }
  if (containing.modelKey) {
    const model = await db.findModelByKey(containing.modelKey);
    if (model && model.tenantId === args.tenantId) {
      await db.deleteModel(String(model._id)).catch(() => undefined);
    }
  }
  await db.deleteLlmPool(args.tenantId, containing.key).catch(() => undefined);
  log.info('auto-published pool cascade-deleted', {
    poolKey: containing.key,
    providerKey: containing.providerKey,
    modelKey: containing.modelKey,
  });
}

export async function removeInferenceServerForDeployment(args: {
  tenantDbName: string;
  deployment: ILlmDeployment;
}): Promise<void> {
  if (!args.deployment.inferenceServerKey) return;
  const db = await getDatabase();
  await db.switchToTenant(args.tenantDbName);
  const existing = await db.findInferenceServerByKey(
    args.deployment.tenantId,
    args.deployment.inferenceServerKey,
  );
  if (!existing) return;
  await db.deleteInferenceServerMetrics(existing.key);
  await db.deleteInferenceServer(String(existing._id));
  await db.updateLlmDeployment(args.deployment.id, { inferenceServerKey: null });
}

// ── Pool publication (Model Hub) ────────────────────────────────────────

export interface PublishPoolInput {
  tenantDbName: string;
  tenantId: string;
  poolKey: string;
  consoleBaseUrl: string;
  /** Bearer token the registered provider should use against the pool proxy. */
  bearerToken: string;
  /** modality drives provider domain + model category. */
  modality: 'llm' | 'embedding' | 'stt' | 'tts' | 'ocr';
  actorUserId: string;
}

/**
 * Publish a pool to the Model Hub:
 *   - Provider (openai-compatible) pointing at /api/internal/gpu-pool/<key>/v1
 *   - One Model record per modality entry (text-generation default)
 *
 * The caller supplies the bearer token (typically a freshly-minted API
 * token). We never auto-mint one here to keep the credential boundary
 * explicit — the audit log shows who owns it.
 */
export async function publishPoolToModelHub(input: PublishPoolInput): Promise<{
  providerKey: string;
  modelKey: string;
}> {
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  const pool = await db.findLlmPoolByKey(input.tenantId, input.poolKey);
  if (!pool) throw new Error(`Pool '${input.poolKey}' not found`);

  const baseUrl = `${input.consoleBaseUrl.replace(/\/$/, '')}/api/internal/gpu-pool/${pool.key}/v1`;
  const providerKey = pool.providerKey ?? `gpu-pool-${pool.key}`;

  if (!pool.providerKey) {
    // credentialsEnc MUST be encrypted base64 — the rest of the platform
    // calls `decryptObject` on it (see providerService.ts) and fails with
    // Node's AES-GCM "Unsupported state or unable to authenticate data"
    // when the field is plaintext JSON. providerService has a legacy-format
    // auto-heal that catches older rows from a buggy version of this code.
    await db.createProvider({
      tenantId: input.tenantId,
      key: providerKey,
      type: 'model',
      driver: 'openai-compatible',
      label: pool.name,
      description: `GPU pool '${pool.key}' (${pool.deploymentIds.length} members)`,
      status: 'active',
      credentialsEnc: encryptObject({ apiKey: input.bearerToken }),
      settings: { baseUrl },
      capabilitiesOverride: undefined,
      metadata: { source: 'gpu-fleet', poolKey: pool.key },
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
    });
  }

  const modelKey = pool.modelKey ?? `gpu-pool-${pool.key}`;
  if (!pool.modelKey) {
    const category = input.modality === 'embedding' ? 'embedding'
      : input.modality === 'stt' ? 'stt'
      : input.modality === 'tts' ? 'tts'
      : input.modality === 'ocr' ? 'ocr'
      : 'llm';
    await db.createModel({
      tenantId: input.tenantId,
      name: pool.name,
      description: `Routed through GPU pool '${pool.key}'`,
      key: modelKey,
      providerKey,
      providerDriver: 'openai-compatible',
      provider: 'openai-compatible',
      category,
      modelId: pool.modelName,
      isMultimodal: false,
      supportsToolCalls: true,
      settings: {},
      pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0 },
      metadata: { source: 'gpu-fleet', poolKey: pool.key },
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
    });
  }

  await db.updateLlmPool(input.tenantId, pool.key, {
    providerKey,
    modelKey,
  });
  log.info('pool published to model hub', { poolKey: pool.key, providerKey, modelKey });
  return { providerKey, modelKey };
}
