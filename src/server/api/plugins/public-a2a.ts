/**
 * Public (unauthenticated) A2A endpoints.
 *
 * Agents whose A2A exposure accessMode is 'public' are reachable without a
 * Cognipeer API token at:
 *
 *   GET  /api/public/a2a/:tenantId/:endpointSlug/.well-known/agent-card.json
 *   POST /api/public/a2a/:tenantId/:endpointSlug   (JSON-RPC message/send, tasks/get)
 *
 * The URL carries the tenant id (opaque) plus the agent's random 16-char
 * endpoint slug — the pair is unguessable, but treat it like a webhook URL:
 * anyone who has it can talk to the agent. Access mode 'token' agents return
 * 404 here regardless of slug knowledge. Mirrors the public MCP surface
 * (public-mcp.ts); protocol handling is shared with client-a2a.ts.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseProvider, IAgent, ITenant } from '@/lib/database';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { resolveA2aExposure } from '@/lib/services/agents/a2aExposure';
import { buildAgentCard, externalBaseUrl, handleA2aRpc } from './client-a2a';

const logger = createLogger('api:public-a2a');

/** Attribution identity stamped on conversations/usage from public A2A calls. */
const PUBLIC_A2A_USER_ID = 'a2a-public';

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { error: { code, message }, id, jsonrpc: '2.0' };
}

async function withTenantDb<T>(
  db: DatabaseProvider,
  tenantDbName: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (db.runWithTenant) return db.runWithTenant(tenantDbName, fn);
  await db.switchToTenant(tenantDbName);
  return fn();
}

/**
 * Resolve tenant + publicly exposed agent for a request. Returns null (→ 404)
 * when the tenant or slug is unknown, the agent is not active, or its A2A
 * exposure is disabled / not public.
 */
async function resolvePublicAgent(
  tenantId: string,
  endpointSlug: string,
): Promise<{ tenant: ITenant; agent: IAgent } | null> {
  if (!tenantId || !endpointSlug || endpointSlug.length < 8) return null;
  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId).catch(() => null);
  if (!tenant?.dbName) return null;

  const agent = await withTenantDb(db, tenant.dbName, async () => {
    const agents = await db.listAgents();
    return agents.find((candidate) => {
      const exposure = resolveA2aExposure(candidate);
      return exposure.enabled
        && exposure.accessMode === 'public'
        && exposure.endpointSlug === endpointSlug;
    }) ?? null;
  });

  if (!agent || agent.status !== 'active') return null;
  return { tenant, agent };
}

export const publicA2aApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/public/a2a/:tenantId/:endpointSlug/.well-known/agent-card.json', async (request, reply) => {
    try {
      const { tenantId, endpointSlug } = request.params as { tenantId: string; endpointSlug: string };
      const resolved = await resolvePublicAgent(tenantId, endpointSlug);
      if (!resolved) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const endpoint = `${externalBaseUrl(request)}/api/public/a2a/${tenantId}/${endpointSlug}`;
      return reply.code(200).send(buildAgentCard(resolved.agent, endpoint, { publicAccess: true }));
    } catch (error) {
      logger.error('Public A2A agent card error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/public/a2a/:tenantId/:endpointSlug', async (request, reply) => {
    try {
      const { tenantId, endpointSlug } = request.params as { tenantId: string; endpointSlug: string };
      const resolved = await resolvePublicAgent(tenantId, endpointSlug);
      if (!resolved) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const { tenant, agent } = resolved;

      const db = await getDatabase();
      return await withTenantDb(db, tenant.dbName, () => handleA2aRpc(
        {
          tenantDbName: tenant.dbName,
          tenantId: agent.tenantId,
          projectId: agent.projectId,
          userId: PUBLIC_A2A_USER_ID,
        },
        agent,
        request,
        reply,
      ));
    } catch (error) {
      logger.error('Public A2A request error', { error });
      return reply.code(200).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  });
};
