/**
 * Client API webhook routes (`/api/client/v1/webhooks…`): the API token's owner,
 * acting in the token's project. The same routes and rules as the dashboard —
 * see `webhook-routes.ts` / `webhookEndpointService.ts`. Who may do what is the
 * policy engine's (the `webhooks` service, as the token's owner within the token's
 * scope); a token never reaches beyond its own project, even for a tenant owner /
 * admin: no tenant-wide endpoints and no endpoints of other projects.
 */

import type { FastifyPluginAsync } from 'fastify';
import { registerWebhookRoutes, webhookScopeFor, type WebhookRouteAdapter } from './webhook-routes';
import { withClientApiRequestContext } from '../fastify-utils';

const adapt: WebhookRouteAdapter = (handler) => withClientApiRequestContext(async (request, reply, ctx) => handler(
  webhookScopeFor(request, {
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    userId: String(ctx.tokenRecord.userId ?? ctx.user?._id ?? ''),
  }),
  request,
  reply,
));

export const clientWebhooksApiPlugin: FastifyPluginAsync = async (app) => {
  registerWebhookRoutes(app, '/client/v1/webhooks', adapt);
};
