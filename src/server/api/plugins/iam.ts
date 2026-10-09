/**
 * Authorization engine API (`/api/iam/*`) — mode, shadow-mode report, engine
 * statistics.
 *
 * RBAC: the paths map to the `iam` permission service, which is an
 * adminService: owner/admin (or an explicit `iam` grant) by default, GET needs
 * `read`, every mutation needs `admin`. The gate runs in withApiRequestContext,
 * exactly like every other dashboard route.
 *
 *   GET  /api/iam/mode                    current mode of this tenant (+ kill switches, tenant name, undeclared routes)
 *   PUT  /api/iam/mode        {mode}      'legacy' | 'shadow' | 'enforce'
 *                                         (enforce: engine self-test first; 409 when the
 *                                         operator kill switch IAM_ENFORCE_DISABLED is set).
 *                                         The tenant OWNER can always call this (owner safety),
 *                                         even when custom policies or the engine would deny.
 *   GET  /api/iam/shadow/summary          per-category totals, per-service, top routes + samples
 *   GET  /api/iam/shadow/entries          every stored aggregate (filter + paginate)
 *   POST /api/iam/shadow/reset            clear the tenant's shadow data
 *   GET  /api/iam/engine/stats            engine + shadow-machinery counters (see statsScope below)
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import {
  AUTHZ_MODES,
  COMING_AUTHZ_MODES,
  engineSelfTest,
  getAuthzMode,
  getTenantShadowStats,
  getShadowStats,
  isAuthzMode,
  isShadowCategory,
  listShadowEntries,
  resetShadowEntries,
  setAuthzMode,
  summarizeShadowEntries,
  type AuthzModeInfo,
  type ShadowCategory,
} from '@/lib/iam/shadow';
import { getIamEngineStats } from '@/lib/iam/engine';
import { getEnforceStats, getTenantEnforceStats } from '@/lib/iam/enforce';
import { getModeLookupStats, isEnforceKillSwitchOn, isShadowKillSwitchOn, recordsShadow } from '@/lib/iam/shadow/mode';
import { listUndeclaredRoutes } from '@/lib/iam/routeRegistry';
import { getDatabase } from '@/lib/database';
import {
  requireSessionContext,
  safeReadJsonBody,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:iam');

/**
 * `name` is what the admin types to confirm enforce mode: the company name, else
 * the slug, else the tenant id, so it is never empty (a confirmation the admin
 * can never satisfy would lock the switch).
 */
async function tenantInfo(tenantId: string): Promise<{ id: string; name: string; slug: string | null }> {
  try {
    const db = await getDatabase();
    const tenant = await db.findTenantById(tenantId);
    const companyName = typeof tenant?.companyName === 'string' ? tenant.companyName.trim() : '';
    const slug = typeof tenant?.slug === 'string' && tenant.slug ? tenant.slug : null;
    return { id: tenantId, name: companyName || slug || tenantId, slug };
  } catch {
    return { id: tenantId, name: tenantId, slug: null };
  }
}

async function modePayload(info: AuthzModeInfo, tenantId: string) {
  const undeclared = listUndeclaredRoutes();
  return {
    mode: info.mode,
    updatedAt: info.updatedAt,
    updatedBy: info.updatedBy,
    availableModes: [...AUTHZ_MODES],
    comingModes: [...COMING_AUTHZ_MODES],
    /**
     * The mode that is ACTUALLY applied: an operator kill switch forces legacy
     * decisions (enforce) or stops the recording (shadow) whatever is stored.
     */
    effectiveMode: info.mode === 'enforce' && isEnforceKillSwitchOn() ? 'legacy' : info.mode,
    killSwitches: { enforce: isEnforceKillSwitchOn(), shadow: isShadowKillSwitchOn() },
    tenant: await tenantInfo(tenantId),
    /** Routes enforce mode would refuse with 403 route_not_declared (empty in a healthy build). */
    undeclaredRoutes: {
      count: undeclared.length,
      sample: undeclared.slice(0, 25).map((r) => ({ method: r.method, url: r.url })),
    },
  };
}

/**
 * Process-wide engine/queue figures describe every tenant a node serves. They
 * are only returned on single-organisation (on-prem) deployments; in SaaS the
 * stats endpoint returns this tenant's own counters and no platform-level data.
 */
function processStatsVisible(): boolean {
  try {
    return getConfig().deployment.isOnPrem;
  } catch {
    return false;
  }
}

function parseIntParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseCategory(value: unknown): ShadowCategory | undefined | 'invalid' {
  if (value === undefined || value === '') return undefined;
  return isShadowCategory(value) ? value : 'invalid';
}

export const iamApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Mode ──────────────────────────────────────────────────────────────────
  app.get('/iam/mode', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    try {
      return reply.send(await modePayload(await getAuthzMode(session.tenantDbName), session.tenantId));
    } catch (error) {
      logger.error('Failed to read authorization mode', { error: error instanceof Error ? error.message : String(error) });
      return reply.code(500).send({ error: 'Failed to read authorization mode' });
    }
  }));

  app.put('/iam/mode', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const body = safeReadJsonBody<{ mode?: unknown }>(request);

    if (typeof body.mode === 'string' && COMING_AUTHZ_MODES.includes(body.mode)) {
      return reply.code(400).send({ error: `The "${body.mode}" mode is not available yet`, code: 'mode_unavailable' });
    }
    if (!isAuthzMode(body.mode)) {
      return reply.code(400).send({
        error: `mode must be one of: ${AUTHZ_MODES.join(', ')}`,
        code: 'invalid_mode',
      });
    }

    try {
      if (body.mode === 'enforce' && isEnforceKillSwitchOn()) {
        return reply.code(409).send({
          error: 'Enforcement is disabled by the operator on this server (IAM_ENFORCE_DISABLED)',
          code: 'enforce_disabled',
        });
      }
      if (body.mode === 'shadow' || body.mode === 'enforce') {
        // Do not switch on an engine that cannot evaluate: surface it now.
        const check = await engineSelfTest(session.tenantDbName);
        if (!check.ok) {
          // The detail may name internals; it goes to the log, not to the client.
          logger.error('Policy engine self-test failed; staying in current mode', { error: check.error });
          return reply.code(503).send({
            error: 'The policy engine is not available on this server',
            code: 'engine_unavailable',
          });
        }
      }
      const info = await setAuthzMode(session.tenantDbName, body.mode, session.userId);
      logger.info('Authorization mode changed', { tenantDbName: session.tenantDbName, mode: info.mode, by: session.userId });
      return reply.send(await modePayload(info, session.tenantId));
    } catch (error) {
      logger.error('Failed to change authorization mode', { error: error instanceof Error ? error.message : String(error) });
      return reply.code(500).send({ error: 'Failed to change authorization mode' });
    }
  }));

  // ── Shadow report ─────────────────────────────────────────────────────────
  app.get('/iam/shadow/summary', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const query = request.query as Record<string, unknown>;
    const category = parseCategory(query.category);
    if (category === 'invalid') {
      return reply.code(400).send({ error: 'Unknown category', code: 'invalid_category' });
    }
    try {
      const [modeInfo, entries] = await Promise.all([
        getAuthzMode(session.tenantDbName),
        listShadowEntries(session.tenantDbName),
      ]);
      const summary = summarizeShadowEntries(entries, {
        category,
        service: typeof query.service === 'string' && query.service ? query.service : undefined,
        limit: parseIntParam(query.limit, 25, 1, 200),
        sampleLimit: parseIntParam(query.samples, 5, 0, 20),
      });
      // This tenant's drops only (a process-wide figure would leak other tenants' load).
      const tenantStats = getTenantShadowStats(session.tenantDbName);
      return reply.send({
        mode: modeInfo.mode,
        collecting: recordsShadow(modeInfo.mode),
        generatedAt: new Date().toISOString(),
        ...summary,
        dropped: { keys: tenantStats.droppedKeys, events: tenantStats.droppedEvents },
      });
    } catch (error) {
      logger.error('Failed to build shadow summary', { error: error instanceof Error ? error.message : String(error) });
      return reply.code(500).send({ error: 'Failed to build shadow summary' });
    }
  }));

  app.get('/iam/shadow/entries', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const query = request.query as Record<string, unknown>;
    const category = parseCategory(query.category);
    if (category === 'invalid') {
      return reply.code(400).send({ error: 'Unknown category', code: 'invalid_category' });
    }
    try {
      const service = typeof query.service === 'string' && query.service ? query.service : undefined;
      const route = typeof query.route === 'string' && query.route ? query.route : undefined;
      const limit = parseIntParam(query.limit, 50, 1, 200);
      const offset = parseIntParam(query.offset, 0, 0, 1_000_000);
      const all = (await listShadowEntries(session.tenantDbName))
        .filter((e) => (!category || e.category === category)
          && (!service || e.service === service)
          && (!route || e.route.includes(route)))
        .sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
      return reply.send({
        total: all.length,
        offset,
        limit,
        entries: all.slice(offset, offset + limit).map((e) => ({ ...e, samples: [...e.samples].reverse() })),
      });
    } catch (error) {
      logger.error('Failed to list shadow entries', { error: error instanceof Error ? error.message : String(error) });
      return reply.code(500).send({ error: 'Failed to list shadow entries' });
    }
  }));

  app.post('/iam/shadow/reset', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    try {
      const cleared = await resetShadowEntries(session.tenantDbName);
      return reply.send({ ok: true, cleared });
    } catch (error) {
      logger.error('Failed to reset shadow data', { error: error instanceof Error ? error.message : String(error) });
      return reply.code(500).send({ error: 'Failed to reset shadow data' });
    }
  }));

  // ── Engine stats ──────────────────────────────────────────────────────────
  app.get('/iam/engine/stats', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    try {
      const modeInfo = await getAuthzMode(session.tenantDbName);
      const tenant = getTenantShadowStats(session.tenantDbName);
      if (processStatsVisible()) {
        return reply.send({
          mode: modeInfo.mode,
          statsScope: 'process',
          generatedAt: new Date().toISOString(),
          /** Process-wide (single-organisation deployment: all traffic is this tenant's). */
          engine: getIamEngineStats(),
          shadow: getShadowStats(),
          enforce: getEnforceStats(),
          tenant,
          tenantEnforce: getTenantEnforceStats(session.tenantDbName),
          modeLookup: getModeLookupStats(),
        });
      }
      // Multi-tenant: only this workspace's counters, same shape as above.
      return reply.send({
        mode: modeInfo.mode,
        statsScope: 'tenant',
        generatedAt: new Date().toISOString(),
        engine: {
          decisions: tenant.evaluated,
          p50Us: null,
          p99Us: null,
          principalCache: { hitRate: null },
        },
        shadow: {
          enqueued: tenant.enqueued,
          evaluated: tenant.evaluated,
          queueDrops: tenant.queueDrops,
          evaluationFailures: tenant.evaluationFailures,
          parityMismatches: tenant.parityMismatches,
          droppedEvents: tenant.droppedEvents,
          droppedKeys: tenant.droppedKeys,
        },
        enforce: getTenantEnforceStats(session.tenantDbName),
        tenant,
      });
    } catch (error) {
      logger.error('Failed to read engine stats', { error: error instanceof Error ? error.message : String(error) });
      return reply.code(500).send({ error: 'Failed to read engine stats' });
    }
  }));
};
