/**
 * An agent turn streamed as OpenAI Responses server-sent events (§5.3 event
 * vocabulary): `response.created` / `response.in_progress`, a message item
 * (`response.output_item.added` → `response.content_part.added` →
 * `response.output_text.delta`… → `.done`s), a reasoning item when the agent
 * shows reasoning (`response.reasoning_summary_*`), then
 * `response.completed` | `response.incomplete` | `response.failed`, or an
 * `error` event. Every `data` carries `type` and `sequence_number`; a `: ping`
 * comment keeps idle proxies from closing the connection.
 */

import type { FastifyReply } from 'fastify';
import { applyStreamHeaders } from '../fastify-utils';

const PING_INTERVAL_MS = 15_000;

export interface ResponsesStreamWriter {
  /** The response the stream is about (id known): `response.created` + `response.in_progress`. */
  started(response: Record<string, unknown>): void;
  text(delta: string): void;
  reasoning(delta: string): void;
  /** The final object; its `status` picks the closing event. */
  finish(response: Record<string, unknown>): void;
  error(error: { message: string; code?: string | null; type?: string }, response?: Record<string, unknown>): void;
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
  end(): void;
}

export function createResponsesStreamWriter(reply: FastifyReply): ResponsesStreamWriter {
  applyStreamHeaders(reply);
  reply.raw.flushHeaders?.();
  const controller = new AbortController();
  let ended = false;
  reply.raw.on('close', () => { if (!ended) controller.abort(); });

  let sequence = 0;
  const write = (chunk: string) => {
    if (ended || controller.signal.aborted) return;
    try {
      reply.raw.write(chunk);
    } catch {
      controller.abort();
    }
  };
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  };
  const ping = setInterval(() => write(': ping\n\n'), PING_INTERVAL_MS);
  ping.unref?.();

  let responseId = '';
  let outputIndex = -1;
  let message: { id: string; index: number; text: string } | null = null;
  let reasoningItem: { id: string; index: number; text: string } | null = null;

  const closeReasoning = () => {
    if (!reasoningItem) return;
    const { id, index, text } = reasoningItem;
    emit('response.reasoning_summary_text.done', { item_id: id, output_index: index, summary_index: 0, text });
    emit('response.reasoning_summary_part.done', { item_id: id, output_index: index, summary_index: 0, part: { type: 'summary_text', text } });
    emit('response.output_item.done', { output_index: index, item: { id, type: 'reasoning', summary: [{ type: 'summary_text', text }] } });
    reasoningItem = null;
  };
  const closeMessage = () => {
    if (!message) return;
    const { id, index, text } = message;
    const part = { type: 'output_text', text, annotations: [] };
    emit('response.output_text.done', { item_id: id, output_index: index, content_index: 0, text });
    emit('response.content_part.done', { item_id: id, output_index: index, content_index: 0, part });
    emit('response.output_item.done', {
      output_index: index,
      item: { id, type: 'message', role: 'assistant', status: 'completed', content: [part] },
    });
    message = null;
  };

  return {
    signal: controller.signal,
    started(response) {
      responseId = String(response.id ?? '');
      emit('response.created', { response });
      emit('response.in_progress', { response });
    },
    reasoning(delta) {
      if (!delta) return;
      if (!reasoningItem) {
        closeMessage();
        reasoningItem = { id: `rs_${responseId}_${outputIndex + 1}`, index: ++outputIndex, text: '' };
        emit('response.output_item.added', { output_index: reasoningItem.index, item: { id: reasoningItem.id, type: 'reasoning', summary: [] } });
        emit('response.reasoning_summary_part.added', {
          item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, part: { type: 'summary_text', text: '' },
        });
      }
      reasoningItem.text += delta;
      emit('response.reasoning_summary_text.delta', { item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, delta });
    },
    text(delta) {
      if (!delta) return;
      if (!message) {
        closeReasoning();
        message = { id: `msg_${responseId}_${outputIndex + 1}`, index: ++outputIndex, text: '' };
        emit('response.output_item.added', {
          output_index: message.index,
          item: { id: message.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        });
        emit('response.content_part.added', {
          item_id: message.id, output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      message.text += delta;
      emit('response.output_text.delta', { item_id: message.id, output_index: message.index, content_index: 0, delta });
    },
    finish(response) {
      closeReasoning();
      closeMessage();
      const status = response.status;
      emit(status === 'failed' ? 'response.failed' : status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
    },
    error(error, response) {
      closeReasoning();
      closeMessage();
      emit('error', { code: error.code ?? null, message: error.message, ...(error.type ? { error_type: error.type } : {}) });
      if (response) emit('response.failed', { response });
    },
    end() {
      clearInterval(ping);
      ended = true;
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  };
}
