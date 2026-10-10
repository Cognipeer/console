/**
 * Dashboard webhook routes (`/api/webhooks…`): the session user, acting in the
 * active project. See `webhook-routes.ts` for the routes and
 * `webhookEndpointService.ts` for the data scoping. Who may do what is the policy
 * engine's (the `webhooks` service); nothing here looks at a role.
 */

import type { FastifyPluginAsync } from 'fastify';
import { logWebhookRouteError, registerWebhookRoutes, webhookScopeFor, type WebhookRouteAdapter } from './webhook-routes';
import { requireProjectContextForRequest, sendProjectContextError, withApiRequestContext } from '../fastify-utils';

const adapt: WebhookRouteAdapter = (handler) => withApiRequestContext(async (request, reply) => {
  try {
    const { projectId, session } = await requireProjectContextForRequest(request);
    return await handler(webhookScopeFor(request, {
      tenantDbName: session.tenantDbName,
      tenantId: session.tenantId,
      projectId,
      userId: session.userId,
    }), request, reply);
  } catch (error) {
    const sent = sendProjectContextError(reply, error);
    if (sent) return sent;
    logWebhookRouteError(error);
    return reply.code(500).send({ error: 'Internal server error' });
  }
});

export const webhooksApiPlugin: FastifyPluginAsync = async (app) => {
  registerWebhookRoutes(app, '/webhooks', adapt);
};
