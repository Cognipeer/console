/**
 * Managing webhook subscriptions — what the dashboard (`/api/webhooks`) and the
 * client API (`/api/client/v1/webhooks`) both do. The two surfaces differ only
 * in how they authenticate; scoping and rules live here once.
 *
 * Who may do what:
 *  - an endpoint scoped to a project: that project's admins, and tenant
 *    owners / admins;
 *  - a tenant-wide endpoint (`projectId` null): tenant owners / admins only.
 * Anyone else gets a 403 on the collection and a 404 on an endpoint they may not
 * see, so an id does not confirm that something exists.
 *
 * The signing secret is returned exactly twice in an endpoint's life: when it is
 * created and when it is rotated. It is stored sealed and never read back out.
 */

import crypto from 'node:crypto';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { IWebhookDelivery, IWebhookEndpoint, WebhookDeliveryStatus } from '@/lib/database';
import { assertPublicUrl } from '@/lib/security/outboundFetch';
import { encryptObject } from '@/lib/utils/crypto';
import { WEBHOOK_EVENT_CATALOG, WEBHOOK_TEST_EVENT, normalizeEventList } from './webhookEvents';
import {
  disableWebhookEndpoint,
  enqueueWebhookDelivery,
  sendWebhookNow,
} from './webhookService';

const MAX_URL_LENGTH = 2_048;
const MAX_DESCRIPTION_LENGTH = 500;
/** A guard against fan-out, not a product limit. */
const MAX_ENDPOINTS_PER_TENANT = 50;
const DEFAULT_DELIVERY_PAGE = 50;
const MAX_DELIVERY_PAGE = 200;

export class WebhookApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'invalid_request') {
    super(message);
    this.name = 'WebhookApiError';
  }
}

export interface WebhookActor {
  userId: string;
  /** Tenant owner or admin. */
  isTenantAdmin: boolean;
  /** Admin of `scope.projectId` (tenant admins count). */
  isProjectAdmin: boolean;
}

export interface WebhookScope {
  tenantDbName: string;
  tenantId: string;
  /** The project the request is made in. */
  projectId: string;
  actor: WebhookActor;
}

// ── Wire shapes ──────────────────────────────────────────────────────────

export function serializeWebhookEndpoint(endpoint: IWebhookEndpoint) {
  return {
    id: String(endpoint._id),
    url: endpoint.url,
    description: endpoint.description || null,
    events: endpoint.events,
    projectId: endpoint.projectId ?? null,
    status: endpoint.status,
    disabledReason: endpoint.disabledReason ?? null,
    failingSince: endpoint.failingSince ? new Date(endpoint.failingSince).toISOString() : null,
    createdBy: endpoint.createdBy,
    createdAt: endpoint.createdAt ? new Date(endpoint.createdAt).toISOString() : null,
    updatedAt: endpoint.updatedAt ? new Date(endpoint.updatedAt).toISOString() : null,
  };
}

export function serializeWebhookDelivery(delivery: IWebhookDelivery) {
  return {
    id: String(delivery._id),
    endpointId: delivery.endpointId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt ? new Date(delivery.nextAttemptAt).toISOString() : null,
    lastStatusCode: delivery.lastStatusCode ?? null,
    lastError: delivery.lastError ?? null,
    lastDurationMs: delivery.lastDurationMs ?? null,
    createdAt: new Date(delivery.createdAt).toISOString(),
    deliveredAt: delivery.deliveredAt ? new Date(delivery.deliveredAt).toISOString() : null,
    payload: delivery.payload,
  };
}

// ── Rules ────────────────────────────────────────────────────────────────

function assertCanManage(scope: WebhookScope): void {
  if (!scope.actor.isTenantAdmin && !scope.actor.isProjectAdmin) {
    throw new WebhookApiError(403, 'Managing webhooks requires a project admin or a tenant owner / admin', 'forbidden');
  }
}

/** May the actor see and manage this endpoint? */
function canAccess(scope: WebhookScope, endpoint: IWebhookEndpoint): boolean {
  if (endpoint.tenantId !== scope.tenantId) return false;
  if (scope.actor.isTenantAdmin) return true;
  return Boolean(endpoint.projectId) && endpoint.projectId === scope.projectId && scope.actor.isProjectAdmin;
}

async function loadEndpoint(db: DatabaseProvider, scope: WebhookScope, id: unknown): Promise<IWebhookEndpoint> {
  assertCanManage(scope);
  const endpoint = typeof id === 'string' && id ? await db.findWebhookEndpointById(id) : null;
  if (!endpoint || !canAccess(scope, endpoint)) throw new WebhookApiError(404, 'Webhook not found', 'not_found');
  return endpoint;
}

/** Save-time URL check; the guard runs again, pinned, on every delivery. */
async function validateUrl(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) throw new WebhookApiError(400, 'url is required');
  const url = value.trim();
  if (url.length > MAX_URL_LENGTH) throw new WebhookApiError(400, `url must be at most ${MAX_URL_LENGTH} characters`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookApiError(400, 'url is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new WebhookApiError(400, 'url must use http or https');
  try {
    await assertPublicUrl(url);
  } catch {
    throw new WebhookApiError(400, 'url must resolve to a public address');
  }
  return url;
}

function validateDescription(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new WebhookApiError(400, 'description must be a string');
  if (value.length > MAX_DESCRIPTION_LENGTH) throw new WebhookApiError(400, `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  return value.trim() || undefined;
}

function validateEvents(value: unknown): string[] {
  const parsed = normalizeEventList(value);
  if (!parsed.ok) throw new WebhookApiError(400, parsed.message);
  return parsed.events;
}

export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

async function inTenantDb<T>(scope: WebhookScope, fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
  const db = await getDatabase();
  if (db.runWithTenant) return db.runWithTenant(scope.tenantDbName, () => fn(db));
  await db.switchToTenant(scope.tenantDbName);
  return fn(db);
}

// ── Operations ───────────────────────────────────────────────────────────

/** The event types a subscription can list, for forms. */
export function listWebhookEventTypes() {
  return WEBHOOK_EVENT_CATALOG.map((event) => ({ type: event.type, group: event.group }));
}

export function listWebhookEndpoints(scope: WebhookScope) {
  return inTenantDb(scope, async (db) => {
    assertCanManage(scope);
    const endpoints = await db.listWebhookEndpoints(scope.tenantId, {
      projectScopes: scope.actor.isTenantAdmin ? [scope.projectId, null] : [scope.projectId],
    });
    return { endpoints: endpoints.map(serializeWebhookEndpoint) };
  });
}

export function getWebhookEndpoint(scope: WebhookScope, id: string) {
  return inTenantDb(scope, async (db) => ({ endpoint: serializeWebhookEndpoint(await loadEndpoint(db, scope, id)) }));
}

export interface CreateWebhookInput {
  url?: unknown;
  description?: unknown;
  events?: unknown;
  /** Omitted = this project; `null` (or `"*"`) = every project (tenant admins only). */
  projectId?: unknown;
}

export function createWebhookEndpoint(scope: WebhookScope, input: CreateWebhookInput) {
  return inTenantDb(scope, async (db) => {
    assertCanManage(scope);
    const url = await validateUrl(input.url);
    const description = validateDescription(input.description);
    const events = validateEvents(input.events);

    let projectId: string | null;
    if (input.projectId === undefined) projectId = scope.projectId;
    else if (input.projectId === null || input.projectId === '*') projectId = null;
    else if (typeof input.projectId === 'string' && input.projectId) projectId = input.projectId;
    else throw new WebhookApiError(400, 'projectId must be a project id, "*" or null');

    if (projectId === null) {
      if (!scope.actor.isTenantAdmin) throw new WebhookApiError(403, 'A webhook for every project requires a tenant owner / admin', 'forbidden');
    } else if (projectId !== scope.projectId) {
      if (!scope.actor.isTenantAdmin) throw new WebhookApiError(403, 'A webhook can only be created for your own project', 'forbidden');
      if (!await db.findProjectById(projectId)) throw new WebhookApiError(400, 'projectId does not name a project');
    }

    const existing = await db.listWebhookEndpoints(scope.tenantId);
    if (existing.length >= MAX_ENDPOINTS_PER_TENANT) {
      throw new WebhookApiError(409, `A tenant can have at most ${MAX_ENDPOINTS_PER_TENANT} webhook endpoints`, 'limit_reached');
    }

    const secret = generateWebhookSecret();
    const endpoint = await db.createWebhookEndpoint({
      tenantId: scope.tenantId,
      projectId,
      url,
      ...(description ? { description } : {}),
      events,
      secretSealed: encryptObject(secret),
      status: 'active',
      disabledReason: null,
      failingSince: null,
      createdBy: scope.actor.userId,
    });
    return { endpoint: { ...serializeWebhookEndpoint(endpoint), secret } };
  });
}

export interface UpdateWebhookInput {
  url?: unknown;
  description?: unknown;
  events?: unknown;
  status?: unknown;
}

export function updateWebhookEndpoint(scope: WebhookScope, id: string, input: UpdateWebhookInput) {
  return inTenantDb(scope, async (db) => {
    const current = await loadEndpoint(db, scope, id);
    const patch: Parameters<DatabaseProvider['updateWebhookEndpoint']>[1] = {};

    if (input.url !== undefined) patch.url = await validateUrl(input.url);
    if (input.description !== undefined) patch.description = validateDescription(input.description) ?? '';
    if (input.events !== undefined) patch.events = validateEvents(input.events);

    let disable = false;
    if (input.status !== undefined) {
      if (input.status !== 'active' && input.status !== 'disabled') throw new WebhookApiError(400, 'status must be "active" or "disabled"');
      if (input.status === 'active' && current.status !== 'active') {
        // Switching back on: the address is checked again, and the failing streak starts over.
        if (patch.url === undefined) await validateUrl(current.url);
        patch.status = 'active';
        patch.disabledReason = null;
        patch.failingSince = null;
      } else if (input.status === 'disabled' && current.status === 'active') {
        disable = true;
      }
    }

    if (Object.keys(patch).length === 0 && !disable) return { endpoint: serializeWebhookEndpoint(current) };
    let updated = Object.keys(patch).length > 0 ? await db.updateWebhookEndpoint(id, patch) : current;
    if (disable) updated = await disableWebhookEndpoint(db, current, 'manual');
    return { endpoint: serializeWebhookEndpoint(updated ?? current) };
  });
}

export function deleteWebhookEndpoint(scope: WebhookScope, id: string) {
  return inTenantDb(scope, async (db) => {
    await loadEndpoint(db, scope, id);
    await db.deleteWebhookEndpoint(id);
    return { deleted: true };
  });
}

export function rotateWebhookSecret(scope: WebhookScope, id: string) {
  return inTenantDb(scope, async (db) => {
    await loadEndpoint(db, scope, id);
    const secret = generateWebhookSecret();
    const updated = await db.updateWebhookEndpoint(id, { secretSealed: encryptObject(secret) });
    if (!updated) throw new WebhookApiError(404, 'Webhook not found', 'not_found');
    return { endpoint: { ...serializeWebhookEndpoint(updated), secret } };
  });
}

/** Sends a `webhook.test` event now and returns what the receiver answered. */
export function testWebhookEndpoint(scope: WebhookScope, id: string) {
  return inTenantDb(scope, async (db) => {
    const endpoint = await loadEndpoint(db, scope, id);
    const delivery = await sendWebhookNow(db, endpoint, { type: WEBHOOK_TEST_EVENT, projectId: scope.projectId, data: {} });
    if (!delivery) throw new WebhookApiError(500, 'Could not record the test delivery', 'internal_error');
    return { delivery: serializeWebhookDelivery(delivery) };
  });
}

export function listWebhookDeliveries(scope: WebhookScope, id: string, query: Record<string, unknown> = {}) {
  return inTenantDb(scope, async (db) => {
    await loadEndpoint(db, scope, id);
    const requested = Number(query.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_DELIVERY_PAGE) : DEFAULT_DELIVERY_PAGE;
    const skipped = Number(query.skip);
    const skip = Number.isFinite(skipped) && skipped > 0 ? Math.floor(skipped) : 0;
    const status = typeof query.status === 'string' && ['pending', 'delivered', 'failed'].includes(query.status)
      ? (query.status as WebhookDeliveryStatus)
      : undefined;
    // One extra row says whether another page exists.
    const rows = await db.listWebhookDeliveries(id, { limit: limit + 1, skip, ...(status ? { status } : {}) });
    return { deliveries: rows.slice(0, limit).map(serializeWebhookDelivery), hasMore: rows.length > limit };
  });
}

/** Puts a delivery back in the queue (same event id), for the endpoint's current URL and secret. */
export function redeliverWebhookDelivery(scope: WebhookScope, deliveryId: string) {
  return inTenantDb(scope, async (db) => {
    assertCanManage(scope);
    const delivery = typeof deliveryId === 'string' && deliveryId ? await db.findWebhookDeliveryById(deliveryId) : null;
    // Reached through its endpoint, so it is as visible as the endpoint is.
    const endpoint = delivery ? await db.findWebhookEndpointById(delivery.endpointId) : null;
    if (!delivery || !endpoint || !canAccess(scope, endpoint)) throw new WebhookApiError(404, 'Delivery not found', 'not_found');
    if (endpoint.status !== 'active') throw new WebhookApiError(409, 'The endpoint is disabled; enable it first', 'endpoint_disabled');
    if (delivery.status === 'pending') throw new WebhookApiError(409, 'This delivery is already waiting to be sent', 'delivery_pending');

    const reset = await db.updateWebhookDelivery(deliveryId, {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      deliveredAt: null,
    });
    await enqueueWebhookDelivery({ deliveryId, tenantDbName: scope.tenantDbName }).catch(() => undefined);
    return { delivery: serializeWebhookDelivery(reset ?? delivery) };
  });
}
