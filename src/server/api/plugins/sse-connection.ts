/**
 * The HTTP side of every agent stream that writes its own server-sent events
 * (Responses events, chat-completion chunks): the headers (the ones the route
 * set before the stream opened included), a `: ping` every 15 s so idle
 * proxies keep the connection, and an abort signal for when the client goes
 * away (the run then stops, or carries on detached, per the caller).
 */

import type { FastifyReply } from 'fastify';
import { RESPONSES_PING_INTERVAL_MS } from '@/lib/services/models/responsesWire';
import { applyStreamHeaders } from '../fastify-utils';

export interface SseConnection {
  /** Writes one raw frame; a no-op once the connection is closed. */
  write(chunk: string): void;
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
  end(): void;
}

export function openSseConnection(reply: FastifyReply): SseConnection {
  // Headers the route set on the reply (e.g. X-Cognipeer-Ignored-Params) go out with the raw stream too.
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value as string | number | string[]);
  }
  applyStreamHeaders(reply);
  reply.raw.statusCode = 200;
  reply.raw.flushHeaders?.();
  const controller = new AbortController();
  let ended = false;
  reply.raw.on('close', () => { if (!ended) controller.abort(); });

  const write = (chunk: string) => {
    if (ended || controller.signal.aborted) return;
    try {
      reply.raw.write(chunk);
    } catch {
      controller.abort();
    }
  };
  const ping = setInterval(() => write(': ping\n\n'), RESPONSES_PING_INTERVAL_MS);
  ping.unref?.();

  return {
    write,
    signal: controller.signal,
    end() {
      clearInterval(ping);
      ended = true;
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  };
}
