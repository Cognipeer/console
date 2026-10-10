/**
 * Client API webhook routes (`/api/client/v1/webhooks…`): the API token's owner,
 * acting in the token's project. The same routes and rules as the dashboard —
 * see `webhook-routes.ts` / `webhookEndpointService.ts`. A token whose owner is
 * only a project member manages nothing, and a token never manages beyond its
 * own project, even for a tenant owner / admin.
 */

import type { FastifyPluginAsync } from 'fastify';
import { getDatabase } from '@/lib/database';
import { registerWebhookRoutes, type WebhookRouteAdapter } from './webhook-routes';
import { withClientApiRequestContext } from '../fastify-utils';

const adapt: WebhookRouteAdapter = (handler) => withClientApiRequestContext(async (request, reply, ctx) => {
  const owner = ctx.user;
  const ownerIsTenantAdmin = owner?.role === 'owner' || owner?.role === 'admin';
  let isProjectAdmin = ownerIsTenantAdmin || owner?.role === 'project_admin';
  if (owner && !isProjectAdmin && ctx.projectId) {
    const membership = await (await getDatabase()).findUserProject(String(owner._id), ctx.projectId);
    isProjectAdmin = membership?.role === 'project_admin';
  }
  return handler({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: {
      userId: String(ctx.tokenRecord.userId ?? owner?._id ?? ''),
      // A project-scoped token never acts as a tenant admin: no tenant-wide
      // endpoints and no endpoints of other projects, whoever owns the token.
      isTenantAdmin: false,
      isProjectAdmin,
    },
  }, request, reply);
});

export const clientWebhooksApiPlugin: FastifyPluginAsync = async (app) => {
  registerWebhookRoutes(app, '/client/v1/webhooks', adapt);
};
