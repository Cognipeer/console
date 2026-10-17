/**
 * What every client entry point that starts an agent turn checks and prepares
 * before it calls `startAgentRun` (§4.1): the agent and the version it runs,
 * the input, the session it continues and the caller's right to it, the new
 * session's budget, reasoning, the model choice, the run limits, the
 * Idempotency-Key, the callback, the files and the runtime context.
 *
 * Shared by the runs API (`client-agent-runs.ts`), the Responses route
 * (`client-agents.ts`), chat completions and A2A; each helper answers a refusal itself in the caller's
 * dialect and returns null, so a route reads `if (!x) return reply;`.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AgentResponseFormat,
  IAgent,
  IAgentConversation,
  IAgentRun,
  IAgentSessionBudget,
} from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { createConversation, getAgentByKey } from '@/lib/services/agents';
import { parseAgentRequestReasoning } from '@/lib/services/agents/agentReasoning';
import type { AgentModelChoice } from '@/lib/services/agents/agentModelSelection';
import { pendingActionsBlockingMessage } from '@/lib/services/agents/agentActionResolution';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  agentDefaultCallback,
  apiErrorBody,
  publicAgentRunId,
  resolveAgentRunLimits,
  serializeAgentRun,
  validateCallbackRequest,
  type AgentRunLimits,
} from '@/lib/services/agents/agentRunService';
import { resolveAgentConfig } from '@/lib/services/agents/agentService';
import {
  extractResponseUserInput,
  storeResponseInputFiles,
  type ResponseUserInput,
} from '@/lib/services/agents/responseInputFiles';
import { assertSessionBudgetAvailable, clientBudgetViolation, parseSessionBudget } from '@/lib/services/agents/sessionBudget';
import { attachmentsAvailability, attachmentsUnavailableMessage } from '@/lib/services/agents/sessionFiles';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import { getModelByKey } from '@/lib/services/models/modelService';
import { createLogger } from '@/lib/core/logger';
import { getHeaderValue } from '../fastify-utils';
import { CANCEL_PENDING_FORBIDDEN_MESSAGE, refuseCancelPending } from './agent-approval-authz';
import {
  AgentModelError,
  rememberSessionModel,
  requestedAgentModel,
  resolveRunModelForRequest,
} from './agent-model-authz';
import {
  decideSessionAccess,
  sendAuthorizationUnavailable,
  sendClientSessionRefusal,
  sendOpenAiSessionRefusal,
} from './agent-session-access';

/** Whose error envelope a refusal uses: the client API's (`{ error: { type, message, code } }`) or OpenAI's. */
export type InvocationDialect = 'client' | 'openai';

export interface InvocationFailure {
  status: number;
  type: string;
  message: string;
  code: string;
  param?: string;
  extra?: Record<string, unknown>;
}

/** Sends a refusal in the dialect's envelope. */
export function sendInvocationFailure(reply: FastifyReply, dialect: InvocationDialect, failure: InvocationFailure): FastifyReply {
  if (dialect === 'openai') {
    return reply.code(failure.status).send({
      error: { message: failure.message, type: failure.type, param: failure.param ?? null, code: failure.code, ...failure.extra },
    });
  }
  return reply.code(failure.status).send(apiErrorBody(failure.type, failure.message, failure.code, failure.extra));
}

const logger = createLogger('api:agent-invocation');

/**
 * A client-envelope error body (`{ error: { type, message, code, ...extra } }`)
 * in OpenAI's (`{ error: { message, type, param, code, ...extra } }`).
 */
export function openAiEnvelopeOf(body: unknown): { error: Record<string, unknown> } {
  const error = ((body as { error?: unknown })?.error ?? {}) as Record<string, unknown>;
  if (typeof error !== 'object' || error === null) {
    return { error: { message: String(error), type: 'invalid_request_error', param: null, code: null } };
  }
  const { type, message, code, param, ...extra } = error;
  return { error: { message: message ?? null, type: type ?? 'api_error', param: param ?? null, code: code ?? null, ...extra } };
}

const invalid = (message: string, code: string, param?: string): InvocationFailure => ({
  status: 400, type: 'invalid_request_error', message, code, ...(param ? { param } : {}),
});

function fail(reply: FastifyReply, dialect: InvocationDialect, failure: InvocationFailure): null {
  sendInvocationFailure(reply, dialect, failure);
  return null;
}

// ── Agent + version ──────────────────────────────────────────────────────

export interface ResolvedInvocationAgent {
  agent: IAgent;
  /** A pinned version; undefined = the published one (or the draft, see usePublished). */
  version?: number;
  /** Run the published version (the draft when nothing is published); false = the draft explicitly. */
  usePublished: boolean;
}

/** `version`: a positive integer, `"draft"`, or absent. */
export function parseRequestedVersion(value: unknown): { version?: number; draft?: boolean } | { error: string } {
  if (value === undefined || value === null) return {};
  if (value === 'draft') return { draft: true };
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return { error: 'version must be a positive integer or "draft"' };
  return { version: n };
}

/**
 * The active agent `agentKey` names in the token's project, and the version
 * the turn runs: the published one by default (the draft while nothing is
 * published), `version: N` pinned, `version: "draft"` the draft. A pinned
 * version that does not exist is refused now, not a run that fails later.
 */
export async function resolveInvocationAgent(
  reply: FastifyReply,
  dialect: InvocationDialect,
  ctx: ApiTokenContext,
  agentKey: string,
  versionValue: unknown,
): Promise<ResolvedInvocationAgent | null> {
  const requested = parseRequestedVersion(versionValue);
  if ('error' in requested) return fail(reply, dialect, invalid(requested.error, 'invalid_version', 'version'));
  const agent = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
  if (!agent) {
    return fail(reply, dialect, { status: 404, type: 'not_found_error', message: `Agent "${agentKey}" not found`, code: 'agent_not_found' });
  }
  if (agent.status !== 'active') return fail(reply, dialect, invalid('Agent is not active', 'agent_inactive'));
  if (requested.version !== undefined) {
    try {
      await resolveAgentConfig(ctx.tenantDbName, agent.key, ctx.projectId, requested.version);
    } catch {
      return fail(reply, dialect, {
        status: 404, type: 'not_found_error', message: `Version ${requested.version} of agent "${agent.key}" not found`, code: 'version_not_found', param: 'version',
      });
    }
  }
  return { agent, ...(requested.version !== undefined ? { version: requested.version } : {}), usePublished: !requested.draft };
}

// ── Target: an agent or a model (§1.2) ───────────────────────────────────

/** `agent:<key>` always names an agent; a bare name is a model first. */
export const AGENT_TARGET_PREFIX = 'agent:';

export type InvocationTarget =
  | { kind: 'agent'; agentKey: string }
  | { kind: 'model'; modelKey: string }
  | { kind: 'not_found' };

/**
 * What `model` names on a route that serves models and agents:
 * `agent:<key>` → that agent; else a model with that key in the project; else
 * an agent with that key; else nothing (404 `model_not_found`). A model wins a
 * bare-name collision so nobody's model traffic moves because an agent was
 * later given the same key. `agentsOnly` (the `/agents/...` alias) skips the
 * model lookup: the name is an agent key.
 */
export async function resolveInvocationTarget(
  ctx: { tenantDbName: string; projectId: string },
  model: string,
  options: { agentsOnly?: boolean } = {},
): Promise<InvocationTarget> {
  const explicit = model.startsWith(AGENT_TARGET_PREFIX);
  const key = explicit ? model.slice(AGENT_TARGET_PREFIX.length) : model;
  if (!key) return { kind: 'not_found' };
  if (explicit || options.agentsOnly) return { kind: 'agent', agentKey: key };
  try {
    if (await getModelByKey(ctx.tenantDbName, key, ctx.projectId)) return { kind: 'model', modelKey: key };
  } catch (error) {
    // A model store that cannot answer must not take agent traffic down with it.
    logger.warn('Model lookup failed while resolving a target; trying agents', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const agent = await getAgentByKey(ctx.tenantDbName, key, ctx.projectId);
  return agent ? { kind: 'agent', agentKey: key } : { kind: 'not_found' };
}

// ── Input ────────────────────────────────────────────────────────────────

export interface InvocationInput {
  userInput: ResponseUserInput;
  userMessage: string;
}

/** The text and the files (`input_file` / `input_image`) of the last user message (the Responses `input`). */
export function parseInvocationInput(
  reply: FastifyReply,
  dialect: InvocationDialect,
  agent: IAgent,
  input: unknown,
  options: { allowEmpty?: boolean } = {},
): InvocationInput | null {
  const userInput = extractResponseUserInput(input);
  const userMessage = userInput.text ?? '';
  if (!userMessage && userInput.files.length === 0 && !options.allowEmpty) {
    return fail(reply, dialect, invalid('input field is required (string or array of message items)', 'missing_input', 'input'));
  }
  const available = attachmentsAvailability(agent.config);
  if (userInput.files.length > 0 && !available.available) {
    return fail(reply, dialect, { status: 403, type: 'invalid_request_error', message: attachmentsUnavailableMessage(available.reason), code: 'attachments_disabled' });
  }
  return { userInput, userMessage };
}

// ── Session ──────────────────────────────────────────────────────────────

/**
 * May this caller send the next message of `conversation` now? Continuing a
 * session somebody else started is acting on it (its owner always may, anybody
 * else needs `agent.session_manage_others` and `agent.session_view_others`); a
 * session waiting on an approval the agent will not cancel is 409; an agent
 * that cancels open requests on a new message (`cancel_pending`) needs the
 * right to answer them; a spent session budget throws (402, classified by the
 * route). The caller has already checked the session is this agent's, in this project.
 */
export async function checkSessionContinuable(
  request: FastifyRequest,
  reply: FastifyReply,
  dialect: InvocationDialect,
  ctx: ApiTokenContext,
  agent: IAgent,
  conversation: IAgentConversation,
): Promise<boolean> {
  const access = await decideSessionAccess(request, conversation, {
    need: 'continue',
    agent,
    actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
  });
  if (!access.ok) {
    if (dialect === 'openai') sendOpenAiSessionRefusal(reply, request, access);
    else sendClientSessionRefusal(reply, request, access);
    return false;
  }
  const blocking = await pendingActionsBlockingMessage(ctx.tenantDbName, conversation, agent.config);
  if (blocking) {
    fail(reply, dialect, {
      status: 409,
      type: 'pending_action',
      code: 'pending_action',
      message: 'This session is waiting for an approval or an answer. Resolve it before sending a new message.',
      extra: { pending_action_ids: blocking },
    });
    return false;
  }
  const cancelRefusal = await refuseCancelPending(request, { tenantDbName: ctx.tenantDbName, conversation, agent });
  if (cancelRefusal?.unavailable) {
    sendAuthorizationUnavailable(reply, request, 'client', { action: 'agent.approve', level: 'write', decisionId: cancelRefusal.decisionId });
    return false;
  }
  if (cancelRefusal) {
    fail(reply, dialect, {
      status: 403,
      type: 'permission_error',
      message: CANCEL_PENDING_FORBIDDEN_MESSAGE,
      code: 'action_forbidden',
      ...(cancelRefusal.decisionId ? { extra: { decision_id: cancelRefusal.decisionId } } : {}),
    });
    return false;
  }
  assertSessionBudgetAvailable(conversation);
  return true;
}

/**
 * The spend budget of the session a request STARTS (`null` = none, undefined =
 * the agent's default). A request continuing a session never reads the field.
 * An agent whose admin set a budget binds its API clients to it.
 */
export function parseNewSessionBudget(
  reply: FastifyReply,
  dialect: InvocationDialect,
  agent: IAgent,
  value: unknown,
): { budget: IAgentSessionBudget | null | undefined } | null {
  let budget: IAgentSessionBudget | null | undefined;
  if (value === null) budget = null;
  else if (value !== undefined) {
    const parsed = parseSessionBudget(value);
    if (!parsed.ok) return fail(reply, dialect, invalid(parsed.message, 'invalid_budget', 'budget'));
    budget = parsed.budget;
  }
  if (budget !== undefined) {
    const violation = clientBudgetViolation(agent.config, budget);
    if (violation) return fail(reply, dialect, { status: 403, type: 'invalid_request_error', message: violation, code: 'budget_override_forbidden' });
  }
  return { budget };
}

// ── Reasoning, model, limits ─────────────────────────────────────────────

/**
 * `reasoning_effort` / `reasoning: { effort }`: the lowest rung of the
 * reasoning precedence, so a bad value is refused instead of silently ignored.
 */
export function parseInvocationReasoning(
  reply: FastifyReply,
  dialect: InvocationDialect,
  body: Record<string, unknown>,
): { value: ReturnType<typeof parseAgentRequestReasoning>['value'] } | null {
  const parsed = parseAgentRequestReasoning(body);
  if (parsed.error) return fail(reply, dialect, invalid(parsed.error, 'invalid_reasoning', 'reasoning'));
  return { value: parsed.value };
}

/**
 * Which of the agent's models this run uses (`agent_model` / header; the
 * session's sticky model otherwise), decided against the config that will run.
 */
export async function resolveInvocationModel(
  request: FastifyRequest,
  reply: FastifyReply,
  dialect: InvocationDialect,
  ctx: ApiTokenContext,
  input: { target: ResolvedInvocationAgent; body: Record<string, unknown>; conversation: IAgentConversation | null },
): Promise<{ modelChoice?: AgentModelChoice } | null> {
  const { agent, version, usePublished } = input.target;
  const asked = requestedAgentModel(request, input.body);
  if (!asked && !agent.config.additionalModels?.length && !input.conversation?.metadata?.activeModel) return {};
  const runConfig = usePublished || version !== undefined
    ? (await resolveAgentConfig(ctx.tenantDbName, agent.key, ctx.projectId, version)).config
    : agent.config;
  if (!asked && !runConfig.additionalModels?.length) return {};
  try {
    const modelChoice = await resolveRunModelForRequest(request, {
      agent, config: runConfig, projectId: ctx.projectId, requested: asked, conversation: input.conversation,
    });
    return modelChoice ? { modelChoice } : {};
  } catch (error) {
    if (error instanceof AgentModelError) {
      return fail(reply, dialect, { status: error.status, type: 'invalid_request_error', message: error.message, code: error.code, param: 'agent_model' });
    }
    throw error;
  }
}

/** min(env ceiling, tenant quota) for the caller. */
export function resolveInvocationLimits(ctx: ApiTokenContext): Promise<AgentRunLimits> {
  return resolveAgentRunLimits({
    quotaContext: {
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      licenseType: ctx.tenant.licenseType as LicenseType,
      userId: ctx.tokenRecord.userId,
      tokenId: ctx.tokenRecord._id?.toString(),
    },
  });
}

// ── Idempotency, callback, metadata, format, inputs ──────────────────────

/** The `Idempotency-Key` header (every mode keeps its run, so it works on waited calls too). */
export function readIdempotencyKey(
  request: FastifyRequest,
  reply: FastifyReply,
  dialect: InvocationDialect,
): { key?: string } | null {
  const key = getHeaderValue(request, 'idempotency-key');
  if (!key) return {};
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return fail(reply, dialect, invalid(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, 'idempotency_key_too_long'));
  }
  return { key };
}

/** The request's callback, else the agent's own (`config.callback`). Validated now (400), not when it fires. */
export async function resolveInvocationCallback(
  reply: FastifyReply,
  dialect: InvocationDialect,
  agent: IAgent,
  url: unknown,
  secret: unknown,
): Promise<{ url?: string; secret?: string } | null> {
  if (url === undefined && secret === undefined) return agentDefaultCallback(agent.config);
  const requested = await validateCallbackRequest(url, secret);
  if (!requested.ok) return fail(reply, dialect, invalid(requested.message, 'invalid_callback', 'callback'));
  return requested.url ? { url: requested.url, ...(requested.secret ? { secret: requested.secret } : {}) } : agentDefaultCallback(agent.config);
}

export const RUN_METADATA_MAX_KEYS = 16;
export const RUN_METADATA_MAX_KEY_LENGTH = 64;
export const RUN_METADATA_MAX_VALUE_LENGTH = 512;
const RUN_METADATA_KEY_RE = /^[A-Za-z0-9_.-]+$/;

/** Run `metadata`: ≤16 string pairs, keys `[A-Za-z0-9_.-]{1,64}`, values ≤512 characters. */
export function parseRunMetadata(value: unknown): { ok: true; metadata: Record<string, string> | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, metadata: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: 'metadata must be an object of string values' };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > RUN_METADATA_MAX_KEYS) return { ok: false, message: `metadata can hold at most ${RUN_METADATA_MAX_KEYS} keys` };
  for (const [key, entry] of entries) {
    if (key.length > RUN_METADATA_MAX_KEY_LENGTH || !RUN_METADATA_KEY_RE.test(key)) {
      return { ok: false, message: `metadata keys must be 1-${RUN_METADATA_MAX_KEY_LENGTH} characters of A-Z, a-z, 0-9, "_", "." or "-"` };
    }
    if (typeof entry !== 'string') return { ok: false, message: `metadata.${key} must be a string` };
    if (entry.length > RUN_METADATA_MAX_VALUE_LENGTH) {
      return { ok: false, message: `metadata.${key} must be at most ${RUN_METADATA_MAX_VALUE_LENGTH} characters` };
    }
  }
  return { ok: true, metadata: entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : null };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A per-request structured output, in either spelling: chat's
 * `{ type: 'json_schema', json_schema: { name, schema, strict } }` or the
 * Responses `text.format` one (`{ type: 'json_schema', name, schema, strict }`).
 * `{ type: 'text' }` (or nothing) = no structured output. Shape only here; the
 * schema itself is checked where it is converted.
 */
export function parseResponseFormat(value: unknown): { ok: true; format: AgentResponseFormat | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, format: null };
  if (!isPlainObject(value)) return { ok: false, message: 'response_format must be an object' };
  if (value.type === 'text') return { ok: true, format: null };
  if (value.type === 'json_object') return { ok: true, format: { type: 'json_object' } };
  if (value.type !== 'json_schema') return { ok: false, message: 'response_format.type must be "text", "json_object" or "json_schema"' };
  const spec = isPlainObject(value.json_schema) ? value.json_schema : value;
  if (!isPlainObject(spec.schema)) return { ok: false, message: 'response_format json_schema needs a schema object' };
  if (spec.name !== undefined && (typeof spec.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(spec.name))) {
    return { ok: false, message: 'response_format name must be 1-64 characters of A-Z, a-z, 0-9, "_" or "-"' };
  }
  if (spec.strict !== undefined && typeof spec.strict !== 'boolean') return { ok: false, message: 'response_format strict must be a boolean' };
  return {
    ok: true,
    format: {
      type: 'json_schema',
      ...(typeof spec.name === 'string' ? { name: spec.name } : {}),
      schema: spec.schema,
      ...(typeof spec.strict === 'boolean' ? { strict: spec.strict } : {}),
    },
  };
}

export const RUN_INPUTS_MAX_KEYS = 32;
const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** `inputs`: the agent's declared input values, an object of ≤32 named values. Shape only here. */
export function parseRunInputs(value: unknown): { ok: true; inputs: Record<string, unknown> | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, inputs: null };
  if (!isPlainObject(value)) return { ok: false, message: 'inputs must be an object of named values' };
  const keys = Object.keys(value);
  if (keys.length > RUN_INPUTS_MAX_KEYS) return { ok: false, message: `inputs can hold at most ${RUN_INPUTS_MAX_KEYS} values` };
  const bad = keys.find((key) => !INPUT_NAME_RE.test(key));
  if (bad !== undefined) return { ok: false, message: `inputs.${bad} is not a valid input name` };
  return { ok: true, inputs: keys.length > 0 ? value : null };
}

// ── The session the run executes on ──────────────────────────────────────

export interface PreparedInvocationSession {
  conversationId: string;
  conversation: IAgentConversation;
  /** Ids of the session files the message attaches. */
  attachments: string[];
  /** The part of `attachments` the caller named by id (what makes a retry "the same"). */
  namedAttachments: string[];
}

/**
 * Creates the session when the request starts one, remembers the model choice
 * on it (a queued run reads it from there) and stores the request's files as
 * files of the session.
 */
export async function prepareInvocationSession(
  ctx: ApiTokenContext,
  input: {
    agent: IAgent;
    conversation: IAgentConversation | null;
    sessionBudget?: IAgentSessionBudget | null;
    modelChoice?: AgentModelChoice;
    userInput: ResponseUserInput;
  },
): Promise<PreparedInvocationSession> {
  let conversation = input.conversation;
  if (!conversation) {
    conversation = await createConversation(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      ctx.tokenRecord.userId,
      input.agent.key,
      undefined,
      { source: 'api' },
      input.sessionBudget,
    );
  }
  if (input.modelChoice) await rememberSessionModel(ctx.tenantDbName, conversation, input.modelChoice);
  let attachments: string[] = [];
  let namedAttachments: string[] = [];
  if (input.userInput.files.length > 0) {
    const stored = await storeResponseInputFiles({
      files: input.userInput.files,
      scope: { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
      conversation,
      agentConfig: input.agent.config,
      actor: {
        userId: ctx.tokenRecord.userId,
        licenseType: ctx.tenant.licenseType,
        tokenId: ctx.tokenRecord._id?.toString() ?? ctx.token,
      },
    });
    attachments = stored.attachments;
    namedAttachments = stored.named;
  }
  return { conversationId: String(conversation._id), conversation, attachments, namedAttachments };
}

export function invocationApiTokenId(ctx: ApiTokenContext): string | undefined {
  return ctx.tokenRecord._id ? String(ctx.tokenRecord._id) : undefined;
}

/** The caller's runtime context (`runtime_context` + runtime headers); header values stay sealed on the run. */
export function invocationRuntimeContext(request: FastifyRequest, ctx: ApiTokenContext, value: unknown) {
  return buildRuntimeContextFromRequest(value, request.headers, {
    userId: ctx.tokenRecord.userId,
    tokenId: invocationApiTokenId(ctx),
    source: 'api',
  });
}

// ── Replies ──────────────────────────────────────────────────────────────

/** The runs API URL of a run (`Location` of every 202). */
export function agentRunLocation(run: Pick<IAgentRun, '_id'>): string {
  return `/api/client/v1/agents/runs/${publicAgentRunId(run)}`;
}

/** 202 for a run that is still going: the run object, where to follow it, and when to look again. */
export function sendRunAccepted(reply: FastifyReply, run: IAgentRun, body: unknown = serializeAgentRun(run)) {
  return reply
    .code(202)
    .header('Location', agentRunLocation(run))
    .header('Retry-After', '2')
    .send(body);
}
