/**
 * An agent turn streamed as OpenAI Responses server-sent events (§5.3) — for
 * `POST /responses` with `stream: true` and for the runs API's `stream: true`.
 * The event sequence itself is `createResponsesEventEncoder` (responsesWire.ts,
 * shared with the model stream); the HTTP side (headers, `: ping`, abort when
 * the client goes away) is `openSseConnection`.
 */

import type { FastifyReply } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IAgentRun } from '@/lib/database';
import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';
import { startAgentRun } from '@/lib/services/agents/agentRunService';
import { createResponsesEventEncoder, type ResponsesEventEncoder } from '@/lib/services/models/responsesWire';
import { runOutcomeRefusal } from './agent-invocation';
import { toAgentResponseObject, type AgentResponseObjectOptions } from './agent-response-object';
import { openSseConnection } from './sse-connection';

const logger = createLogger('api:agent-responses-stream');

export interface ResponsesStreamWriter extends Omit<ResponsesEventEncoder, 'functionCall' | 'items' | 'closeItems'> {
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
  end(): void;
}

export function createResponsesStreamWriter(reply: FastifyReply): ResponsesStreamWriter {
  const connection = openSseConnection(reply);
  const events = createResponsesEventEncoder(connection.write);
  return {
    signal: connection.signal,
    started: events.started,
    text: events.text,
    reasoning: events.reasoning,
    finish: events.finish,
    error: events.error,
    end: connection.end,
  };
}

/** A run that already exists, as a stream: opened, then closed with the object as it stands. */
function writeRunSnapshot(writer: ResponsesStreamWriter, run: IAgentRun, object: AgentResponseObjectOptions) {
  writer.started(toAgentResponseObject({ ...run, status: 'running' }, object));
  writer.finish(toAgentResponseObject(run, object));
}

/** An idempotent replay answered as a stream: the stored answer (or the run as it stands, still going). */
export function streamRunSnapshot(reply: FastifyReply, run: IAgentRun, object: AgentResponseObjectOptions): FastifyReply {
  const writer = createResponsesStreamWriter(reply);
  try {
    writeRunSnapshot(writer, run, object);
  } finally {
    writer.end();
  }
  return reply;
}

/**
 * Runs an agent turn inline and answers with it as Responses events: the run
 * is named up front (`response.created` carries `resp_<runId>`), text and
 * reasoning stream as they come, and the closing event carries the full
 * Response object (output files and annotations included, as the non-stream
 * object has them). A refusal (409 / 429) or a failure is an `error` event.
 */
export async function streamAgentRunAsResponses(
  reply: FastifyReply,
  base: Omit<Parameters<typeof startAgentRun>[0], 'execution'>,
  options: {
    /** Stop the run when the client goes away; false = it carries on detached (`background: true`). */
    cancelOnDisconnect: boolean;
    modelKey?: string;
    requestReasoning?: Parameters<typeof startAgentRun>[0]['requestReasoning'];
    /** Stream reasoning text (the agent shows it and the caller did not opt out). */
    streamReasoning: boolean;
    object: AgentResponseObjectOptions;
  },
): Promise<FastifyReply> {
  const writer = createResponsesStreamWriter(reply);
  let started: IAgentRun | null = null;
  try {
    const outcome = await startAgentRun({
      ...base,
      ...(options.modelKey ? { modelKey: options.modelKey } : {}),
      ...(options.requestReasoning ? { requestReasoning: options.requestReasoning } : {}),
      execution: {
        kind: 'inline',
        waitMs: 0,
        stream: {
          onTextChunk: (text) => writer.text(text),
          ...(options.streamReasoning ? { onReasoningChunk: (text: string) => writer.reasoning(text) } : {}),
        },
        signal: writer.signal,
        cancelOnDisconnect: options.cancelOnDisconnect,
        onStarted: (run) => {
          started = run;
          writer.started(toAgentResponseObject(run, options.object));
        },
      },
    });
    const refusal = runOutcomeRefusal(outcome);
    if (refusal) {
      writer.error((refusal.body as { error: { message: string; code?: string; type?: string } }).error);
    } else if (outcome.kind === 'completed') {
      const { _conversation_messages, ...response } = outcome.response;
      void _conversation_messages;
      writer.finish(toAgentResponseObject(outcome.run, options.object, response as unknown as Record<string, unknown>));
    } else if (outcome.kind === 'replay') {
      writeRunSnapshot(writer, outcome.run, options.object);
    }
  } catch (error) {
    const classified = logAgentRouteError(logger, 'Agent response stream error', error);
    const run = started as IAgentRun | null;
    writer.error(
      { message: classified.error.message, code: classified.error.code ?? null, type: classified.error.type },
      // The row is already finalized as failed; the closing object says what the error event said.
      run
        ? toAgentResponseObject({ ...run, status: 'failed', errorReason: classified.error.code ?? classified.error.type, errorMessage: classified.error.message } as IAgentRun, options.object)
        : undefined,
    );
  } finally {
    writer.end();
  }
  return reply;
}
