/**
 * The webhook subscription routes, shared by the dashboard (`/webhooks…`) and
 * the client API (`/client/v1/webhooks…`). Each surface hands in how a request
 * becomes a `WebhookScope` (who is calling, in which project); the routes and
 * their rules are the same.
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
import { safeReadJsonBody } from '../fastify-utils';

const logger = createLogger('api:webhooks');

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
