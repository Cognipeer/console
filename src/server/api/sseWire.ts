/**
 * Shared server-sent-event wire pieces: the frame format and the lazily
 * opened stream used by routes that may answer with plain JSON until their
 * first event.
 */

import type { FastifyReply } from 'fastify';
import { applyStreamHeaders } from './fastify-utils';

/** One SSE frame: optional `id:`, then `event:` and a JSON `data:` line. */
export function formatSseFrame(event: string, data: unknown, id?: number | string): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface LazySseStream {
  /** Opens the stream (headers + any frames queued so far); a no-op when disabled or already open. */
  start(): void;
  /** Writes a frame, or queues it until the stream opens. Ignored when disabled or closed. */
  send(event: string, data: unknown, id?: number): void;
  started(): boolean;
  readonly closed: boolean;
  /** A callback that starts the stream and forwards one kind of progress event. */
  live<A extends unknown[]>(event: string, map: (...args: A) => unknown): (...args: A) => void;
  end(): void;
}

/**
 * An SSE response that opens lazily — at the first event it is given — so a
 * refusal that comes before anything has happened can still be a normal JSON
 * response. Disabled (`enabled` false) it swallows every call.
 */
export function openLazySseStream(reply: FastifyReply, enabled: boolean): LazySseStream {
  let started = false;
  let closed = false;
  const pendingFrames: Array<() => void> = [];
  const write = (event: string, data: unknown, id?: number) => {
    if (closed) return;
    try {
      reply.raw.write(formatSseFrame(event, data, id));
    } catch {
      closed = true;
    }
  };
  const start = () => {
    if (started || !enabled) return;
    started = true;
    applyStreamHeaders(reply);
    reply.raw.flushHeaders?.();
    reply.raw.on('close', () => { closed = true; });
    for (const frame of pendingFrames.splice(0)) frame();
  };
  const send = (event: string, data: unknown, id?: number) => {
    if (!enabled) return;
    if (!started) {
      pendingFrames.push(() => write(event, data, id));
      return;
    }
    write(event, data, id);
  };
  return {
    start,
    send,
    started: () => started,
    get closed() { return closed; },
    live: (event, map) => (...args) => {
      start();
      send(event, map(...args));
    },
    end: () => { if (!closed) reply.raw.end(); },
  };
}
