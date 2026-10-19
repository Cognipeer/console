/**
 * Incoming trigger webhooks (SPEC-webhooks W2):
 *
 *   POST /api/public/hooks/:tenantId/:hookId
 *
 * No API token: the URL names the tenant and the trigger's random hook id, and
 * every delivery proves the trigger's secret — in a header (checked in
 * `onRequest`, before the body is read) or as a signature over the raw body
 * (checked once it is read). An unknown URL is 404 and remembered per node for
 * a minute; a found trigger is never cached, so disabling, rotating or deleting
 * applies at once on every replica. A failed lookup is 503 (Azure DevOps
 * retries it) and is not remembered.
 *
 * The body is kept as the exact bytes received (signatures cover them), within
 * AGENT_WEBHOOK_BODY_LIMIT_BYTES; anything but JSON is 415. Floods from many
 * addresses are the ingress / WAF's job: senders such as GitHub and Azure
 * DevOps share addresses, and the client address is only as reliable as the
 * proxy settings, so nothing here keys on it. Bodies, headers and secrets are
 * never logged.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import { isServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import type { AgentTriggerOfType, IAgentTrigger, ITenant } from '@/lib/database';
import { authz } from '@/lib/iam/routeAuthz';
import { apiErrorBody } from '@/lib/services/agents/agentRunService';
import { isHeaderAuth, verifyHeaderAuth } from '@/lib/services/agents/agentTriggerWebhookAuth';
import { processWebhookDelivery, recordDelivery, unauthorizedAnswer, type WebhookAnswer } from '@/lib/services/agents/agentTriggerWebhookDelivery';
import { openWebhookSecrets } from '@/lib/services/agents/agentTriggerWebhookIntake';
import { countRequest } from '@/lib/services/auth/sharedRateCounter';

const logger = createLogger('api:public-hooks');

const PUBLIC_HOOK_AUTHZ = authz.self(
  'unauthenticated by design: addressed by tenant id + random hook id; every delivery is authenticated with the trigger secret',
);

interface HookDelivery {
  tenant: ITenant;
  trigger: AgentTriggerOfType<'webhook'>;
  secrets: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The trigger an incoming webhook resolved to (public-hooks.ts). */
    hookDelivery?: HookDelivery;
    /** A header auth mode verified the request before its body was read. */
    hookAuthenticated?: boolean;
  }
}

const NOT_FOUND_BODY = apiErrorBody('not_found_error', 'Unknown webhook.', 'webhook_not_found');
const UNAVAILABLE_BODY = apiErrorBody('api_error', 'The webhook cannot be looked up right now; retry later.', 'webhook_unavailable');
const UNSUPPORTED_MEDIA_MESSAGE = 'Send application/json. GitHub: set Content type to application/json.';

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/;
const HOOK_ID_RE = /^wh_[A-Za-z0-9_-]{16,64}$/;

/** The abuse ceiling per trigger and minute: max(600, 10 × the run limit). */
const ABUSE_FLOOR_PER_MINUTE = 600;

// ── Per-node caches ──────────────────────────────────────────────────────

/** A bounded map whose entries expire; the oldest entry goes first when it is full. */
class ExpiringMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Unknown (tenant, hook id) pairs. Only misses are remembered. */
const unknownHooks = new ExpiringMap<true>(10_000, 60_000);
/** Tenants by id (the tenant record changes rarely; the trigger is read on every request). */
const tenants = new ExpiringMap<ITenant>(1_000, 60_000);

/** Test seam: forget both caches. */
export function resetPublicHookCaches(): void {
  unknownHooks.clear();
  tenants.clear();
}

async function findTenant(tenantId: string): Promise<ITenant | null> {
  const cached = tenants.get(tenantId);
  if (cached) return cached;
  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId);
  if (tenant) tenants.set(tenantId, tenant);
  return tenant;
}

// ── Answers ──────────────────────────────────────────────────────────────

function send(reply: FastifyReply, answer: WebhookAnswer): FastifyReply {
  if (answer.retryAfterSeconds) void reply.header('Retry-After', String(answer.retryAfterSeconds));
  return reply.code(answer.status).send(answer.body);
}

const notFound = (reply: FastifyReply) => reply.code(404).send(NOT_FOUND_BODY);
const unavailable = (reply: FastifyReply) => reply.code(503).header('Retry-After', '30').send(UNAVAILABLE_BODY);
const rateLimited = (reply: FastifyReply, retryAfterSeconds: number) => reply
  .code(429)
  .header('Retry-After', String(Math.max(1, retryAfterSeconds)))
  .send(apiErrorBody('rate_limit_error', 'Too many requests for this webhook.', 'webhook_rate_limited'));

function contentLength(request: FastifyRequest): number {
  const value = Number(request.headers['content-length']);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

// ── onRequest: find the trigger, check a header secret (no body read yet) ──

async function resolveHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  const { tenantId, hookId } = request.params as { tenantId: string; hookId: string };
  const cacheKey = `${tenantId}:${hookId}`;
  const miss = () => {
    unknownHooks.set(cacheKey, true);
    return notFound(reply);
  };

  const mongo = getConfig().database.provider === 'mongodb';
  if (!TENANT_ID_RE.test(tenantId ?? '') || (mongo && !OBJECT_ID_RE.test(tenantId)) || !HOOK_ID_RE.test(hookId ?? '')) return miss();
  if (unknownHooks.get(cacheKey)) return notFound(reply);

  let tenant: ITenant | null;
  try {
    tenant = await findTenant(tenantId);
  } catch (error) {
    logger.warn('Webhook tenant lookup failed', { error: error instanceof Error ? error.message : String(error) });
    return unavailable(reply);
  }
  if (!tenant?.dbName) return miss();
  // A switched-off agents service answers like an unknown hook: no run is started.
  if (!(await isServiceEnabled({ tenantId: String(tenant._id) }, 'agents'))) return miss();

  let trigger: IAgentTrigger | null;
  try {
    trigger = await runWithTenantScope(tenant.dbName, (db) => db.findAgentTriggerByHookId(hookId));
  } catch (error) {
    logger.warn('Webhook trigger lookup failed', { error: error instanceof Error ? error.message : String(error) });
    return unavailable(reply);
  }
  if (!trigger || trigger.type !== 'webhook' || trigger.webhook.hookId !== hookId || trigger.tenantId !== String(tenant._id)) {
    return miss();
  }

  const webhook = trigger.webhook;
  const tenantDbName = tenant.dbName;
  const found = trigger;
  const receivedAt = new Date();
  const ceiling = Math.max(ABUSE_FLOOR_PER_MINUTE, 10 * getConfig().agent.webhooks.rateLimitPerMinute);
  const ceilingKey = `hook-abuse:${String(tenant._id)}:${String(trigger._id)}`;
  const record = (outcome: 'unauthorized' | 'rejected', httpStatus: number, reason: string) =>
    runWithTenantScope(tenantDbName, (db) => recordDelivery(db, found, { outcome, httpStatus, reason, bytes: contentLength(request), receivedAt }))
      .catch(() => undefined);
  const secrets = openWebhookSecrets(String(trigger._id), webhook, receivedAt);

  if (isHeaderAuth(webhook.auth)) {
    const check = secrets
      ? verifyHeaderAuth(webhook.auth, request.headers, webhook.headerName, secrets)
      : { ok: false as const, reason: 'secret unavailable; rotate the secret' };
    if (!check.ok) {
      // Only failed attempts count here: an authenticated request is never refused by the ceiling.
      const decision = await countRequest(ceilingKey, ceiling);
      if (!decision.allowed) {
        await record('rejected', 429, 'rate limited');
        return rateLimited(reply, decision.retryAfterSeconds);
      }
      await record('unauthorized', 401, check.reason);
      return send(reply, unauthorizedAnswer());
    }
    request.hookAuthenticated = true;
  } else {
    // A signature can only be checked once the body is read: every request counts.
    const decision = await countRequest(ceilingKey, ceiling);
    if (!decision.allowed) {
      await record('rejected', 429, 'rate limited');
      return rateLimited(reply, decision.retryAfterSeconds);
    }
    if (!secrets) {
      await record('unauthorized', 401, 'secret unavailable; rotate the secret');
      return send(reply, unauthorizedAnswer());
    }
  }
  request.hookDelivery = { tenant, trigger, secrets: secrets! };
}

// ── Plugin ───────────────────────────────────────────────────────────────

export const publicHooksApiPlugin: FastifyPluginAsync = async (app) => {
  const bodyLimit = getConfig().agent.webhooks.bodyLimitBytes;

  // Signatures cover the exact bytes: JSON stays a Buffer here (this scope only).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addContentTypeParser(/^application\/[\w.+-]+\+json$/, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  // Fastify's own refusals (a body over the limit, another media type) in the API's error envelope.
  app.setErrorHandler((error: { statusCode?: number; code?: string }, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send(apiErrorBody('invalid_request_error', `The body is larger than ${bodyLimit} bytes.`, 'payload_too_large'));
    }
    if (status === 415 || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send(apiErrorBody('invalid_request_error', UNSUPPORTED_MEDIA_MESSAGE, 'unsupported_media_type'));
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send(apiErrorBody('invalid_request_error', 'The request could not be read.', 'invalid_request'));
    }
    logger.error('Webhook request error', { code: error.code });
    return reply.code(500).send(apiErrorBody('api_error', 'Internal error', 'internal_error'));
  });

  app.post('/public/hooks/:tenantId/:hookId', { config: PUBLIC_HOOK_AUTHZ, bodyLimit, onRequest: resolveHook }, async (request, reply) => {
    const hook = request.hookDelivery;
    if (!hook) return notFound(reply);
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    try {
      // Everything from the body check on — de-duplication, the delivery rows, the fire — in one tenant scope.
      const answer = await runWithTenantScope(hook.tenant.dbName!, (db) => processWebhookDelivery(db, {
        trigger: hook.trigger,
        tenant: { tenantId: String(hook.tenant._id), tenantDbName: hook.tenant.dbName!, licenseType: hook.tenant.licenseType },
        headers: request.headers,
        body,
        receivedAt: new Date(),
        secrets: hook.secrets,
        headerAuthenticated: request.hookAuthenticated === true,
      }));
      return send(reply, answer);
    } catch (error) {
      logger.warn('Webhook delivery could not be processed', { error: error instanceof Error ? error.message : String(error) });
      return unavailable(reply);
    }
  });
};
