import {
  cancelAgentRun,
  getAgentRunStatus,
  publicAgentRunId,
  resolveAgentRunLimits,
  startAgentRun,
  type AgentRunLimits,
  type StartAgentRunInput,
  type StartAgentRunOutcome,
} from '@/lib/services/agents/agentRunService';
import { cancelConversationTurn } from '@/lib/services/agents/turnCancellation';
/**
 * Inbound A2A (Agent2Agent) server — exposes Cognipeer agents to external
 * A2A clients over JSON-RPC 2.0 (spec v1.0).
 *
 * Token-authenticated surface (per agent, `cpeer_` API token):
 *   GET  /client/v1/a2a/:agentKey/.well-known/agent-card.json
 *   POST /client/v1/a2a/:agentKey          (message/send, message/stream, tasks/get, tasks/cancel)
 *
 * Exposure is OPT-IN per agent via `agent.metadata.a2a` (see
 * `@/lib/services/agents/a2aExposure`); agents without it respond 404 on
 * every A2A route. Agents with accessMode 'public' are additionally served
 * unauthenticated by the public-a2a plugin, which reuses the shared
 * `handleA2aRpc` / `buildAgentCard` helpers exported here.
 *
 * State model: A2A `contextId` maps 1:1 onto the agent conversation (session).
 * A `message/send` is a run (`startAgentRun`, channel `a2a`) executed inside
 * the call: it returns a `completed` task (or an `input-required` one when the
 * turn paused for an approval or an answer), or a `working` one when the wait
 * window ended first and the run carries on. With `configuration.blocking:
 * false` (token route only) the run is queued and the task comes back
 * `submitted`. `message/stream` runs the same turn and answers with events.
 * A message's parts are text, `file` (inline bytes or an http(s) uri, stored as
 * session files) and `data` (the agent's inputs, or JSON appended to the text). The task id is the run's id
 * (`run_<runId>`), so `tasks/get` reads the run and `tasks/cancel` cancels it.
 * Ids from before (`task_<conversationId>_<messageIndex>`) still resolve
 * against the conversation's messages.
 */

import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';
import { toClientErrorBody, toClientOutputFiles, toClientPendingAction, type ClientOutputFile } from '@/lib/services/agents/clientWire';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IAgent, IAgentInputField, IAgentRun } from '@/lib/database';
import type { AgentChatResponse } from '@/lib/services/agents/agentService';
import { getAgentByKey, getConversationById } from '@/lib/services/agents/agentService';
import { resolveRunInputs, stringifyInputsBlock } from '@/lib/services/agents/agentInputs';
import { AgentAttachmentError } from '@/lib/services/agents/agentErrors';
import { assertQueuedTurnSpendAllowed } from '@/lib/services/agents/agentSpendLimits';
import {
  extractResponseUserInput,
  InputContentPartError,
  storeResponseInputFiles,
  type ResponseInputFile,
} from '@/lib/services/agents/responseInputFiles';
import { attachmentsUnavailableMessage } from '@/lib/services/agents/sessionFiles';
import { attachmentsAvailability } from '@/lib/services/agents/sessionFilesConfig';
import { isA2aEnabled } from '@/lib/services/agents/a2aExposure';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';
import { resolveConversation } from './agent-openai-bridge';
import { resolveInvocationLimits, resolvePublishedAgentConfig } from './agent-invocation';
import { openSseConnection, type SseConnection } from './sse-connection';
import { authorizeEndingOpenRequests, CANCEL_PENDING_FORBIDDEN_MESSAGE, refuseCancelPending } from './agent-approval-authz';

const logger = createLogger('api:client-a2a');

const A2A_PROTOCOL_VERSION = '1.0';
const JSONRPC_VERSION = '2.0';

// A2A-specific JSON-RPC error codes (spec §8).
const ERR_TASK_NOT_FOUND = -32001;
const ERR_UNSUPPORTED_OPERATION = -32004;
// Not one of the spec's: a caller the policy engine does not let answer the request this call would end.
const ERR_FORBIDDEN = -32010;
/** The policy engine could not decide: try again (the JSON-RPC "internal error" code; nothing was refused on merit). */
const ERR_AUTHORIZATION_UNAVAILABLE = -32603;

interface A2aPart {
  kind?: string;
  text?: string;
  data?: unknown;
  /** A `file` part: its content inline (`bytes`, base64) or by reference (`uri`). */
  file?: { bytes?: string; uri?: string; name?: string; mimeType?: string };
}

interface A2aIncomingMessage {
  role?: string;
  parts?: A2aPart[];
  messageId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/** Tenant/caller identity an A2A call executes under (token or public). */
export interface A2aCallContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** Attribution identity: the token's user, or a sentinel for public calls. */
  userId: string;
  tokenId?: string;
  /** The tenant's license type (file quotas are counted by it). */
  licenseType?: string;
  /** `configuration.blocking: false` may queue the run and answer at once (the authenticated surface only). */
  allowNonBlocking?: boolean;
  /** The caller's run limits (its wait window included); the env ceilings otherwise. */
  limits?: AgentRunLimits;
}

/**
 * Whether an existing conversation may be read (`tasks/get`) or continued
 * (`message/send` with a contextId) by this caller. Agent + project is not
 * enough: on the PUBLIC surface anyone holding the endpoint is a caller, and a
 * contextId / task id is just a conversation id — so without the creator check
 * an anonymous caller could read, or append to, conversations other callers
 * (dashboard, API tokens) had with the same agent. Public calls share the
 * `a2a-public` identity, so they only ever reach public-created conversations.
 */
function conversationVisibleTo(
  conversation: { agentKey?: string; projectId?: string; createdBy?: string } | null | undefined,
  agent: Pick<IAgent, 'key'>,
  ctx: A2aCallContext,
): boolean {
  return Boolean(
    conversation
    && conversation.agentKey === agent.key
    && conversation.projectId === ctx.projectId
    && conversation.createdBy === ctx.userId,
  );
}

function jsonRpcOk(id: string | number | null, result: unknown) {
  return { id, jsonrpc: JSONRPC_VERSION, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: Record<string, unknown>) {
  return { error: { code, message, ...(data ? { data } : {}) }, id, jsonrpc: JSONRPC_VERSION };
}

function extractText(parts: A2aPart[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && (p.kind === 'text' || p.kind === undefined) && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `data` parts of a message. A part whose keys are all inputs the agent
 * declares carries those inputs (validated like any request's); any other data
 * is appended to the text as a JSON block, so the agent still reads it.
 */
export function splitA2aDataParts(
  parts: A2aPart[] | undefined,
  declared: ReadonlyArray<IAgentInputField> | undefined,
): { inputs: Record<string, unknown>; other: Record<string, unknown>[] } {
  const names = new Set((declared ?? []).map((field) => field.name));
  const inputs: Record<string, unknown> = {};
  const other: Record<string, unknown>[] = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || part.kind !== 'data' || !isPlainObject(part.data)) continue;
    const keys = Object.keys(part.data);
    if (keys.length > 0 && names.size > 0 && keys.every((key) => names.has(key))) Object.assign(inputs, part.data);
    else if (keys.length > 0) other.push(part.data);
  }
  return { inputs, other };
}

/** Data that is not an input, as the block appended to the message text. */
function appendA2aData(text: string, other: Record<string, unknown>[]): string {
  if (other.length === 0) return text;
  const blocks = other.map((data) => `Data:\n\`\`\`json\n${stringifyInputsBlock(data)}\n\`\`\``);
  return [text, ...blocks].filter((part) => part.length > 0).join('\n\n');
}

/** The data artifact of a structured answer (`output_parsed`): the parsed object, as an A2A `data` part. */
function structuredArtifact(taskIdValue: string, parsed: unknown): Array<Record<string, unknown>> {
  if (!isPlainObject(parsed)) return [];
  return [{ artifactId: `${taskIdValue}_data`, name: 'output', parts: [{ kind: 'data', data: parsed }] }];
}

/** A task id of the run scheme (`run_<runId>`). */
function isRunTaskId(id: string): boolean {
  return /^run_[A-Za-z0-9-]+$/.test(id);
}

function answerTextOf(result: Pick<AgentChatResponse, 'output'> | null | undefined): string {
  return (result?.output ?? [])
    .filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
    .flatMap((item) => item.content.map((c) => c.text))
    .join('');
}

/** A finished (or paused) turn's answer as its task. */
function taskFromResponse(id: string, contextId: string, result: AgentChatResponse, baseUrl: string): Record<string, unknown> {
  const assistantText = answerTextOf(result);
  if (result.status === 'requires_action') {
    return inputRequiredTask(id, contextId, assistantText, result.required_action?.actions ?? []);
  }
  return completedTask(
    id,
    contextId,
    assistantText,
    result.stop_reason && result.stop_reason !== 'completed'
      ? { reason: result.stop_reason, ...(result.stop_detail ? { detail: result.stop_detail } : {}) }
      : undefined,
    a2aFileArtifacts(id, result.output_files ?? [], baseUrl),
    { parsed: result.output_parsed, error: result.output_error },
  );
}

/** A task with no answer yet (or none at all): just its state. */
function stateTask(id: string, contextId: string, state: string, text?: string): Record<string, unknown> {
  return {
    kind: 'task',
    id,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(text ? { message: { kind: 'message', role: 'agent', messageId: `${id}_status`, parts: [{ kind: 'text', text }] } } : {}),
    },
  };
}

/** The task a run is, in A2A states: submitted (waiting), working, input-required, completed, failed, canceled. */
function taskFromRun(run: IAgentRun, baseUrl: string): Record<string, unknown> {
  const id = publicAgentRunId(run);
  const result = run.result as unknown as AgentChatResponse | null | undefined;
  switch (run.status) {
    case 'scheduled':
    case 'queued':
      return stateTask(id, run.conversationId, 'submitted');
    case 'running':
      return stateTask(id, run.conversationId, 'working');
    case 'requires_action':
      return inputRequiredTask(id, run.conversationId, answerTextOf(result), result?.required_action?.actions ?? []);
    case 'succeeded':
      return result ? taskFromResponse(id, run.conversationId, result, baseUrl) : completedTask(id, run.conversationId, '');
    case 'canceled':
      return stateTask(id, run.conversationId, 'canceled');
    default:
      return stateTask(id, run.conversationId, 'failed', run.errorMessage ?? 'The run failed.');
  }
}

function parseTaskId(id: string): { conversationId: string; messageIndex: number } | null {
  const match = /^task_(.+)_(\d+)$/.exec(id);
  if (!match) return null;
  return { conversationId: match[1], messageIndex: Number(match[2]) };
}

/** One A2A `file` part per output file; `uri` is the absolute session file content route (fetch it with the same credentials). */
export function a2aFileArtifacts(taskIdValue: string, files: ReadonlyArray<ClientOutputFile>, baseUrl: string) {
  return files.map((file, i) => ({
    artifactId: `${taskIdValue}_file_${i + 1}`,
    name: file.name,
    parts: [{ kind: 'file', file: { name: file.name, mimeType: file.mime_type, uri: `${baseUrl}${file.download_url}` } }],
    metadata: { fileId: file.id, size: file.size },
  }));
}

function completedTask(
  id: string,
  contextId: string,
  assistantText: string,
  /** Why the run ended without a final answer (a run limit, a cancellation). */
  stop?: { reason: string; detail?: string },
  /** Files the agent produced this turn, as extra artifacts. */
  fileArtifacts: ReadonlyArray<Record<string, unknown>> = [],
  /** The structured answer (a `data` artifact), or why the contract failed (`metadata.outputError`). */
  structured: { parsed?: unknown; error?: string } = {},
): Record<string, unknown> {
  const metadata = {
    ...(stop ? { stopReason: stop.reason, ...(stop.detail ? { stopDetail: stop.detail } : {}) } : {}),
    ...(structured.error ? { outputError: structured.error } : {}),
  };
  return {
    kind: 'task',
    id,
    contextId,
    status: {
      // A2A has no "truncated" state; the task is still terminal. The reason
      // goes in the status message and in metadata, where a client can act on it.
      state: 'completed',
      timestamp: new Date().toISOString(),
      ...(stop
        ? {
          message: {
            kind: 'message',
            role: 'agent',
            messageId: `${id}_status`,
            parts: [{ kind: 'text', text: `Run stopped early: ${stop.detail ?? stop.reason}` }],
          },
        }
        : {}),
    },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    artifacts: [
      {
        artifactId: `${id}_artifact`,
        name: 'response',
        parts: [{ kind: 'text', text: assistantText }],
      },
      ...structuredArtifact(id, structured.parsed),
      ...fileArtifacts,
    ],
  };
}

/**
 * A task paused for an approval or a question: A2A's `input-required`. The
 * actions to resolve ride in `metadata.pendingActions` (resolve them through
 * the session actions endpoint; the task then continues). The actions are
 * spelled as the rest of the client API does (`tool_name`, `allow_free_text`);
 * the A2A envelope keeps the protocol's own camelCase.
 */
function inputRequiredTask(
    id: string,
    contextId: string,
    assistantText: string,
    pendingActions: unknown[],
): Record<string, unknown> {
    return {
        kind: 'task',
        id,
        contextId,
        status: {
            state: 'input-required',
            timestamp: new Date().toISOString(),
            message: {
                kind: 'message',
                role: 'agent',
                messageId: `${id}_status`,
                parts: [{ kind: 'text', text: assistantText || 'Waiting for an approval or an answer.' }],
            },
        },
        metadata: { stopReason: 'requires_action', pendingActions },
        artifacts: assistantText
            ? [{ artifactId: `${id}_artifact`, name: 'response', parts: [{ kind: 'text', text: assistantText }] }]
            : [],
    };
}

export function externalBaseUrl(request: FastifyRequest): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProto === 'string' && forwardedProto.length > 0
    ? forwardedProto
    : 'http';
  const host = typeof request.headers.host === 'string' && request.headers.host.length > 0
    ? request.headers.host
    : 'localhost';
  return `${protocol}://${host}`;
}

export function buildAgentCard(
  agent: IAgent,
  endpoint: string,
  options: { publicAccess?: boolean } = {},
): Record<string, unknown> {
  const toolTags = (agent.config.toolBindings ?? []).flatMap((b) => b.toolNames).slice(0, 20);
  // Text, and JSON (a `data` part: the agent's inputs; a structured answer); files too once the agent takes attachments.
  const attachments = attachmentsAvailability(agent.config);
  const fileTypes = attachments.available ? (attachments.cfg.allowedMimeTypes.length > 0 ? attachments.cfg.allowedMimeTypes : ['*/*']) : [];
  const inputModes = [...new Set(['text/plain', 'application/json', ...fileTypes])];
  const outputModes = ['text/plain', 'application/json'];

  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: agent.name,
    description: agent.description || `Cognipeer agent "${agent.name}"`,
    url: endpoint,
    preferredTransport: 'JSONRPC',
    provider: { organization: 'Cognipeer', url: 'https://cognipeer.com' },
    version: agent.publishedVersion ? String(agent.publishedVersion) : '0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills: [
      {
        id: 'chat',
        name: `Chat with ${agent.name}`,
        description: agent.description || `Conversational access to the "${agent.name}" agent.`,
        tags: ['chat', ...toolTags],
        inputModes,
        outputModes,
      },
    ],
    ...(options.publicAccess
      ? { securitySchemes: {}, security: [] }
      : {
          securitySchemes: {
            bearer: {
              type: 'http',
              scheme: 'bearer',
              description: 'Cognipeer API token (cpeer_…)',
            },
          },
          security: [{ bearer: [] }],
        }),
  };
}

/** The files of a message's `file` parts (`bytes` base64 or an http(s) `uri`), as the shared input files; text and data parts are read elsewhere. */
function a2aInputFiles(parts: A2aPart[] | undefined): ResponseInputFile[] {
  const content = (Array.isArray(parts) ? parts : []).flatMap((part): Array<Record<string, unknown>> => {
    if (!part || part.kind !== 'file' || !isPlainObject(part.file)) return [];
    const { bytes, uri, name, mimeType } = part.file;
    const filename = typeof name === 'string' && name ? { filename: name } : {};
    if (typeof bytes === 'string' && bytes) {
      return [{ type: 'input_file', file_data: typeof mimeType === 'string' && mimeType ? `data:${mimeType};base64,${bytes}` : bytes, ...filename }];
    }
    if (typeof uri === 'string' && uri) return [{ type: 'input_file', file_url: uri, ...filename }];
    return [];
  });
  // The shared reader checks the shapes (an http(s) uri) and the file count.
  return content.length > 0 ? extractResponseUserInput([{ role: 'user', content }]).files : [];
}

type A2aTurn =
  | { failure: ReturnType<typeof jsonRpcError> }
  | { base: Omit<StartAgentRunInput, 'execution'>; limits: AgentRunLimits };

/**
 * Everything a `message/send` / `message/stream` needs before its run starts:
 * the declared inputs, the text, the files stored on the session, the session
 * itself (contextId), the cancel_pending check, the runtime context. A failure
 * is the JSON-RPC error to answer with.
 */
async function prepareA2aTurn(
  ctx: A2aCallContext,
  agent: IAgent,
  request: FastifyRequest,
  params: Record<string, unknown> | undefined,
  rpcId: string | number | null,
  /** The run is queued rather than waited on (`blocking: false`). */
  queued: boolean,
): Promise<A2aTurn> {
  const fail = (code: number, message: string, data?: Record<string, unknown>): A2aTurn => ({ failure: jsonRpcError(rpcId, code, message, data) });
  const message = (params?.message ?? {}) as A2aIncomingMessage;
  // The config this call runs (published), for the agent's declared inputs and file limits.
  const runConfig = await resolvePublishedAgentConfig(ctx.tenantDbName, agent, ctx.projectId);
  const data = splitA2aDataParts(message.parts, runConfig.inputs);
  const resolvedInputs = resolveRunInputs(runConfig.inputs, Object.keys(data.inputs).length > 0 ? data.inputs : null);
  if (!resolvedInputs.ok) {
    return fail(-32602, 'Invalid params: invalid inputs', { type: 'invalid_request_error', code: 'invalid_inputs', errors: resolvedInputs.errors });
  }
  let files: ResponseInputFile[];
  try {
    files = a2aInputFiles(message.parts);
  } catch (error) {
    if (error instanceof InputContentPartError) return fail(-32602, `Invalid params: ${error.message}`, { type: 'invalid_request_error', code: error.code });
    throw error;
  }
  const availability = attachmentsAvailability(runConfig);
  if (files.length > 0 && !availability.available) {
    return fail(-32602, `Invalid params: ${attachmentsUnavailableMessage(availability.reason)}`, { type: 'invalid_request_error', code: 'attachments_disabled' });
  }
  const userMessage = appendA2aData(extractText(message.parts), data.other);
  if (!userMessage.trim() && !resolvedInputs.inputs && files.length === 0) {
    return fail(-32602, 'Invalid params: message.parts must contain text');
  }

  // contextId ↔ conversationId: reuse the Responses API conversation
  // store, scoped on agent AND project like every other agent surface.
  const contextId = typeof message.contextId === 'string' && message.contextId ? message.contextId : undefined;
  if (contextId && !conversationVisibleTo(await getConversationById(ctx.tenantDbName, contextId), agent, ctx)) {
    return fail(-32602, 'Invalid params: unknown contextId');
  }
  // A queued turn learns of an exhausted spend limit now, before a session is created for it.
  if (queued) {
    await assertQueuedTurnSpendAllowed({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, agentKey: agent.key, userId: ctx.userId });
  }
  const resolved = await resolveConversation(contextId, agent, ctx, 'a2a');
  if ('error' in resolved) return fail(-32602, 'Invalid params: unknown contextId');
  const { conversationId } = resolved;

  // A new message to a task that waits on a request, under `cancel_pending`, cancels that request. Over the
  // token route the caller is a principal the engine can be asked about (the public route's callers are
  // the conversation's creator by construction - `conversationVisibleTo` - and have no principal).
  if (contextId && request.apiTokenContext) {
    const refusal = await refuseCancelPending(request, {
      tenantDbName: ctx.tenantDbName,
      conversation: await getConversationById(ctx.tenantDbName, contextId),
      agent,
    });
    if (refusal?.unavailable) {
      return fail(ERR_AUTHORIZATION_UNAVAILABLE, 'Authorization is temporarily unavailable', {
        ...(refusal.decisionId ? { decision_id: refusal.decisionId } : {}),
      });
    }
    if (refusal) {
      return fail(ERR_FORBIDDEN, CANCEL_PENDING_FORBIDDEN_MESSAGE, {
        ...(refusal.decisionId ? { decision_id: refusal.decisionId } : {}),
      });
    }
  }

  let attachments: string[] = [];
  if (files.length > 0) {
    try {
      ({ attachments } = await storeResponseInputFiles({
        files,
        scope: { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        conversation: { _id: conversationId, agentKey: agent.key },
        agentConfig: runConfig,
        actor: { userId: ctx.userId, licenseType: ctx.licenseType ?? '', ...(ctx.tokenId ? { tokenId: ctx.tokenId } : {}) },
      }));
    } catch (error) {
      if (error instanceof AgentAttachmentError) {
        return fail(error.status === 429 ? ERR_AUTHORIZATION_UNAVAILABLE : -32602, `Invalid params: ${error.message}`, { type: 'invalid_request_error', code: error.code });
      }
      throw error;
    }
  }

  const runtimeContext = buildRuntimeContextFromRequest(
    message.metadata?.runtime_context,
    request.headers,
    {
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      source: 'a2a',
    },
  );
  const limits = ctx.limits ?? await resolveAgentRunLimits();
  return {
    limits,
    base: {
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      agentKey: agent.key,
      conversationId,
      userMessage,
      ...(attachments.length > 0 ? { attachments } : {}),
      userId: ctx.userId,
      ...(ctx.tokenId ? { apiTokenId: ctx.tokenId, actorType: 'api_token' as const } : {}),
      usePublished: true,
      runtimeContext,
      ...(resolvedInputs.inputs ? { inputs: resolvedInputs.inputs } : {}),
      channel: 'a2a',
      trigger: 'request',
      limits,
    },
  };
}

/** The JSON-RPC error of a start the engine refused, or null for a run. */
function runRefusalRpc(rpcId: string | number | null, outcome: StartAgentRunOutcome): ReturnType<typeof jsonRpcError> | null {
  switch (outcome.kind) {
    case 'conflict':
      return jsonRpcError(rpcId, -32603, 'An active run (queued or running) already exists for this conversation.', {
        type: 'agent_run_conflict', code: 'agent_run_conflict',
      });
    case 'concurrency_limit':
      return jsonRpcError(rpcId, -32603, 'Too many agent runs are queued or running; retry later.', {
        type: 'rate_limit_error', code: 'agent_run_concurrency_limit', class: outcome.runClass, scope: outcome.scope, limit: outcome.limit,
      });
    case 'idempotency_conflict':
      return jsonRpcError(rpcId, -32603, 'Idempotency conflict', { type: 'idempotency_key_conflict' });
    default:
      return null;
  }
}

/**
 * `message/stream`: the turn as server-sent events, one JSON-RPC response per
 * event. The Task opens it (`submitted`), then a `working` status event, then
 * the answer's text as artifact chunks while the model writes it (the first
 * creates the artifact, the rest append, an empty last one closes it), the
 * files and the structured answer as artifacts, and a final status event
 * (`completed`, `input-required`, `failed` or `canceled`). The stream opens
 * once the run has started: a refusal before that (409 / 429) is a plain
 * JSON-RPC error. The client going away cancels the run, as on the other
 * streams here. (A2A leaves a dropped stream running so it can be resumed with
 * `tasks/resubscribe`, which this server does not offer; the Task id is the
 * first event, so `tasks/get` and `tasks/cancel` work from the start.)
 */
async function streamA2aTurn(
  reply: FastifyReply,
  rpcId: string | number | null,
  base: Omit<StartAgentRunInput, 'execution'>,
  baseUrl: string,
): Promise<FastifyReply> {
  const contextId = base.conversationId;
  const disconnected = new AbortController();
  const sse: { connection: SseConnection | null } = { connection: null };
  let taskId = '';
  let streamed = false;
  const textArtifactId = () => `${taskId}_artifact`;
  const emit = (result: Record<string, unknown>) => sse.connection?.write(`data: ${JSON.stringify(jsonRpcOk(rpcId, result))}\n\n`);
  const statusEvent = (status: Record<string, unknown>, final: boolean, metadata?: unknown) => emit({
    kind: 'status-update', taskId, contextId, status, final, ...(metadata ? { metadata } : {}),
  });
  const artifactEvent = (artifact: Record<string, unknown>, append: boolean, lastChunk: boolean) => emit({
    kind: 'artifact-update', taskId, contextId, artifact, append, lastChunk,
  });
  /** A Task as its closing events: its artifacts, then its status as the final event. */
  const finish = (task: Record<string, unknown>) => {
    if (streamed) artifactEvent({ artifactId: textArtifactId(), name: 'response', parts: [{ kind: 'text', text: '' }] }, true, true);
    for (const artifact of (task.artifacts ?? []) as Array<Record<string, unknown>>) {
      if (streamed && artifact.artifactId === textArtifactId()) continue;
      artifactEvent(artifact, false, true);
    }
    statusEvent(task.status as Record<string, unknown>, true, task.metadata);
  };

  try {
    const outcome = await startAgentRun({
      ...base,
      execution: {
        kind: 'inline',
        waitMs: 0,
        stream: {
          onTextChunk: (text) => {
            if (!text) return;
            artifactEvent({ artifactId: textArtifactId(), name: 'response', parts: [{ kind: 'text', text }] }, streamed, false);
            streamed = true;
          },
        },
        signal: disconnected.signal,
        cancelOnDisconnect: true,
        onStarted: (run) => {
          taskId = publicAgentRunId(run);
          sse.connection = openSseConnection(reply);
          sse.connection.signal.addEventListener('abort', () => disconnected.abort(), { once: true });
          emit(stateTask(taskId, contextId, 'submitted'));
          statusEvent({ state: 'working', timestamp: new Date().toISOString() }, false);
        },
      },
    });
    const refusal = runRefusalRpc(rpcId, outcome);
    if (refusal) return await reply.code(200).send(refusal);
    if (outcome.kind === 'completed') {
      finish(outcome.run.status === 'canceled'
        ? stateTask(taskId, contextId, 'canceled')
        : taskFromResponse(taskId, contextId, outcome.response, baseUrl));
    } else if ('run' in outcome) {
      finish(taskFromRun(outcome.run, baseUrl));
    }
  } catch (error) {
    // Before the stream opened this is the call's error like any other; after, the run ended in failure.
    if (!sse.connection) throw error;
    const classified = logAgentRouteError(logger, 'A2A stream error', error);
    statusEvent({
      state: 'failed',
      timestamp: new Date().toISOString(),
      message: { kind: 'message', role: 'agent', messageId: `${taskId}_status`, parts: [{ kind: 'text', text: classified.error.message }] },
    }, true, { errorType: classified.error.type, ...(classified.error.code ? { errorCode: classified.error.code } : {}) });
  } finally {
    sse.connection?.end();
  }
  return reply;
}

/**
 * Shared JSON-RPC dispatcher for the token and public A2A surfaces. The
 * caller has already resolved + authorized the agent; this only executes
 * the protocol methods under the supplied call context.
 */
export async function handleA2aRpc(
  ctx: A2aCallContext,
  agent: IAgent,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  let rpcId: string | number | null = null;
  try {
    let body: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      body = readJsonBody(request);
    } catch {
      return reply.code(200).send(jsonRpcError(null, -32700, 'Parse error'));
    }
    rpcId = body.id ?? null;
    const method = body.method;

    if (method === 'message/send' || method === 'message/stream') {
      const streaming = method === 'message/stream';
      // Only the authenticated surface may leave early (`blocking: false`): a public caller always waits
      // for the answer, or for the window to end (a `working` task then).
      const configuration = isPlainObject(body.params?.configuration) ? body.params.configuration : {};
      const queued = !streaming && ctx.allowNonBlocking === true && configuration.blocking === false;
      const prepared = await prepareA2aTurn(ctx, agent, request, body.params, rpcId, queued);
      if ('failure' in prepared) return reply.code(200).send(prepared.failure);
      const baseUrl = externalBaseUrl(request);
      if (streaming) return await streamA2aTurn(reply, rpcId, prepared.base, baseUrl);

      const outcome = await startAgentRun({
        ...prepared.base,
        // Past the window the run carries on and the caller gets a `working` task to poll with tasks/get.
        execution: queued ? { kind: 'queued' } : { kind: 'inline', waitMs: prepared.limits.syncWaitMs, cancelOnDisconnect: false },
      });
      const refusal = runRefusalRpc(rpcId, outcome);
      if (refusal) return reply.code(200).send(refusal);
      if (outcome.kind === 'completed') {
        return reply.code(200).send(jsonRpcOk(
          rpcId,
          taskFromResponse(publicAgentRunId(outcome.run), prepared.base.conversationId, outcome.response, baseUrl),
        ));
      }
      // `detached` (the window ended first), `accepted` (queued): the run as it stands.
      if (!('run' in outcome)) throw new Error(`Unexpected start outcome: ${outcome.kind}`);
      return reply.code(200).send(jsonRpcOk(rpcId, taskFromRun(outcome.run, baseUrl)));
    }

    if (method === 'tasks/get') {
      const requestedId = typeof body.params?.id === 'string' ? body.params.id : '';
      if (isRunTaskId(requestedId)) {
        const run = await loadTaskRun(ctx, agent, requestedId);
        if (!run) return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
        return reply.code(200).send(jsonRpcOk(rpcId, taskFromRun(run, externalBaseUrl(request))));
      }
      const parsed = requestedId ? parseTaskId(requestedId) : null;
      if (!parsed) {
        return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
      }
      const conversation = await getConversationById(ctx.tenantDbName, parsed.conversationId);
      const message = conversationVisibleTo(conversation, agent, ctx)
        ? conversation?.messages?.[parsed.messageIndex]
        : undefined;
      if (!message || message.role !== 'assistant') {
        return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
      }
      if (message.pendingActions?.some((action) => action.status === 'pending')) {
        return reply.code(200).send(jsonRpcOk(
          rpcId,
          inputRequiredTask(requestedId, parsed.conversationId, message.content, message.pendingActions.map(toClientPendingAction)),
        ));
      }
      return reply.code(200).send(jsonRpcOk(
        rpcId,
        completedTask(
          requestedId,
          parsed.conversationId,
          message.content,
          message.stopReason ? { reason: message.stopReason, ...(message.stopDetail ? { detail: message.stopDetail } : {}) } : undefined,
          a2aFileArtifacts(requestedId, toClientOutputFiles(parsed.conversationId, message.attachments), externalBaseUrl(request)),
          { parsed: message.output, error: message.outputError },
        ),
      ));
    }

    if (method === 'tasks/cancel') {
      // A turn runs inside a `message/send` call, but another request can still stop it: the turn
      // holds the conversation's run slot, which every node reads. A task that waits on a person
      // (`input-required`) is cancelled with it — its open approvals and questions end as cancelled.
      const requestedId = typeof body.params?.id === 'string' ? body.params.id : '';
      if (isRunTaskId(requestedId)) {
        const run = await loadTaskRun(ctx, agent, requestedId);
        if (!run) return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
        if (run.status === 'requires_action' && request.apiTokenContext) {
          // Ending a task that waits on a request is answering it with "no": the engine says whether this caller may.
          const conversation = await getConversationById(ctx.tenantDbName, run.conversationId);
          if (conversation) {
            const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: ctx.tenantDbName, conversation, agent });
            if (!verdict.allowed && verdict.unavailable) {
              return reply.code(200).send(jsonRpcError(rpcId, ERR_AUTHORIZATION_UNAVAILABLE, 'Authorization is temporarily unavailable', {
                ...(verdict.decisionId ? { decision_id: verdict.decisionId } : {}),
              }));
            }
            if (!verdict.allowed) {
              return reply.code(200).send(jsonRpcError(rpcId, ERR_FORBIDDEN, 'You are not allowed to answer the request this task waits on.', {
                ...(verdict.decisionId ? { decision_id: verdict.decisionId } : {}),
              }));
            }
          }
        }
        const outcome = await cancelAgentRun({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, runId: requestedId });
        if (outcome.kind === 'not_found') return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
        if (outcome.kind === 'already_terminal') {
          return reply.code(200).send(jsonRpcError(rpcId, ERR_UNSUPPORTED_OPERATION, 'The task cannot be canceled: it is not running'));
        }
        // A running turn stops at its next checkpoint; the task is canceled from here on.
        return reply.code(200).send(jsonRpcOk(rpcId, stateTask(requestedId, run.conversationId, 'canceled')));
      }
      const parsed = requestedId ? parseTaskId(requestedId) : null;
      if (!parsed) {
        // Not an id this server hands out: nothing to look up, and nothing that could be canceled.
        return reply.code(200).send(jsonRpcError(rpcId, ERR_UNSUPPORTED_OPERATION, 'The task cannot be canceled: it is not running'));
      }
      const conversation = await getConversationById(ctx.tenantDbName, parsed.conversationId);
      if (!conversationVisibleTo(conversation, agent, ctx)) {
        return reply.code(200).send(jsonRpcError(rpcId, -32001, 'Task not found'));
      }
      const message = conversation?.messages?.[parsed.messageIndex];
      const waitingOn = message?.role === 'assistant'
        ? (message.pendingActions ?? []).filter((action) => action.status === 'pending').map((action) => action.id)
        : [];
      if (waitingOn.length > 0) {
        // Ending a task that waits on a request is answering it with "no": the engine says whether this caller may.
        if (conversation && request.apiTokenContext) {
          const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: ctx.tenantDbName, conversation, agent });
          if (!verdict.allowed && verdict.unavailable) {
            return reply.code(200).send(jsonRpcError(rpcId, ERR_AUTHORIZATION_UNAVAILABLE, 'Authorization is temporarily unavailable', {
              pending_action_ids: waitingOn,
              ...(verdict.decisionId ? { decision_id: verdict.decisionId } : {}),
            }));
          }
          if (!verdict.allowed) {
            return reply.code(200).send(jsonRpcError(rpcId, ERR_FORBIDDEN, 'You are not allowed to answer the request this task waits on.', {
              pending_action_ids: waitingOn,
              ...(verdict.decisionId ? { decision_id: verdict.decisionId } : {}),
            }));
          }
        }
      }
      const outcome = await cancelConversationTurn({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        conversationId: parsed.conversationId,
        agentKey: agent.key,
      });
      if (!outcome.cancelled) {
        if (waitingOn.length > 0) {
          return reply.code(200).send(jsonRpcError(
            rpcId,
            ERR_UNSUPPORTED_OPERATION,
            'The task is waiting for an approval or an answer, so there is no running turn to stop; answer the open requests (or reject them) through the actions endpoint to end the wait.',
            { pending_action_ids: waitingOn },
          ));
        }
        return reply.code(200).send(
          jsonRpcError(rpcId, ERR_UNSUPPORTED_OPERATION, 'The task cannot be canceled: it is not running'),
        );
      }
      return reply.code(200).send(jsonRpcOk(rpcId, {
        kind: 'task',
        id: requestedId,
        contextId: parsed.conversationId,
        status: { state: 'canceled', timestamp: new Date().toISOString() },
      }));
    }

    return reply.code(200).send(jsonRpcError(rpcId, -32601, `Method not found: ${method}`));
  } catch (error) {
    const classified = logAgentRouteError(logger, 'A2A request error', error);
    // What the caller needs to act on it rides along, spelled as the rest of the client API does
    // (`pending_action_ids` to answer, `spent_usd` / `max_cost_usd` of a spent budget).
    const { message: _message, type: _type, code: _code, ...extra } = toClientErrorBody(classified.error);
    void _message; void _type; void _code;
    return reply.code(200).send(jsonRpcError(rpcId, -32603, classified.error.message, {
      type: classified.error.type,
      ...(classified.error.code ? { code: classified.error.code } : {}),
      ...extra,
    }));
  }
}

/** The run a `run_<id>` task names, when this caller may see it (this agent, this project, a conversation it started). */
async function loadTaskRun(ctx: A2aCallContext, agent: IAgent, taskIdValue: string): Promise<IAgentRun | null> {
  const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, taskIdValue);
  if (!run || run.mode === 'sync' || run.agentKey !== agent.key) return null;
  const conversation = await getConversationById(ctx.tenantDbName, run.conversationId).catch(() => null);
  return conversationVisibleTo(conversation, agent, ctx) ? run : null;
}

async function loadExposedAgent(
  ctx: ApiTokenContext,
  agentKey: string,
  reply: FastifyReply,
): Promise<IAgent | null> {
  const agent = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
  if (!agent || !isA2aEnabled(agent)) {
    // Same response for missing and unexposed agents — don't leak existence.
    void reply.code(404).send({ error: 'Agent not found' });
    return null;
  }
  if (agent.status !== 'active') {
    void reply.code(400).send({ error: 'Agent is not active' });
    return null;
  }
  return agent;
}

export const clientA2aApiPlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/client/v1/a2a/:agentKey/.well-known/agent-card.json',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const { agentKey } = request.params as { agentKey: string };
        const agent = await loadExposedAgent(ctx, agentKey, reply);
        if (!agent) return reply;

        const endpoint = `${externalBaseUrl(request)}/api/client/v1/a2a/${agent.key}`;
        return reply.code(200).send(buildAgentCard(agent, endpoint));
      } catch (error) {
        logger.error('A2A agent card error', { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }),
  );

  app.post('/client/v1/a2a/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };

      const agent = await loadExposedAgent(ctx, agentKey, reply);
      if (!agent) return reply;

      return await handleA2aRpc(
        {
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          userId: ctx.tokenRecord.userId,
          tokenId: ctx.tokenRecord._id ? String(ctx.tokenRecord._id) : undefined,
          licenseType: ctx.tenant.licenseType,
          allowNonBlocking: true,
          limits: await resolveInvocationLimits(ctx),
        },
        agent,
        request,
        reply,
      );
    } catch (error) {
      logger.error('A2A request error', { error });
      return reply.code(200).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));
};
