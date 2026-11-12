import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDatabase } from '@/lib/database';
import { isShuttingDown } from '@/lib/core/lifecycle';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { markGated } from '@/lib/iam/routeAuthz';
import { ApiTokenAuthError, type ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { isPlanLimitError, planLimitAnthropicBody, planLimitErrorBody, planLimitHeaders, planLimitOpenAiBody } from '@/lib/limits';
import { DelegationError } from '@/lib/iam/delegationGate';
import { getAuthzClientIp } from './request';
import { RbacAuthorizationError, AUTHORIZATION_RETRY_AFTER_SECONDS } from './rbacError';
import { requireApiTokenContext, applyDelegation, countApiRequestRate } from './apiToken';
import { enforceServiceAvailability, enforceApiTokenRbac } from './rbac';

/** Error envelope styles for the client (token) API. */
export type ClientApiErrorStyle = 'json' | 'openai' | 'anthropic';

export interface ClientApiContextOptions {
  /**
   * Response envelope on error. `'json'` → `{ error: string }` (the default,
   * used by most client routes). `'openai'` → `{ error: { message, type } }`
   * for OpenAI-SDK-compatible routes (chat/completions, embeddings, audio).
   */
  errorStyle?: ClientApiErrorStyle;
  /**
   * Enforce API-token RBAC for paths that map to a permission service. Defaults
   * to `true`. Only set `false` for routes that are intentionally open to any
   * valid token regardless of the token owner's service permissions. (RBAC is a
   * no-op for paths with no permission-service mapping, so leaving it on is
   * safe and is what closes accidental bypasses.)
   */
  rbac?: boolean;
}

function openAiErrorBody(message: string, type: string) {
  return { error: { message, type } };
}

/**
 * Anthropic's envelope. Different enough from OpenAI's that an SDK cannot read
 * the other one: it is `{type:'error', error:{type, message}}`, and the error
 * `type` vocabulary is its own (`authentication_error`, `permission_error`,
 * `invalid_request_error`, `api_error`).
 */
function anthropicErrorEnvelope(message: string, type: string) {
  return { type: 'error', error: { type, message } };
}

/**
 * Single error responder for the client (token) API. Maps the well-known error
 * types to the right status + envelope so every token route reports failures
 * identically. Returns the reply (never null) so callers can `return` it.
 */
function sendClientApiError(
  reply: FastifyReply,
  error: unknown,
  style: ClientApiErrorStyle,
) {
  if (isPlanLimitError(error)) {
    // A plan limit (requests per minute, allowance, storage, ...): the code is the contract, in every dialect.
    for (const [name, value] of Object.entries(planLimitHeaders(error))) reply.header(name, value);
    if (style === 'anthropic') return reply.code(error.status).send(planLimitAnthropicBody(error));
    if (style === 'openai') return reply.code(error.status).send(planLimitOpenAiBody(error));
    return reply.code(error.status).send(planLimitErrorBody(error));
  }

  if (error instanceof ApiTokenAuthError) {
    // A refusal that carries a code (`ip_not_allowed`) is "authenticated but not
    // permitted from here": a 403 permission error in every dialect, with the
    // code visible, so a client can tell it apart from a bad or expired token.
    if (error.code) {
      if (style === 'anthropic') {
        return reply.code(error.status).send(anthropicErrorEnvelope(error.message, 'permission_error'));
      }
      if (style === 'openai') {
        const body = openAiErrorBody(error.message, 'permission_error');
        return reply.code(error.status).send({ error: { ...body.error, code: error.code } });
      }
      return reply.code(error.status).send({ error: error.message, code: error.code });
    }
    if (style === 'anthropic') {
      return reply.code(401).send(anthropicErrorEnvelope(error.message, 'authentication_error'));
    }
    if (style === 'openai') {
      // OpenAI SDKs treat auth failures as 401 regardless of the finer status.
      return reply.code(401).send(openAiErrorBody(error.message, 'invalid_request_error'));
    }
    return reply.code(error.status).send({ error: error.message });
  }

  if (error instanceof DelegationError) {
    // 401 (the user token was not accepted), 403 (the person may not act through an API token) or 503 (the stores cannot
    // answer): the typed code and the decision id are in every dialect, so a caller can tell them apart and quote the id.
    if (error.status === 503) reply.header('Retry-After', AUTHORIZATION_RETRY_AFTER_SECONDS);
    if (style === 'anthropic') {
      const type = error.status === 403 ? 'permission_error' : error.status === 503 ? 'api_error' : 'authentication_error';
      const envelope = anthropicErrorEnvelope(error.message, type);
      return reply.code(error.status).send({ ...envelope, error: { ...envelope.error, code: error.code, decision_id: error.decisionId } });
    }
    if (style === 'openai') {
      const type = error.status === 403 ? 'permission_error' : error.status === 503 ? 'server_error' : 'invalid_request_error';
      const body = openAiErrorBody(error.message, type);
      return reply.code(error.status).send({ error: { ...body.error, code: error.code, decision_id: error.decisionId } });
    }
    return reply.code(error.status).send({ error: error.message, code: error.code, decisionId: error.decisionId });
  }

  if (error instanceof RbacAuthorizationError) {
    const code = typeof error.body?.code === 'string' ? error.body.code : undefined;
    // A refusal names its decision in every dialect, so an API caller can hand it to
    // IAM center > Access check (403) or to support (503) like a dashboard user can.
    const decisionId = typeof error.body?.decisionId === 'string' ? error.body.decisionId : undefined;
    const extra = decisionId ? { decision_id: decisionId } : {};
    // 503 = authorization was unavailable (nobody was refused on merit): a server
    // error in every dialect, one the SDKs retry - not a permission error.
    const unavailable = error.status === 503;
    for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
    if (style === 'anthropic') {
      const envelope = anthropicErrorEnvelope(error.message, unavailable ? 'api_error' : 'permission_error');
      return reply.code(error.status).send({ ...envelope, error: { ...envelope.error, ...extra } });
    }
    if (style === 'openai') {
      const body = openAiErrorBody(error.message, unavailable ? 'server_error' : 'permission_error');
      return reply.code(error.status).send({ error: { ...body.error, ...(code ? { code } : {}), ...extra } });
    }
    return reply.code(error.status).send(error.body ?? { error: error.message });
  }

  if (style === 'anthropic') {
    return reply.code(500).send(anthropicErrorEnvelope('Internal server error', 'api_error'));
  }
  if (style === 'openai') {
    return reply.code(500).send(openAiErrorBody('Internal server error', 'server_error'));
  }
  return reply
    .code(500)
    .send({ error: error instanceof Error ? error.message : 'Internal server error' });
}

/**
 * THE canonical wrapper for every API-token ("client") route. It is the single
 * source of truth for the token request lifecycle:
 *   1. shutdown guard (503),
 *   2. authenticate the Bearer token → ApiTokenContext (stored on the request),
 *   3. enforce API-token RBAC (unless `rbac: false`; no-op for unmapped paths),
 *   4. bind the tenant DB for the WHOLE handler via `runWithTenant` (immune to
 *      the cross-tenant process-global race under concurrent load),
 *   5. uniform error responses (`errorStyle`).
 * The resolved `auth` context is passed as the handler's third argument.
 *
 * Do not hand-roll this per plugin — pass options instead. Local clones drift
 * (e.g. silently skipping RBAC on chat/embeddings/ocr-jobs).
 */
export function withClientApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
  options: ClientApiContextOptions = {},
) {
  const errorStyle: ClientApiErrorStyle = options.errorStyle ?? 'json';
  const enforceRbac = options.rbac ?? true;

  const run = async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      if (errorStyle === 'openai') {
        return reply
          .code(503)
          .header('Retry-After', '5')
          .send(openAiErrorBody('Service is shutting down', 'server_error'));
      }
      if (errorStyle === 'anthropic') {
        // `overloaded_error` is the Messages type the SDKs treat as retryable,
        // which is exactly what a draining instance wants them to do.
        return reply
          .code(503)
          .header('Retry-After', '5')
          .send(anthropicErrorEnvelope('Service is shutting down', 'overloaded_error'));
      }
      return reply
        .code(503)
        .header('Retry-After', '5')
        .send({ error: 'Service is shutting down' });
    }

    let apiToken: ApiTokenContext;
    try {
      apiToken = await requireApiTokenContext(request);
      request.apiTokenContext = apiToken;
      // A call that carries a user token acts for that person: from here on they are the principal (capped by this
      // token's scope and project), and this token stays the actor.
      apiToken = await applyDelegation(request, apiToken);
      await countApiRequestRate(request, reply, apiToken);
      await enforceServiceAvailability(request, apiToken.tenantId);
      if (enforceRbac) {
        await enforceApiTokenRbac(request, apiToken);
      }
    } catch (error) {
      return sendClientApiError(reply, error, errorStyle);
    }

    try {
      return await runWithRequestContext(
        {
          requestId: request.apiRequestId,
          tenantId: apiToken.tenantId,
          tenantSlug: apiToken.tenantSlug,
          userId: apiToken.tokenRecord.userId
            ? String(apiToken.tokenRecord.userId)
            : apiToken.user?._id
              ? String(apiToken.user._id)
              : undefined,
          projectId: apiToken.projectId ?? undefined,
          apiTokenId: apiToken.tokenRecord._id ? String(apiToken.tokenRecord._id) : undefined,
          actorType: 'api_token',
          source: 'api',
          clientIp: getAuthzClientIp(request),
          ...(apiToken.delegation?.state === 'active' ? { via: { kind: 'delegated' as const, issuer: apiToken.delegation.issuer } } : {}),
        },
        async () => {
          // Bind the tenant DB for the whole handler execution so every nested
          // query resolves to the token's tenant. Without this, client-API
          // (token) requests never establish a tenant scope at request top and
          // fall back to the process-global tenant binding, which a concurrent
          // request for another tenant can overwrite — causing cross-tenant
          // reads/writes. Mirrors the cookie/RBAC path.
          const db = await getDatabase();
          if (typeof db.runWithTenant === 'function') {
            return db.runWithTenant(apiToken.tenantDbName, () =>
              handler(request as TRequest, reply, apiToken),
            );
          }
          await db.switchToTenant(apiToken.tenantDbName);
          return handler(request as TRequest, reply, apiToken);
        },
      );
    } catch (error) {
      return sendClientApiError(reply, error, errorStyle);
    }
  };
  // `rbac: false` opts out of the permission gate, so such a route is not "gated".
  return enforceRbac ? markGated(run) : run;
}

/**
 * Convenience for OpenAI-SDK-compatible token routes (chat/completions,
 * embeddings, audio/*, ocr). Identical to {@link withClientApiRequestContext}
 * but emits the OpenAI `{ error: { message, type } }` envelope. RBAC stays on
 * by default (no-op for paths without a permission service) — this is what
 * closes the historical bypasses on the routes that DO map to a service.
 */
export function withOpenAiApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
  options: Omit<ClientApiContextOptions, 'errorStyle'> = {},
) {
  return withClientApiRequestContext(handler, { ...options, errorStyle: 'openai' });
}

/**
 * Same lifecycle as the OpenAI wrapper — auth, RBAC, tenant binding — with the
 * Messages-dialect error envelope. A route that authenticates identically but
 * answers failures in the other dialect is the whole difference, and it has to
 * be the whole difference: an Anthropic SDK cannot parse an OpenAI error body,
 * so a shared wrapper with the wrong envelope turns every 401 into an opaque
 * client-side crash.
 */
export function withAnthropicApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
  options: Omit<ClientApiContextOptions, 'errorStyle'> = {},
) {
  return withClientApiRequestContext(handler, { ...options, errorStyle: 'anthropic' });
}
