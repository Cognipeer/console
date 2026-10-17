/**
 * The routines API (§5.7): a routine is a saved way of starting an agent — a
 * prompt (+ inputs) and a trigger (a cron schedule in a timezone, one time, or
 * by hand). Every fire is an ordinary run (`channel: 'routine'`), so a routine's
 * history is `GET /client/v1/agents/runs?routine_id=`.
 *
 * Two mounts of the same handlers: the client API (`/client/v1/agents/:agentKey/routines…`,
 * API token) and the dashboard (`/agents/:agentId/routines…`, session). Both are
 * the `agents` service (GET read, everything else write) through the route
 * prefix map, and both answer in the client envelope `{ error: { type, message, code } }`.
 *
 * The callback secret is write-only: sealed on save, shown as `{ url, signed }`.
 * A webhook trigger's secret is shown once — in the answer that created or
 * replaced it (`webhook: { url, secret }`, or rotate-secret) — and only its last
 * four characters after that. Its delivery log is `…/routines/{id}/deliveries`.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { AgentRoutineTrigger, AgentRunClass, IAgent, IAgentRoutine } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { getAgentByKey } from '@/lib/services/agents';
import { AGENT_CALLBACK_SECRET_MASK, sealAgentCallbackConfig } from '@/lib/services/agents/agentCallbackConfig';
import { resolveRunInputs, type InputIssue } from '@/lib/services/agents/agentInputs';
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
  createAgentRoutine,
  deleteAgentRoutine,
  fireRoutine,
  getAgentRoutine,
  listAgentRoutines,
  resolveRoutineInputs,
  routineAgentConfig,
  serializeAgentRoutine,
  updateAgentRoutine,
  type RoutineScope,
  type RoutineTenant,
  type RoutineWrite,
} from '@/lib/services/agents/agentRoutines';
import { resolveAgentConfig } from '@/lib/services/agents/agentService';
import { DEFAULT_ROUTINE_TIMEZONE, isValidRoutineTimezone, validateRoutineCron } from '@/lib/services/agents/routineSchedule';
import { dryRunAnswer, manualWebhookTurn, serializeDelivery } from '@/lib/services/agents/routineWebhookDelivery';
import {
  MAX_ROTATION_GRACE_SECONDS,
  isWebhookTrigger,
  openWebhookSecrets,
  parseWebhookTriggerWrite,
  rotateWebhookSecret,
  rotationAnswer,
  webhookUrl,
} from '@/lib/services/agents/routineWebhookTrigger';
import { inputMappingProblems, templateProblem } from '@/lib/services/agents/routineWebhookView';
import { getHeaderValue, readJsonBody, withApiRequestContext, withClientApiRequestContext } from '../fastify-utils';
import {
  parseResponseFormat,
  parseRunInputs,
  parseRunMetadata,
  readIdempotencyKey,
  resolvePublishedAgentConfig,
  sendRunAccepted,
  clientGoneSignal,
} from './agent-invocation';
import { requireScopedAgent } from './agents';
import { parsePreferHeader, parseTimestamp, parseWaitSeconds } from './client-agent-runs';

const logger = createLogger('api:agent-routines');

const INTERNAL_ERROR_BODY = apiErrorBody('api_error', 'Internal error', 'internal_error');

export const ROUTINE_NAME_MAX_LENGTH = 200;
export const ROUTINE_DESCRIPTION_MAX_LENGTH = 2000;
export const ROUTINE_PROMPT_MAX_LENGTH = 32_000;
/** A `run_at` this far in the past still counts as "now" (the caller's clock, the request's time in flight). */
const RUN_AT_PAST_TOLERANCE_MS = 60_000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Who is asking, about which agent: the same for both mounts. */
interface RoutineCaller {
  scope: RoutineScope;
  tenant: RoutineTenant;
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

/**
 * A routine trigger from a request. `once` takes `run_at` (ISO-8601 or unix
 * seconds, not in the past) or `delay_seconds`. Another trigger type is added
 * here and in `serializeAgentRoutine`.
 */
export function parseRoutineTrigger(value: unknown, now: Date): { ok: true; trigger: AgentRoutineTrigger } | { ok: false; issue: InputIssue } {
  const issue = (field: string, message: string) => ({ ok: false as const, issue: { field, message } });
  if (!isPlainObject(value)) return issue('trigger', 'trigger must be an object with a type');
  switch (value.type) {
    case 'schedule': {
      const cronError = validateRoutineCron(value.cron);
      if (cronError) return issue('trigger.cron', cronError);
      const timezone = value.timezone === undefined || value.timezone === null || value.timezone === '' ? DEFAULT_ROUTINE_TIMEZONE : value.timezone;
      if (!isValidRoutineTimezone(timezone)) return issue('trigger.timezone', 'timezone must be an IANA timezone name, like "Europe/Istanbul"');
      return { ok: true, trigger: { type: 'schedule', cron: String(value.cron).trim().split(/\s+/).join(' '), timezone } };
    }
    case 'once': {
      const hasRunAt = value.run_at !== undefined && value.run_at !== null;
      const hasDelay = value.delay_seconds !== undefined && value.delay_seconds !== null;
      if (hasRunAt === hasDelay) return issue('trigger.run_at', 'a once trigger needs run_at or delay_seconds (one of them)');
      if (hasDelay) {
        const delay = value.delay_seconds;
        if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0) {
          return issue('trigger.delay_seconds', 'delay_seconds must be a whole number of seconds (0 or more)');
        }
        return { ok: true, trigger: { type: 'once', runAt: new Date(now.getTime() + delay * 1000) } };
      }
      const runAt = parseTimestamp(value.run_at);
      if (!runAt) return issue('trigger.run_at', 'run_at must be an ISO-8601 date or unix seconds');
      if (runAt.getTime() < now.getTime() - RUN_AT_PAST_TOLERANCE_MS) return issue('trigger.run_at', 'run_at is in the past');
      return { ok: true, trigger: { type: 'once', runAt } };
    }
    case 'manual':
      return { ok: true, trigger: { type: 'manual' } };
    default:
      return issue('trigger.type', 'trigger.type must be "schedule", "once", "manual" or "webhook"');
  }
}

/**
 * Is `value` (a request's trigger) the stored trigger sent back unchanged — an
 * editor saving the whole form? Then nothing about the timing changes, even for
 * a once time that has passed since.
 */
function isStoredTrigger(value: unknown, stored: AgentRoutineTrigger): boolean {
  if (!isPlainObject(value) || value.type !== stored.type) return false;
  switch (stored.type) {
    case 'schedule':
      return typeof value.cron === 'string' && value.cron.trim().split(/\s+/).join(' ') === stored.cron
        && (value.timezone ?? DEFAULT_ROUTINE_TIMEZONE) === stored.timezone;
    case 'once': {
      if (value.delay_seconds !== undefined && value.delay_seconds !== null) return false;
      const runAt = parseTimestamp(value.run_at);
      return Boolean(runAt) && runAt!.getTime() === new Date(stored.runAt).getTime();
    }
    default:
      return Object.keys(value).length === 1;
  }
}

/**
 * A create (`existing` absent) or PATCH body → the fields to save. Absent =
 * unchanged; `null` clears a nullable field. The prompt / inputs / version are
 * checked together against the inputs the agent (that version of it) declares:
 * the prompt may be empty only when the agent declares inputs and the routine
 * gives some.
 */
export async function prepareRoutineWrite(input: {
  body: Record<string, unknown>;
  agent: IAgent;
  scope: RoutineScope;
  existing?: IAgentRoutine | null;
  now?: Date;
}): Promise<{ ok: true; write: RoutineWrite; /** A new generated webhook secret, shown once. */ webhookSecret?: string } | { ok: false; errors: InputIssue[] }> {
  const { body, agent, scope, existing } = input;
  const now = input.now ?? new Date();
  const errors: InputIssue[] = [];
  const write: RoutineWrite = {};
  const given = (key: string) => body[key] !== undefined;
  let webhookSecret: string | undefined;

  if (given('name') || !existing) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push({ field: 'name', message: 'name is required' });
    else if (name.length > ROUTINE_NAME_MAX_LENGTH) errors.push({ field: 'name', message: `name can be at most ${ROUTINE_NAME_MAX_LENGTH} characters` });
    else write.name = name;
  }
  if (given('description')) {
    if (body.description === null || body.description === '') write.description = null;
    else if (typeof body.description !== 'string' || body.description.length > ROUTINE_DESCRIPTION_MAX_LENGTH) {
      errors.push({ field: 'description', message: `description must be a string of at most ${ROUTINE_DESCRIPTION_MAX_LENGTH} characters` });
    } else write.description = body.description;
  }
  if (given('enabled')) {
    if (typeof body.enabled !== 'boolean') errors.push({ field: 'enabled', message: 'enabled must be a boolean' });
    else write.enabled = body.enabled;
  }
  if (!existing || (given('trigger') && !isStoredTrigger(body.trigger, existing.trigger))) {
    // A new routine without a trigger is manual (Run now / the API).
    const value = existing ? body.trigger : body.trigger ?? { type: 'manual' };
    if (isPlainObject(value) && value.type === 'webhook') {
      // Keeps the stored hook id and secret unless the secret rules replace the secret.
      const parsed = parseWebhookTriggerWrite(value, existing?.trigger);
      if (!parsed.ok) errors.push(...parsed.errors);
      else {
        write.trigger = parsed.trigger;
        webhookSecret = parsed.secret;
      }
    } else {
      const parsed = parseRoutineTrigger(value, now);
      if (!parsed.ok) errors.push(parsed.issue);
      else write.trigger = parsed.trigger;
    }
  }
  if (given('prompt')) {
    if (body.prompt !== null && typeof body.prompt !== 'string') errors.push({ field: 'prompt', message: 'prompt must be a string' });
    else if (typeof body.prompt === 'string' && body.prompt.length > ROUTINE_PROMPT_MAX_LENGTH) {
      errors.push({ field: 'prompt', message: `prompt can be at most ${ROUTINE_PROMPT_MAX_LENGTH} characters` });
    } else write.prompt = typeof body.prompt === 'string' ? body.prompt : '';
  }
  if (given('version')) {
    const value = body.version;
    if (value === null) write.version = null;
    else if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      errors.push({ field: 'version', message: 'version must be a positive integer, or null for the published version' });
    } else {
      try {
        await resolveAgentConfig(scope.tenantDbName, agent.key, scope.projectId, value);
        write.version = value;
      } catch {
        errors.push({ field: 'version', message: `version ${value} of agent "${agent.key}" does not exist` });
      }
    }
  }
  if (given('class')) {
    if (body.class !== 'default' && body.class !== 'deferred') errors.push({ field: 'class', message: 'class must be "default" or "deferred"' });
    else write.runClass = body.class as AgentRunClass;
  }
  if (given('metadata')) {
    const parsed = parseRunMetadata(body.metadata);
    if (!parsed.ok) errors.push({ field: 'metadata', message: parsed.message });
    else write.metadata = parsed.metadata;
  }
  if (given('response_format')) {
    const parsed = parseResponseFormat(body.response_format);
    if (!parsed.ok) errors.push({ field: 'response_format', message: parsed.message });
    else write.responseFormat = parsed.format;
  }
  let shapedInputs: Record<string, unknown> | null | undefined;
  if (given('inputs')) {
    const parsed = parseRunInputs(body.inputs);
    if (!parsed.ok) errors.push({ field: 'inputs', message: parsed.message });
    else shapedInputs = write.inputs = parsed.inputs;
  }
  if (given('callback')) {
    const callback = await prepareRoutineCallback(body.callback, existing?.callback ?? null);
    if (!callback.ok) errors.push({ field: 'callback', message: callback.message });
    else write.callback = callback.callback;
  }

  // Prompt + inputs against the declaration of the version that runs — on create, and whenever one of them
  // (or the trigger: a webhook routine's prompt is a template and its inputs a mapping) changes.
  if (errors.length === 0 && (!existing || given('prompt') || given('inputs') || given('version') || write.trigger !== undefined)) {
    const version = write.version !== undefined ? write.version : existing?.version ?? null;
    const config = await resolvePublishedAgentConfig(scope.tenantDbName, agent, scope.projectId, version ?? undefined);
    const inputs = shapedInputs !== undefined ? shapedInputs : existing?.inputs ?? null;
    const trigger = write.trigger ?? existing?.trigger;
    const prompt = write.prompt !== undefined ? write.prompt : existing?.prompt ?? '';
    const declaresInputs = (config.inputs?.length ?? 0) > 0;
    const givesInputs = declaresInputs && Boolean(inputs && Object.keys(inputs).length > 0);
    if (isWebhookTrigger(trigger)) {
      const problem = templateProblem(prompt);
      if (problem) errors.push({ field: 'prompt', message: problem });
      errors.push(...inputMappingProblems(config.inputs, inputs).map((issue) => ({ field: `inputs.${issue.field}`, message: issue.message })));
      // The event payload alone can be the whole message.
      if (prompt.trim() === '' && !trigger.includePayload && !givesInputs) {
        errors.push({ field: 'prompt', message: 'prompt is required unless the routine includes the event payload or gives inputs' });
      }
    } else {
      const resolved = resolveRunInputs(config.inputs, inputs);
      if (!resolved.ok) errors.push(...resolved.errors.map((issue) => ({ field: `inputs.${issue.field}`, message: issue.message })));
      if (prompt.trim() === '' && !givesInputs) {
        errors.push({ field: 'prompt', message: 'prompt is required unless the routine gives the inputs the agent declares' });
      }
    }
    if (!existing && write.prompt === undefined) write.prompt = prompt;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, write, ...(webhookSecret ? { webhookSecret } : {}) };
}

/**
 * `callback: { url, secret? } | null`. The secret is write-only: absent (or the
 * mask) keeps the stored one, `""` removes it, a new value replaces it.
 */
async function prepareRoutineCallback(
  value: unknown,
  current: IAgentRoutine['callback'],
): Promise<{ ok: true; callback: IAgentRoutine['callback'] } | { ok: false; message: string }> {
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

/** A routine, plus `webhook: { url, secret }` in the one answer that carries a new generated secret. */
function routineAnswer(routine: IAgentRoutine, webhookSecret?: string) {
  const serialized = serializeAgentRoutine(routine);
  if (!webhookSecret || !isWebhookTrigger(routine.trigger)) return serialized;
  return { ...serialized, webhook: { url: webhookUrl(routine.tenantId, routine.trigger.hookId), secret: webhookSecret } };
}

function invalidRoutineBody(errors: InputIssue[]) {
  const summary = errors.slice(0, 5).map((issue) => `${issue.field}: ${issue.message}`).join('; ');
  return apiErrorBody('invalid_request_error', `Invalid routine - ${summary}`, 'invalid_routine', { errors });
}

const routineNotFoundBody = () => apiErrorBody('not_found_error', 'Routine not found', 'routine_not_found');

/** A body that may be empty (Run now), else the parsed JSON object. Null when it is not an object. */
function readOptionalBody(request: FastifyRequest): Record<string, unknown> | null {
  if (request.body === undefined || request.body === null || request.body === '') return {};
  const body = readJsonBody<unknown>(request);
  return isPlainObject(body) ? body : null;
}

// ── Handlers (shared by both mounts) ─────────────────────────────────────

async function loadRoutine(request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller): Promise<IAgentRoutine | null> {
  const { routineId } = request.params as { routineId: string };
  const routine = await getAgentRoutine(caller.scope, caller.agent.key, routineId);
  if (!routine) void reply.code(404).send(routineNotFoundBody());
  return routine;
}

async function listRoutines(reply: FastifyReply, caller: RoutineCaller) {
  const routines = await listAgentRoutines(caller.scope, caller.agent.key);
  return reply.code(200).send({ object: 'list', data: routines.map(serializeAgentRoutine), has_more: false });
}

async function createRoutine(request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller) {
  const body = readOptionalBody(request);
  if (!body) return reply.code(400).send(invalidRequestErrorBody('The body must be a JSON object', 'invalid_request'));
  const prepared = await prepareRoutineWrite({ body, agent: caller.agent, scope: caller.scope });
  if (!prepared.ok) return reply.code(400).send(invalidRoutineBody(prepared.errors));
  const { write } = prepared;
  const routine = await createAgentRoutine(
    caller.scope,
    caller.agent.key,
    { ...write, name: write.name!, trigger: write.trigger!, prompt: write.prompt ?? '' },
    caller.userId,
  );
  return reply.code(201).send(routineAnswer(routine, prepared.webhookSecret));
}

async function getRoutine(request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller) {
  const routine = await loadRoutine(request, reply, caller);
  if (!routine) return reply;
  return reply.code(200).send(serializeAgentRoutine(routine));
}

async function patchRoutine(request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller) {
  const existing = await loadRoutine(request, reply, caller);
  if (!existing) return reply;
  const body = readOptionalBody(request);
  if (!body) return reply.code(400).send(invalidRequestErrorBody('The body must be a JSON object', 'invalid_request'));
  const prepared = await prepareRoutineWrite({ body, agent: caller.agent, scope: caller.scope, existing });
  if (!prepared.ok) return reply.code(400).send(invalidRoutineBody(prepared.errors));
  const updated = await updateAgentRoutine(caller.scope, existing, prepared.write, caller.userId);
  if (!updated) return reply.code(404).send(routineNotFoundBody());
  return reply.code(200).send(routineAnswer(updated, prepared.webhookSecret));
}

async function removeRoutine(request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller) {
  const routine = await loadRoutine(request, reply, caller);
  if (!routine) return reply;
  await deleteAgentRoutine(caller.scope, routine);
  return reply.code(200).send({ id: String(routine._id), object: 'agent.routine.deleted', deleted: true });
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
 * Run now: one fire (trigger `manual`) with the routine's prompt; the body may
 * override `inputs` (merged over the routine's) and `metadata`. Answers like the
 * runs API create: 200 with a run that finished within `wait`, else 202.
 *
 * A webhook routine also takes a sample `payload` (+ `headers`) and builds the
 * turn a delivery would (its events and filter are not applied, nothing is
 * de-duplicated); `dry_run: true` only evaluates it and creates nothing.
 */
async function runRoutineNow(request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller) {
  const routine = await loadRoutine(request, reply, caller);
  if (!routine) return reply;
  const body = readOptionalBody(request);
  if (!body) return reply.code(400).send(invalidRequestErrorBody('The body must be a JSON object', 'invalid_request'));
  const bad = (message: string, code: string) => reply.code(400).send(invalidRequestErrorBody(message, code));

  const overrides = parseRunInputs(body.inputs);
  if (!overrides.ok) return bad(overrides.message, 'invalid_inputs');
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

  const webhook = isWebhookTrigger(routine.trigger) ? routine.trigger : null;
  if (!webhook && (body.payload !== undefined || body.headers !== undefined || body.dry_run !== undefined)) {
    return bad('payload, headers and dry_run are only accepted by a routine with a webhook trigger', 'invalid_request');
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return bad('dry_run must be a boolean', 'invalid_request');
  if (body.payload !== undefined && (body.payload === null || typeof body.payload !== 'object')) {
    return bad('payload must be a JSON object or array, like a delivery body', 'invalid_payload');
  }
  const sampleHeaders = parseSampleHeaders(body.headers);
  if (!sampleHeaders.ok) return bad(sampleHeaders.message, 'invalid_headers');

  let message = routine.prompt;
  let runInputs: Record<string, unknown> | null;
  let runMetadata = metadata.metadata;
  let externalContent = false;
  if (webhook) {
    const built = await manualWebhookTurn({
      routine,
      tenantDbName: caller.tenant.tenantDbName,
      payload: body.payload,
      headers: sampleHeaders.headers,
      overrides: overrides.inputs,
      metadata: metadata.metadata,
      secrets: openWebhookSecrets(String(routine._id), webhook) ?? [],
    });
    if (body.dry_run === true) return reply.code(200).send(dryRunAnswer(built));
    if (!built.turn.ok) {
      return reply.code(400).send(apiErrorBody('invalid_request_error', `The routine did not start a run: ${built.turn.reason}`, built.turn.code, { errors: built.turn.errors }));
    }
    message = built.turn.message;
    runInputs = built.turn.inputs;
    runMetadata = built.metadata;
    externalContent = body.payload !== undefined;
  } else {
    const config = await routineAgentConfig(caller.tenant.tenantDbName, routine);
    const inputs = resolveRoutineInputs(config, routine, overrides.inputs);
    if (!inputs.ok) {
      return reply.code(400).send(apiErrorBody('invalid_request_error', `Invalid inputs - ${inputs.reason.replace(/^invalid inputs: /, '')}`, 'invalid_inputs', { errors: inputs.errors }));
    }
    runInputs = inputs.inputs;
  }

  const fired = await fireRoutine(routine, caller.tenant, {
    trigger: 'manual',
    message,
    inputs: runInputs,
    metadata: runMetadata,
    ...(externalContent ? { externalContent: true } : {}),
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
        .send(apiErrorBody('rate_limit_error', `The routine did not start a run: ${fired.reason}`, codes[fired.kind]));
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
async function rotateRoutineWebhookSecret(request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller) {
  const routine = await loadRoutine(request, reply, caller);
  if (!routine) return reply;
  if (!isWebhookTrigger(routine.trigger)) {
    return reply.code(400).send(invalidRequestErrorBody('This routine has no webhook trigger', 'routine_not_webhook'));
  }
  const body = readOptionalBody(request);
  if (!body) return reply.code(400).send(invalidRequestErrorBody('The body must be a JSON object', 'invalid_request'));
  const grace = body.grace_seconds ?? 0;
  if (typeof grace !== 'number' || !Number.isInteger(grace) || grace < 0 || grace > MAX_ROTATION_GRACE_SECONDS) {
    return reply.code(400).send(invalidRoutineBody([{ field: 'grace_seconds', message: `grace_seconds must be a whole number from 0 to ${MAX_ROTATION_GRACE_SECONDS}` }]));
  }
  const rotated = rotateWebhookSecret(routine.trigger, { graceSeconds: grace, secret: body.secret });
  if (!rotated.ok) return reply.code(400).send(invalidRoutineBody([{ field: rotated.field, message: rotated.message }]));
  const updated = await updateAgentRoutine(caller.scope, routine, { trigger: rotated.trigger }, caller.userId);
  if (!updated) return reply.code(404).send(routineNotFoundBody());
  return reply.code(200).send(rotationAnswer(rotated.trigger, rotated.secret));
}

const DELIVERIES_DEFAULT_LIMIT = 20;
const DELIVERIES_MAX_LIMIT = 100;

/** The webhook delivery log, newest first (`?limit=` 1–100, `?before=<delivery id>` for the next page). */
async function listRoutineDeliveries(request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller) {
  const routine = await loadRoutine(request, reply, caller);
  if (!routine) return reply;
  const query = (request.query ?? {}) as { limit?: string; before?: string };
  const limit = query.limit === undefined || query.limit === '' ? DELIVERIES_DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > DELIVERIES_MAX_LIMIT) {
    return reply.code(400).send(invalidRequestErrorBody(`limit must be a whole number from 1 to ${DELIVERIES_MAX_LIMIT}`, 'invalid_limit'));
  }
  const rows = await runWithTenantScope(caller.scope.tenantDbName, (db) => db.listAgentRoutineDeliveries({
    tenantId: caller.scope.tenantId,
    projectId: caller.scope.projectId,
    routineId: String(routine._id),
    limit: limit + 1,
    ...(typeof query.before === 'string' && query.before ? { before: query.before } : {}),
  }));
  return reply.code(200).send({ object: 'list', data: rows.slice(0, limit).map(serializeDelivery), has_more: rows.length > limit });
}

type RoutineHandler = (request: FastifyRequest, reply: FastifyReply, caller: RoutineCaller) => Promise<unknown>;

// ── Plugin ───────────────────────────────────────────────────────────────

export const agentRoutinesApiPlugin: FastifyPluginAsync = async (app) => {
  // Client API: the agent `:agentKey` names in the token's project.
  const client = (handler: RoutineHandler, logMessage: string) => withClientApiRequestContext(async (request, reply, ctx) => {
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
        scope: { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
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
  const dashboard = (handler: RoutineHandler, logMessage: string) => withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
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
        scope: { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
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

  app.get('/client/v1/agents/:agentKey/routines', client((_request, reply, caller) => listRoutines(reply, caller), 'List routines error'));
  app.post('/client/v1/agents/:agentKey/routines', client(createRoutine, 'Create routine error'));
  app.get('/client/v1/agents/:agentKey/routines/:routineId', client(getRoutine, 'Get routine error'));
  app.patch('/client/v1/agents/:agentKey/routines/:routineId', client(patchRoutine, 'Update routine error'));
  app.delete('/client/v1/agents/:agentKey/routines/:routineId', client(removeRoutine, 'Delete routine error'));
  app.post('/client/v1/agents/:agentKey/routines/:routineId/run', client(runRoutineNow, 'Run routine error'));
  app.post('/client/v1/agents/:agentKey/routines/:routineId/webhook/rotate-secret', client(rotateRoutineWebhookSecret, 'Rotate routine webhook secret error'));
  app.get('/client/v1/agents/:agentKey/routines/:routineId/deliveries', client(listRoutineDeliveries, 'List routine deliveries error'));

  app.get('/agents/:agentId/routines', dashboard((_request, reply, caller) => listRoutines(reply, caller), 'List routines error'));
  app.post('/agents/:agentId/routines', dashboard(createRoutine, 'Create routine error'));
  app.get('/agents/:agentId/routines/:routineId', dashboard(getRoutine, 'Get routine error'));
  app.patch('/agents/:agentId/routines/:routineId', dashboard(patchRoutine, 'Update routine error'));
  app.delete('/agents/:agentId/routines/:routineId', dashboard(removeRoutine, 'Delete routine error'));
  app.post('/agents/:agentId/routines/:routineId/run', dashboard(runRoutineNow, 'Run routine error'));
  app.post('/agents/:agentId/routines/:routineId/webhook/rotate-secret', dashboard(rotateRoutineWebhookSecret, 'Rotate routine webhook secret error'));
  app.get('/agents/:agentId/routines/:routineId/deliveries', dashboard(listRoutineDeliveries, 'List routine deliveries error'));
};
