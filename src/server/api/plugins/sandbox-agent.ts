/**
 * Sandbox runner agent (machine-to-machine) API.
 *
 * Runner agents authenticate with a bearer token (registration token for the
 * first handshake, then a long-lived agent token). These endpoints are exempt
 * from the cookie-session hook via SELF_AUTH_API_PREFIXES ('/api/sandbox/agent/').
 *
 * Routes are written without the '/api' prefix; the parent registers this
 * plugin under '/api'. Independent of the gpu agent API.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { safeReadJsonBody } from '../fastify-utils';
import {
  authenticateAgent,
  completeHandshake,
  touchHeartbeat,
} from '@/lib/services/sandbox/runnerService';
import { fetchPendingCommandsForAgent } from '@/lib/services/sandbox/commandQueue';
import { ingestEvents } from '@/lib/services/sandbox/eventIngestor';
import type { SandboxEvent } from '@cognipeer/sandbox-protocol';

const log = createLogger('api:sandbox-agent');

interface TenantRef {
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
}

async function resolveTenant(request: FastifyRequest): Promise<TenantRef | null> {
  const { tenantSlug } = request.params as { tenantSlug: string };
  const db = await getDatabase();
  const tenant = await db.findTenantBySlug(tenantSlug);
  if (!tenant) return null;
  return {
    tenantDbName: tenant.dbName ?? `tenant_${tenant.slug}`,
    tenantId: String(tenant._id ?? ''),
    tenantSlug,
  };
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const sandboxAgentApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/sandbox/agent/:tenantSlug/handshake', async (request, reply) => {
    const tenant = await resolveTenant(request);
    if (!tenant) return reply.code(404).send({ error: 'tenant-not-found' });
    const body = safeReadJsonBody(request) as {
      registrationToken?: string;
      inventory?: Record<string, unknown> | null;
    };
    if (!body.registrationToken) {
      return reply.code(400).send({ error: 'registrationToken-required' });
    }
    const result = await completeHandshake({
      tenantDbName: tenant.tenantDbName,
      registrationToken: body.registrationToken,
      inventory: body.inventory ?? null,
    });
    if (!result) return reply.code(401).send({ error: 'invalid-registration-token' });
    return reply.code(200).send({
      runnerId: result.runner.id,
      agentToken: result.agentToken,
      heartbeatIntervalSeconds: 30,
      commandPollWaitSeconds: 25,
    });
  });

  app.post('/sandbox/agent/:tenantSlug/heartbeat', async (request, reply) => {
    const tenant = await resolveTenant(request);
    if (!tenant) return reply.code(404).send({ error: 'tenant-not-found' });
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const runner = await authenticateAgent(tenant.tenantDbName, token);
    if (!runner) return reply.code(401).send({ error: 'unauthorized' });
    const body = safeReadJsonBody(request) as { inventory?: Record<string, unknown> | null };
    await touchHeartbeat(tenant.tenantDbName, runner.id, body.inventory ?? undefined);
    return reply.code(200).send({ ok: true });
  });

  app.get('/sandbox/agent/:tenantSlug/commands', async (request, reply) => {
    const tenant = await resolveTenant(request);
    if (!tenant) return reply.code(404).send({ error: 'tenant-not-found' });
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const runner = await authenticateAgent(tenant.tenantDbName, token);
    if (!runner) return reply.code(401).send({ error: 'unauthorized' });

    const requested = Number((request.query as { wait?: string }).wait ?? 25);
    const waitSeconds = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 25, 25));
    const deadline = Date.now() + waitSeconds * 1000;

    for (;;) {
      const commands = await fetchPendingCommandsForAgent({
        tenantDbName: tenant.tenantDbName,
        runnerId: runner.id,
      });
      if (commands.length > 0 || Date.now() >= deadline) {
        return reply.code(200).send({ commands });
      }
      await sleep(400);
    }
  });

  app.post('/sandbox/agent/:tenantSlug/events', async (request, reply) => {
    const tenant = await resolveTenant(request);
    if (!tenant) return reply.code(404).send({ error: 'tenant-not-found' });
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const runner = await authenticateAgent(tenant.tenantDbName, token);
    if (!runner) return reply.code(401).send({ error: 'unauthorized' });

    const body = safeReadJsonBody(request) as { events?: SandboxEvent[] };
    const events = Array.isArray(body.events) ? body.events : [];
    const result = await ingestEvents({
      tenantDbName: tenant.tenantDbName,
      tenantId: tenant.tenantId,
      runner,
      events,
    });
    return reply.code(200).send({ accepted: result.accepted, highWatermark: result.highWatermark });
  });

  log.info('sandbox agent API registered');
};
