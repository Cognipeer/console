/**
 * Authorization engine API (`/api/iam/*`) - engine statistics, plus the
 * Authorization center's own endpoints.
 *
 * RBAC: the paths map to the `iam` permission service, which is an
 * adminService: owner/admin (or an explicit `iam` grant) by default, GET needs
 * `read`, every mutation needs `admin`. The gate runs in withApiRequestContext,
 * exactly like every other dashboard route.
 *
 *   GET  /api/iam/engine/stats            engine health, decision counters, undeclared routes (see statsScope below)
 *
 * The Authorization center's endpoints (catalog, policies, simulate, principals,
 * audit, settings) live in iam-policies.ts / iam-directory.ts and are registered
 * from here, under the same prefix and the same RBAC service.
 *
 * There is no mode to switch: the engine decides every request of every
 * workspace (lib/iam/enforce.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { describeTenantPolicySet, getIamEngineStats } from '@/lib/iam/engine';
import { getEnforceStats, getTenantEnforceStats } from '@/lib/iam/enforce';
import { engineHealth } from '@/lib/iam/selfTest';
import { listUndeclaredRoutes } from '@/lib/iam/routeRegistry';
import {
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';
import { iamDirectoryApiPlugin } from './iam-directory';
import { iamPoliciesApiPlugin } from './iam-policies';

const logger = createLogger('api:iam');

/**
 * Process-wide engine figures describe every tenant a node serves. They are only
 * returned on single-organisation (on-prem) deployments; in SaaS the stats
 * endpoint returns this tenant's own counters and no platform-level data.
 */
function processStatsVisible(): boolean {
  try {
    return getConfig().deployment.isOnPrem;
  } catch {
    return false;
  }
}

export const iamApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Engine stats ──────────────────────────────────────────────────────────
  app.get('/iam/engine/stats', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    try {
      const undeclared = listUndeclaredRoutes();
      const policySet = await describeTenantPolicySet(session.tenantDbName)
        .then((p) => ({ version: p.version, custom: p.custom, skipped: p.skipped }))
        .catch(() => null);
      const health = engineHealth();
      const common = {
        generatedAt: new Date().toISOString(),
        /** `ok` | `degraded` | `down`, as the readiness endpoint reports it. */
        health: { status: health.status, ...(health.message ? { message: health.message } : {}) },
        /** This workspace's policy set: custom statements in force and the ones that could not be loaded (null = unreadable). */
        policySet,
        /** Routes the gate would refuse with 403 route_not_declared (empty in a healthy build). */
        undeclaredRoutes: {
          count: undeclared.length,
          sample: undeclared.slice(0, 25).map((r) => ({ method: r.method, url: r.url })),
        },
      };
      if (processStatsVisible()) {
        return reply.send({
          statsScope: 'process',
          ...common,
          /** Process-wide (single-organisation deployment: all traffic is this tenant's). */
          engine: getIamEngineStats(),
          enforce: getEnforceStats(),
          tenantEnforce: getTenantEnforceStats(session.tenantDbName),
        });
      }
      // Multi-tenant: only this workspace's counters, same shape as above.
      const tenant = getTenantEnforceStats(session.tenantDbName);
      return reply.send({
        statsScope: 'tenant',
        ...common,
        engine: {
          decisions: tenant.engineDecisions,
          p50Us: null,
          p99Us: null,
          principalCache: { hitRate: null },
        },
        enforce: tenant,
      });
    } catch (error) {
      logger.error('Failed to read engine stats', { error: error instanceof Error ? error.message : String(error) });
      return reply.code(500).send({ error: 'Failed to read engine stats' });
    }
  }));

  // ── Authorization center ──────────────────────────────────────────────────
  await app.register(iamPoliciesApiPlugin);
  await app.register(iamDirectoryApiPlugin);
};
