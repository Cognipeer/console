/**
 * The OpenAI Responses object of an agent run (§5.3): what `POST /responses`
 * answers (200 finished, 202 still going), `GET /responses/{id}` reads back and
 * `POST /responses/{id}/cancel` returns. One run = one response, so the id is
 * run-scoped (`resp_<runId>`) for every mode, a synchronous call included.
 */

import type { FastifyReply } from 'fastify';
import type { AgentResponseFormat, IAgentRun } from '@/lib/database';
import { isAgentRunActive, publicAgentRunId } from '@/lib/services/agents/agentRunService';
import { agentRunLocation } from './agent-invocation';

export type AgentResponseStatus = 'queued' | 'in_progress' | 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'requires_action';

export interface AgentResponseObjectOptions {
  /** `model` as the caller asked for it (`agent:<key>` or the bare key); the agent key otherwise. */
  model?: string;
  /** What the request named; undefined = what the stored result says. */
  previousResponseId?: string | null;
  /** The agent's model this run used, when the caller picked one (`agent_model`). */
  agentModel?: string;
  /** `include_reasoning: false` narrows the output to the answer (it never brings back what the agent hid). */
  includeReasoning?: boolean;
  /** What the request said; undefined = what the run records (queued, or `background` on the row). */
  background?: boolean;
}

type ResultBody = Record<string, unknown>;

/** The Responses `text.format` of a run's per-request structured output (`{ type: 'text' }` when none). */
export function textFormatOf(format: AgentResponseFormat | null | undefined): Record<string, unknown> {
  if (!format) return { type: 'text' };
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    name: format.name ?? 'response',
    schema: format.schema ?? {},
    ...(format.strict !== undefined ? { strict: format.strict } : {}),
  };
}

function resultStatus(result: ResultBody | null): AgentResponseStatus | null {
  const status = result?.status;
  return status === 'completed' || status === 'incomplete' || status === 'failed' || status === 'requires_action' ? status : null;
}

/** The run's state in Responses words; a live answer (`result`) decides while the row is still running. */
export function agentResponseStatus(run: Pick<IAgentRun, 'status'>, result: ResultBody | null = null): AgentResponseStatus {
  switch (run.status) {
    case 'scheduled':
    case 'queued':
      return 'queued';
    case 'running':
      return resultStatus(result) ?? 'in_progress';
    case 'requires_action':
      return 'requires_action';
    case 'succeeded': {
      const status = resultStatus(result);
      return status === 'incomplete' || status === 'failed' ? status : 'completed';
    }
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

function outputTextOf(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output as Array<Record<string, unknown>>) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

/**
 * `background` of a run read back. A Responses request records `background: true` on its run when it asked
 * for it, so for those runs that flag alone answers (a `service_tier: "flex"` call is queued, yet was not a
 * background request); a run another surface started is background when it was queued.
 */
function backgroundOf(run: Pick<IAgentRun, 'channel' | 'mode' | 'background'>): boolean {
  if (run.channel === 'responses') return run.background === true;
  return run.mode === 'background' || run.background === true;
}

/** A usage block with the detail objects of the Responses usage (zero when the run did not report them). */
function responsesUsageOf(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const value = usage as Record<string, unknown>;
  const inputDetails = (value.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (value.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    ...value,
    input_tokens_details: { ...inputDetails, cached_tokens: typeof inputDetails.cached_tokens === 'number' ? inputDetails.cached_tokens : 0 },
    output_tokens_details: { ...outputDetails, reasoning_tokens: typeof outputDetails.reasoning_tokens === 'number' ? outputDetails.reasoning_tokens : 0 },
  };
}

const toEpochSeconds =(value: Date | string | null | undefined) =>
  (value ? Math.floor(new Date(value).getTime() / 1000) : Math.floor(Date.now() / 1000));

/**
 * The Response object of `run`. `result` is the turn's live answer (an inline
 * call that finished inside its window); otherwise the stored result is used
 * — present once the run succeeded, paused, or was stopped with a partial answer.
 */
export function toAgentResponseObject(
  run: IAgentRun,
  options: AgentResponseObjectOptions = {},
  result?: ResultBody | null,
): Record<string, unknown> {
  const stored = run.status === 'succeeded' || run.status === 'requires_action' || run.status === 'canceled'
    ? (run.result as ResultBody | null | undefined) ?? null
    : null;
  const body: ResultBody | null = result ?? stored;
  const status = agentResponseStatus(run, result ?? stored);
  const rawOutput = Array.isArray(body?.output) ? body!.output as unknown[] : [];
  const output = options.includeReasoning === false
    ? rawOutput.filter((item) => (item as { type?: unknown })?.type !== 'reasoning')
    : rawOutput;
  const runId = String(run._id);
  return {
    ...(body ?? {}),
    id: `resp_${runId}`,
    object: 'response',
    created_at: typeof body?.created_at === 'number' ? body.created_at : toEpochSeconds(run.createdAt),
    status,
    model: options.model ?? (typeof body?.model === 'string' ? body.model : run.agentKey),
    output,
    output_text: outputTextOf(output),
    usage: responsesUsageOf(body?.usage),
    error: status === 'failed'
      ? { code: run.errorReason ?? 'agent_error', message: run.errorMessage ?? 'The run failed.' }
      : null,
    incomplete_details: body?.incomplete_details ?? null,
    metadata: run.metadata ?? {},
    text: { format: textFormatOf(run.responseFormat) },
    service_tier: run.runClass === 'deferred' ? 'flex' : 'default',
    background: options.background ?? backgroundOf(run),
    previous_response_id: options.previousResponseId !== undefined
      ? options.previousResponseId
      : (typeof body?.previous_response_id === 'string' ? body.previous_response_id : null),
    conversation: { id: run.conversationId },
    cognipeer: {
      run_id: publicAgentRunId(run),
      session_id: run.conversationId,
      ...(options.agentModel ? { agent_model: options.agentModel } : {}),
    },
  };
}

/**
 * Answers a create with the run's Response object: 202 (with `Location` on the
 * runs API and `Retry-After`) while it is queued or running, 200 once it
 * finished or paused.
 */
export function sendAgentResponseObject(
  reply: FastifyReply,
  run: IAgentRun,
  options: AgentResponseObjectOptions = {},
  result?: ResultBody | null,
): FastifyReply {
  const body = toAgentResponseObject(run, options, result);
  if (!result && isAgentRunActive(run)) {
    return reply.code(202).header('Location', agentRunLocation(run)).header('Retry-After', '2').send(body);
  }
  return reply.code(200).send(body);
}
