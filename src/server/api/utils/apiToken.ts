import { createLogger } from '@/lib/core/logger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiTokenAuthError, requireApiTokenFromHeader, type ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { assertApiRequestRate } from '@/lib/limits';
import { DelegationError, resolveDelegatedCaller, USER_TOKEN_HEADER } from '@/lib/iam/delegationGate';
import { getHeaderValue, getAuthzClientIp, getRequestPathname } from './request';

const logger = createLogger('api:session-account-state');

export async function requireApiTokenContext(
  request: FastifyRequest,
): Promise<ApiTokenContext> {
  try {
    return await requireApiTokenFromHeader(getHeaderValue(request, 'authorization'), {
      // The token's IP allowlist is matched against the address the server can
      // vouch for (getAuthzClientIp: the connection peer, or the forwarded address
      // only through the configured trusted proxies), never against a header the
      // caller can set.
      clientIp: getAuthzClientIp(request),
    });
  } catch (error) {
    if (error instanceof ApiTokenAuthError && error.code === 'ip_not_allowed' && error.denial) {
      const { denial } = error;
      // Authentication refused the call before any tenant context existed, so the
      // response-time audit hook would write nothing; record the refusal itself.
      void import('@/lib/services/apiTokens/ipDenialAudit')
        .then(({ recordTokenIpDenial }) => recordTokenIpDenial({
          ...denial,
          requestId: request.apiRequestId,
          method: request.method,
          path: getRequestPathname(request),
          userAgent: getHeaderValue(request, 'user-agent') ?? undefined,
        }))
        .catch((auditError: unknown) => {
          logger.warn('Could not audit a token IP refusal', {
            error: auditError instanceof Error ? auditError.message : String(auditError),
          });
        });
    }
    throw error;
  }
}

/**
 * The context a request runs in once its user token (if any) has been honoured. A request without the header is returned
 * as it is. With it, the person becomes the principal: `user` and `tokenRecord.userId` are theirs (so every handler that
 * reads "who is calling" - the engine gate, the quota keys, the runtime context, the attribution of what is created -
 * sees the person), while `tokenRecord._id`, the token scope and the project stay the application's - and the person must
 * be able to open that project themselves (the gate refuses with `project_not_accessible` otherwise).
 * A refusal throws a {@link DelegationError}; it is audited with a decision id and attributed to the application token,
 * never to the account the token belongs to.
 */
export async function applyDelegation(request: FastifyRequest, apiToken: ApiTokenContext): Promise<ApiTokenContext> {
  try {
    const caller = await resolveDelegatedCaller({
      headerValue: request.headers[USER_TOKEN_HEADER],
      tokenId: apiToken.tokenRecord._id ? String(apiToken.tokenRecord._id) : undefined,
      tenantDbName: apiToken.tenantDbName,
      tenantId: apiToken.tenantId,
      // The project the call runs in: the person must be able to open it themselves.
      projectId: apiToken.projectId,
      requireUserToken: apiToken.tokenRecord.requireUserToken === true,
    });
    if (!caller) return apiToken;
    const delegated: ApiTokenContext = {
      ...apiToken,
      tokenRecord: { ...apiToken.tokenRecord, userId: String(caller.user._id) },
      user: caller.user,
      delegation: {
        state: 'active',
        issuer: caller.issuer,
        subject: caller.subject,
        kind: caller.kind,
        appOwnerId: String(apiToken.tokenRecord.userId),
        created: caller.created,
      },
    };
    request.apiTokenContext = delegated;
    return delegated;
  } catch (error) {
    if (error instanceof DelegationError) {
      request.iamDenial = {
        code: 'delegation_refused',
        decisionId: error.decisionId,
        reasons: [error.code],
        ip: getAuthzClientIp(request),
      };
      request.apiTokenContext = {
        ...apiToken,
        user: null,
        delegation: { state: 'refused', code: error.code, issuer: error.issuer, subject: error.subject },
      };
    }
    throw error;
  }
}

/** Requests already counted against the plan's requests per minute (one count per request, however many wrappers it passes). */
const rpmCountedRequests = new WeakSet<FastifyRequest>();

/**
 * Counts this request once against the tenant's plan requests per minute and sets the rate headers on the reply.
 * Throws PlanLimitError when over the limit. No-op when plan limits are off, and for a route configured `countRpm: false`.
 * Not called from `requireApiTokenContext`: a long stream re-runs that to refresh the principal.
 */
export async function countApiRequestRate(request: FastifyRequest, reply: FastifyReply | undefined, apiToken: ApiTokenContext): Promise<void> {
  if (rpmCountedRequests.has(request)) return;
  rpmCountedRequests.add(request);
  const config = request.routeOptions?.config as { countRpm?: boolean } | undefined;
  if (config?.countRpm === false) return;
  const tokenId = apiToken.tokenRecord._id ? String(apiToken.tokenRecord._id) : undefined;
  const headers = await assertApiRequestRate({ tenantId: apiToken.tenantId, source: { type: 'api_token', id: tokenId } });
  if (reply) for (const [name, value] of Object.entries(headers)) reply.header(name, value);
}

export async function getApiTokenContextForRequest(
  request: FastifyRequest,
  reply?: FastifyReply,
): Promise<ApiTokenContext> {
  if (request.apiTokenContext) {
    return request.apiTokenContext;
  }

  const context = await requireApiTokenContext(request);
  // A route that authenticates here instead of through `withClientApiRequestContext` (which has already honoured the header
  // and left its context on the request) does not act for users. A call that asks it to is refused rather than answered as
  // the token's owner.
  if (request.headers[USER_TOKEN_HEADER] !== undefined) {
    throw new ApiTokenAuthError('This endpoint does not act for users: remove the user token header', 400, 'user_token_not_supported');
  }
  // A token that must act for a person has no business on an endpoint that cannot: refused, never answered as its owner.
  if (context.tokenRecord.requireUserToken === true) {
    throw new ApiTokenAuthError('This API token only acts for users and this endpoint does not support that', 403, 'user_token_required');
  }
  await countApiRequestRate(request, reply, context);
  request.apiTokenContext = context;
  return context;
}

export function sendApiTokenError(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof ApiTokenAuthError) {
    return reply.code(error.status).send(error.code ? { error: error.message, code: error.code } : { error: error.message });
  }

  return null;
}
