/**
 * Public (unauthenticated) key set of a workspace's Console identity issuer (lib/iam/consoleIdentity.ts):
 *
 *   GET /api/public/identity/:tenantId/.well-known/jwks.json
 *   GET /api/public/identity/:tenantId/.well-known/openid-configuration
 *
 * MCP servers and connected agents set up for Console identity fetch these to verify the token
 * Console sends with each call. Both documents hold only public data: the public halves of the
 * workspace's signing keys and the URLs around them. A workspace that never used Console identity
 * publishes an empty key set; an unknown tenant id is a 404. Requests are rate limited per client
 * address.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  consoleIdentityDiscovery,
  consoleIdentityTenantDbName,
  getConsoleIdentityJwks,
  isConsoleIdentityError,
} from '@/lib/iam/consoleIdentity';
import { authz } from '@/lib/iam/routeAuthz';
import { checkRateLimit } from '@/lib/services/auth/rateLimiter';
import { clientAddressBucket } from '@/lib/services/mcp/publicGuard';
import { getClientIp } from '../fastify-utils';

const logger = createLogger('api:public-identity');

const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RATE_LIMIT = { maxAttempts: 120, windowSeconds: 60 };
const MAX_AGE_SECONDS = 300;
/** An empty key set may fill any moment (first use), so verifiers should not keep it long. */
const EMPTY_MAX_AGE_SECONDS = 30;

function rateLimited(request: FastifyRequest, reply: FastifyReply): boolean {
  const decision = checkRateLimit(`identity-public:${clientAddressBucket(getClientIp(request))}`, RATE_LIMIT);
  if (decision.allowed) return false;
  void reply
    .code(429)
    .header('Retry-After', String(Math.max(1, decision.retryAfterSeconds)))
    .send({ error: 'Too many requests' });
  return true;
}

/** The tenant's database name, or null when the id is not a workspace (→ 404). */
async function resolveTenant(tenantId: string): Promise<string | null> {
  if (!TENANT_ID_PATTERN.test(tenantId)) return null;
  try {
    return await consoleIdentityTenantDbName(tenantId);
  } catch (error) {
    if (isConsoleIdentityError(error) && error.code === 'unknown_workspace') return null;
    throw error;
  }
}

function sendPublicJson(reply: FastifyReply, body: unknown, maxAgeSeconds: number): FastifyReply {
  return reply
    .code(200)
    .header('Cache-Control', `public, max-age=${maxAgeSeconds}`)
    .header('Access-Control-Allow-Origin', '*')
    .header('Content-Type', 'application/json; charset=utf-8')
    .send(body);
}

export const publicIdentityApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/public/identity/:tenantId/.well-known/jwks.json', { config: authz.public() }, async (request, reply) => {
    if (rateLimited(request, reply)) return reply;
    try {
      const { tenantId } = request.params as { tenantId: string };
      const tenantDbName = await resolveTenant(tenantId);
      if (!tenantDbName) return reply.code(404).send({ error: 'Not found' });
      const jwks = await getConsoleIdentityJwks(tenantDbName);
      return sendPublicJson(reply, jwks, jwks.keys.length > 0 ? MAX_AGE_SECONDS : EMPTY_MAX_AGE_SECONDS);
    } catch (error) {
      logger.error('Console identity key set error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/public/identity/:tenantId/.well-known/openid-configuration', { config: authz.public() }, async (request, reply) => {
    if (rateLimited(request, reply)) return reply;
    try {
      const { tenantId } = request.params as { tenantId: string };
      const tenantDbName = await resolveTenant(tenantId);
      if (!tenantDbName) return reply.code(404).send({ error: 'Not found' });
      return sendPublicJson(reply, consoleIdentityDiscovery(tenantId), MAX_AGE_SECONDS);
    } catch (error) {
      logger.error('Console identity discovery error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
};
