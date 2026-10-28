/**
 * The triggers API (§5.7): a trigger is a saved way of starting an agent — a
 * prompt (+ variables) and a `type` with that type's settings object (`schedule`:
 * a cron in a timezone, `once`: one time, `manual`: by hand, `webhook`: an
 * incoming webhook, `connector`: an event of a connector — a vendor webhook or a
 * poll — through the enterprise Connectors module). Every fire is an ordinary run (`channel: 'trigger'`), so a
 * trigger's history is `GET /client/v1/agents/runs?trigger_id=`.
 *
 * Two mounts of the same handlers: the client API (`/client/v1/agents/:agentKey/triggers…`,
 * API token) and the dashboard (`/agents/:agentId/triggers…`, session). Both are
 * the `agents` service (GET read, everything else write) through the route
 * prefix map, and both answer in the client envelope `{ error: { type, message, code } }`.
 *
 * The callback secret is write-only: sealed on save, shown as `{ url, signed }`.
 * A webhook trigger's secret is shown once — in the answer that created or
 * replaced it (`webhook.secret`, or rotate-secret) — and only its last four
 * characters after that. Its delivery log is `…/triggers/{id}/deliveries`.
 *
 * A connector trigger is bound by the Connectors module to a shared subscription
 * (`src/enterprise/connector-triggers.ts`): its answers carry that subscription
 * as `connector_subscription`, and `…/connector/retry` tries the vendor
 * registration again. Without the module it cannot be written and never fires.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getConnectorTriggerHost } from '@/enterprise/connector-triggers';
import type { ConnectorSubscriptionWire } from '@/lib/shared/connectorTriggers';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { AgentTriggerConnector, AgentTriggerType, AgentTriggerTypeSettings, AgentRunClass, IAgent, IAgentTrigger } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { getAgentByKey } from '@/lib/services/agents';
import { AGENT_CALLBACK_SECRET_MASK, sealAgentCallbackConfig } from '@/lib/services/agents/agentCallbackConfig';
import { resolveRunVariables, type VariableIssue } from '@/lib/services/agents/agentVariables';
import {
  apiErrorBody,
  idempotencyKeyConflictErrorBody,
  invalidRequestErrorBody,
  isAgentRunActive,
  resolveAgentRunLimits,
  serializeAgentRun,
  validateCallbackRequest,
  waitForAgentRun,
} from '@/lib/services/agents/agentRunService';
import {
  createAgentTriggerHosted,
  deleteAgentTriggerHosted,
  fireTrigger,
  getAgentTrigger,
  listAgentTriggers,
  resolveTriggerVariables,
  triggerAgentConfig,
  serializeAgentTrigger,
  updateAgentTrigger,
  updateAgentTriggerHosted,
  type HostedTrigger,
  type NewTriggerWrite,
  type TriggerFields,
  type TriggerScope,
  type TriggerTenant,
  type TriggerWrite,
} from '@/lib/services/agents/agentTriggers';
import { resolveAgentConfig } from '@/lib/services/agents/agentService';
import { DEFAULT_TRIGGER_TIMEZONE, isValidTriggerTimezone, validateTriggerCron } from '@/lib/services/agents/agentTriggerSchedule';
import {
  CONNECTOR_TRIGGERS_UNAVAILABLE_MESSAGE,
  connectorLocale,
  connectorScope,
  parseConnectorWrite,
  sampleConnectorTrigger,
  toSubscriptionWire,
  viewConnectorTrigger,
} from '@/lib/services/agents/agentTriggerConnectorHost';
import { dryRunAnswer, manualConnectorTurn } from '@/lib/services/agents/agentTriggerEventDispatch';
import { manualWebhookTurn, serializeDelivery } from '@/lib/services/agents/agentTriggerWebhookDelivery';
import { isRetiredWebhook } from '@/lib/services/agents/agentTriggerWebhookAuth';
import {
  MAX_ROTATION_GRACE_SECONDS,
  openWebhookSecrets,
  parseWebhookWrite,
  rotateWebhookSecret,
  rotationAnswer,
} from '@/lib/services/agents/agentTriggerWebhookIntake';
import { variableMappingProblems, templateProblem } from '@/lib/services/agents/agentTriggerWebhookView';
import { getHeaderValue, readJsonBody, withApiRequestContext, withClientApiRequestContext } from '../fastify-utils';
import {
  parseResponseFormat,
  parseRunVariables,
  parseRunMetadata,
  readIdempotencyKey,
  resolvePublishedAgentConfig,
  sendRunAccepted,
  clientGoneSignal,
} from './agent-invocation';
import { requireScopedAgent } from './agents';
import { parsePreferHeader, parseTimestamp, parseWaitSeconds } from './client-agent-runs';

const logger = createLogger('api:agent-triggers');

const INTERNAL_ERROR_BODY = apiErrorBody('api_error', 'Internal error', 'internal_error');
const RETIRED_WEBHOOK_MESSAGE = 'This webhook trigger used a retired vendor preset. Recreate it as a connector trigger.';
const EVENT_TYPE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export const TRIGGER_NAME_MAX_LENGTH = 200;
export const TRIGGER_DESCRIPTION_MAX_LENGTH = 2000;
export const TRIGGER_PROMPT_MAX_LENGTH = 32_000;
/** A `run_at` this far in the past still counts as "now" (the caller's clock, the request's time in flight). */
const RUN_AT_PAST_TOLERANCE_MS = 60_000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Who is asking, about which agent: the same for both mounts. */
interface TriggerCaller {
  scope: TriggerScope;
  tenant: TriggerTenant;
  agent: IAgent;
  userId: string;
  /** The API token of a client call (Run now counts against it). */
  apiTokenId?: string;
  /** The client API takes an `Idempotency-Key` on Run now; the dashboard does not. */
  dialect: 'client' | 'dashboard';
  /** The longest Run now may wait (`wait` / `Prefer: wait=N`). */
  syncWaitMs: () => Promise<number>;
}

// ── Request parsing ──────────────────────────────────────────────────────

/** The request keys that carry a type's settings: each is accepted only with its own `type` (`manual` has none). */
const TYPE_SETTINGS_KEYS = ['schedule', 'once', 'webhook', 'connector'] as const;
const TRIGGER_TYPES: readonly AgentTriggerType[] = ['schedule', 'once', 'manual', 'webhook', 'connector'];

/**
 * A request's `type` and the settings object named after it (an empty one when
 * it was left out). The object of another type is refused, not dropped: the
 * caller would think it was saved.
 */
function readTypeSettings(
  body: Record<string, unknown>,
): { ok: true; type: AgentTriggerType; settings: Record<string, unknown> } | { ok: false; issue: VariableIssue } {
  const issue = (field: string, message: string) => ({ ok: false as const, issue: { field, message } });
  const type = body.type;
  if (typeof type !== 'string' || !TRIGGER_TYPES.includes(type as AgentTriggerType)) {
    return issue('type', 'type must be "schedule", "once", "manual", "webhook" or "connector"');
  }
  for (const key of TYPE_SETTINGS_KEYS) {
    if (key !== type && body[key] !== undefined && body[key] !== null) return issue(key, `${key} is only accepted when type is "${key}"`);
  }
  if (type === 'manual') return { ok: true, type, settings: {} };
  const settings = body[type];
  if (settings === undefined || settings === null) return { ok: true, type: type as AgentTriggerType, settings: {} };
  if (!isPlainObject(settings)) return issue(type, `${type} must be an object`);
  return { ok: true, type: type as AgentTriggerType, settings };
}

/**
 * The `type` and settings of a `schedule`, `once` or `manual` trigger from a
 * request. `schedule` takes `cron` and `timezone`; `once` takes `run_at`
 * (ISO-8601 or unix seconds, not in the past) or `delay_seconds`. A webhook is
 * read by `parseWebhookWrite`, a connector trigger by `parseConnectorWrite`.
 * Another type is added here and in `serializeAgentTrigger`.
 */
export function parseTriggerTypeSettings(
  type: Exclude<AgentTriggerType, 'webhook' | 'connector'>,
  settings: Record<string, unknown>,
  now: Date,
): { ok: true; settings: AgentTriggerTypeSettings } | { ok: false; issue: VariableIssue } {
  const issue = (field: string, message: string) => ({ ok: false as const, issue: { field, message } });
  switch (type) {
    case 'schedule': {
      const cronError = validateTriggerCron(settings.cron);
      if (cronError) return issue('schedule.cron', cronError);
      const timezone = settings.timezone === undefined || settings.timezone === null || settings.timezone === '' ? DEFAULT_TRIGGER_TIMEZONE : settings.timezone;
      if (!isValidTriggerTimezone(timezone)) return issue('schedule.timezone', 'timezone must be an IANA timezone name, like "Europe/Istanbul"');
      return { ok: true, settings: { type, schedule: { cron: String(settings.cron).trim().split(/\s+/).join(' '), timezone } } };
    }
    case 'once': {
      const hasRunAt = settings.run_at !== undefined && settings.run_at !== null;
      const hasDelay = settings.delay_seconds !== undefined && settings.delay_seconds !== null;
      if (hasRunAt === hasDelay) return issue('once.run_at', 'a once trigger needs run_at or delay_seconds (one of them)');
      if (hasDelay) {
        const delay = settings.delay_seconds;
        if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0) {
          return issue('once.delay_seconds', 'delay_seconds must be a whole number of seconds (0 or more)');
        }
        return { ok: true, settings: { type, once: { runAt: new Date(now.getTime() + delay * 1000) } } };
      }
      const runAt = parseTimestamp(settings.run_at);
      if (!runAt) return issue('once.run_at', 'run_at must be an ISO-8601 date or unix seconds');
      if (runAt.getTime() < now.getTime() - RUN_AT_PAST_TOLERANCE_MS) return issue('once.run_at', 'run_at is in the past');
      return { ok: true, settings: { type, once: { runAt } } };
    }
    default:
      return { ok: true, settings: { type: 'manual' } };
  }
}

/**
 * Does the request (`type` + its settings object) send the stored type and
 * settings back unchanged — an editor saving the whole form? Then nothing about
 * the timing changes, even for a once time that has passed since.
 */
function isStoredTypeSettings(body: Record<string, unknown>, stored: IAgentTrigger): boolean {
  const read = readTypeSettings(body);
  if (!read.ok || read.type !== stored.type) return false;
  const settings = read.settings;
  switch (stored.type) {
    case 'schedule':
      return typeof settings.cron === 'string' && settings.cron.trim().split(/\s+/).join(' ') === stored.schedule.cron
        && (settings.timezone ?? DEFAULT_TRIGGER_TIMEZONE) === stored.schedule.timezone;
    case 'once': {
      if (settings.delay_seconds !== undefined && settings.delay_seconds !== null) return false;
      const runAt = parseTimestamp(settings.run_at);
      return Boolean(runAt) && runAt!.getTime() === new Date(stored.once.runAt).getTime();
    }
    case 'connector':
      return sameConnectorBody(settings, stored.connector);
    default:
      // Manual has no settings; a webhook sent without any keeps everything it has.
      return Object.keys(settings).length === 0;
  }
}

const sortedKeys = (value: unknown): unknown => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sortedKeys(item)]))
  : Array.isArray(value) ? value.map(sortedKeys) : value);

/** Does a `connector` request object send the stored settings back unchanged (an editor saving the whole form)? What it leaves out is unchanged too. */
function sameConnectorBody(settings: Record<string, unknown>, stored: AgentTriggerConnector): boolean {
  const same = (given: unknown, kept: unknown) => given === undefined || JSON.stringify(sortedKeys(given)) === JSON.stringify(sortedKeys(kept));
  const sorted = (list: unknown) => (Array.isArray(list) ? [...list].sort() : list ?? []);
  const schedule = settings.schedule;
  const sameSchedule = schedule === undefined
    || (stored.schedule
      ? isPlainObject(schedule) && schedule.cron === stored.schedule.cron && (schedule.timezone ?? DEFAULT_TRIGGER_TIMEZONE) === stored.schedule.timezone
      : schedule === null);
  return same(settings.connector_id, stored.connectorId)
    && same(settings.trigger, stored.trigger)
    && same(settings.params, stored.params ?? {})
    && sameSchedule
    && (settings.events === undefined || JSON.stringify(sorted(settings.events)) === JSON.stringify(sorted(stored.events)))
    && same(settings.filter, stored.filter ?? [])
    && same(settings.include_payload, stored.includePayload);
}

/**
 * A create (`existing` absent) or PATCH body → the fields to save. Absent =
 * unchanged; `null` clears a nullable field. The prompt / variables / version are
 * checked together against the variables the agent (that version of it) declares:
 * the prompt may be empty only when the agent declares variables and the trigger
 * gives some.
 */
export async function prepareTriggerWrite(input: {
  body: Record<string, unknown>;
  agent: IAgent;
  scope: TriggerScope;
  existing?: IAgentTrigger | null;
  now?: Date;
  /** Who writes (the Connectors module is told); default `system`. */
  actorId?: string;
  locale?: string;
}): Promise<{ ok: true; write: TriggerWrite; /** A new generated webhook secret, shown once. */ webhookSecret?: string } | { ok: false; errors: VariableIssue[] }> {
  const { body, agent, scope, existing } = input;
  const now = input.now ?? new Date();
  const errors: VariableIssue[] = [];
  const fields: TriggerFields = {};
  let typeSettings: AgentTriggerTypeSettings | undefined;
  const given = (key: string) => body[key] !== undefined;
  let webhookSecret: string | undefined;

  if (given('name') || !existing) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push({ field: 'name', message: 'name is required' });
    else if (name.length > TRIGGER_NAME_MAX_LENGTH) errors.push({ field: 'name', message: `name can be at most ${TRIGGER_NAME_MAX_LENGTH} characters` });
    else fields.name = name;
  }
  if (given('description')) {
    if (body.description === null || body.description === '') fields.description = null;
    else if (typeof body.description !== 'string' || body.description.length > TRIGGER_DESCRIPTION_MAX_LENGTH) {
      errors.push({ field: 'description', message: `description must be a string of at most ${TRIGGER_DESCRIPTION_MAX_LENGTH} characters` });
    } else fields.description = body.description;
  }
  if (given('enabled')) {
    if (typeof body.enabled !== 'boolean') errors.push({ field: 'enabled', message: 'enabled must be a boolean' });
    else fields.enabled = body.enabled;
  }
  // A body names its type with `type` and that type's settings object (`schedule`, `once`, `webhook`).
  const settingsGiven = TYPE_SETTINGS_KEYS.some((key) => body[key] !== undefined && body[key] !== null);
  if (!existing || ((given('type') || settingsGiven) && !isStoredTypeSettings(body, existing))) {
    // A new trigger without a type (or settings) is manual (Run now / the API).
    const read = readTypeSettings(!existing && (body.type === undefined || body.type === null) && !settingsGiven ? { type: 'manual' } : body);
    if (!read.ok) errors.push(read.issue);
    else if (read.type === 'webhook') {
      // Keeps the stored hook id and secret unless the secret rules replace the secret.
      const parsed = parseWebhookWrite(read.settings, existing?.type === 'webhook' ? existing.webhook : null);
      if (!parsed.ok) errors.push(...parsed.errors);
      else {
        typeSettings = { type: 'webhook', webhook: parsed.webhook };
        webhookSecret = parsed.secret;
      }
    } else if (read.type === 'connector') {
      const parsed = await parseConnectorWrite(
        connectorScope(scope, input.actorId ?? 'system', input.locale),
        read.settings,
        existing?.type === 'connector' ? existing.connector : null,
      );
      if (!parsed.ok) errors.push(...parsed.errors);
      else typeSettings = { type: 'connector', connector: parsed.connector };
    } else {
      const parsed = parseTriggerTypeSettings(read.type, read.settings, now);
      if (!parsed.ok) errors.push(parsed.issue);
      else typeSettings = parsed.settings;
    }
  }
  if (given('prompt')) {
    if (body.prompt !== null && typeof body.prompt !== 'string') errors.push({ field: 'prompt', message: 'prompt must be a string' });
    else if (typeof body.prompt === 'string' && body.prompt.length > TRIGGER_PROMPT_MAX_LENGTH) {
      errors.push({ field: 'prompt', message: `prompt can be at most ${TRIGGER_PROMPT_MAX_LENGTH} characters` });
    } else fields.prompt = typeof body.prompt === 'string' ? body.prompt : '';
  }
  if (given('version')) {
    const value = body.version;
    if (value === null) fields.version = null;
    else if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      errors.push({ field: 'version', message: 'version must be a positive integer, or null for the published version' });
    } else {
      try {
        await resolveAgentConfig(scope.tenantDbName, agent.key, scope.projectId, value);
        fields.version = value;
      } catch {
        errors.push({ field: 'version', message: `version ${value} of agent "${agent.key}" does not exist` });
      }
    }
  }
  if (given('class')) {
    if (body.class !== 'default' && body.class !== 'deferred') errors.push({ field: 'class', message: 'class must be "default" or "deferred"' });
    else fields.runClass = body.class as AgentRunClass;
  }
  if (given('metadata')) {
    const parsed = parseRunMetadata(body.metadata);
    if (!parsed.ok) errors.push({ field: 'metadata', message: parsed.message });
    else fields.metadata = parsed.metadata;
  }
  if (given('response_format')) {
    const parsed = parseResponseFormat(body.response_format);
    if (!parsed.ok) errors.push({ field: 'response_format', message: parsed.message });
    else fields.responseFormat = parsed.format;
  }
  let shapedVariables: Record<string, unknown> | null | undefined;
  if (given('variables')) {
    const parsed = parseRunVariables(body.variables);
    if (!parsed.ok) errors.push({ field: 'variables', message: parsed.message });
    else shapedVariables = fields.variables = parsed.variables;
  }
  if (given('callback')) {
    const callback = await prepareTriggerCallback(body.callback, existing?.callback ?? null);
    if (!callback.ok) errors.push({ field: 'callback', message: callback.message });
    else fields.callback = callback.callback;
  }

  // Prompt + variables against the declaration of the version that runs — on create, and whenever one of them
  // (or the type: a webhook trigger's prompt is a template and its variables a mapping) changes.
  if (errors.length === 0 && (!existing || given('prompt') || given('variables') || given('version') || typeSettings !== undefined)) {
    const version = fields.version !== undefined ? fields.version : existing?.version ?? null;
    const config = await resolvePublishedAgentConfig(scope.tenantDbName, agent, scope.projectId, version ?? undefined);
    const variables = shapedVariables !== undefined ? shapedVariables : existing?.variables ?? null;
    // A webhook or connector trigger's prompt is a template over the event and its variables a mapping.
    const eventTrigger = (source: AgentTriggerTypeSettings | IAgentTrigger | null | undefined) =>
      source?.type === 'webhook' ? source.webhook : source?.type === 'connector' ? source.connector : null;
    const webhook = typeSettings ? eventTrigger(typeSettings) : eventTrigger(existing);
    const prompt = fields.prompt !== undefined ? fields.prompt : existing?.prompt ?? '';
    const declaresVariables = (config.variables?.length ?? 0) > 0;
    const givesVariables = declaresVariables && Boolean(variables && Object.keys(variables).length > 0);
    if (webhook) {
      const problem = templateProblem(prompt);
      if (problem) errors.push({ field: 'prompt', message: problem });
      errors.push(...variableMappingProblems(config.variables, variables).map((issue) => ({ field: `variables.${issue.field}`, message: issue.message })));
      // The event payload alone can be the whole message.
      if (prompt.trim() === '' && !webhook.includePayload && !givesVariables) {
        errors.push({ field: 'prompt', message: 'prompt is required unless the trigger includes the event payload or gives variables' });
      }
    } else {
      const resolved = resolveRunVariables(config.variables, variables);
      if (!resolved.ok) errors.push(...resolved.errors.map((issue) => ({ field: `variables.${issue.field}`, message: issue.message })));
      if (prompt.trim() === '' && !givesVariables) {
        errors.push({ field: 'prompt', message: 'prompt is required unless the trigger gives the variables the agent declares' });
      }
    }
    if (!existing && fields.prompt === undefined) fields.prompt = prompt;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, write: { ...fields, ...typeSettings }, ...(webhookSecret ? { webhookSecret } : {}) };
}

/**
 * `callback: { url, secret? } | null`. The secret is write-only: absent (or the
 * mask) keeps the stored one, `""` removes it, a new value replaces it.
 */
async function prepareTriggerCallback(
  value: unknown,
  current: IAgentTrigger['callback'],
): Promise<{ ok: true; callback: IAgentTrigger['callback'] } | { ok: false; message: string }> {
  if (value === null) return { ok: true, callback: null };
  if (!isPlainObject(value)) return { ok: false, message: 'callback must be an object { url, secret? } or null' };
  if (value.url === undefined || value.url === null || value.url === '') return { ok: true, callback: null };
  const secret = value.secret;
  if (secret !== undefined && secret !== null && typeof secret !== 'string') return { ok: false, message: 'callback.secret must be a string' };
  const newSecret = typeof secret === 'string' && secret !== '' && secret !== AGENT_CALLBACK_SECRET_MASK ? secret : undefined;
  const checked = await validateCallbackRequest(value.url, newSecret);
  if (!checked.ok) return { ok: false, message: checked.message.replace('callback_url', 'callback.url').replace('callback_secret', 'callback.secret') };
  const sealed = sealAgentCallbackConfig(
    { url: checked.url, ...(typeof secret === 'string' ? { secret } : {}) },
    current?.secretSealed ? { url: current.url, secretSealed: current.secretSealed } : undefined,
  );
  return { ok: true, callback: { url: checked.url!, secretSealed: sealed?.secretSealed ?? null } };
}

/**
 * A trigger, with `webhook.secret` in the one answer that carries a new generated secret and, for a
 * connector trigger, its subscription as `connector_subscription` (`view`, from the host).
 */
function triggerAnswer(trigger: IAgentTrigger, webhookSecret?: string, connectorSubscription?: ConnectorSubscriptionWire | null) {
  const serialized = serializeAgentTrigger(trigger);
  if (serialized.type === 'connector') return { ...serialized, connector_subscription: connectorSubscription ?? null };
  if (!webhookSecret || serialized.type !== 'webhook') return serialized;
  return { ...serialized, webhook: { ...serialized.webhook, secret: webhookSecret } };
}

/** A hosted write's answer: the subscription view the host returned when it bound the trigger. */
const hostedAnswer = (hosted: HostedTrigger, webhookSecret?: string) =>
  triggerAnswer(hosted.trigger, webhookSecret, toSubscriptionWire(hosted.connectorView));

function invalidTriggerBody(errors: VariableIssue[]) {
  const summary = errors.slice(0, 5).map((issue) => `${issue.field}: ${issue.message}`).join('; ');
  return apiErrorBody('invalid_request_error', `Invalid trigger - ${summary}`, 'invalid_trigger', { errors });
}

const triggerNotFoundBody = () => apiErrorBody('not_found_error', 'Trigger not found', 'trigger_not_found');

/** A body that may be empty (Run now), else the parsed JSON object. Null when it is not an object. */
function readOptionalBody(request: FastifyRequest): Record<string, unknown> | null {
  if (request.body === undefined || request.body === null || request.body === '') return {};
  const body = readJsonBody<unknown>(request);
  return isPlainObject(body) ? body : null;
}

// ── Handlers (shared by both mounts) ─────────────────────────────────────

async function loadTrigger(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller): Promise<IAgentTrigger | null> {
  const { triggerId } = request.params as { triggerId: string };
  const trigger = await getAgentTrigger(caller.scope, caller.agent.key, triggerId);
  if (!trigger) void reply.code(404).send(triggerNotFoundBody());
  return trigger;
}

async function listTriggers(reply: FastifyReply, caller: TriggerCaller) {
  const triggers = await listAgentTriggers(caller.scope, caller.agent.key);
  return reply.code(200).send({ object: 'list', data: triggers.map(serializeAgentTrigger), has_more: false });
}

async function createTrigger(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) {
  const body = readOptionalBody(request);
  if (!body) return reply.code(400).send(invalidRequestErrorBody('The body must be a JSON object', 'invalid_request'));
  const prepared = await prepareTriggerWrite({ body, agent: caller.agent, scope: caller.scope, actorId: caller.userId });
  if (!prepared.ok) return reply.code(400).send(invalidTriggerBody(prepared.errors));
  const { write } = prepared;
  // Create always names its type (a missing one is manual) and its name.
  const created = await createAgentTriggerHosted(
    caller.scope,
    caller.agent.key,
    { ...write, name: write.name!, prompt: write.prompt ?? '' } as NewTriggerWrite,
    caller.userId,
  );
  return reply.code(201).send(hostedAnswer(created, prepared.webhookSecret));
}

/** A stored connector trigger's subscription as the host shows it now (null for the other types). */
const subscriptionOf = (caller: TriggerCaller, trigger: IAgentTrigger) =>
  viewConnectorTrigger(connectorScope(caller.scope, caller.userId), trigger);

async function getTrigger(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) {
  const trigger = await loadTrigger(request, reply, caller);
  if (!trigger) return reply;
  return reply.code(200).send(trigger.type === 'connector'
    ? triggerAnswer(trigger, undefined, await subscriptionOf(caller, trigger))
    : serializeAgentTrigger(trigger));
}

async function patchTrigger(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) {
  const existing = await loadTrigger(request, reply, caller);
  if (!existing) return reply;
  const body = readOptionalBody(request);
  if (!body) return reply.code(400).send(invalidRequestErrorBody('The body must be a JSON object', 'invalid_request'));
  const prepared = await prepareTriggerWrite({ body, agent: caller.agent, scope: caller.scope, existing, actorId: caller.userId });
  if (!prepared.ok) return reply.code(400).send(invalidTriggerBody(prepared.errors));
  const updated = await updateAgentTriggerHosted(caller.scope, existing, prepared.write, caller.userId);
  if (!updated) return reply.code(404).send(triggerNotFoundBody());
  return reply.code(200).send(hostedAnswer(updated, prepared.webhookSecret));
}

async function removeTrigger(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) {
  const trigger = await loadTrigger(request, reply, caller);
  if (!trigger) return reply;
  await deleteAgentTriggerHosted(caller.scope, trigger, caller.userId);
  return reply.code(200).send({ id: String(trigger._id), object: 'agent.trigger.deleted', deleted: true });
}

const MAX_SAMPLE_HEADERS = 50;
const MAX_SAMPLE_HEADER_LENGTH = 8 * 1024;

/** A Run now's sample `headers`: an object of string values, or why not. */
function parseSampleHeaders(value: unknown): { ok: true; headers: Record<string, string> } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, headers: {} };
  if (!isPlainObject(value)) return { ok: false, message: 'headers must be an object of header names to string values' };
  const entries = Object.entries(value);
  if (entries.length > MAX_SAMPLE_HEADERS) return { ok: false, message: `headers can have at most ${MAX_SAMPLE_HEADERS} entries` };
  if (!entries.every(([, item]) => typeof item === 'string' && item.length <= MAX_SAMPLE_HEADER_LENGTH)) {
    return { ok: false, message: `each header value must be a string of at most ${MAX_SAMPLE_HEADER_LENGTH} characters` };
  }
  return { ok: true, headers: Object.fromEntries(entries.map(([name, item]) => [name.toLowerCase(), item as string])) };
}

/**
 * Run now: one fire (trigger `manual`) with the trigger's prompt; the body may
 * override `variables` (merged over the trigger's) and `metadata`. Answers like the
 * runs API create: 200 with a run that finished within `wait`, else 202.
 *
 * A webhook trigger also takes a sample `payload` (+ `headers`) and builds the
 * turn a delivery would (its events and filter are not applied, nothing is
 * de-duplicated); `dry_run: true` only evaluates it and creates nothing. A
 * connector trigger takes the event's data as `payload` and its type as `event`
 * (the package's declared sample when `payload` is left out) the same way.
 */
async function runTriggerNow(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) {
  const trigger = await loadTrigger(request, reply, caller);
  if (!trigger) return reply;
  const body = readOptionalBody(request);
  if (!body) return reply.code(400).send(invalidRequestErrorBody('The body must be a JSON object', 'invalid_request'));
  const bad = (message: string, code: string) => reply.code(400).send(invalidRequestErrorBody(message, code));

  const overrides = parseRunVariables(body.variables);
  if (!overrides.ok) return bad(overrides.message, 'invalid_variables');
  const metadata = parseRunMetadata(body.metadata);
  if (!metadata.ok) return bad(metadata.message, 'invalid_metadata');
  const prefer = parsePreferHeader(getHeaderValue(request, 'prefer'));
  const bodyWait = parseWaitSeconds(body.wait);
  if (bodyWait === null) return bad('wait must be a number of seconds (0 or more)', 'invalid_wait');
  const waitSeconds = bodyWait ?? (prefer.respondAsync ? 0 : prefer.wait ?? 0);
  let idempotencyKey: string | undefined;
  if (caller.dialect === 'client') {
    const idempotency = readIdempotencyKey(request, reply, 'client');
    if (!idempotency) return reply;
    idempotencyKey = idempotency.key;
  }

  if (trigger.type === 'connector' && !getConnectorTriggerHost()) {
    return reply.code(409).send(apiErrorBody('invalid_request_error', CONNECTOR_TRIGGERS_UNAVAILABLE_MESSAGE, 'connector_triggers_unavailable'));
  }
  if (trigger.type !== 'webhook' && trigger.type !== 'connector' && (body.payload !== undefined || body.headers !== undefined || body.dry_run !== undefined)) {
    return bad('payload, headers and dry_run are only accepted by a trigger of type "webhook" or "connector"', 'invalid_request');
  }
  if (trigger.type !== 'connector' && body.event !== undefined) return bad('event is only accepted by a trigger of type "connector"', 'invalid_request');
  if (trigger.type === 'connector' && body.headers !== undefined) return bad('headers are only accepted by a trigger of type "webhook"', 'invalid_request');
  if (body.event !== undefined && (typeof body.event !== 'string' || !EVENT_TYPE_RE.test(body.event))) {
    return bad('event must be an event type like "pull_request.opened" (letters, digits and . _ : -, at most 64 characters)', 'invalid_request');
  }
  if (trigger.type === 'webhook' && isRetiredWebhook(trigger.webhook)) {
    return reply.code(410).send(apiErrorBody('gone', RETIRED_WEBHOOK_MESSAGE, 'webhook_preset_retired'));
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return bad('dry_run must be a boolean', 'invalid_request');
  if (body.payload !== undefined && (body.payload === null || typeof body.payload !== 'object')) {
    return bad('payload must be a JSON object or array, like a delivery body', 'invalid_payload');
  }
  const sampleHeaders = parseSampleHeaders(body.headers);
  if (!sampleHeaders.ok) return bad(sampleHeaders.message, 'invalid_headers');

  let message = trigger.prompt;
  let runVariables: Record<string, unknown> | null;
  let runMetadata = metadata.metadata;
  let externalContent = false;
  let literalVariables: string[] = [];
  let triggerData: Record<string, unknown> | undefined;
  if (trigger.type === 'connector') {
    // Without a payload the package's declared sample stands in for the event.
    let payload = body.payload;
    let event = typeof body.event === 'string' ? body.event : undefined;
    if (payload === undefined) {
      const sample = await sampleConnectorTrigger(connectorScope(caller.scope, caller.userId), trigger);
      if (sample && sample.data !== null && typeof sample.data === 'object') {
        payload = sample.data;
        event ??= sample.eventType;
      }
    }
    const built = await manualConnectorTurn({
      trigger,
      tenantDbName: caller.tenant.tenantDbName,
      payload,
      event,
      overrides: overrides.variables,
      metadata: metadata.metadata,
    });
    if (body.dry_run === true) return reply.code(200).send(dryRunAnswer(built));
    if (!built.turn.ok) {
      return reply.code(400).send(apiErrorBody('invalid_request_error', `The trigger did not start a run: ${built.turn.reason}`, built.turn.code, { errors: built.turn.errors }));
    }
    message = built.turn.message;
    runVariables = built.turn.variables;
    literalVariables = built.turn.literalVariables;
    runMetadata = built.metadata;
    externalContent = payload !== undefined;
    triggerData = built.triggerData;
  } else if (trigger.type === 'webhook') {
    const built = await manualWebhookTurn({
      trigger,
      tenantDbName: caller.tenant.tenantDbName,
      payload: body.payload,
      headers: sampleHeaders.headers,
      overrides: overrides.variables,
      metadata: metadata.metadata,
      secrets: openWebhookSecrets(String(trigger._id), trigger.webhook) ?? [],
    });
    if (body.dry_run === true) return reply.code(200).send(dryRunAnswer(built));
    if (!built.turn.ok) {
      return reply.code(400).send(apiErrorBody('invalid_request_error', `The trigger did not start a run: ${built.turn.reason}`, built.turn.code, { errors: built.turn.errors }));
    }
    message = built.turn.message;
    runVariables = built.turn.variables;
    literalVariables = built.turn.literalVariables;
    runMetadata = built.metadata;
    externalContent = body.payload !== undefined;
  } else {
    const config = await triggerAgentConfig(caller.tenant.tenantDbName, trigger);
    const variables = resolveTriggerVariables(config, trigger, overrides.variables);
    if (!variables.ok) {
      return reply.code(400).send(apiErrorBody('invalid_request_error', `Invalid variables - ${variables.reason.replace(/^invalid variables: /, '')}`, 'invalid_variables', { errors: variables.errors }));
    }
    runVariables = variables.variables;
  }

  const fired = await fireTrigger(trigger, caller.tenant, {
    trigger: 'manual',
    message,
    variables: runVariables,
    metadata: runMetadata,
    ...(externalContent ? { externalContent: true, literalVariables } : {}),
    ...(triggerData ? { triggerData } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    // Run now counts against the person (and token) who pressed it.
    principal: { userId: caller.userId, ...(caller.apiTokenId ? { apiTokenId: caller.apiTokenId } : {}) },
  });
  switch (fired.kind) {
    case 'accepted':
    case 'duplicate': {
      if (!fired.run) return reply.code(409).send(idempotencyKeyConflictErrorBody());
      const waitMs = Math.min(waitSeconds * 1000, await caller.syncWaitMs());
      if (bodyWait === undefined && (prefer.respondAsync || prefer.wait !== undefined)) {
        void reply.header('Preference-Applied', prefer.respondAsync ? 'respond-async' : `wait=${Math.round(waitMs / 1000)}`);
      }
      const run = waitMs > 0 && isAgentRunActive(fired.run)
        ? (await waitForAgentRun({ ...caller.scope, runId: String(fired.run._id) }, waitMs, clientGoneSignal(reply))) ?? fired.run
        : fired.run;
      return isAgentRunActive(run) ? sendRunAccepted(reply, run) : reply.code(200).send(serializeAgentRun(run));
    }
    case 'concurrency_limit':
    case 'spend_limit':
    case 'quota_exceeded': {
      const codes = { concurrency_limit: 'agent_run_concurrency_limit', spend_limit: 'spend_limit_exceeded', quota_exceeded: 'agent_quota_exceeded' } as const;
      return reply
        .code(429)
        .header('Retry-After', String(fired.retryAfterSeconds))
        .send(apiErrorBody('rate_limit_error', `The trigger did not start a run: ${fired.reason}`, codes[fired.kind]));
    }
    default:
      if (fired.reason === 'idempotency key in use') return reply.code(409).send(idempotencyKeyConflictErrorBody());
      if (fired.reason === 'agent is not active') return bad('Agent is not active', 'agent_inactive');
      if (fired.reason.startsWith('metadata')) return bad(fired.reason, 'invalid_metadata');
      return reply.code(500).send(INTERNAL_ERROR_BODY);
  }
}

/**
 * A new webhook secret: generated (shown once in this answer), or the
 * sender's for Standard Webhooks. `grace_seconds` (0 – 86400, default 0) keeps
 * the current secret accepted for that long.
 */
async function rotateTriggerWebhookSecret(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) {
  const trigger = await loadTrigger(request, reply, caller);
  if (!trigger) return reply;
  if (trigger.type !== 'webhook' && trigger.type !== 'connector') {
    return reply.code(400).send(invalidRequestErrorBody('This trigger is not of type "webhook" or "connector"', 'trigger_not_webhook'));
  }
  const body = readOptionalBody(request);
  if (!body) return reply.code(400).send(invalidRequestErrorBody('The body must be a JSON object', 'invalid_request'));
  const grace = body.grace_seconds ?? 0;
  if (typeof grace !== 'number' || !Number.isInteger(grace) || grace < 0 || grace > MAX_ROTATION_GRACE_SECONDS) {
    return reply.code(400).send(invalidTriggerBody([{ field: 'grace_seconds', message: `grace_seconds must be a whole number from 0 to ${MAX_ROTATION_GRACE_SECONDS}` }]));
  }
  if (trigger.type === 'connector') return rotateConnectorSecret(reply, caller, trigger, grace);
  if (isRetiredWebhook(trigger.webhook)) {
    return reply.code(410).send(apiErrorBody('gone', RETIRED_WEBHOOK_MESSAGE, 'webhook_preset_retired'));
  }
  const rotated = rotateWebhookSecret(trigger.webhook, { graceSeconds: grace, secret: body.secret });
  if (!rotated.ok) return reply.code(400).send(invalidTriggerBody([{ field: rotated.field, message: rotated.message }]));
  const updated = await updateAgentTrigger(caller.scope, trigger, { type: 'webhook', webhook: rotated.webhook }, caller.userId);
  if (!updated) return reply.code(404).send(triggerNotFoundBody());
  return reply.code(200).send(rotationAnswer(rotated.webhook, rotated.secret));
}

/** The connector host's answer when the module is missing: writes are refused (400 `invalid_trigger`), these calls are not possible (409). */
const connectorUnavailable = (reply: FastifyReply) =>
  reply.code(409).send(apiErrorBody('invalid_request_error', CONNECTOR_TRIGGERS_UNAVAILABLE_MESSAGE, 'connector_triggers_unavailable'));

/** A connector trigger's webhook secret: a new one through the host (manual setup keeps the old one for the grace; auto setup re-registers). */
async function rotateConnectorSecret(reply: FastifyReply, caller: TriggerCaller, trigger: IAgentTrigger, grace: number) {
  const host = getConnectorTriggerHost();
  if (!host) return connectorUnavailable(reply);
  let view: Awaited<ReturnType<typeof host.rotate>>;
  try {
    view = await host.rotate(connectorScope(caller.scope, caller.userId), trigger, { graceSeconds: grace });
  } catch (error) {
    logger.warn('Rotating a connector trigger secret failed', { triggerId: String(trigger._id), error: error instanceof Error ? error.message : String(error) });
    return reply.code(502).send(apiErrorBody('api_error', 'The connector could not rotate the secret; try again.', 'connector_rotate_failed'));
  }
  if (!view) return reply.code(400).send(invalidRequestErrorBody('This connector trigger has no webhook secret to rotate', 'connector_no_secret'));
  const wire = toSubscriptionWire(view);
  return reply.code(200).send({
    object: 'agent.trigger.webhook_secret' as const,
    ...(view.secret ? { secret: view.secret } : {}),
    secret_hint: view.secretHint ?? null,
    // A manually set up webhook keeps the previous secret for the grace period the caller asked for.
    previous_valid_until: wire?.previous_secret_valid_until ?? null,
    connector_subscription: wire,
  });
}

/** Tries the vendor registration of a connector trigger again, or resumes its paused poll. */
async function retryConnectorTrigger(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) {
  const trigger = await loadTrigger(request, reply, caller);
  if (!trigger) return reply;
  if (trigger.type !== 'connector') {
    return reply.code(400).send(invalidRequestErrorBody('This trigger is not of type "connector"', 'trigger_not_connector'));
  }
  const host = getConnectorTriggerHost();
  if (!host) return connectorUnavailable(reply);
  let view: Awaited<ReturnType<typeof host.retry>>;
  try {
    view = await host.retry(connectorScope(caller.scope, caller.userId), trigger);
  } catch (error) {
    logger.warn('Retrying a connector trigger failed', { triggerId: String(trigger._id), error: error instanceof Error ? error.message : String(error) });
    return reply.code(502).send(apiErrorBody('api_error', 'The connector could not be reached; try again.', 'connector_retry_failed'));
  }
  if (!view) return reply.code(409).send(invalidRequestErrorBody('This connector trigger has no subscription to retry', 'connector_subscription_missing'));
  return reply.code(200).send(triggerAnswer(trigger, undefined, toSubscriptionWire(view)));
}

const DELIVERIES_DEFAULT_LIMIT = 20;
const DELIVERIES_MAX_LIMIT = 100;

/** The webhook delivery log, newest first (`?limit=` 1–100, `?before=<delivery id>` for the next page). */
async function listTriggerDeliveries(request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) {
  const trigger = await loadTrigger(request, reply, caller);
  if (!trigger) return reply;
  const query = (request.query ?? {}) as { limit?: string; before?: string };
  const limit = query.limit === undefined || query.limit === '' ? DELIVERIES_DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > DELIVERIES_MAX_LIMIT) {
    return reply.code(400).send(invalidRequestErrorBody(`limit must be a whole number from 1 to ${DELIVERIES_MAX_LIMIT}`, 'invalid_limit'));
  }
  const rows = await runWithTenantScope(caller.scope.tenantDbName, (db) => db.listAgentTriggerDeliveries({
    tenantId: caller.scope.tenantId,
    projectId: caller.scope.projectId,
    triggerId: String(trigger._id),
    limit: limit + 1,
    ...(typeof query.before === 'string' && query.before ? { before: query.before } : {}),
  }));
  return reply.code(200).send({ object: 'list', data: rows.slice(0, limit).map(serializeDelivery), has_more: rows.length > limit });
}

type TriggerHandler = (request: FastifyRequest, reply: FastifyReply, caller: TriggerCaller) => Promise<unknown>;

// ── Plugin ───────────────────────────────────────────────────────────────

export const agentTriggersApiPlugin: FastifyPluginAsync = async (app) => {
  // Client API: the agent `:agentKey` names in the token's project.
  const client = (handler: TriggerHandler, logMessage: string) => withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { agentKey } = request.params as { agentKey: string };
      const agent = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
      if (!agent) return reply.code(404).send(apiErrorBody('not_found_error', `Agent "${agentKey}" not found`, 'agent_not_found'));
      const quotaContext = {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        licenseType: ctx.tenant.licenseType as LicenseType,
        userId: ctx.tokenRecord.userId,
        tokenId: ctx.tokenRecord._id?.toString(),
      };
      return await handler(request, reply, {
        scope: { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ...connectorLocale(request.query) },
        tenant: { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, licenseType: ctx.tenant.licenseType },
        agent,
        userId: String(ctx.tokenRecord.userId ?? ''),
        ...(ctx.tokenRecord._id ? { apiTokenId: String(ctx.tokenRecord._id) } : {}),
        dialect: 'client',
        syncWaitMs: async () => (await resolveAgentRunLimits({ quotaContext })).syncWaitMs,
      });
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send(invalidRequestErrorBody('The body is not valid JSON', 'invalid_json'));
      logger.error(logMessage, { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  });

  // Dashboard: the agent `:agentId` names in the session's project.
  const dashboard = (handler: TriggerHandler, logMessage: string) => withApiRequestContext(async (request, reply) => {
    try {
      // A hidden agent a flow owns has no triggers: the flow is what starts it.
      const scoped = await requireScopedAgent(request, reply, { owned: 'refuse' });
      if (!scoped) return reply;
      const { session, projectId, agent } = scoped;
      const quotaContext = {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        licenseType: session.licenseType as LicenseType,
        userId: session.userId,
      };
      return await handler(request, reply, {
        scope: { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, ...connectorLocale(request.query) },
        tenant: { tenantDbName: session.tenantDbName, tenantId: session.tenantId, licenseType: session.licenseType },
        agent,
        userId: String(session.userId),
        dialect: 'dashboard',
        syncWaitMs: async () => (await resolveAgentRunLimits({ quotaContext })).syncWaitMs,
      });
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send(invalidRequestErrorBody('The body is not valid JSON', 'invalid_json'));
      logger.error(logMessage, { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  });

  app.get('/client/v1/agents/:agentKey/triggers', client((_request, reply, caller) => listTriggers(reply, caller), 'List triggers error'));
  app.post('/client/v1/agents/:agentKey/triggers', client(createTrigger, 'Create trigger error'));
  app.get('/client/v1/agents/:agentKey/triggers/:triggerId', client(getTrigger, 'Get trigger error'));
  app.patch('/client/v1/agents/:agentKey/triggers/:triggerId', client(patchTrigger, 'Update trigger error'));
  app.delete('/client/v1/agents/:agentKey/triggers/:triggerId', client(removeTrigger, 'Delete trigger error'));
  app.post('/client/v1/agents/:agentKey/triggers/:triggerId/run', client(runTriggerNow, 'Run trigger error'));
  app.post('/client/v1/agents/:agentKey/triggers/:triggerId/webhook/rotate-secret', client(rotateTriggerWebhookSecret, 'Rotate trigger webhook secret error'));
  app.post('/client/v1/agents/:agentKey/triggers/:triggerId/connector/retry', client(retryConnectorTrigger, 'Retry connector trigger error'));
  app.get('/client/v1/agents/:agentKey/triggers/:triggerId/deliveries', client(listTriggerDeliveries, 'List trigger deliveries error'));

  app.get('/agents/:agentId/triggers', dashboard((_request, reply, caller) => listTriggers(reply, caller), 'List triggers error'));
  app.post('/agents/:agentId/triggers', dashboard(createTrigger, 'Create trigger error'));
  app.get('/agents/:agentId/triggers/:triggerId', dashboard(getTrigger, 'Get trigger error'));
  app.patch('/agents/:agentId/triggers/:triggerId', dashboard(patchTrigger, 'Update trigger error'));
  app.delete('/agents/:agentId/triggers/:triggerId', dashboard(removeTrigger, 'Delete trigger error'));
  app.post('/agents/:agentId/triggers/:triggerId/run', dashboard(runTriggerNow, 'Run trigger error'));
  app.post('/agents/:agentId/triggers/:triggerId/webhook/rotate-secret', dashboard(rotateTriggerWebhookSecret, 'Rotate trigger webhook secret error'));
  app.post('/agents/:agentId/triggers/:triggerId/connector/retry', dashboard(retryConnectorTrigger, 'Retry connector trigger error'));
  app.get('/agents/:agentId/triggers/:triggerId/deliveries', dashboard(listTriggerDeliveries, 'List trigger deliveries error'));
};
