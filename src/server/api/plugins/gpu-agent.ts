/**
 * GPU agent HTTP surface (machine-to-machine).
 *
 * Routes live under `/api/gpu/agent/:tenantSlug/*`. The global cookie-session
 * hook in `plugin.ts` is bypassed (see `SELF_AUTH_API_PREFIXES`); each handler
 * here authenticates the Bearer token itself against the tenant's host table.
 *
 * Endpoints:
 *   POST   /handshake                 — exchange registration token for an agent token
 *   POST   /heartbeat                 — keep-alive + lightweight state report
 *   POST   /inventory                 — full inventory + slice refresh
 *   GET    /commands                  — long-poll pending commands
 *   POST   /events                    — push event batch
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type IGpuHost } from '@/lib/database';
import { readJsonBody } from '../fastify-utils';
import type {
  CommandPollResponse,
  EventBatchRequest,
  EventBatchResponse,
  FleetHandshakeRequest,
  FleetHandshakeResponse,
  HandshakeRequest,
  HandshakeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  InventoryRefreshRequest,
  InventoryRefreshResponse,
} from '@cognipeer/gpu-fleet-protocol';
import {
  authenticateAgent,
  completeFleetHandshake,
  completeHandshake,
  fetchPendingCommandsForAgent,
  ingestAgentEvents,
  reconcileSlicesFromAgent,
  touchHostHeartbeat,
} from '@/lib/services/gpuFleet';

const log = createLogger('api:gpu-agent');

const HEARTBEAT_INTERVAL_SECONDS = 15;
const COMMAND_POLL_WAIT_SECONDS = 25;
const MAX_COMMAND_LONG_POLL_MS = COMMAND_POLL_WAIT_SECONDS * 1000;
const COMMAND_POLL_TICK_MS = 1000;

/**
 * The application registers a JSON content-type parser that keeps the body
 * as the raw STRING (Next.js route handlers need that). Fastify plugin
 * routes therefore have to parse it themselves before treating it as an
 * object — otherwise `body.fleetToken` is undefined on a `string` value.
 *
 * Wraps the shared `readJsonBody` helper to (a) coerce missing/empty bodies
 * to {} instead of throwing, and (b) swallow malformed JSON so handlers can
 * report their own 400 with a domain-specific message.
 */
function parseJsonBody<T = Record<string, unknown>>(request: FastifyRequest): T {
  try {
    return readJsonBody<T>(request);
  } catch {
    return {} as T;
  }
}

interface TenantContext {
  tenantId: string;
  tenantSlug: string;
  tenantDbName: string;
}

async function resolveTenant(slug: string): Promise<TenantContext | null> {
  const db = await getDatabase();
  const tenant = await db.findTenantBySlug(slug);
  if (!tenant) return null;
  return {
    tenantId: String(tenant._id ?? ''),
    tenantSlug: tenant.slug,
    tenantDbName: tenant.dbName,
  };
}

function getBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

type AgentRequest = FastifyRequest<{ Params: { tenantSlug: string } }>;

async function withAuthenticatedAgent(
  request: AgentRequest,
  reply: FastifyReply,
  handler: (ctx: { tenant: TenantContext; host: IGpuHost }) => Promise<unknown>,
): Promise<unknown> {
  const tenant = await resolveTenant(request.params.tenantSlug);
  if (!tenant) {
    return reply.code(404).send({ error: 'Unknown tenant' });
  }
  const token = getBearerToken(request);
  if (!token) {
    return reply.code(401).send({ error: 'Missing bearer token' });
  }
  const host = await authenticateAgent(tenant.tenantDbName, token);
  if (!host) {
    return reply.code(401).send({ error: 'Invalid agent token' });
  }
  return handler({ tenant, host });
}

export const gpuAgentApiPlugin: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { tenantSlug: string } }>(
    '/gpu/agent/:tenantSlug/handshake',
    async (request, reply) => {
      const tenant = await resolveTenant(request.params.tenantSlug);
      if (!tenant) {
        return reply.code(404).send({ error: 'Unknown tenant' });
      }

      const body = parseJsonBody<Partial<HandshakeRequest>>(request);
      if (!body.registrationToken || !body.agentVersion || !body.inventory) {
        return reply.code(400).send({ error: 'registrationToken, agentVersion, inventory required' });
      }

      try {
        const { host, agentToken } = await completeHandshake({
          tenantDbName: tenant.tenantDbName,
          registrationToken: String(body.registrationToken),
          agentVersion: String(body.agentVersion),
          inventory: body.inventory,
        });

        if (Array.isArray(body.slices) && body.slices.length > 0) {
          await reconcileSlicesFromAgent({
            tenantDbName: tenant.tenantDbName,
            tenantId: tenant.tenantId,
            hostId: host.id,
            slices: body.slices,
          });
        }

        const response: HandshakeResponse = {
          hostId: host.id,
          agentToken,
          heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
          commandPollWaitSeconds: COMMAND_POLL_WAIT_SECONDS,
          tenantId: tenant.tenantId,
          tenantSlug: tenant.tenantSlug,
        };
        return reply.code(200).send(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Handshake failed';
        log.warn('gpu-agent handshake failed', { tenantSlug: tenant.tenantSlug, message });
        return reply.code(401).send({ error: message });
      }
    },
  );

  app.post<{ Params: { tenantSlug: string } }>(
    '/gpu/agent/:tenantSlug/fleet-handshake',
    async (request, reply) => {
      const tenant = await resolveTenant(request.params.tenantSlug);
      if (!tenant) return reply.code(404).send({ error: 'Unknown tenant' });

      const body = parseJsonBody<Partial<FleetHandshakeRequest>>(request);
      if (!body.fleetToken || !body.agentVersion || !body.inventory) {
        return reply.code(400).send({ error: 'fleetToken, agentVersion, inventory required' });
      }

      try {
        const { host, agentToken } = await completeFleetHandshake({
          tenantDbName: tenant.tenantDbName,
          tenantId: tenant.tenantId,
          fleetToken: String(body.fleetToken),
          agentVersion: String(body.agentVersion),
          inventory: body.inventory,
        });

        if (Array.isArray(body.slices) && body.slices.length > 0) {
          await reconcileSlicesFromAgent({
            tenantDbName: tenant.tenantDbName,
            tenantId: tenant.tenantId,
            hostId: host.id,
            slices: body.slices,
          });
        }

        const response: FleetHandshakeResponse = {
          hostId: host.id,
          agentToken,
          status: 'pending_claim',
          heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
          commandPollWaitSeconds: COMMAND_POLL_WAIT_SECONDS,
          tenantId: tenant.tenantId,
          tenantSlug: tenant.tenantSlug,
        };
        return reply.code(200).send(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Fleet handshake failed';
        log.warn('fleet handshake failed', { tenantSlug: tenant.tenantSlug, message });
        return reply.code(401).send({ error: message });
      }
    },
  );

  app.post<{ Params: { tenantSlug: string } }>(
    '/gpu/agent/:tenantSlug/heartbeat',
    (request, reply) =>
      withAuthenticatedAgent(request, reply, async ({ tenant, host }) => {
        const body = parseJsonBody<Partial<HeartbeatRequest>>(request);
        // Inventory inlined in heartbeat refreshes accelerator + framework
        // on the host row — critical for hosts that registered before their
        // NVIDIA driver loaded ("cpu" → "nvidia-gpu" after reboot).
        await touchHostHeartbeat(
          tenant.tenantDbName,
          host.id,
          body.agentVersion ?? null,
          body.inventory ?? null,
        );

        if (Array.isArray(body.slices) && body.slices.length > 0) {
          await reconcileSlicesFromAgent({
            tenantDbName: tenant.tenantDbName,
            tenantId: tenant.tenantId,
            hostId: host.id,
            slices: body.slices,
          });
        }

        const response: HeartbeatResponse = {
          requestInventoryRefresh: Boolean(body.inventoryDirty),
          expectedTokenVersion: host.agentTokenVersion,
        };
        return reply.code(200).send(response);
      }),
  );

  app.post<{ Params: { tenantSlug: string } }>(
    '/gpu/agent/:tenantSlug/inventory',
    (request, reply) =>
      withAuthenticatedAgent(request, reply, async ({ tenant, host }) => {
        const body = parseJsonBody<Partial<InventoryRefreshRequest>>(request);
        if (!body.inventory) {
          return reply.code(400).send({ error: 'inventory required' });
        }
        const db = await getDatabase();
        await db.switchToTenant(tenant.tenantDbName);
        await db.updateGpuHost(host.id, {
          inventory: body.inventory as unknown as Record<string, unknown>,
        });
        if (Array.isArray(body.slices)) {
          await reconcileSlicesFromAgent({
            tenantDbName: tenant.tenantDbName,
            tenantId: tenant.tenantId,
            hostId: host.id,
            slices: body.slices,
          });
        }
        const response: InventoryRefreshResponse = { accepted: true };
        return reply.code(200).send(response);
      }),
  );

  app.get<{ Params: { tenantSlug: string }; Querystring: { wait?: string } }>(
    '/gpu/agent/:tenantSlug/commands',
    (request, reply) =>
      withAuthenticatedAgent(request, reply, async ({ tenant, host }) => {
        const requestedWait = Number(request.query.wait);
        const waitMs = Math.min(
          MAX_COMMAND_LONG_POLL_MS,
          Math.max(0, Number.isFinite(requestedWait) ? requestedWait * 1000 : MAX_COMMAND_LONG_POLL_MS),
        );

        const deadline = Date.now() + waitMs;
        // Simple polling loop. Replace with a pub/sub when host counts grow.
        // Returns as soon as anything is available; otherwise holds open until
        // the deadline, then returns an empty list so the agent reconnects.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const commands = await fetchPendingCommandsForAgent({
            tenantDbName: tenant.tenantDbName,
            hostId: host.id,
          });
          if (commands.length > 0 || Date.now() >= deadline) {
            const response: CommandPollResponse = { commands };
            return reply.code(200).send(response);
          }
          await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_TICK_MS));
        }
      }),
  );

  app.post<{ Params: { tenantSlug: string } }>(
    '/gpu/agent/:tenantSlug/events',
    (request, reply) =>
      withAuthenticatedAgent(request, reply, async ({ tenant, host }) => {
        const body = parseJsonBody<Partial<EventBatchRequest>>(request);
        if (!Array.isArray(body.events)) {
          return reply.code(400).send({ error: 'events array required' });
        }
        const result = await ingestAgentEvents({
          tenantDbName: tenant.tenantDbName,
          tenantId: tenant.tenantId,
          hostId: host.id,
          events: body.events,
        });
        const response: EventBatchResponse = {
          accepted: result.accepted,
          highWatermark: result.highWatermark,
        };
        return reply.code(200).send(response);
      }),
  );
};
