/**
 * Managing webhook subscriptions — what the dashboard (`/api/webhooks`) and the
 * client API (`/api/client/v1/webhooks`) both do. The two surfaces differ only
 * in how they authenticate; scoping and rules live here once.
 *
 * AUTHORITY is not here. Whether the caller may read or change webhooks at all is
 * the policy engine's answer on the `webhooks` service, asked by the route gate
 * (read for a GET, admin for anything else): nothing in this file looks at a role
 * or a membership. What is left is DATA SCOPING:
 *  - an endpoint of the project the request is made in is reachable by whoever
 *    passed the gate;
 *  - a tenant-wide endpoint (`projectId` null) and an endpoint of another project
 *    are reachable only by a caller who holds `webhooks` in the workspace itself,
 *    not narrowed by a project (`scope.workspaceAllows`; never a token, which acts
 *    in its own project only).
 * An endpoint outside that reach answers 404, so an id does not confirm that
 * something exists.
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

/** What the caller wants to do with an endpoint outside the project the request is made in: look at it, or change it. */
export type WebhookReach = 'read' | 'manage';

export interface WebhookScope {
  tenantDbName: string;
  tenantId: string;
  /** The project the request is made in. */
  projectId: string;
  /** Who is calling: recorded as the creator of an endpoint. */
  userId: string;
  /**
   * Does the caller hold `webhooks` in the WORKSPACE (outside any project, before a project's limits narrow
   * it) at the level `kind` needs - `read` for the first, `admin` for the second? The policy engine's answer
   * (the route builds it); always false for a token. Reaches tenant-wide endpoints and those of other projects.
   */
  workspaceAllows: (kind: WebhookReach) => Promise<boolean>;
  /** What the caller can do here, for the page to show or hide its controls (asked of the engine, not guessed from a role). */
  capabilities: () => Promise<WebhookCapabilities>;
}

/** The engine's answers the Webhooks page is built from. */
export interface WebhookCapabilities {
  /** Create, edit, test, rotate, redeliver and delete in this project. */
  manage: boolean;
  /** ...and for every project / a tenant-wide endpoint. */
  workspaceScope: boolean;
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

// ── Scoping ──────────────────────────────────────────────────────────────

/** Is this endpoint inside the reach of the caller for what they want to do with it? (Data scoping, not authority.) */
async function inReach(scope: WebhookScope, endpoint: IWebhookEndpoint, kind: WebhookReach): Promise<boolean> {
  if (endpoint.tenantId !== scope.tenantId) return false;
  if (endpoint.projectId && endpoint.projectId === scope.projectId) return true;
  return scope.workspaceAllows(kind);
}

async function loadEndpoint(db: DatabaseProvider, scope: WebhookScope, id: unknown, kind: WebhookReach): Promise<IWebhookEndpoint> {
  const endpoint = typeof id === 'string' && id ? await db.findWebhookEndpointById(id) : null;
  if (!endpoint || !await inReach(scope, endpoint, kind)) throw new WebhookApiError(404, 'Webhook not found', 'not_found');
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
    // The tenant-wide endpoints are listed for a caller who holds `webhooks` in the workspace itself.
    const endpoints = await db.listWebhookEndpoints(scope.tenantId, {
      projectScopes: await scope.workspaceAllows('read') ? [scope.projectId, null] : [scope.projectId],
    });
    return { endpoints: endpoints.map(serializeWebhookEndpoint), capabilities: await scope.capabilities() };
  });
}

export function getWebhookEndpoint(scope: WebhookScope, id: string) {
  return inTenantDb(scope, async (db) => ({ endpoint: serializeWebhookEndpoint(await loadEndpoint(db, scope, id, 'read')) }));
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
    const url = await validateUrl(input.url);
    const description = validateDescription(input.description);
    const events = validateEvents(input.events);

    let projectId: string | null;
    if (input.projectId === undefined) projectId = scope.projectId;
    else if (input.projectId === null || input.projectId === '*') projectId = null;
    else if (typeof input.projectId === 'string' && input.projectId) projectId = input.projectId;
    else throw new WebhookApiError(400, 'projectId must be a project id, "*" or null');

    // An endpoint for every project, or for another project, is workspace-level: it needs `webhooks` in the workspace.
    if (projectId === null) {
      if (!await scope.workspaceAllows('manage')) {
        throw new WebhookApiError(403, 'A webhook for every project needs workspace-level Webhooks access', 'forbidden');
      }
    } else if (projectId !== scope.projectId) {
      if (!await scope.workspaceAllows('manage')) {
        throw new WebhookApiError(403, 'A webhook for another project needs workspace-level Webhooks access', 'forbidden');
      }
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
      createdBy: scope.userId,
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
    const current = await loadEndpoint(db, scope, id, 'manage');
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
    await loadEndpoint(db, scope, id, 'manage');
    await db.deleteWebhookEndpoint(id);
    return { deleted: true };
  });
}

export function rotateWebhookSecret(scope: WebhookScope, id: string) {
  return inTenantDb(scope, async (db) => {
    await loadEndpoint(db, scope, id, 'manage');
    const secret = generateWebhookSecret();
    const updated = await db.updateWebhookEndpoint(id, { secretSealed: encryptObject(secret) });
    if (!updated) throw new WebhookApiError(404, 'Webhook not found', 'not_found');
    return { endpoint: { ...serializeWebhookEndpoint(updated), secret } };
  });
}

/** Sends a `webhook.test` event now and returns what the receiver answered. */
export function testWebhookEndpoint(scope: WebhookScope, id: string) {
  return inTenantDb(scope, async (db) => {
    const endpoint = await loadEndpoint(db, scope, id, 'manage');
    const delivery = await sendWebhookNow(db, endpoint, { type: WEBHOOK_TEST_EVENT, projectId: scope.projectId, data: {} });
    if (!delivery) throw new WebhookApiError(500, 'Could not record the test delivery', 'internal_error');
    return { delivery: serializeWebhookDelivery(delivery) };
  });
}

export function listWebhookDeliveries(scope: WebhookScope, id: string, query: Record<string, unknown> = {}) {
  return inTenantDb(scope, async (db) => {
    await loadEndpoint(db, scope, id, 'read');
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
    const delivery = typeof deliveryId === 'string' && deliveryId ? await db.findWebhookDeliveryById(deliveryId) : null;
    // Reached through its endpoint, so it is as visible as the endpoint is.
    const endpoint = delivery ? await db.findWebhookEndpointById(delivery.endpointId) : null;
    if (!delivery || !endpoint || !await inReach(scope, endpoint, 'manage')) throw new WebhookApiError(404, 'Delivery not found', 'not_found');
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
