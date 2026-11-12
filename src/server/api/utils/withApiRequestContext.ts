import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDatabase } from '@/lib/database';
import { isShuttingDown } from '@/lib/core/lifecycle';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { markGated } from '@/lib/iam/routeAuthz';
import { isPlanLimitError, planLimitErrorBody, planLimitHeaders } from '@/lib/limits';
import { getAuthzClientIp } from './request';
import { sendRbacError } from './rbacError';
import { getSessionContext } from './session';
import { enforceServiceAvailability, enforceSessionRbac, applyGateLoadedRole } from './rbac';

export function withApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (request: TRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return markGated(async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      return reply
        .code(503)
        .header('Retry-After', '5')
        .send({ error: 'Service is shutting down' });
    }

    const session = getSessionContext(request);

    try {
      if (session) {
        await enforceServiceAvailability(request, session.tenantId);
        await enforceSessionRbac(request, session);
        applyGateLoadedRole(request, session);
      }
    } catch (error) {
      return sendRbacError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }

    try {
      return await runWithRequestContext(
        {
          requestId: request.apiRequestId,
          tenantId: session?.tenantId,
          tenantSlug: session?.tenantSlug,
          userId: session?.userId,
          actorType: session ? 'user' : undefined,
          source: 'dashboard',
          clientIp: getAuthzClientIp(request),
        },
        async () => {
          // Bind the tenant DB for the whole handler execution so every nested
          // query resolves to this session's tenant. Without this, cookie/RBAC
          // (dashboard) requests never establish a tenant scope at request top
          // and fall back to the process-global tenant binding, which a
          // concurrent request for another tenant can overwrite — causing
          // cross-tenant reads/writes (e.g. a provider/model landing in the
          // wrong tenant DB). Mirrors the client-API (token) path above.
          const db = await getDatabase();
          if (session?.tenantDbName && typeof db.runWithTenant === 'function') {
            return db.runWithTenant(session.tenantDbName, () =>
              handler(request as TRequest, reply),
            );
          }
          return handler(request as TRequest, reply);
        },
      );
    } catch (error) {
      // A handler-level authorization check (authorizeServiceForRequest) refuses
      // by throwing, exactly as the gate does; anything else is the handler's own
      // error and goes to the framework's error handler, as it always did.
      if (isPlanLimitError(error)) {
        reply.headers(planLimitHeaders(error));
        return reply.code(error.status).send(planLimitErrorBody(error));
      }
      const refused = sendRbacError(reply, error);
      if (refused) return refused;
      throw error;
    }
  });
}
