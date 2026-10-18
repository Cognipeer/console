/**
 * `POST /client/v1/responses` for a MODEL target (§5.3): the Responses request
 * translated to chat completions (responsesWire.ts), run through the same
 * gateway function as `POST /client/v1/chat/completions` (quota, rate,
 * budget, guardrails, routing, usage under route `responses`), and the answer
 * translated back — a Response object, or `response.*` events when streamed.
 * Nothing is stored: the id is fresh and `GET /responses/{id}` does not know it.
 */

import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import {
  ResponsesRequestError,
  chatCompletionToResponse,
  chatStreamToResponses,
  newModelResponseId,
  responsesRequestToChat,
} from '@/lib/services/models/responsesWire';
import { applyStreamHeaders } from '../fastify-utils';
import { openAiEnvelopeOf, parseRunMetadata } from './agent-invocation';
import { modelChatFailure, runModelChatCompletion, type ChatCompletionRequest } from './model-chat-gateway';

const logger = createLogger('api:model-responses');

/** The usage-row route of a model call made through the Responses dialect. */
const USAGE_ROUTE = 'responses';

export async function sendModelResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: ApiTokenContext,
  body: Record<string, unknown>,
  modelKey: string,
): Promise<FastifyReply> {
  const startedAt = Date.now();
  let chat: ChatCompletionRequest;
  try {
    chat = responsesRequestToChat(body) as ChatCompletionRequest;
  } catch (error) {
    if (error instanceof ResponsesRequestError) {
      return reply.code(error.status).send({ error: { message: error.message, type: 'invalid_request_error', param: error.param, code: error.code } });
    }
    throw error;
  }
  // Echoed on the response, so held to the same shape as an agent run's.
  const metadata = parseRunMetadata(body.metadata);
  if (!metadata.ok) {
    return reply.code(400).send({ error: { message: metadata.message, type: 'invalid_request_error', param: 'metadata', code: 'invalid_metadata' } });
  }
  // The upstream gets the model key; the response says `model` as the caller wrote it.
  chat.model = modelKey;
  const context = { id: newModelResponseId(), createdAt: Math.floor(startedAt / 1000) };

  try {
    const outcome = await runModelChatCompletion(auth, chat, { modelKey, route: USAGE_ROUTE });
    if (outcome.kind === 'refused') return reply.code(outcome.status).send(openAiEnvelopeOf(outcome.body));
    const { result } = outcome;
    if (result.stream) {
      applyStreamHeaders(reply, result.requestId);
      const events = chatStreamToResponses(result.stream as ReadableStream<Uint8Array>, body, context);
      return reply.send(Readable.fromWeb(events as unknown as NodeReadableStream<Uint8Array>));
    }
    return reply.code(200).header('X-Request-Id', result.requestId).send(chatCompletionToResponse(result.response ?? {}, body, context));
  } catch (error) {
    logger.error('Client model response error', { error });
    const failure = await modelChatFailure(request, auth, { modelKey, body: chat, startedAt, route: USAGE_ROUTE }, error);
    return reply.code(failure.status).send(openAiEnvelopeOf(failure.body));
  }
}
