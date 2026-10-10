/**
 * The webhook subscription routes, shared by the dashboard (`/webhooks…`) and
 * the client API (`/client/v1/webhooks…`). Each surface hands in how a request
 * becomes a `WebhookScope` (who is calling, in which project); the routes and
 * their rules are the same.
 *
 * Authority is the policy engine's, asked by the route gate: `webhooks` is an
 * administration service, so a GET needs `read` and every other method `admin`.
 * The routes themselves look at no role. What they add is the engine's answer to
 * "does this caller hold `webhooks` in the workspace itself" (`webhookScopeFor`),
 * which decides whether tenant-wide and other projects' endpoints are in reach.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  WebhookApiError,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  listWebhookEventTypes,
  redeliverWebhookDelivery,
  rotateWebhookSecret,
  testWebhookEndpoint,
  updateWebhookEndpoint,
  type WebhookScope,
} from '@/lib/services/webhooks/webhookEndpointService';
import { safeReadJsonBody, serviceLevelForRequest } from '../fastify-utils';

const logger = createLogger('api:webhooks');

/**
 * The scope of a request: who is calling, in which project, and what the policy engine says the caller holds on
 * `webhooks` - in the project (for the page's controls) and in the workspace itself (for what lies outside the
 * project). Asked quietly and at most once per request. A token never holds the workspace question: it acts in its
 * own project only, whoever owns it.
 */
export function webhookScopeFor(
  request: FastifyRequest,
  base: Pick<WebhookScope, 'tenantDbName' | 'tenantId' | 'projectId' | 'userId'>,
): WebhookScope {
  let workspace: ReturnType<typeof serviceLevelForRequest> | undefined;
  let project: ReturnType<typeof serviceLevelForRequest> | undefined;
  const workspaceLevel = () => (workspace ??= serviceLevelForRequest(request, 'webhooks', { workspace: true }));
  const projectLevel = () => (project ??= serviceLevelForRequest(request, 'webhooks'));
  return {
    ...base,
    // `webhooks` is an administration service: its levels are none, read and admin.
    workspaceAllows: async (kind) => {
      const level = await workspaceLevel();
      return kind === 'read' ? level !== 'none' : level === 'admin';
    },
    capabilities: async () => {
      const [inProject, inWorkspace] = await Promise.all([projectLevel(), workspaceLevel()]);
      return { manage: inProject === 'admin', workspaceScope: inProject === 'admin' && inWorkspace === 'admin' };
    },
  };
}

export type WebhookRouteHandler = (
  scope: WebhookScope,
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

/** Wraps a handler with the surface's own auth / context; resolves the scope for it. */
export type WebhookRouteAdapter = (handler: WebhookRouteHandler) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Domain errors answer as themselves; anything else is a 500 that does not leak its message. */
export async function replyWebhookResult(reply: FastifyReply, run: () => Promise<unknown>, status = 200) {
  try {
    return reply.code(status).send(await run());
  } catch (error) {
    if (error instanceof WebhookApiError) {
      return reply.code(error.status).send({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export function registerWebhookRoutes(app: FastifyInstance, base: string, adapt: WebhookRouteAdapter): void {
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const queryOf = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;

  app.get(`${base}/events`, adapt((_scope, _request, reply) => replyWebhookResult(reply, async () => ({ events: listWebhookEventTypes() }))));

  app.get(base, adapt((scope, _request, reply) => replyWebhookResult(reply, () => listWebhookEndpoints(scope))));

  app.post(base, adapt((scope, request, reply) => replyWebhookResult(
    reply,
    () => createWebhookEndpoint(scope, safeReadJsonBody(request)),
    201,
  )));

  app.get(`${base}/:id`, adapt((scope, request, reply) => replyWebhookResult(reply, () => getWebhookEndpoint(scope, idOf(request)))));

  app.patch(`${base}/:id`, adapt((scope, request, reply) => replyWebhookResult(
    reply,
    () => updateWebhookEndpoint(scope, idOf(request), safeReadJsonBody(request)),
  )));

  app.delete(`${base}/:id`, adapt((scope, request, reply) => replyWebhookResult(reply, () => deleteWebhookEndpoint(scope, idOf(request)))));

  app.post(`${base}/:id/rotate-secret`, adapt((scope, request, reply) => replyWebhookResult(reply, () => rotateWebhookSecret(scope, idOf(request)))));

  app.post(`${base}/:id/test`, adapt((scope, request, reply) => replyWebhookResult(reply, () => testWebhookEndpoint(scope, idOf(request)))));

  app.get(`${base}/:id/deliveries`, adapt((scope, request, reply) => replyWebhookResult(
    reply,
    () => listWebhookDeliveries(scope, idOf(request), queryOf(request)),
  )));

  app.post(`${base}/deliveries/:deliveryId/redeliver`, adapt((scope, request, reply) => replyWebhookResult(
    reply,
    () => redeliverWebhookDelivery(scope, (request.params as { deliveryId: string }).deliveryId),
    202,
  )));
}

/** Logged once per unexpected failure by the adapters. */
export function logWebhookRouteError(error: unknown): void {
  logger.error('Webhook route error', { error });
}
