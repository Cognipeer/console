import {
  cancelAgentRun,
  getAgentRunStatus,
  publicAgentRunId,
  resolveAgentRunLimits,
  startAgentRun,
  type AgentRunLimits,
} from '@/lib/services/agents/agentRunService';
import { cancelConversationTurn } from '@/lib/services/agents/turnCancellation';
/**
 * Inbound A2A (Agent2Agent) server — exposes Cognipeer agents to external
 * A2A clients over JSON-RPC 2.0 (spec v1.0).
 *
 * Token-authenticated surface (per agent, `cpeer_` API token):
 *   GET  /client/v1/a2a/:agentKey/.well-known/agent-card.json
 *   POST /client/v1/a2a/:agentKey          (message/send, tasks/get)
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
 * window ended first and the run carries on. The task id is the run's id
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
    parts: [{ kind: 'file', file: { name: file.name, mimeType: file.mime_type, uri: `${baseUrl}/api${file.download_url}` } }],
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

  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: agent.name,
    description: agent.description || `Cognipeer agent "${agent.name}"`,
    url: endpoint,
    preferredTransport: 'JSONRPC',
    provider: { organization: 'Cognipeer', url: 'https://cognipeer.com' },
    version: agent.publishedVersion ? String(agent.publishedVersion) : '0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'chat',
        name: `Chat with ${agent.name}`,
        description: agent.description || `Conversational access to the "${agent.name}" agent.`,
        tags: ['chat', ...toolTags],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
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

    if (method === 'message/send') {
      const message = (body.params?.message ?? {}) as A2aIncomingMessage;
      // The config this call runs (published), for the agent's declared inputs.
      const runConfig = await resolvePublishedAgentConfig(ctx.tenantDbName, agent, ctx.projectId);
      const data = splitA2aDataParts(message.parts, runConfig.inputs);
      const resolvedInputs = resolveRunInputs(runConfig.inputs, Object.keys(data.inputs).length > 0 ? data.inputs : null);
      if (!resolvedInputs.ok) {
        return reply.code(200).send(jsonRpcError(rpcId, -32602, 'Invalid params: invalid inputs', { type: 'invalid_request_error', code: 'invalid_inputs', errors: resolvedInputs.errors }));
      }
      const userMessage = appendA2aData(extractText(message.parts), data.other);
      if (!userMessage.trim() && !resolvedInputs.inputs) {
        return reply.code(200).send(
          jsonRpcError(rpcId, -32602, 'Invalid params: message.parts must contain text'),
        );
      }

      // contextId ↔ conversationId: reuse the Responses API conversation
      // store, scoped on agent AND project like every other agent surface.
      const contextId = typeof message.contextId === 'string' && message.contextId ? message.contextId : undefined;
      if (contextId && !conversationVisibleTo(await getConversationById(ctx.tenantDbName, contextId), agent, ctx)) {
        return reply.code(200).send(jsonRpcError(rpcId, -32602, 'Invalid params: unknown contextId'));
      }
      const resolved = await resolveConversation(
        contextId,
        agent,
        ctx,
        'a2a',
      );
      if ('error' in resolved) {
        return reply.code(200).send(jsonRpcError(rpcId, -32602, 'Invalid params: unknown contextId'));
      }
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
          return reply.code(200).send(jsonRpcError(rpcId, ERR_AUTHORIZATION_UNAVAILABLE, 'Authorization is temporarily unavailable', {
            ...(refusal.decisionId ? { decision_id: refusal.decisionId } : {}),
          }));
        }
        if (refusal) {
          return reply.code(200).send(jsonRpcError(rpcId, ERR_FORBIDDEN, CANCEL_PENDING_FORBIDDEN_MESSAGE, {
            ...(refusal.decisionId ? { decision_id: refusal.decisionId } : {}),
          }));
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
      const outcome = await startAgentRun({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        agentKey: agent.key,
        conversationId,
        userMessage,
        userId: ctx.userId,
        ...(ctx.tokenId ? { apiTokenId: ctx.tokenId, actorType: 'api_token' as const } : {}),
        usePublished: true,
        runtimeContext,
        ...(resolvedInputs.inputs ? { inputs: resolvedInputs.inputs } : {}),
        channel: 'a2a',
        trigger: 'request',
        // Past the window the run carries on and the caller gets a `working` task to poll with tasks/get.
        execution: { kind: 'inline', waitMs: limits.syncWaitMs, cancelOnDisconnect: false },
        limits,
      });
      if (outcome.kind === 'conflict') {
        return reply.code(200).send(jsonRpcError(rpcId, -32603, 'An active run (queued or running) already exists for this conversation.', {
          type: 'agent_run_conflict', code: 'agent_run_conflict',
        }));
      }
      if (outcome.kind === 'concurrency_limit') {
        return reply.code(200).send(jsonRpcError(rpcId, -32603, 'Too many agent runs are queued or running; retry later.', {
          type: 'rate_limit_error', code: 'agent_run_concurrency_limit', class: outcome.runClass, scope: outcome.scope, limit: outcome.limit,
        }));
      }
      if (outcome.kind === 'idempotency_conflict') {
        return reply.code(200).send(jsonRpcError(rpcId, -32603, 'Idempotency conflict', { type: 'idempotency_key_conflict' }));
      }
      if (outcome.kind === 'completed') {
        return reply.code(200).send(jsonRpcOk(
          rpcId,
          taskFromResponse(publicAgentRunId(outcome.run), conversationId, outcome.response, externalBaseUrl(request)),
        ));
      }
      // `detached` (the window ended first) and the rest: the run as it stands — `working` while it goes on.
      return reply.code(200).send(jsonRpcOk(rpcId, taskFromRun(outcome.run, externalBaseUrl(request))));
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
