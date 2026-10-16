/**
 * The SSE response the MCP plugins share: the session it registers lives
 * exactly as long as the response — it is removed when the response closes,
 * finishes or errors, or when its socket does — and a stream over a limit is
 * answered with a status, a Retry-After and a JSON body instead.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/core/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/core/logger')>()),
  createLogger: () => log,
}));

import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { PUBLIC_SSE_PRINCIPAL, sseSessionCount, removeSseSession } from '@/lib/services/mcp/sseSessionManager';
import { startMcpSseResponse } from '@/server/api/mcpTransport';

const originalSource = getConfigSource();

class FakeSocket extends EventEmitter {
  destroyed = false;
}

class FakeRawResponse extends EventEmitter {
  destroyed = false;
  headers = new Map<string, string>();
  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }
}

interface Harness {
  request: FastifyRequest;
  reply: FastifyReply;
  socket: FakeSocket;
  raw: FakeRawResponse;
  sent: { payload: unknown; status?: number; headers: Record<string, string> };
}

function harness(): Harness {
  const socket = new FakeSocket();
  const raw = new FakeRawResponse();
  const sent: Harness['sent'] = { payload: undefined, headers: {} };
  const reply = {
    raw,
    code(status: number) {
      sent.status = status;
      return reply;
    },
    header(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(payload: unknown) {
      sent.payload = payload;
      return reply;
    },
  } as unknown as FastifyReply;
  const request = { raw: { socket } } as unknown as FastifyRequest;
  return { request, reply, socket, raw, sent };
}

const publicSession = {
  serverKey: 'srv',
  tenantDbName: 'tenant_a',
  tenantId: 'tenant-a',
  projectId: 'proj-1',
  tokenId: undefined,
  principal: PUBLIC_SSE_PRINCIPAL,
};

function start(h: Harness, session = publicSession) {
  return startMcpSseResponse(h.request, h.reply, {
    messagePath: '/api/public/mcp/t/s/message',
    session,
    logFields: {},
  });
}

beforeEach(() => {
  setConfigSource({ name: 'test', get: () => undefined });
  vi.clearAllMocks();
});

afterEach(() => {
  setConfigSource(originalSource);
  // Sessions the tests leave behind would count against the next one.
  const leftover = sseSessionCount();
  if (leftover) throw new Error(`${leftover} session(s) left behind`);
});

describe('a session lives as long as its response', () => {
  it('registers a session and streams to the response', () => {
    const h = harness();
    start(h);
    expect(sseSessionCount()).toBe(1);
    expect(h.raw.headers.get('content-type')).toBe('text/event-stream');
    expect(h.raw.headers.get('x-mcp-session-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.sent.payload).toBeDefined();
    removeSseSession(h.raw.headers.get('x-mcp-session-id') as string);
  });

  it.each([
    ['the response closes', (h: Harness) => h.raw.emit('close')],
    ['the response finishes', (h: Harness) => h.raw.emit('finish')],
    ['the response errors', (h: Harness) => h.raw.emit('error', new Error('write after end'))],
    ['the socket closes', (h: Harness) => h.socket.emit('close')],
    ['the socket errors', (h: Harness) => h.socket.emit('error', new Error('ECONNRESET'))],
  ])('is removed when %s', (_label, end) => {
    const h = harness();
    // An 'error' event with no listener would throw; the real response has the server's.
    h.raw.on('error', () => undefined);
    h.socket.on('error', () => undefined);
    start(h);
    expect(sseSessionCount()).toBe(1);
    end(h);
    expect(sseSessionCount()).toBe(0);
  });

  it('lets go of the socket, so a connection serving many streams collects no listeners', () => {
    const h = harness();
    start(h);
    expect(h.socket.listenerCount('close')).toBe(1);
    h.raw.emit('close');
    expect(h.socket.listenerCount('close')).toBe(0);
    expect(h.socket.listenerCount('error')).toBe(0);
  });

  it('is removed straight away when the response is already gone', () => {
    const h = harness();
    h.raw.destroyed = true;
    start(h);
    expect(sseSessionCount()).toBe(0);
  });

  it('is removed straight away when the socket is already gone', () => {
    const h = harness();
    h.socket.destroyed = true;
    start(h);
    expect(sseSessionCount()).toBe(0);
  });

  it('runs the session\'s cleanup once, whichever of the endings come first', () => {
    const h = harness();
    const onClose = vi.fn();
    start(h, { ...publicSession, onClose } as typeof publicSession);
    h.raw.emit('close');
    h.raw.emit('finish');
    h.socket.emit('close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/));
  });
});

describe('a stream over a limit', () => {
  it('is answered with the status, a Retry-After and a JSON body, and registers nothing', () => {
    setConfigSource({ name: 'test', get: (key) => (key === 'MCP_SSE_MAX_SESSIONS' ? '1' : undefined) });
    const first = harness();
    start(first, { ...publicSession, principal: 'token:t1' });
    expect(sseSessionCount()).toBe(1);

    const refused = harness();
    start(refused, { ...publicSession, principal: 'token:t1' });
    expect(refused.sent.status).toBe(503);
    expect(Number(refused.sent.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(refused.sent.payload).toEqual({ error: expect.any(String) });
    expect(refused.raw.headers.get('content-type')).toBeUndefined();
    expect(refused.raw.listenerCount('close')).toBe(0);
    expect(sseSessionCount()).toBe(1);

    first.raw.emit('close');
  });

  it('is logged once in a while, however many streams are refused', () => {
    vi.useFakeTimers();
    try {
      setConfigSource({ name: 'test', get: (key) => (key === 'MCP_SSE_MAX_SESSIONS' ? '1' : undefined) });
      const held = harness();
      start(held, { ...publicSession, principal: 'token:t1' });
      vi.clearAllMocks();

      // Past the quiet period of whatever an earlier test logged.
      vi.setSystemTime(Date.now() + 60_000);
      for (let i = 0; i < 5; i += 1) start(harness(), { ...publicSession, principal: 'token:t1' });
      expect(log.warn).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 31_000);
      start(harness(), { ...publicSession, principal: 'token:t1' });
      expect(log.warn).toHaveBeenCalledTimes(2);

      held.raw.emit('close');
    } finally {
      vi.useRealTimers();
    }
  });
});
