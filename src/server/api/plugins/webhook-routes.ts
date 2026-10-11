/**
 * The webhook subscription routes, shared by the dashboard (`/webhooks…`) and
 * the client API (`/client/v1/webhooks…`). Each surface hands in how a request
 * becomes a `WebhookScope` (who is calling, in which project); the routes and
 * their rules are the same.
 *
 * Authority is the policy engine's, asked by the route gate: `webhooks` is an
 * administration service, so a GET asks `webhooks.read` and every route that changes
 * something asks `webhooks.admin` (declared on the route below: the gate would
 * otherwise ask `webhooks.write` for a POST, and a rule that names only that action
 * would let somebody edit a webhook without administering the service).
 * The routes themselves look at no role. What they add is the engine's answer to
 * "does this caller hold `webhooks` in the workspace itself" (`webhookScopeFor`),
 * which decides whether tenant-wide and other projects' endpoints are in reach.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { authz } from '@/lib/iam/routeAuthz';
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
import { safeReadJsonBody, serviceActionAllowedForRequest } from '../fastify-utils';

const logger = createLogger('api:webhooks');

/**
 * The scope of a request: who is calling, in which project, and what the policy engine says the caller may do with
 * `webhooks` - in the project (for the page's controls) and in the workspace itself (for what lies outside the
 * project). Each answer is the engine's decision on the one action the matching route asks its gate for (`read` to
 * look, `admin` to change), so what the page shows and what the routes allow cannot drift apart. Asked quietly and
 * at most once per request. A token never holds the workspace question: it acts in its own project only, whoever
 * owns it.
 */
export function webhookScopeFor(
  request: FastifyRequest,
  base: Pick<WebhookScope, 'tenantDbName' | 'tenantId' | 'projectId' | 'userId'>,
): WebhookScope {
  const memo = new Map<string, Promise<boolean>>();
  const allows = (level: 'read' | 'admin', workspace: boolean) => {
    const key = `${workspace ? 'workspace' : 'project'}:${level}`;
    let answer = memo.get(key);
    if (!answer) {
      answer = serviceActionAllowedForRequest(request, 'webhooks', level, workspace ? { workspace: true } : {});
      memo.set(key, answer);
    }
    return answer;
  };
  return {
    ...base,
    workspaceAllows: (kind) => allows(kind === 'read' ? 'read' : 'admin', true),
    capabilities: async () => {
      const [manage, inWorkspace] = await Promise.all([allows('admin', false), allows('admin', true)]);
      return { manage, workspaceScope: manage && inWorkspace };
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

/** Every route that changes something (create, edit, delete, rotate, test, redeliver) asks the gate for `webhooks.admin`, not the method-derived `webhooks.write`. */
const CHANGES_WEBHOOKS = { config: authz.service('webhooks', 'admin') } as const;

export function registerWebhookRoutes(app: FastifyInstance, base: string, adapt: WebhookRouteAdapter): void {
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const queryOf = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;

  app.get(`${base}/events`, adapt((_scope, _request, reply) => replyWebhookResult(reply, async () => ({ events: listWebhookEventTypes() }))));

  app.get(base, adapt((scope, _request, reply) => replyWebhookResult(reply, () => listWebhookEndpoints(scope))));

  app.post(base, CHANGES_WEBHOOKS, adapt((scope, request, reply) => replyWebhookResult(
    reply,
    () => createWebhookEndpoint(scope, safeReadJsonBody(request)),
    201,
  )));

  app.get(`${base}/:id`, adapt((scope, request, reply) => replyWebhookResult(reply, () => getWebhookEndpoint(scope, idOf(request)))));

  app.patch(`${base}/:id`, CHANGES_WEBHOOKS, adapt((scope, request, reply) => replyWebhookResult(
    reply,
    () => updateWebhookEndpoint(scope, idOf(request), safeReadJsonBody(request)),
  )));

  app.delete(`${base}/:id`, CHANGES_WEBHOOKS, adapt((scope, request, reply) => replyWebhookResult(reply, () => deleteWebhookEndpoint(scope, idOf(request)))));

  app.post(`${base}/:id/rotate-secret`, CHANGES_WEBHOOKS, adapt((scope, request, reply) => replyWebhookResult(reply, () => rotateWebhookSecret(scope, idOf(request)))));

  app.post(`${base}/:id/test`, CHANGES_WEBHOOKS, adapt((scope, request, reply) => replyWebhookResult(reply, () => testWebhookEndpoint(scope, idOf(request)))));

  app.get(`${base}/:id/deliveries`, adapt((scope, request, reply) => replyWebhookResult(
    reply,
    () => listWebhookDeliveries(scope, idOf(request), queryOf(request)),
  )));

  app.post(`${base}/deliveries/:deliveryId/redeliver`, CHANGES_WEBHOOKS, adapt((scope, request, reply) => replyWebhookResult(
    reply,
    () => redeliverWebhookDelivery(scope, (request.params as { deliveryId: string }).deliveryId),
    202,
  )));
}

/** Logged once per unexpected failure by the adapters. */
export function logWebhookRouteError(error: unknown): void {
  logger.error('Webhook route error', { error });
}
