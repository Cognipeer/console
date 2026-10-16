/**
 * Helpers for tests of the MCP HTTP plugins: a Fastify app wired like the real
 * server (the production body parsers, request ids), and a small SSE client
 * for tests that need a real socket.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { registerBodyParsers } from '@/server/app';

export interface McpTestAppOptions {
  /** Fastify's `trustProxy`; `true` lets a test pick the client address with X-Forwarded-For. */
  trustProxy?: boolean;
  /** Fastify's global body limit; the server's own default (`NEXT_BODY_SIZE_LIMIT`) is 10 MiB. */
  bodyLimit?: number;
}

/** The plugin under test, registered under `/api` with the server's own body parsers and limit. */
export async function buildMcpTestApp(
  plugin: FastifyPluginAsync,
  options: McpTestAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: options.trustProxy ?? false,
    bodyLimit: options.bodyLimit ?? 10 * 1024 * 1024,
  });
  registerBodyParsers(app);
  app.addHook('onRequest', async (request) => {
    request.apiRequestId = 'test-request';
    request.apiContextHeaders = { 'x-request-id': 'test-request' };
  });
  await app.register(plugin, { prefix: '/api' });
  return app;
}

/** Listen on an ephemeral port of the loopback interface. */
export async function listenOnLoopback(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

export interface SseEvent {
  event: string;
  data: string;
}

export interface SseConnection {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Complete events received so far (comment frames excluded). */
  events: SseEvent[];
  /** Raw text received so far, comment frames included. */
  raw(): string;
  /** Resolves with the first event that satisfies the predicate (already received or still to come). */
  waitForEvent(predicate: (event: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  isEnded(): boolean;
  /** Hang up from the client side. */
  close(): void;
}

/** Open an SSE stream and keep reading it. Resolves once the response headers are in. */
export function connectSse(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      let text = '';
      let pending = '';
      let ended = false;
      const events: SseEvent[] = [];
      const waiters: Array<() => void> = [];
      let markEnded: () => void = () => undefined;
      const endedPromise = new Promise<void>((done) => { markEnded = done; });

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        pending += chunk;
        let boundary = pending.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const lines = frame.split('\n');
          const event = lines.find((line) => line.startsWith('event:'));
          const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
          if (event) events.push({ event: event.slice(6).trim(), data: data.join('\n') });
          boundary = pending.indexOf('\n\n');
        }
        waiters.splice(0).forEach((wake) => wake());
      });
      const finish = () => {
        ended = true;
        markEnded();
        waiters.splice(0).forEach((wake) => wake());
      };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);

      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        events,
        raw: () => text,
        waitForEvent: (predicate, timeoutMs = 3000) => new Promise((ok, fail) => {
          const deadline = setTimeout(() => fail(new Error('Timed out waiting for an SSE event')), timeoutMs);
          const check = () => {
            const found = events.find(predicate);
            if (found) {
              clearTimeout(deadline);
              ok(found);
              return;
            }
            if (ended) {
              clearTimeout(deadline);
              fail(new Error('The stream ended before the expected event'));
              return;
            }
            waiters.push(check);
          };
          check();
        }),
        ended: endedPromise,
        isEnded: () => ended,
        close: () => { request.destroy(); },
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/** One request without an SSE reader; resolves with the whole response. */
export function rawRequest(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: options.path, method: options.method, headers: options.headers, agent: false },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(parts).toString('utf8'),
        }));
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

/** Poll until the condition holds (or fail the test with `message`). */
export async function eventually(condition: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Condition not met in time: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
