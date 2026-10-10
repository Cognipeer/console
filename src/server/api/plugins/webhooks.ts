/**
 * Dashboard webhook routes (`/api/webhooks…`): the session user, acting in the
 * active project. See `webhook-routes.ts` for the routes and
 * `webhookEndpointService.ts` for who may manage what.
 */

import type { FastifyPluginAsync } from 'fastify';
import { logWebhookRouteError, registerWebhookRoutes, type WebhookRouteAdapter } from './webhook-routes';
import { requireProjectContextForRequest, sendProjectContextError, withApiRequestContext } from '../fastify-utils';

const adapt: WebhookRouteAdapter = (handler) => withApiRequestContext(async (request, reply) => {
  try {
    const { projectId, user, userProject, session } = await requireProjectContextForRequest(request);
    const isTenantAdmin = user.role === 'owner' || user.role === 'admin';
    return await handler({
      tenantDbName: session.tenantDbName,
      tenantId: session.tenantId,
      projectId,
      actor: {
        userId: session.userId,
        isTenantAdmin,
        isProjectAdmin: isTenantAdmin || user.role === 'project_admin' || userProject?.role === 'project_admin',
      },
    }, request, reply);
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
