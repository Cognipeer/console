import crypto from 'node:crypto';
import {
  cancelAgentRun,
  getAgentRunStatus,
  isAgentRunActive,
  publicAgentRunId,
  resolveAgentRunLimits,
  runWithTenantDb,
  waitForAgentRun,
  type AgentRunLimits,
  type StartAgentRunInput,
  type StartAgentRunOutcome,
} from '@/lib/services/agents/agentRunService';
import { cancelConversationTurn } from '@/lib/services/agents/turnCancellation';
import { followSessionEvents } from '@/lib/services/agents/sessionEvents';
/**
 * Inbound A2A (Agent2Agent) server — exposes Cognipeer agents to external
 * A2A clients over JSON-RPC 2.0 (spec v1.0).
 *
 * Token-authenticated surface (per agent, `cpeer_` API token):
 *   GET  /client/v1/a2a/:agentKey/.well-known/agent-card.json
 *   POST /client/v1/a2a/:agentKey          (message/send, message/stream, tasks/get, tasks/resubscribe, tasks/cancel)
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
 * `submitted`. `message/stream` runs the same turn and answers with events;
 * a client that goes away leaves the run going, and `tasks/resubscribe`
 * reattaches to it (or to any task the caller may read).
 * A message's parts are text, `file` (inline bytes or an http(s) uri, stored as
 * session files) and `data` (the agent's variables, or JSON appended to the text). The task id is the run's id
 * (`run_<runId>`), so `tasks/get` reads the run and `tasks/cancel` cancels it.
 * Ids from before (`task_<conversationId>_<messageIndex>`) still resolve
 * against the conversation's messages.
 *
 * On the public route every anonymous caller shares one identity, so a task is
 * bound to the caller that created it instead: the first message of a
 * conversation draws a random caller nonce (its digest is kept on the
 * conversation), and the ids handed out carry it (`run_<runId>.<nonce>`,
 * `<conversationId>.<nonce>`). Reading, following, cancelling or continuing
 * needs the id as handed out; anything else is answered like an unknown task
 * or context.
 */

import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';
import { toClientErrorBody, toClientOutputFiles, toClientPendingAction, type ClientOutputFile } from '@/lib/services/agents/clientWire';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IAgent, IAgentVariable, IAgentRun } from '@/lib/database';
import type { AgentChatResponse } from '@/lib/services/agents/agentService';
import { getAgentByKey, getConversationById } from '@/lib/services/agents/agentService';
import { resolveRunVariables, stringifyVariablesBlock } from '@/lib/services/agents/agentVariables';
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
import { discardRefusedSession, resolveInvocationLimits, resolvePublishedAgentConfig, startRunOnSession } from './agent-invocation';
import { openSseConnection } from './sse-connection';
import { authorizeEndingOpenRequests, CANCEL_PENDING_FORBIDDEN_MESSAGE, refuseCancelPending } from './agent-approval-authz';

const logger = createLogger('api:client-a2a');

const A2A_PROTOCOL_VERSION = '1.0';
const JSONRPC_VERSION = '2.0';

// A2A-specific JSON-RPC error codes (spec §8).
const ERR_TASK_NOT_FOUND = -32001;
const ERR_TASK_NOT_CANCELABLE = -32002;
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
  /**
   * An anonymous caller of the public route: its tasks and contexts are bound to it by a caller nonce, and
   * what it sends is external content (its `data` variables never fill the system prompt).
   */
  publicCaller?: boolean;
}

/** Where a conversation keeps the digest of its public caller's nonce (`metadata`). */
const CALLER_NONCE_FIELD = 'a2aCallerNonceSha256';

/** A new caller nonce: 144 random bits, base64url (no `.`, so it can follow an id after one). */
function newCallerNonce(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function callerNonceDigest(nonce: string): Buffer {
  return crypto.createHash('sha256').update(nonce).digest();
}

/** Whether `nonce` is the caller nonce of `conversation` (constant-time; a conversation without one matches nothing). */
function callerNonceMatches(conversation: { metadata?: Record<string, unknown> } | null | undefined, nonce: string | undefined): boolean {
  const stored = conversation?.metadata?.[CALLER_NONCE_FIELD];
  if (typeof stored !== 'string' || !nonce) return false;
  const expected = Buffer.from(stored, 'hex');
  const presented = callerNonceDigest(nonce);
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
}

/** `<id>.<nonce>` split at its last `.`; null when there is no nonce. */
function splitCallerNonce(value: string): { id: string; nonce: string } | null {
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  return { id: value.slice(0, dot), nonce: value.slice(dot + 1) };
}

/** The ids a conversation's tasks are handed out with: as they are on the token route, with the caller nonce on the public one. */
interface A2aIds {
  contextId: string;
  taskId(run: Pick<IAgentRun, '_id'>): string;
}

function a2aIds(conversationId: string, nonce?: string): A2aIds {
  const suffix = nonce ? `.${nonce}` : '';
  return { contextId: `${conversationId}${suffix}`, taskId: (run) => `${publicAgentRunId(run)}${suffix}` };
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
 * The `data` parts of a message. A part whose keys are all variables the agent
 * declares carries those variables (validated like any request's); any other data
 * is appended to the text as a JSON block, so the agent still reads it.
 */
export function splitA2aDataParts(
  parts: A2aPart[] | undefined,
  declared: ReadonlyArray<IAgentVariable> | undefined,
): { variables: Record<string, unknown>; other: Record<string, unknown>[] } {
  const names = new Set((declared ?? []).map((field) => field.name));
  const variables: Record<string, unknown> = {};
  const other: Record<string, unknown>[] = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || part.kind !== 'data' || !isPlainObject(part.data)) continue;
    const keys = Object.keys(part.data);
    if (keys.length > 0 && names.size > 0 && keys.every((key) => names.has(key))) Object.assign(variables, part.data);
    else if (keys.length > 0) other.push(part.data);
  }
  return { variables, other };
}

/** Data that is not a variable, as the block appended to the message text. */
function appendA2aData(text: string, other: Record<string, unknown>[]): string {
  if (other.length === 0) return text;
  const blocks = other.map((data) => `Data:\n\`\`\`json\n${stringifyVariablesBlock(data)}\n\`\`\``);
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

/** A run that failed after it started, as its task: `failed`, the error's message and what classifies it. */
function failedTask(id: string, contextId: string, error: Record<string, unknown>): Record<string, unknown> {
  const { message, type, code, ...extra } = error;
  return {
    ...stateTask(id, contextId, 'failed', typeof message === 'string' ? message : 'The run failed.'),
    metadata: { errorType: type, ...(code ? { errorCode: code } : {}), ...extra },
  };
}

/** The task a run is, in A2A states: submitted (waiting), working, input-required, completed, failed, canceled. */
function taskFromRun(run: IAgentRun, baseUrl: string, ids: A2aIds = a2aIds(run.conversationId)): Record<string, unknown> {
  const id = ids.taskId(run);
  const contextId = ids.contextId;
  const result = run.result as unknown as AgentChatResponse | null | undefined;
  switch (run.status) {
    case 'scheduled':
    case 'queued':
      return stateTask(id, contextId, 'submitted');
    case 'running':
      return stateTask(id, contextId, 'working');
    case 'requires_action':
      return inputRequiredTask(id, contextId, answerTextOf(result), result?.required_action?.actions ?? []);
    case 'succeeded':
      return result ? taskFromResponse(id, contextId, result, baseUrl) : completedTask(id, contextId, '');
    case 'canceled':
      return stateTask(id, contextId, 'canceled');
    default:
      return stateTask(id, contextId, 'failed', run.errorMessage ?? 'The run failed.');
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
  // Text, and JSON (a `data` part: the agent's variables; a structured answer); files too once the agent takes attachments.
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
  | {
    base: Omit<StartAgentRunInput, 'execution'>;
    limits: AgentRunLimits;
    /** The ids this turn's task is handed out with. */
    ids: A2aIds;
    /** The call created the conversation (a refused start removes it again). */
    createdSession: boolean;
  };

/**
 * Everything a `message/send` / `message/stream` needs before its run starts:
 * the declared variables, the text, the files stored on the session, the session
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
  // The config this call runs (published), for the agent's declared variables and file limits.
  const runConfig = await resolvePublishedAgentConfig(ctx.tenantDbName, agent, ctx.projectId);
  const data = splitA2aDataParts(message.parts, runConfig.variables);
  const resolvedVariables = resolveRunVariables(runConfig.variables, Object.keys(data.variables).length > 0 ? data.variables : null);
  if (!resolvedVariables.ok) {
    return fail(-32602, 'Invalid params: invalid variables', { type: 'invalid_request_error', code: 'invalid_variables', errors: resolvedVariables.errors });
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
  if (!userMessage.trim() && !resolvedVariables.variables && files.length === 0) {
    return fail(-32602, 'Invalid params: message.parts must contain text');
  }

  // contextId ↔ conversationId: reuse the Responses API conversation
  // store, scoped on agent AND project like every other agent surface. A public caller
  // names it with its caller nonce (`<conversationId>.<nonce>`); without the right one it is unknown.
  const requestedContextId = typeof message.contextId === 'string' && message.contextId ? message.contextId : undefined;
  let contextId: string | undefined;
  let callerNonce: string | undefined;
  if (requestedContextId && ctx.publicCaller) {
    const bound = splitCallerNonce(requestedContextId);
    const conversation = bound ? await getConversationById(ctx.tenantDbName, bound.id) : null;
    if (!bound || !conversationVisibleTo(conversation, agent, ctx) || !callerNonceMatches(conversation, bound.nonce)) {
      return fail(-32602, 'Invalid params: unknown contextId');
    }
    contextId = bound.id;
    callerNonce = bound.nonce;
  } else if (requestedContextId) {
    if (!conversationVisibleTo(await getConversationById(ctx.tenantDbName, requestedContextId), agent, ctx)) {
      return fail(-32602, 'Invalid params: unknown contextId');
    }
    contextId = requestedContextId;
  }
  // A queued turn learns of an exhausted spend limit now, before a session is created for it.
  if (queued) {
    await assertQueuedTurnSpendAllowed({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, agentKey: agent.key, userId: ctx.userId });
  }
  // A public caller's new conversation draws its caller nonce; only its digest is stored.
  if (ctx.publicCaller && !contextId) callerNonce = newCallerNonce();
  const resolved = await resolveConversation(
    contextId,
    agent,
    ctx,
    'a2a',
    !contextId && callerNonce ? { [CALLER_NONCE_FIELD]: callerNonceDigest(callerNonce).toString('hex') } : {},
  );
  if ('error' in resolved) return fail(-32602, 'Invalid params: unknown contextId');
  const { conversationId } = resolved;
  const createdSession = resolved.created === true;

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
      // No run starts: a conversation this call created goes again.
      if (createdSession) await discardRefusedSession(ctx.tenantDbName, conversationId);
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
    ids: a2aIds(conversationId, callerNonce),
    createdSession,
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
      ...(resolvedVariables.variables ? { variables: resolvedVariables.variables } : {}),
      // An anonymous caller's message and variables are external content: variables never fill the system prompt
      // (as a webhook payload's); an authenticated caller's variables stay prompt variables.
      ...(ctx.publicCaller ? { externalContent: true } : {}),
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

/** An open A2A task stream: one JSON-RPC response per event, on one SSE connection. */
interface A2aTaskStream {
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
  emit(result: Record<string, unknown>): void;
  status(status: Record<string, unknown>, final: boolean, metadata?: unknown): void;
  /** A piece of the answer's text: the first creates the text artifact, the rest append to it. */
  text(chunk: string): void;
  /**
   * A Task as its closing events: its artifacts, then its status as the final
   * event. After streamed text the text artifact is closed with an empty last
   * chunk, unless `wholeText`: then the whole answer replaces it (a follower
   * that joined late has only part of it).
   */
  finish(task: Record<string, unknown>, options?: { wholeText?: boolean }): void;
  end(): void;
}

function openA2aTaskStream(reply: FastifyReply, rpcId: string | number | null, taskId: string, contextId: string): A2aTaskStream {
  const connection = openSseConnection(reply);
  const textArtifactId = `${taskId}_artifact`;
  let streamed = false;
  const emit = (result: Record<string, unknown>) => connection.write(`data: ${JSON.stringify(jsonRpcOk(rpcId, result))}\n\n`);
  const status = (state: Record<string, unknown>, final: boolean, metadata?: unknown) => emit({
    kind: 'status-update', taskId, contextId, status: state, final, ...(metadata ? { metadata } : {}),
  });
  const artifact = (value: Record<string, unknown>, append: boolean, lastChunk: boolean) => emit({
    kind: 'artifact-update', taskId, contextId, artifact: value, append, lastChunk,
  });
  return {
    signal: connection.signal,
    emit,
    status,
    text(chunk) {
      if (!chunk) return;
      artifact({ artifactId: textArtifactId, name: 'response', parts: [{ kind: 'text', text: chunk }] }, streamed, false);
      streamed = true;
    },
    finish(task, options = {}) {
      const closeStreamed = streamed && !options.wholeText;
      if (closeStreamed) artifact({ artifactId: textArtifactId, name: 'response', parts: [{ kind: 'text', text: '' }] }, true, true);
      for (const value of (task.artifacts ?? []) as Array<Record<string, unknown>>) {
        if (closeStreamed && value.artifactId === textArtifactId) continue;
        artifact(value, false, true);
      }
      status(task.status as Record<string, unknown>, true, task.metadata);
    },
    end: connection.end,
  };
}

/**
 * `message/stream`: the turn as server-sent events, one JSON-RPC response per
 * event. The Task opens it (`submitted`), then a `working` status event, then
 * the answer's text as artifact chunks while the model writes it (the first
 * creates the artifact, the rest append, an empty last one closes it), the
 * files and the structured answer as artifacts, and a final status event
 * (`completed`, `input-required`, `failed` or `canceled`). The stream opens
 * once the run has started: a refusal before that (409 / 429) is a plain
 * JSON-RPC error. The client going away does not stop the run: it carries on
 * detached (as a Responses stream with `background: true` does), and
 * `tasks/resubscribe` reattaches to it; `tasks/cancel` stops it.
 */
async function streamA2aTurn(
  reply: FastifyReply,
  rpcId: string | number | null,
  prepared: Extract<A2aTurn, { base: unknown }>,
  baseUrl: string,
): Promise<FastifyReply> {
  const { base, ids } = prepared;
  const contextId = ids.contextId;
  const disconnected = new AbortController();
  const open: { stream: A2aTaskStream | null } = { stream: null };
  let taskId = '';

  try {
    const outcome = await startRunOnSession({
      ...base,
      execution: {
        kind: 'inline',
        waitMs: 0,
        stream: { onTextChunk: (text) => open.stream?.text(text) },
        signal: disconnected.signal,
        cancelOnDisconnect: false,
        onStarted: (run) => {
          taskId = ids.taskId(run);
          const stream = openA2aTaskStream(reply, rpcId, taskId, contextId);
          open.stream = stream;
          stream.signal.addEventListener('abort', () => disconnected.abort(), { once: true });
          stream.emit(stateTask(taskId, contextId, 'submitted'));
          stream.status({ state: 'working', timestamp: new Date().toISOString() }, false);
        },
      },
    }, { tenantDbName: base.tenantDbName, conversationId: base.conversationId, created: prepared.createdSession });
    const refusal = runRefusalRpc(rpcId, outcome);
    if (refusal) return await reply.code(200).send(refusal);
    if (outcome.kind === 'completed') {
      open.stream?.finish(outcome.run.status === 'canceled'
        ? stateTask(taskId, contextId, 'canceled')
        : taskFromResponse(taskId, contextId, outcome.response, baseUrl));
    } else if ('run' in outcome) {
      open.stream?.finish(taskFromRun(outcome.run, baseUrl, ids));
    }
  } catch (error) {
    // Before the stream opened this is the call's error like any other; after, the run ended in failure.
    if (!open.stream) throw error;
    const classified = logAgentRouteError(logger, 'A2A stream error', error);
    open.stream.status({
      state: 'failed',
      timestamp: new Date().toISOString(),
      message: { kind: 'message', role: 'agent', messageId: `${taskId}_status`, parts: [{ kind: 'text', text: classified.error.message }] },
    }, true, { errorType: classified.error.type, ...(classified.error.code ? { errorCode: classified.error.code } : {}) });
  } finally {
    open.stream?.end();
  }
  return reply;
}

/** How long one `tasks/resubscribe` follows a task that does not end; then the stream closes and the client resubscribes. */
const RESUBSCRIBE_MAX_MS = 60 * 60 * 1000;

/**
 * `tasks/resubscribe`: reattaches to a task. The Task as it stands comes
 * first; a task that already ended (or waits on a person) is followed by its
 * final status event and the stream closes. A running or queued task is
 * followed through the session event log, the same source as the runs API's
 * event stream, so it works from any node: `working` when the turn starts,
 * the answer's text as artifact chunks, and, once the run row is terminal,
 * the whole answer, files and structured answer as artifacts and the final
 * status event.
 */
async function resubscribeA2aTask(
  reply: FastifyReply,
  rpcId: string | number | null,
  ctx: A2aCallContext,
  found: { task: Record<string, unknown>; run?: IAgentRun; ids?: A2aIds },
  baseUrl: string,
): Promise<FastifyReply> {
  const { task, run } = found;
  const taskId = String(task.id);
  const contextId = String(task.contextId);
  if (!run || !isAgentRunActive(run)) {
    const stream = openA2aTaskStream(reply, rpcId, taskId, contextId);
    try {
      stream.emit(task);
      stream.status(task.status as Record<string, unknown>, true, task.metadata);
    } finally {
      stream.end();
    }
    return reply;
  }

  // What happens next: events after the newest one stored now.
  const afterSeq = await runWithTenantDb(ctx.tenantDbName, (db) => db.getAgentSessionMaxSeq(run.conversationId));
  const stream = openA2aTaskStream(reply, rpcId, taskId, contextId);
  const follow = new AbortController();
  stream.signal.addEventListener('abort', () => follow.abort(), { once: true });
  try {
    stream.emit(task);
    const following = runWithTenantDb(ctx.tenantDbName, (db) => followSessionEvents({
      db,
      conversationId: run.conversationId,
      afterSeq,
      runId: String(run._id),
      types: ['session.status_running', 'agent.message.delta'],
      signal: follow.signal,
      maxDurationMs: RESUBSCRIBE_MAX_MS,
      write: ({ event, data }) => {
        if (event === 'agent.message.delta') stream.text(typeof data.data.text === 'string' ? data.data.text : '');
        else stream.status({ state: 'working', timestamp: new Date().toISOString() }, false);
      },
      // The SSE connection pings on its own.
      writePing: () => undefined,
    })).catch((error: unknown) => {
      // The run row still ends the stream; only the chunks in between are lost.
      logger.warn('A2A resubscribe could not follow the session events', { taskId, error: error instanceof Error ? error.message : String(error) });
    });
    // The run row says when the task ended (events are best effort; the row is not).
    const settled = await waitForAgentRun(
      { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, runId: String(run._id) },
      RESUBSCRIBE_MAX_MS,
      follow.signal,
    );
    follow.abort();
    await following;
    if (settled && !isAgentRunActive(settled)) stream.finish(taskFromRun(settled, baseUrl, found.ids), { wholeText: true });
  } catch (error) {
    logAgentRouteError(logger, 'A2A resubscribe error', error);
  } finally {
    follow.abort();
    stream.end();
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
      if (streaming) return await streamA2aTurn(reply, rpcId, prepared, baseUrl);

      const { ids } = prepared;
      const turn: { run: IAgentRun | null } = { run: null };
      let outcome: StartAgentRunOutcome;
      try {
        outcome = await startRunOnSession({
          ...prepared.base,
          // Past the window the run carries on and the caller gets a `working` task to poll with tasks/get.
          execution: queued
            ? { kind: 'queued' }
            : { kind: 'inline', waitMs: prepared.limits.syncWaitMs, cancelOnDisconnect: false, onStarted: (run) => { turn.run = run; } },
        }, { tenantDbName: ctx.tenantDbName, conversationId: prepared.base.conversationId, created: prepared.createdSession });
      } catch (error) {
        // Before the run existed this is the call's error; after, the run failed: its task says so (as tasks/get does).
        if (!turn.run) throw error;
        const classified = logAgentRouteError(logger, 'A2A run failed', error);
        return reply.code(200).send(jsonRpcOk(rpcId, failedTask(ids.taskId(turn.run), ids.contextId, toClientErrorBody(classified.error))));
      }
      const refusal = runRefusalRpc(rpcId, outcome);
      if (refusal) return reply.code(200).send(refusal);
      if (outcome.kind === 'completed') {
        const taskId = ids.taskId(outcome.run);
        // A run stopped while the call waited ended canceled, whatever partial answer it had.
        return reply.code(200).send(jsonRpcOk(rpcId, outcome.run.status === 'canceled'
          ? stateTask(taskId, ids.contextId, 'canceled')
          : taskFromResponse(taskId, ids.contextId, outcome.response, baseUrl)));
      }
      // `detached` (the window ended first), `accepted` (queued): the run as it stands.
      if (!('run' in outcome)) throw new Error(`Unexpected start outcome: ${outcome.kind}`);
      return reply.code(200).send(jsonRpcOk(rpcId, taskFromRun(outcome.run, baseUrl, ids)));
    }

    if (method === 'tasks/get' || method === 'tasks/resubscribe') {
      const requestedId = typeof body.params?.id === 'string' ? body.params.id : '';
      const baseUrl = externalBaseUrl(request);
      const found = await findTask(ctx, agent, requestedId, baseUrl);
      if (!found) return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
      if (method === 'tasks/resubscribe') return await resubscribeA2aTask(reply, rpcId, ctx, found, baseUrl);
      return reply.code(200).send(jsonRpcOk(rpcId, found.task));
    }

    if (method === 'tasks/cancel') {
      // A turn runs inside a `message/send` call, but another request can still stop it: the turn
      // holds the conversation's run slot, which every node reads. A task that waits on a person
      // (`input-required`) is cancelled with it — its open approvals and questions end as cancelled.
      const requestedId = typeof body.params?.id === 'string' ? body.params.id : '';
      const ref = readTaskId(ctx, requestedId);
      if (ref && 'runTaskId' in ref) {
        const found = await loadTaskRun(ctx, agent, ref.runTaskId, ref.nonce);
        if (!found) return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
        const { run } = found;
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
        const outcome = await cancelAgentRun({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ref.runTaskId });
        if (outcome.kind === 'not_found') return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
        if (outcome.kind === 'already_terminal') {
          return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_CANCELABLE, 'The task cannot be canceled: it is not running'));
        }
        // A running turn stops at its next checkpoint; the task is canceled from here on.
        return reply.code(200).send(jsonRpcOk(rpcId, stateTask(requestedId, found.ids.contextId, 'canceled')));
      }
      // A public caller names only the run tasks it was handed (with their nonce): anything else is unknown.
      if (ctx.publicCaller) return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_FOUND, 'Task not found'));
      const parsed = ref && 'legacy' in ref ? ref.legacy : null;
      if (!parsed) {
        // Not an id this server hands out: nothing to look up, and nothing that could be canceled.
        return reply.code(200).send(jsonRpcError(rpcId, ERR_TASK_NOT_CANCELABLE, 'The task cannot be canceled: it is not running'));
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
            ERR_TASK_NOT_CANCELABLE,
            'The task is waiting for an approval or an answer, so there is no running turn to stop; answer the open requests (or reject them) through the actions endpoint to end the wait.',
            { pending_action_ids: waitingOn },
          ));
        }
        return reply.code(200).send(
          jsonRpcError(rpcId, ERR_TASK_NOT_CANCELABLE, 'The task cannot be canceled: it is not running'),
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

/**
 * The task an id names, when this caller may see it: a run (`run_<runId>`;
 * `run` is then set) or, from before tasks were runs, an assistant message
 * (`task_<conversationId>_<index>`).
 */
async function findTask(
  ctx: A2aCallContext,
  agent: IAgent,
  requestedId: string,
  baseUrl: string,
): Promise<{ task: Record<string, unknown>; run?: IAgentRun; ids?: A2aIds } | null> {
  const ref = readTaskId(ctx, requestedId);
  if (!ref) return null;
  if ('runTaskId' in ref) {
    const found = await loadTaskRun(ctx, agent, ref.runTaskId, ref.nonce);
    return found ? { task: taskFromRun(found.run, baseUrl, found.ids), run: found.run, ids: found.ids } : null;
  }
  const parsed = ref.legacy;
  const conversation = await getConversationById(ctx.tenantDbName, parsed.conversationId);
  const message = conversationVisibleTo(conversation, agent, ctx)
    ? conversation?.messages?.[parsed.messageIndex]
    : undefined;
  if (!message || message.role !== 'assistant') return null;
  if (message.pendingActions?.some((action) => action.status === 'pending')) {
    return { task: inputRequiredTask(requestedId, parsed.conversationId, message.content, message.pendingActions.map(toClientPendingAction)) };
  }
  return {
    task: completedTask(
      requestedId,
      parsed.conversationId,
      message.content,
      message.stopReason ? { reason: message.stopReason, ...(message.stopDetail ? { detail: message.stopDetail } : {}) } : undefined,
      a2aFileArtifacts(requestedId, toClientOutputFiles(parsed.conversationId, message.attachments), baseUrl),
      { parsed: message.output, error: message.outputError },
    ),
  };
}

/**
 * What a task id names for this caller: a run task (`run_<runId>`; a public caller's carries its nonce,
 * `run_<runId>.<nonce>`), an older message task (`task_<conversationId>_<index>`, the token route only), or
 * nothing.
 */
function readTaskId(
  ctx: A2aCallContext,
  id: string,
): { runTaskId: string; nonce?: string } | { legacy: { conversationId: string; messageIndex: number } } | null {
  if (!id) return null;
  if (ctx.publicCaller) {
    const bound = splitCallerNonce(id);
    return bound && isRunTaskId(bound.id) ? { runTaskId: bound.id, nonce: bound.nonce } : null;
  }
  if (isRunTaskId(id)) return { runTaskId: id };
  const legacy = parseTaskId(id);
  return legacy ? { legacy } : null;
}

/**
 * The run a `run_<id>` task names, when this caller may see it (this agent, this project, a conversation it
 * started; on the public route also the conversation's caller nonce), and the ids its task is handed out with.
 */
async function loadTaskRun(
  ctx: A2aCallContext,
  agent: IAgent,
  taskIdValue: string,
  nonce?: string,
): Promise<{ run: IAgentRun; ids: A2aIds } | null> {
  const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, taskIdValue);
  if (!run || run.mode === 'sync' || run.agentKey !== agent.key) return null;
  const conversation = await getConversationById(ctx.tenantDbName, run.conversationId).catch(() => null);
  if (!conversationVisibleTo(conversation, agent, ctx)) return null;
  if (ctx.publicCaller && !callerNonceMatches(conversation, nonce)) return null;
  return { run, ids: a2aIds(run.conversationId, ctx.publicCaller ? nonce : undefined) };
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
