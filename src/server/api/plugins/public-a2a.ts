/**
 * Public (unauthenticated) A2A endpoints.
 *
 * Agents whose A2A exposure accessMode is 'public' are reachable without a
 * Cognipeer API token at:
 *
 *   GET  /api/public/a2a/:tenantId/:endpointSlug/.well-known/agent-card.json
 *   POST /api/public/a2a/:tenantId/:endpointSlug   (JSON-RPC message/send, message/stream, tasks/get, tasks/resubscribe, tasks/cancel)
 *
 * The URL carries the tenant id (opaque) plus the agent's random 16-char
 * endpoint slug — the pair is unguessable, but treat it like a webhook URL:
 * anyone who has it can talk to the agent. Access mode 'token' agents return
 * 404 here regardless of slug knowledge. Mirrors the public MCP surface
 * (public-mcp.ts); protocol handling is shared with client-a2a.ts.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { IAgent, ITenant } from '@/lib/database';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import { isServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { createLogger } from '@/lib/core/logger';
import { authz } from '@/lib/iam/routeAuthz';
import { resolveA2aExposure } from '@/lib/services/agents/a2aExposure';
import {
  checkPublicAddressRate,
  checkPublicEndpointRate,
  type PublicLimitDecision,
} from '@/lib/services/mcp/publicGuard';
import { getClientIp } from '../fastify-utils';
import { buildAgentCard, externalBaseUrl, handleA2aRpc } from './client-a2a';
import { gatePublicRequestRate } from '../publicRpmGate';

const logger = createLogger('api:public-a2a');

const PUBLIC_SLUG_AUTHZ = authz.self(
  'unauthenticated by design: addressed by tenant id + random endpoint slug; the handler 404s unless the agent exposes A2A with accessMode public',
);

/** Attribution identity stamped on conversations/usage from public A2A calls. */
const PUBLIC_A2A_USER_ID = 'a2a-public';

/** Slugs are short URL-safe tokens; anything else is answered like an unknown endpoint without a lookup. */
const ENDPOINT_SLUG_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function sendRateLimited(reply: FastifyReply, decision: PublicLimitDecision) {
  return reply
    .code(429)
    .header('Retry-After', String(decision.retryAfterSeconds))
    .send({ error: 'Rate limit exceeded' });
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { error: { code, message }, id, jsonrpc: '2.0' };
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
  if (!tenantId || !endpointSlug || !ENDPOINT_SLUG_PATTERN.test(endpointSlug)) return null;
  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId).catch(() => null);
  if (!tenant?.dbName) return null;
  // A switched-off agents service answers like an unknown agent.
  if (!(await isServiceEnabled({ tenantId: String(tenant._id) }, 'agents'))) return null;

  const agent = await runWithTenantScope(tenant.dbName, async (tenantDb) => {
    const agents = await tenantDb.listAgents();
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
  // Per client address, across the public endpoints; runs before any lookup.
  app.addHook('onRequest', async (request, reply) => {
    const rate = checkPublicAddressRate(getClientIp(request));
    if (!rate.allowed) return sendRateLimited(reply, rate);
    return undefined;
  });

  app.get('/public/a2a/:tenantId/:endpointSlug/.well-known/agent-card.json', { config: PUBLIC_SLUG_AUTHZ }, async (request, reply) => {
    try {
      const { tenantId, endpointSlug } = request.params as { tenantId: string; endpointSlug: string };
      const resolved = await resolvePublicAgent(tenantId, endpointSlug);
      if (!resolved) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const rate = await checkPublicEndpointRate({
        server: { tenantId: String(resolved.agent.tenantId), _id: resolved.agent._id as string | undefined, key: endpointSlug },
        clientAddress: getClientIp(request),
      });
      if (!rate.allowed) return sendRateLimited(reply, rate);
      const endpoint = `${externalBaseUrl(request)}/api/public/a2a/${tenantId}/${endpointSlug}`;
      return reply.code(200).send(buildAgentCard(resolved.agent, endpoint, { publicAccess: true }));
    } catch (error) {
      logger.error('Public A2A agent card error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/public/a2a/:tenantId/:endpointSlug', { config: PUBLIC_SLUG_AUTHZ }, async (request, reply) => {
    try {
      const { tenantId, endpointSlug } = request.params as { tenantId: string; endpointSlug: string };
      const resolved = await resolvePublicAgent(tenantId, endpointSlug);
      if (!resolved) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const { tenant, agent } = resolved;
      const rate = await checkPublicEndpointRate({
        server: { tenantId: String(resolved.agent.tenantId), _id: resolved.agent._id as string | undefined, key: endpointSlug },
        clientAddress: getClientIp(request),
      });
      if (!rate.allowed) return sendRateLimited(reply, rate);

      const refused = await gatePublicRequestRate(request, reply, { tenantId: agent.tenantId, sourceType: 'a2a', sourceId: agent.key });
      if (refused) return refused;

      return await runWithTenantScope(tenant.dbName, () => handleA2aRpc(
        {
          tenantDbName: tenant.dbName,
          tenantId: agent.tenantId,
          projectId: agent.projectId,
          userId: PUBLIC_A2A_USER_ID,
          licenseType: tenant.licenseType,
          // Every anonymous caller is `a2a-public`: its tasks are bound to it by a caller nonce instead.
          publicCaller: true,
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
