/**
 * The calls from core to the enterprise Connectors module for connector
 * triggers (`src/enterprise/connector-triggers.ts`), in one place: the scope the
 * host is given, the wire shape of its subscription view, and the wrappers that
 * keep a host failure from failing a trigger write (attach: the trigger is
 * stored, the view says `failed`; detach: logged and ignored).
 *
 * A leaf module (database and the seam only), so the agent delete in
 * `agentService.ts` can use it without a cycle. Nothing here logs an event
 * payload, a header or a secret.
 */

import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { AgentTriggerConnector, IAgentTrigger } from '@/lib/database';
import {
  getConnectorTriggerHost,
  type ConnectorTriggerSample,
  type ConnectorTriggerScope,
  type ConnectorTriggerView,
} from '@/enterprise/connector-triggers';
import { ATTACH_FAILED_REASON_CODE, toSubscriptionWire, type ConnectorSubscriptionWire } from '@/lib/shared/connectorTriggers';
import { DEFAULT_TRIGGER_TIMEZONE, isValidTriggerTimezone, validateTriggerCron } from './agentTriggerSchedule';
import { parseFilterRules } from './agentTriggerWebhookView';
import type { VariableIssue } from './agentVariables';

export { toSubscriptionWire };

const logger = createLogger('agent-trigger-connector');

/** The field error for a write when no Connectors module is registered (community edition). */
export const CONNECTOR_TRIGGERS_UNAVAILABLE_MESSAGE = 'Connector triggers need the enterprise Connectors module.';

export function connectorScope(
  scope: { tenantId: string; tenantDbName: string; projectId: string; locale?: string },
  actorId: string,
  locale?: string,
): ConnectorTriggerScope {
  const language = locale ?? scope.locale;
  return {
    tenantId: scope.tenantId,
    tenantDbName: scope.tenantDbName,
    projectId: scope.projectId,
    actorId,
    ...(language ? { locale: language } : {}),
  };
}

/**
 * The reader's language for the texts the Connectors module writes in it (the setup steps of a webhook, and the sentence
 * that says a secret was shown once): the `locale` query parameter, `tr` or `en`. The `reason` of a subscription is one
 * English sentence whatever the language; a screen says it from `reason_code`. Anything else is left out, and the module
 * uses its default.
 */
export function connectorLocale(query: unknown): { locale?: 'tr' | 'en' } {
  const raw = typeof query === 'object' && query !== null ? (query as { locale?: unknown }).locale : undefined;
  return raw === 'tr' || raw === 'en' ? { locale: raw } : {};
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a host refused with: the whole 4xx status, the code and the message it gave. */
export interface HostRefusal {
  status: number;
  code: string;
  message: string;
}

/**
 * The refusal in an error the host threw, or null. The Connectors module throws its `ConnectorError` (a numeric `status`
 * and a string `code`) for a call it will not make, such as the licence guard's 402 / 403 `service_unavailable`; core reads
 * that shape, so it needs no import of the module. An error without a 4xx status and a code is a failure of the host.
 */
export function hostRefusal(error: unknown): HostRefusal | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) return null;
  if (typeof code !== 'string' || code === '') return null;
  return { status, code, message: typeof message === 'string' && message !== '' ? message : code };
}

/** What a failed `attach` leaves the editor with: the trigger is stored, the subscription is not usable yet. */
function failedView(trigger: IAgentTrigger & { type: 'connector' }): ConnectorTriggerView {
  return {
    subscriptionId: trigger.connector.subscriptionId ?? '',
    status: 'failed',
    kind: trigger.connector.kind ?? 'webhook',
    reason: 'The connection to the connector could not be set up. Retry.',
    reasonCode: ATTACH_FAILED_REASON_CODE,
    bindings: 0,
  };
}

/**
 * Binds a stored connector trigger to its subscription. Never throws: a host
 * that fails leaves the trigger stored and the view `failed`. The settings come
 * back only when the host changed them (a new `subscriptionId`).
 */
export async function attachConnectorTrigger(
  scope: ConnectorTriggerScope,
  trigger: IAgentTrigger & { type: 'connector' },
): Promise<{ settings: AgentTriggerConnector | null; view: ConnectorTriggerView | null }> {
  const host = getConnectorTriggerHost();
  if (!host) return { settings: null, view: null };
  try {
    const attached = await host.attach(scope, trigger);
    const changed = JSON.stringify(attached.settings) !== JSON.stringify(trigger.connector);
    return { settings: changed ? attached.settings : null, view: attached.view };
  } catch (error) {
    logger.warn('A connector trigger could not be attached', { triggerId: String(trigger._id), error: errorMessage(error) });
    return { settings: null, view: failedView(trigger) };
  }
}

/** Releases a connector trigger's binding. Never throws. */
export async function detachConnectorTrigger(scope: ConnectorTriggerScope, trigger: IAgentTrigger): Promise<void> {
  if (trigger.type !== 'connector') return;
  const host = getConnectorTriggerHost();
  if (!host) return;
  try {
    await host.detach(scope, trigger);
  } catch (error) {
    logger.warn('A connector trigger could not be detached', { triggerId: String(trigger._id), error: errorMessage(error) });
  }
}

/** The subscription behind a stored connector trigger, or null (no host, no subscription, or the host failed). */
export async function viewConnectorTrigger(scope: ConnectorTriggerScope, trigger: IAgentTrigger): Promise<ConnectorSubscriptionWire | null> {
  if (trigger.type !== 'connector') return null;
  const host = getConnectorTriggerHost();
  if (!host) return null;
  try {
    return toSubscriptionWire(await host.view(scope, trigger));
  } catch (error) {
    logger.warn('A connector trigger view could not be read', { triggerId: String(trigger._id), error: errorMessage(error) });
    return null;
  }
}

/** The package's sample event for Run now, or null (no host, no sample, or the host failed). */
export async function sampleConnectorTrigger(scope: ConnectorTriggerScope, trigger: IAgentTrigger): Promise<ConnectorTriggerSample | null> {
  const host = getConnectorTriggerHost();
  if (!host || trigger.type !== 'connector') return null;
  try {
    return await host.sample(scope, trigger);
  } catch (error) {
    logger.warn('A connector trigger sample could not be read', { triggerId: String(trigger._id), error: errorMessage(error) });
    return null;
  }
}

/**
 * The connector triggers of a deleted agent give up their subscriptions. Call
 * with the triggers listed BEFORE `deleteAgentTriggersForAgent` removes them.
 */
export async function detachConnectorTriggers(
  scope: { tenantId: string; tenantDbName: string },
  triggers: readonly IAgentTrigger[],
  actorId = 'system',
): Promise<void> {
  for (const trigger of triggers) {
    if (trigger.type !== 'connector') continue;
    await detachConnectorTrigger(connectorScope({ ...scope, projectId: trigger.projectId }, actorId), trigger);
  }
}

/** Stores the settings the host changed on attach (a new `subscriptionId`), without touching anything else. */
export function persistConnectorSettings(
  tenantDbName: string,
  trigger: IAgentTrigger,
  settings: AgentTriggerConnector,
): Promise<IAgentTrigger | null> {
  return runWithTenantScope(tenantDbName, (db) => db.updateAgentTrigger(
    String(trigger._id), trigger.tenantId, trigger.projectId, { type: 'connector', connector: settings },
  ));
}

// ── The request → the stored settings ────────────────────────────────────

const TRIGGER_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const EVENT_NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_EVENTS = 50;
const MAX_ID_LENGTH = 200;
const MAX_PARAMS_BYTES = 64 * 1024;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
    : item));
}

/** Do two connector settings point at the same subscription (connector, trigger, parameters, poll schedule)? */
export function sameConnectorSubscription(a: AgentTriggerConnector, b: AgentTriggerConnector): boolean {
  const key = (value: AgentTriggerConnector) => stableJson([
    value.connectorId, value.trigger, value.params ?? {}, value.schedule?.cron ?? null, value.schedule?.timezone ?? null,
  ]);
  return key(a) === key(b);
}

export type ConnectorWrite =
  | { ok: true; connector: AgentTriggerConnector }
  | { ok: false; errors: VariableIssue[] };

/**
 * The `connector` settings from a create / PATCH body's `connector` object
 * (`connector_id`, `trigger`, `params`, `schedule`, `events`, `filter`,
 * `include_payload`): the shape is checked here, the content (the connector,
 * the package's trigger, parameter values, the schedule's interval) by the
 * Connectors module. `existing` is the stored `connector` when the trigger
 * already is a connector one: absent fields keep its values, unless the write
 * points at another connector or trigger (then only what the body gives
 * carries). Without a Connectors module this is a field error on `type`.
 */
export async function parseConnectorWrite(
  scope: ConnectorTriggerScope,
  value: Record<string, unknown>,
  existing: AgentTriggerConnector | null | undefined,
): Promise<ConnectorWrite> {
  const host = getConnectorTriggerHost();
  if (!host) return { ok: false, errors: [{ field: 'type', message: CONNECTOR_TRIGGERS_UNAVAILABLE_MESSAGE }] };

  const prev = existing ?? null;
  const errors: VariableIssue[] = [];
  const issue = (field: string, message: string) => errors.push({ field: `connector.${field}`, message });

  const connectorId = value.connector_id ?? prev?.connectorId;
  if (typeof connectorId !== 'string' || connectorId.trim() === '' || connectorId.length > MAX_ID_LENGTH) {
    issue('connector_id', 'connector_id is required: the connector this trigger listens to');
  }
  const triggerName = value.trigger ?? prev?.trigger;
  if (typeof triggerName !== 'string' || !TRIGGER_NAME_RE.test(triggerName)) {
    issue('trigger', 'trigger is required: the name of a trigger the connector\'s package declares');
  }
  // Another connector or trigger: nothing of the stored settings carries over.
  const sameTarget = prev !== null && connectorId === prev.connectorId && triggerName === prev.trigger;
  const base = sameTarget ? prev : null;

  let params: Record<string, unknown> = base?.params ?? {};
  if (value.params !== undefined && value.params !== null) {
    if (!isPlainObject(value.params)) issue('params', 'params must be an object');
    else if (Buffer.byteLength(JSON.stringify(value.params)) > MAX_PARAMS_BYTES) issue('params', `params can be at most ${MAX_PARAMS_BYTES / 1024} KiB`);
    else params = value.params;
  } else if (value.params === null) params = {};

  let schedule: AgentTriggerConnector['schedule'] = base?.schedule ?? null;
  if (value.schedule === null) schedule = null;
  else if (value.schedule !== undefined) {
    if (!isPlainObject(value.schedule)) issue('schedule', 'schedule must be an object { cron, timezone? }');
    else {
      const cronError = validateTriggerCron(value.schedule.cron);
      const timezone = value.schedule.timezone === undefined || value.schedule.timezone === null || value.schedule.timezone === ''
        ? DEFAULT_TRIGGER_TIMEZONE
        : value.schedule.timezone;
      if (cronError) issue('schedule.cron', cronError);
      else if (!isValidTriggerTimezone(timezone)) issue('schedule.timezone', 'timezone must be an IANA timezone name, like "Europe/Istanbul"');
      else schedule = { cron: String(value.schedule.cron).trim().split(/\s+/).join(' '), timezone: timezone as string };
    }
  }

  let events: string[] = base?.events ?? [];
  if (value.events !== undefined) {
    if (value.events === null) events = [];
    else if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS
      || !value.events.every((event) => typeof event === 'string' && EVENT_NAME_RE.test(event))) {
      issue('events', `events must be a list of at most ${MAX_EVENTS} event names (letters, digits and . _ : -)`);
    } else events = [...new Set(value.events as string[])];
  }

  let filter = base?.filter ?? [];
  if (value.filter !== undefined) {
    const parsed = parseFilterRules(value.filter);
    if (!parsed.ok) errors.push(...parsed.errors.map((item) => ({ field: `connector.${item.field}`, message: item.message })));
    else filter = parsed.rules;
  }

  let includePayload = prev?.includePayload ?? true;
  if (value.include_payload !== undefined) {
    if (typeof value.include_payload !== 'boolean') issue('include_payload', 'include_payload must be a boolean');
    else includePayload = value.include_payload;
  }
  if (errors.length > 0) return { ok: false, errors };

  const candidate: AgentTriggerConnector = {
    connectorId: connectorId as string,
    trigger: triggerName as string,
    params,
    schedule,
    events,
    filter,
    includePayload,
    ...(sameTarget && prev?.subscriptionId ? { subscriptionId: prev.subscriptionId } : {}),
  };
  const prepared = await host.prepare(scope, { settings: candidate, previous: prev });
  if (!prepared.ok) {
    return { ok: false, errors: prepared.errors.map((item) => ({ field: item.field.startsWith('connector') ? item.field : `connector.${item.field}`, message: item.message })) };
  }
  // The host normalizes the parameters, events and schedule and fills the package, kind and label; the target, the filter and
  // the payload choice stay what the request said, and the binding only carries over to the same subscription.
  const connector: AgentTriggerConnector = {
    ...prepared.settings,
    connectorId: candidate.connectorId,
    trigger: candidate.trigger,
    filter,
    includePayload,
    subscriptionId: prev?.subscriptionId && sameConnectorSubscription(prev, prepared.settings) ? prev.subscriptionId : null,
  };
  return { ok: true, connector };
}
