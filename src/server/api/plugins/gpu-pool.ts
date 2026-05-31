/**
 * GPU pool proxy + admin endpoints.
 *
 * The proxy lives under `/api/internal/gpu-pool/:poolKey/v1/*`. It is
 * Bearer-authenticated like the rest of the client API, so callers reach
 * the pool with the same OpenAI SDK setup they'd use for OpenAI itself —
 * just point `baseURL` at this endpoint.
 *
 * Admin CRUD endpoints live under `/api/gpu-fleet/pools/*` and use the
 * standard cookie-session.
 */

import { finished } from 'node:stream/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { recordAuditLog } from '@/lib/services/audit';
import {
  requireSessionContext,
  safeReadJsonBody,
  withApiRequestContext,
  withClientApiRequestContext,
} from '../fastify-utils';
import {
  NoHealthyMembersError,
  attachDeploymentToPool,
  bulkDeployModel,
  createLlmPool,
  deleteLlmPool,
  detachDeploymentFromPool,
  getLlmPool,
  listLlmPools,
  proxyToPool,
  publishPoolToModelHub,
} from '@/lib/services/gpuFleet';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { getDatabase } from '@/lib/database';
import type { LlmPoolAlgorithm } from '@/lib/database';

const log = createLogger('api:gpu-pool');

const VALID_ALGORITHMS: LlmPoolAlgorithm[] = [
  'round-robin',
  'least-busy',
  'weighted-static',
  'random',
];

function isAlgorithm(v: unknown): v is LlmPoolAlgorithm {
  return typeof v === 'string' && (VALID_ALGORITHMS as string[]).includes(v);
}

export const gpuPoolApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Admin CRUD ──────────────────────────────────────────────────────

  app.get(
    '/gpu-fleet/pools',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const pools = await listLlmPools(session.tenantDbName, session.tenantId);
      return reply.code(200).send({ pools });
    }),
  );

  app.post(
    '/gpu-fleet/pools',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const body = safeReadJsonBody(request) as Record<string, unknown>;
      if (typeof body.name !== 'string' || typeof body.modelName !== 'string') {
        return reply.code(400).send({ error: 'name and modelName required' });
      }
      const algorithm = isAlgorithm(body.algorithm) ? body.algorithm : 'round-robin';
      try {
        const pool = await createLlmPool({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          name: body.name,
          modelName: body.modelName,
          modelLibraryId: typeof body.modelLibraryId === 'string' ? body.modelLibraryId : null,
          algorithm,
          createdBy: session.userId,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.pool.create',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'llm-pool',
            resourceId: pool.key,
            metadata: { modelName: pool.modelName, algorithm: pool.algorithm },
          },
        );
        return reply.code(201).send({ pool });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Pool creation failed',
        });
      }
    }),
  );

  app.post(
    '/gpu-fleet/pools/bulk-deploy',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const body = safeReadJsonBody(request) as Record<string, unknown>;
      if (typeof body.modelLibraryId !== 'string' || typeof body.runtimeKey !== 'string') {
        return reply.code(400).send({ error: 'modelLibraryId and runtimeKey required' });
      }
      if (!Array.isArray(body.targets) || body.targets.length === 0) {
        return reply.code(400).send({ error: 'targets array required' });
      }
      const algorithm = isAlgorithm(body.algorithm) ? body.algorithm : 'round-robin';
      try {
        const result = await bulkDeployModel({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          modelLibraryId: body.modelLibraryId,
          runtimeKey: body.runtimeKey,
          targets: body.targets as Array<{ hostId: string; sliceUuid: string; name?: string }>,
          poolName: typeof body.poolName === 'string' ? body.poolName : `${body.modelLibraryId} pool`,
          algorithm,
          gpuCountPerDeployment: typeof body.gpuCountPerDeployment === 'number' ? body.gpuCountPerDeployment : undefined,
          createdBy: session.userId,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.pool.bulk-deploy',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'llm-pool',
            resourceId: result.pool.key,
            metadata: {
              modelLibraryId: body.modelLibraryId,
              members: result.deployments.length,
              algorithm,
            },
          },
        );
        return reply.code(201).send({
          pool: result.pool,
          deployments: result.deployments,
        });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Bulk deploy failed',
        });
      }
    }),
  );

  app.get<{ Params: { poolKey: string } }>(
    '/gpu-fleet/pools/:poolKey/candidates',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const poolKey = (request.params as { poolKey: string }).poolKey;
      const pool = await getLlmPool(session.tenantDbName, session.tenantId, poolKey);
      if (!pool) return reply.code(404).send({ error: 'Pool not found' });
      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      // Candidates: deployments serving the same modelName that aren't
      // already members of this pool. We don't filter by "membership in any
      // pool" — a deployment can belong to multiple pools if an admin wants
      // an aliased endpoint, which is fine.
      const all = await db.listLlmDeploymentsByTenant(session.tenantId);
      const memberSet = new Set(pool.deploymentIds);
      const candidates = all.filter(
        (d) => d.modelName === pool.modelName && !memberSet.has(d.id),
      );
      return reply.code(200).send({ candidates });
    }),
  );

  app.patch<{ Params: { poolKey: string } }>(
    '/gpu-fleet/pools/:poolKey',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const poolKey = (request.params as { poolKey: string }).poolKey;
        const body = safeReadJsonBody(request) as {
          algorithm?: unknown;
          weights?: unknown;
          name?: unknown;
          description?: unknown;
          status?: unknown;
        };
        const patch: Record<string, unknown> = {};
        if (typeof body.name === 'string') patch.name = body.name;
        if (body.description === null || typeof body.description === 'string') {
          patch.description = body.description as string | null;
        }
        if (body.status === 'active' || body.status === 'disabled') patch.status = body.status;
        if (isAlgorithm(body.algorithm)) patch.algorithm = body.algorithm;
        if (body.weights && typeof body.weights === 'object') {
          patch.weights = Object.fromEntries(
            Object.entries(body.weights as Record<string, unknown>)
              .map(([k, v]) => [k, typeof v === 'number' ? v : Number.parseFloat(String(v))])
              .filter(([, v]) => Number.isFinite(v as number) && (v as number) >= 0),
          );
        }
        const db = await getDatabase();
        await db.switchToTenant(session.tenantDbName);
        const updated = await db.updateLlmPool(session.tenantId, poolKey, patch);
        if (!updated) return reply.code(404).send({ error: 'Pool not found' });
        return reply.code(200).send({ pool: updated });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Pool update failed',
        });
      }
    }),
  );

  app.post<{ Params: { poolKey: string } }>(
    '/gpu-fleet/pools/:poolKey/members/:deploymentId',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const params = request.params as { poolKey: string; deploymentId: string };
      await attachDeploymentToPool({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        poolKey: params.poolKey,
        deploymentId: params.deploymentId,
      });
      return reply.code(204).send();
    }),
  );

  app.delete<{ Params: { poolKey: string; deploymentId: string } }>(
    '/gpu-fleet/pools/:poolKey/members/:deploymentId',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const params = request.params as { poolKey: string; deploymentId: string };
      await detachDeploymentFromPool({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        poolKey: params.poolKey,
        deploymentId: params.deploymentId,
      });
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: { poolKey: string } }>(
    '/gpu-fleet/pools/:poolKey/publish',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const poolKey = (request.params as { poolKey: string }).poolKey;
        const body = safeReadJsonBody(request) as { modality?: string };
        const validModalities = ['llm', 'embedding', 'stt', 'tts', 'ocr'] as const;
        type Modality = typeof validModalities[number];
        const modality: Modality = (validModalities as readonly string[]).includes(body.modality ?? '')
          ? (body.modality as Modality)
          : 'llm';

        const pool = await getLlmPool(session.tenantDbName, session.tenantId, poolKey);
        if (!pool) return reply.code(404).send({ error: 'Pool not found' });

        // Mint a tenant API token so the auto-registered Provider has a real
        // credential when the Model Hub later calls the pool proxy. Owner is
        // the admin running the publish.
        const db = await getDatabase();
        await db.switchToTenant(session.tenantDbName);
        const bearerToken = createApiTokenSecret();
        await db.createApiToken({
          tenantId: session.tenantId,
          userId: session.userId,
          label: `gpu-pool/${pool.key}`,
          tokenHash: hashApiToken(bearerToken),
          tokenPrefix: getApiTokenPrefix(bearerToken),
        });

        const consoleBaseUrl = `${request.protocol}://${request.headers.host}`;
        const result = await publishPoolToModelHub({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          poolKey,
          consoleBaseUrl,
          bearerToken,
          modality,
          actorUserId: session.userId,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.pool.publish',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'llm-pool',
            resourceId: poolKey,
            metadata: { providerKey: result.providerKey, modelKey: result.modelKey, modality },
          },
        );
        return reply.code(201).send({
          providerKey: result.providerKey,
          modelKey: result.modelKey,
          // Echo the token back once. We never expose it again — operator
          // must rotate to recover.
          bearerToken,
        });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Publish failed',
        });
      }
    }),
  );

  app.delete<{ Params: { poolKey: string } }>(
    '/gpu-fleet/pools/:poolKey',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const key = (request.params as { poolKey: string }).poolKey;
      const removed = await deleteLlmPool(session.tenantDbName, session.tenantId, key);
      if (!removed) return reply.code(404).send({ error: 'Pool not found' });
      return reply.code(204).send();
    }),
  );

  // ── Proxy ───────────────────────────────────────────────────────────

  // Match any sub-path under /v1 — chat/completions, embeddings, models, …
  // The pool proxy strips the /v1 segment when building the upstream URL.
  //
  // The handler is wrapped with `withClientApiRequestContext` so the bearer
  // token from `Authorization: Bearer …` is actually validated against the
  // `api_tokens` table and `request.apiTokenContext` is populated. Without
  // the wrapper the global `onRequest` hook only checks that *some* Bearer
  // header is present (see plugin.ts:270-279) — the handler then bails with
  // 401 "Bearer token required" because nothing ever set the context. That
  // surfaced as a LangChain MODEL_AUTHENTICATION error from the playground.
  app.route<{ Params: { poolKey: string; '*': string } }>({
    url: '/internal/gpu-pool/:poolKey/v1/*',
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    handler: withClientApiRequestContext(handleProxy),
  });
};

async function handleProxy(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  // The proxy authenticates through the standard client API gate — callers
  // present a Bearer token, which the global hook already verified.
  const apiToken = request.apiTokenContext;
  if (!apiToken) {
    return reply.code(401).send({ error: 'Bearer token required' });
  }
  const params = request.params as { poolKey: string; '*': string };
  const poolKey = params.poolKey;
  const upstreamPath = params['*'];
  if (!poolKey || !upstreamPath) {
    return reply.code(400).send({ error: 'invalid pool URL' });
  }

  try {
    const result = await proxyToPool({
      tenantDbName: apiToken.tenantDbName,
      tenantId: apiToken.tenantId,
      poolKey,
      upstreamPath,
      method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      headers: request.headers as Record<string, string | string[] | undefined>,
      body: request.body == null
        ? null
        : Buffer.isBuffer(request.body)
          ? request.body
          : typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body),
    });

    reply.code(result.statusCode);
    for (const [name, value] of Object.entries(result.headers)) {
      reply.header(name, value);
    }

    // Hijack + manual pipe — `reply.send(stream)` runs the response through
    // Fastify's onSend pipeline (content-type checks, serializer fallback,
    // potential Content-Length materialization). For text/event-stream that
    // pipeline can hold chunks until the upstream stream closes, which is
    // why direct vLLM (Postman) worked but the same call through this proxy
    // hung from the playground. Hijacking detaches the response so undici's
    // chunks land in `reply.raw` the moment they arrive.
    //
    // We do this for ALL upstream responses, not only SSE: a stream pipe is
    // strictly more general and never needs to know the content-type ahead
    // of time. JSON responses still arrive in one piece because the upstream
    // closes the body immediately after writing.
    reply.hijack();
    const upstreamBody = result.body;
    upstreamBody.on('error', (streamError) => {
      log.warn('pool proxy upstream stream errored', {
        poolKey,
        error: streamError instanceof Error ? streamError.message : String(streamError),
      });
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 502;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(
          JSON.stringify({
            error: streamError instanceof Error ? streamError.message : 'upstream stream error',
          }),
        );
      } else {
        reply.raw.destroy(streamError instanceof Error ? streamError : new Error(String(streamError)));
      }
    });
    request.raw.on('close', () => {
      // Client disconnected (browser closed tab, Postman cancelled, etc.).
      // Stop pulling from upstream so the deployment isn't stuck generating
      // tokens nobody is listening to.
      if (!upstreamBody.destroyed) {
        upstreamBody.destroy();
      }
    });
    upstreamBody.pipe(reply.raw);
    await finished(upstreamBody).catch(() => undefined);
    return;
  } catch (error) {
    if (error instanceof NoHealthyMembersError) {
      log.warn('pool has no healthy members', { poolKey });
      return reply.code(503).send({ error: error.message });
    }
    log.error('pool proxy failed', { poolKey, error });
    return reply.code(502).send({
      error: error instanceof Error ? error.message : 'upstream proxy failed',
    });
  }
}
