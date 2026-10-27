/**
 * One incoming generic webhook delivery, from an authenticated request to a
 * trigger fire (SPEC W2 steps 7–9): the body signature, the JSON, the event and
 * delivery id and the disabled answer. The rest of the way (the `events`
 * allow-list, the filter, de-duplication, the run rate, the turn and
 * `fireTrigger`) is `dispatchTriggerEvent`, shared with connector events. Also
 * the same turn for a Run now with a sample payload and its dry run.
 *
 * A webhook that was stored with a retired vendor preset never gets here: its
 * URL answers 410 (`public-hooks.ts`), and the check below is the backstop.
 */

import { createLogger } from '@/lib/core/logger';
import type { AgentTriggerOfType, DatabaseProvider, IAgentTrigger, IAgentVariable } from '@/lib/database';
import { type TriggerTenant, triggerAgentConfig } from './agentTriggers';
import { apiErrorBody } from './agentRunService';
import {
  allowedHeaders,
  dedupMaterial,
  deliveryIdentity,
  isHeaderAuth,
  isRetiredWebhook,
  verifyBodyAuth,
  type DeliveryIdentity,
  type HeaderBag,
} from './agentTriggerWebhookAuth';
import {
  buildEventTurn,
  dispatchTriggerEvent,
  eventMismatch,
  eventView,
  recordDelivery,
  webhookMetadata,
  webhookPreface,
  type ManualEventTurn,
  type WebhookAnswer,
  type WebhookTurn,
} from './agentTriggerEventDispatch';

// What the delivery log and the turn are made of moved to `agentTriggerEventDispatch.ts`; these stay importable from here.
export {
  dryRunAnswer,
  recordDelivery,
  resetDeliveryRecording,
  serializeDelivery,
  webhookMetadata,
  type DeliveryRecord,
  type ManualEventTurn as ManualWebhookTurn,
  type WebhookAnswer,
} from './agentTriggerEventDispatch';

const logger = createLogger('agent-trigger-webhook');

const JSON_MAX_DEPTH = 64;

// ── JSON ─────────────────────────────────────────────────────────────────

/** Deeper than `max` levels of arrays / objects? Iterative, so a deep payload cannot exhaust the stack. */
function deeperThan(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    if (depth > max) return true;
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** The body as JSON (UTF-8; an object or an array; at most 64 levels deep), or null. */
export function parseDeliveryJson(body: Buffer): unknown | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object') return null;
    return deeperThan(value, JSON_MAX_DEPTH) ? null : value;
  } catch {
    return null;
  }
}

// ── The turn ─────────────────────────────────────────────────────────────

/** The context filters, the event check and templates read (SPEC W4), bounded and without prototypes. */
export function deliveryView(input: {
  trigger: IAgentTrigger;
  webhook: { preset: string };
  payload: unknown;
  headers: Record<string, string>;
  identity: DeliveryIdentity;
  receivedAt: Date;
}): Record<string, unknown> {
  return eventView({ ...input, preset: input.webhook.preset });
}

/**
 * The message and variables of a webhook fire: see `buildEventTurn`. Without a
 * payload (a Run now of a webhook trigger with no sample) the prompt is
 * rendered over an empty event and nothing external is added.
 */
export function buildWebhookTurn(input: {
  trigger: IAgentTrigger;
  webhook: { preset: string; includePayload: boolean };
  declared: ReadonlyArray<IAgentVariable> | undefined;
  view: Record<string, unknown>;
  payload: unknown;
  identity: DeliveryIdentity;
  overrides?: Record<string, unknown> | null;
}): WebhookTurn {
  return buildEventTurn({
    trigger: input.trigger,
    preface: webhookPreface(input.webhook.preset, input.identity.event),
    payloadLabel: 'Webhook',
    includePayload: input.webhook.includePayload,
    declared: input.declared,
    view: input.view,
    payload: input.payload,
    overrides: input.overrides,
  });
}

// ── Answers ──────────────────────────────────────────────────────────────

const UNAUTHORIZED_BODY = apiErrorBody('authentication_error', 'The request is not authenticated for this webhook.', 'webhook_unauthorized');

export function unauthorizedAnswer(): WebhookAnswer {
  return { status: 401, body: UNAUTHORIZED_BODY };
}

/** The answer for a webhook stored with a retired vendor preset (`public-hooks.ts` answers it before auth). */
export function retiredWebhookAnswer(): WebhookAnswer {
  return {
    status: 410,
    body: apiErrorBody('gone', 'This webhook trigger used a retired vendor preset. Recreate it as a connector trigger.', 'webhook_preset_retired'),
  };
}

// ── The delivery ─────────────────────────────────────────────────────────

export interface WebhookDeliveryInput {
  trigger: AgentTriggerOfType<'webhook'>;
  tenant: TriggerTenant;
  headers: HeaderBag;
  body: Buffer;
  receivedAt: Date;
  /** Opened by the caller (current, then previous while its grace runs). */
  secrets: readonly string[];
  /** A header mode already checked the request before the body was read. */
  headerAuthenticated: boolean;
}

/**
 * SPEC W2 steps 7–9, then `dispatchTriggerEvent`, for an authenticated-or-signed
 * request whose trigger is known. Call inside `runWithTenantScope(tenant.tenantDbName, …)`;
 * uses only the trigger it is given (no re-read). Never throws.
 */
export async function processWebhookDelivery(db: DatabaseProvider, input: WebhookDeliveryInput): Promise<WebhookAnswer> {
  const { trigger, tenant, headers, body, receivedAt, secrets } = input;
  const webhook = trigger.webhook;
  const triggerId = String(trigger._id);
  const bytes = body.length;
  let identity: DeliveryIdentity = { invalidEvent: false };
  const record = (entry: { outcome: 'unauthorized' | 'failed'; httpStatus: number; reason: string }) =>
    recordDelivery(db, trigger, { ...entry, identity, bytes, receivedAt });

  try {
    if (isRetiredWebhook(webhook)) return retiredWebhookAnswer();
    const auth = webhook.auth as Exclude<typeof webhook.auth, 'github_signature' | 'gitlab_token' | 'basic'>;

    // 7. The body signature, over the exact bytes; a header mode was checked before the body was read.
    let authenticated = input.headerAuthenticated && isHeaderAuth(auth);
    if (!isHeaderAuth(auth)) {
      const check = verifyBodyAuth(auth, headers, body, secrets, receivedAt.getTime());
      if (!check.ok) {
        await record({ outcome: 'unauthorized', httpStatus: 401, reason: check.reason });
        return unauthorizedAnswer();
      }
      authenticated = true;
    }
    if (!authenticated) {
      await record({ outcome: 'unauthorized', httpStatus: 401, reason: 'missing credentials' });
      return unauthorizedAnswer();
    }

    // 8. JSON.
    const payload = parseDeliveryJson(body);
    if (payload === null) {
      await record({ outcome: 'failed', httpStatus: 400, reason: 'invalid JSON' });
      return { status: 400, body: apiErrorBody('invalid_request_error', 'The body is not valid JSON (an object or an array, UTF-8).', 'invalid_json') };
    }

    // 9. Event + delivery id; everything after is the shared dispatch (disabled, events, filter, dedup, rate, turn, fire).
    identity = deliveryIdentity(headers, payload);
    const answer = await dispatchTriggerEvent(db, trigger, tenant, {
      source: 'webhook',
      event: identity.event ?? null,
      deliveryId: identity.deliveryId ?? null,
      dedupMaterial: dedupMaterial(auth, headers, body),
      payload,
      headers: allowedHeaders(headers, secrets),
      receivedAt,
      bytes,
      invalidEvent: identity.invalidEvent,
    });
    const { outcome: _outcome, runId: _runId, ...wire } = answer;
    return wire;
  } catch (error) {
    logger.error('Webhook delivery failed', { triggerId, error: error instanceof Error ? error.message : String(error) });
    await record({ outcome: 'failed', httpStatus: 500, reason: 'internal error' });
    return { status: 500, body: apiErrorBody('api_error', 'Internal error', 'internal_error') };
  }
}

// ── Run now with a sample payload, and its dry run ───────────────────────

/**
 * A Run now / dry run of a webhook trigger with an optional sample `payload`
 * and `headers`: the turn a delivery would build (the request's values are
 * data, never templates). The events allow-list and the filter are evaluated
 * for the dry run's answer; a Run now does not apply them.
 */
export async function manualWebhookTurn(input: {
  trigger: AgentTriggerOfType<'webhook'>;
  tenantDbName: string;
  payload: unknown;
  headers: Record<string, string>;
  overrides?: Record<string, unknown> | null;
  metadata?: Record<string, string> | null;
  secrets: readonly string[];
  now?: Date;
}): Promise<ManualEventTurn> {
  const { trigger } = input;
  const webhook = trigger.webhook;
  const receivedAt = input.now ?? new Date();
  const lower: HeaderBag = {};
  for (const [name, value] of Object.entries(input.headers)) lower[name.toLowerCase()] = value;
  const identity = input.payload === undefined ? { invalidEvent: false } : deliveryIdentity(lower, input.payload);
  const view = deliveryView({
    trigger, webhook, payload: input.payload, headers: allowedHeaders(lower, input.secrets), identity, receivedAt,
  });
  const reason = eventMismatch({ events: webhook.events ?? [], filter: webhook.filter ?? [] }, view, identity);
  const config = await triggerAgentConfig(input.tenantDbName, trigger);
  const turn = buildWebhookTurn({ trigger, webhook, declared: config?.variables, view, payload: input.payload, identity, overrides: input.overrides });
  return { matched: reason === null, reason, identity, turn, metadata: webhookMetadata(trigger, identity, input.metadata) };
}
