/**
 * The in-memory registry behind the MCP SSE transport: a session belongs to
 * the stream that opened it (tenant, server, principal), the registry is
 * bounded (process-wide and per-address caps, idle timeout, backlog bound),
 * and a session never outlives its stream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import {
  closeSseSession,
  createSseSession,
  encodeSseEndpointEvent,
  getSseSession,
  getSseSessionFor,
  McpSseLimitError,
  openSseStream,
  PUBLIC_SSE_PRINCIPAL,
  removeSseSession,
  sendSseResponse,
  sseSessionCount,
  sweepSseSessions,
  tokenSsePrincipal,
  type McpSseBinding,
  type McpSseSession,
} from '@/lib/services/mcp/sseSessionManager';

const originalSource = getConfigSource();

function setTestConfig(values: Record<string, string | undefined> = {}) {
  const source: ConfigSource = { name: 'test', get: (key) => values[key] };
  setConfigSource(source);
}

const decoder = new TextDecoder();

type SessionInit = Omit<McpSseSession, 'controller'>;

function init(overrides: Partial<SessionInit> = {}): SessionInit {
  return {
    serverKey: 'srv',
    tenantDbName: 'tenant_a',
    tenantId: 'tenant-a',
    projectId: 'proj-1',
    tokenId: undefined,
    principal: PUBLIC_SSE_PRINCIPAL,
    ...overrides,
  };
}

function binding(overrides: Partial<McpSseBinding> = {}): McpSseBinding {
  return {
    tenantId: 'tenant-a',
    projectId: 'proj-1',
    serverKey: 'srv',
    principal: PUBLIC_SSE_PRINCIPAL,
    ...overrides,
  };
}

let nextId = 0;
const ids: string[] = [];
function newId(): string {
  const id = `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;
  ids.push(id);
  return id;
}

/** Open a stream and return a reader that collects what the client would receive. */
function open(sessionInit: SessionInit = init(), sessionId = newId()) {
  const stream = openSseStream({ sessionId, session: sessionInit, messageEndpoint: `/msg?sessionId=${sessionId}` });
  const reader = stream.getReader();
  const received: string[] = [];
  return {
    sessionId,
    stream,
    reader,
    received,
    /** Read one chunk (the stream must have one queued). */
    async next() {
      const { value, done } = await reader.read();
      if (!done && value) received.push(decoder.decode(value));
      return { value: value ? decoder.decode(value) : undefined, done };
    },
  };
}

beforeEach(() => {
  setTestConfig();
});

afterEach(() => {
  for (const id of ids.splice(0)) removeSseSession(id);
  setConfigSource(originalSource);
  vi.useRealTimers();
});

describe('opening a stream', () => {
  it('registers the session and sends the endpoint event first', async () => {
    const s = open();
    expect(getSseSession(s.sessionId)).toBeDefined();
    const first = await s.next();
    expect(first.value).toBe(`event: endpoint\ndata: /msg?sessionId=${s.sessionId}\n\n`);
  });

  it('removes the session when the stream is cancelled', async () => {
    const s = open();
    await s.reader.cancel();
    expect(getSseSession(s.sessionId)).toBeUndefined();
  });

  it('keeps the endpoint on one line', () => {
    expect(decoder.decode(encodeSseEndpointEvent('/a\r\nevent: message\ndata: x'))).toBe(
      'event: endpoint\ndata: /aevent: messagedata: x\n\n',
    );
  });

  it('delivers a JSON-RPC response as a message event', async () => {
    const s = open();
    await s.next();
    expect(sendSseResponse(s.sessionId, { jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    const frame = await s.next();
    expect(frame.value).toBe('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
  });

  it('does not deliver into a session that is gone', () => {
    expect(sendSseResponse(newId(), { id: 1 })).toBe(false);
  });
});

describe('session binding', () => {
  it('hands the session to the caller that presents the binding it was opened with', () => {
    const s = open(init({ tokenId: 'tok-1', principal: tokenSsePrincipal('tok-1') }));
    expect(getSseSessionFor(s.sessionId, binding({ principal: tokenSsePrincipal('tok-1') }))).toBeDefined();
  });

  it.each([
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another server', { serverKey: 'other' }],
    ['another project', { projectId: 'proj-2' }],
    ['no project', { projectId: undefined }],
    ['another principal', { principal: tokenSsePrincipal('tok-2') }],
    ['the public principal', { principal: PUBLIC_SSE_PRINCIPAL }],
  ])('treats a session opened for %s like an unknown one', (_label, override) => {
    const s = open(init({ tokenId: 'tok-1', principal: tokenSsePrincipal('tok-1') }));
    expect(getSseSessionFor(s.sessionId, binding({ principal: tokenSsePrincipal('tok-1'), ...override }))).toBeUndefined();
  });

  it('does not hand a public session to a token caller', () => {
    const s = open(init());
    expect(getSseSessionFor(s.sessionId, binding({ principal: tokenSsePrincipal('tok-1') }))).toBeUndefined();
    expect(getSseSessionFor(s.sessionId, binding())).toBeDefined();
  });

  it('never matches a token principal that has no id against the public one', () => {
    const s = open(init({ tokenId: undefined, principal: tokenSsePrincipal(undefined) }));
    expect(getSseSessionFor(s.sessionId, binding())).toBeUndefined();
  });

  it('derives the principal from the token id for a session registered the old way', () => {
    const id = newId();
    createSseSession(id, { ...init({ tokenId: 'tok-9', principal: undefined }), controller: null });
    expect(getSseSessionFor(id, binding({ principal: tokenSsePrincipal('tok-9') }))).toBeDefined();
    expect(getSseSessionFor(id, binding())).toBeUndefined();
  });

  it('does not know an id it never issued', () => {
    expect(getSseSessionFor(newId(), binding())).toBeUndefined();
  });
});

describe('caps', () => {
  it('refuses a stream over the process-wide cap with 503 and a retry hint', () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS: '2' });
    open(init({ principal: tokenSsePrincipal('t') }));
    open(init({ principal: tokenSsePrincipal('t') }));
    let error: unknown;
    try {
      open(init({ principal: tokenSsePrincipal('t') }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(McpSseLimitError);
    expect((error as McpSseLimitError).status).toBe(503);
    expect((error as McpSseLimitError).retryAfterSeconds).toBeGreaterThan(0);
    expect(sseSessionCount()).toBe(2);
  });

  it('frees the slot when a session ends', async () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS: '1' });
    const first = open(init({ principal: tokenSsePrincipal('t') }));
    expect(() => open(init({ principal: tokenSsePrincipal('t') }))).toThrow(McpSseLimitError);
    removeSseSession(first.sessionId);
    expect(() => open(init({ principal: tokenSsePrincipal('t') }))).not.toThrow();
  });

  it('keeps the last quarter of the process cap for token callers', () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS: '4' });
    open(init({ clientIp: '203.0.113.1' }));
    open(init({ clientIp: '203.0.113.2' }));
    open(init({ clientIp: '203.0.113.3' }));
    expect(() => open(init({ clientIp: '203.0.113.4' }))).toThrow(McpSseLimitError);
    expect(() => open(init({ principal: tokenSsePrincipal('t') }))).not.toThrow();
    expect(sseSessionCount()).toBe(4);
  });

  it('refuses a public stream over the per-address cap with 429', () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS_PER_IP: '2' });
    open(init({ clientIp: '203.0.113.9' }));
    open(init({ clientIp: '203.0.113.9' }));
    let error: unknown;
    try {
      open(init({ clientIp: '203.0.113.9' }));
    } catch (e) {
      error = e;
    }
    expect((error as McpSseLimitError).status).toBe(429);
    // Another address is unaffected.
    expect(() => open(init({ clientIp: '203.0.113.10' }))).not.toThrow();
  });

  it('does not apply the per-address cap to token streams', () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS_PER_IP: '1' });
    open(init({ principal: tokenSsePrincipal('t'), clientIp: '203.0.113.9' }));
    expect(() => open(init({ principal: tokenSsePrincipal('t'), clientIp: '203.0.113.9' }))).not.toThrow();
  });

  it('counts an address down as its sessions end', () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS_PER_IP: '1' });
    const first = open(init({ clientIp: '203.0.113.9' }));
    expect(() => open(init({ clientIp: '203.0.113.9' }))).toThrow(McpSseLimitError);
    removeSseSession(first.sessionId);
    expect(() => open(init({ clientIp: '203.0.113.9' }))).not.toThrow();
  });

  it('applies the caps to sessions registered the old way too', () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS: '1' });
    createSseSession(newId(), { ...init({ principal: tokenSsePrincipal('t') }), controller: null });
    expect(() => createSseSession(newId(), { ...init({ principal: tokenSsePrincipal('t') }), controller: null }))
      .toThrow(McpSseLimitError);
  });

  it('turns each cap off with 0', () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS: '0', MCP_SSE_MAX_SESSIONS_PER_IP: '0' });
    for (let i = 0; i < 5; i += 1) open(init({ clientIp: '203.0.113.9' }));
    expect(sseSessionCount()).toBe(5);
  });

  it('registers nothing for a refused stream', () => {
    setTestConfig({ MCP_SSE_MAX_SESSIONS: '1' });
    open(init({ principal: tokenSsePrincipal('t') }));
    expect(() => open(init({ principal: tokenSsePrincipal('t') }))).toThrow();
    expect(sseSessionCount()).toBe(1);
  });
});

describe('cleanup', () => {
  it('runs onClose once, with the session id, however the session ends', () => {
    const onClose = vi.fn();
    const s = open(init({ onClose }));
    removeSseSession(s.sessionId);
    removeSseSession(s.sessionId);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(s.sessionId);
  });

  it('runs onClose when the stream is cancelled', async () => {
    const onClose = vi.fn();
    const s = open(init({ onClose }));
    await s.reader.cancel();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('survives an onClose that throws', () => {
    const s = open(init({ onClose: () => { throw new Error('boom'); } }));
    expect(() => removeSseSession(s.sessionId)).not.toThrow();
    expect(getSseSession(s.sessionId)).toBeUndefined();
  });

  it('finishes the stream when the gateway closes the session', async () => {
    const s = open();
    await s.next();
    closeSseSession(s.sessionId, 'test');
    expect(getSseSession(s.sessionId)).toBeUndefined();
    expect((await s.next()).done).toBe(true);
  });
});

describe('idle timeout', () => {
  it('closes a session that received no message within the timeout', async () => {
    setTestConfig({ MCP_SSE_IDLE_TIMEOUT_MS: '1000', MCP_SSE_KEEPALIVE_MS: '0' });
    const s = open();
    await s.next();
    sweepSseSessions(Date.now() + 999);
    expect(getSseSession(s.sessionId)).toBeDefined();
    sweepSseSessions(Date.now() + 1001);
    expect(getSseSession(s.sessionId)).toBeUndefined();
    expect((await s.next()).done).toBe(true);
  });

  it('counts a message for the session as activity', () => {
    setTestConfig({ MCP_SSE_IDLE_TIMEOUT_MS: '1000', MCP_SSE_KEEPALIVE_MS: '0' });
    vi.useFakeTimers();
    const s = open();
    vi.setSystemTime(Date.now() + 800);
    expect(getSseSessionFor(s.sessionId, binding())).toBeDefined();
    vi.setSystemTime(Date.now() + 800);
    sweepSseSessions();
    expect(getSseSession(s.sessionId)).toBeDefined();
    vi.setSystemTime(Date.now() + 300);
    sweepSseSessions();
    expect(getSseSession(s.sessionId)).toBeUndefined();
  });

  it('does not count a message presented with the wrong binding', () => {
    setTestConfig({ MCP_SSE_IDLE_TIMEOUT_MS: '1000', MCP_SSE_KEEPALIVE_MS: '0' });
    vi.useFakeTimers();
    const s = open();
    vi.setSystemTime(Date.now() + 800);
    expect(getSseSessionFor(s.sessionId, binding({ tenantId: 'someone-else' }))).toBeUndefined();
    vi.setSystemTime(Date.now() + 300);
    sweepSseSessions();
    expect(getSseSession(s.sessionId)).toBeUndefined();
  });

  it('does not count its own keep-alive comments as activity', async () => {
    setTestConfig({ MCP_SSE_IDLE_TIMEOUT_MS: '60000', MCP_SSE_KEEPALIVE_MS: '10000' });
    vi.useFakeTimers();
    const s = open();
    await s.next();
    for (let i = 1; i <= 5; i += 1) {
      vi.setSystemTime(Date.now() + 10_000);
      sweepSseSessions();
    }
    // Five keep-alives went out, yet the session is idle for 50 s only.
    expect(getSseSession(s.sessionId)).toBeDefined();
    vi.setSystemTime(Date.now() + 10_001);
    sweepSseSessions();
    expect(getSseSession(s.sessionId)).toBeUndefined();
  });

  it('never closes a session when the timeout is 0', () => {
    setTestConfig({ MCP_SSE_IDLE_TIMEOUT_MS: '0', MCP_SSE_KEEPALIVE_MS: '0' });
    const s = open();
    sweepSseSessions(Date.now() + 10 * 24 * 3600 * 1000);
    expect(getSseSession(s.sessionId)).toBeDefined();
  });
});

describe('keep-alive', () => {
  it('writes a comment frame to a stream that has been quiet', async () => {
    setTestConfig({ MCP_SSE_KEEPALIVE_MS: '5000', MCP_SSE_IDLE_TIMEOUT_MS: '0' });
    const s = open();
    await s.next();
    sweepSseSessions(Date.now() + 4000);
    sweepSseSessions(Date.now() + 5001);
    const frame = await s.next();
    expect(frame.value).toBe(': keepalive\n\n');
  });

  it('leaves a stream that was written to recently alone', async () => {
    setTestConfig({ MCP_SSE_KEEPALIVE_MS: '5000', MCP_SSE_IDLE_TIMEOUT_MS: '0' });
    const s = open();
    await s.next();
    sweepSseSessions(Date.now() + 1000);
    sendSseResponse(s.sessionId, { id: 1 });
    // The first frame after the endpoint event is the response: the early
    // sweep queued no keep-alive in front of it.
    expect((await s.next()).value).toContain('event: message');
  });

  it('can be turned off', async () => {
    setTestConfig({ MCP_SSE_KEEPALIVE_MS: '0', MCP_SSE_IDLE_TIMEOUT_MS: '0' });
    const s = open();
    await s.next();
    sweepSseSessions(Date.now() + 3600_000);
    sendSseResponse(s.sessionId, { id: 1 });
    expect((await s.next()).value).toContain('event: message');
  });
});

describe('backlog bound', () => {
  it('closes a session whose client stopped reading, and discards what was queued', async () => {
    setTestConfig({ MCP_SSE_MAX_BUFFERED_BYTES: '2048', MCP_SSE_KEEPALIVE_MS: '0', MCP_SSE_IDLE_TIMEOUT_MS: '0' });
    const s = open();
    // Nothing is read: every response piles up in the stream's queue.
    const big = { result: 'x'.repeat(1500) };
    expect(sendSseResponse(s.sessionId, big)).toBe(true);
    expect(sendSseResponse(s.sessionId, big)).toBe(true);
    // The backlog is now past the bound: the next response closes the session.
    expect(sendSseResponse(s.sessionId, big)).toBe(false);
    expect(getSseSession(s.sessionId)).toBeUndefined();
    await expect(s.reader.read()).rejects.toThrow(/not reading/);
    expect(sendSseResponse(s.sessionId, big)).toBe(false);
  });

  it('accepts one frame larger than the bound while the backlog is small', () => {
    setTestConfig({ MCP_SSE_MAX_BUFFERED_BYTES: '1024', MCP_SSE_KEEPALIVE_MS: '0', MCP_SSE_IDLE_TIMEOUT_MS: '0' });
    const s = open();
    expect(sendSseResponse(s.sessionId, { result: 'x'.repeat(5000) })).toBe(true);
    expect(getSseSession(s.sessionId)).toBeDefined();
  });

  it('keeps a client that reads as fast as it is written to', async () => {
    setTestConfig({ MCP_SSE_MAX_BUFFERED_BYTES: '2048', MCP_SSE_KEEPALIVE_MS: '0', MCP_SSE_IDLE_TIMEOUT_MS: '0' });
    const s = open();
    await s.next();
    for (let i = 0; i < 20; i += 1) {
      expect(sendSseResponse(s.sessionId, { result: 'x'.repeat(1500) })).toBe(true);
      await s.next();
    }
    expect(getSseSession(s.sessionId)).toBeDefined();
  });

  it('does not bound the backlog when the bound is 0', () => {
    setTestConfig({ MCP_SSE_MAX_BUFFERED_BYTES: '0', MCP_SSE_KEEPALIVE_MS: '0', MCP_SSE_IDLE_TIMEOUT_MS: '0' });
    const s = open();
    for (let i = 0; i < 50; i += 1) {
      expect(sendSseResponse(s.sessionId, { result: 'x'.repeat(1500) })).toBe(true);
    }
    expect(getSseSession(s.sessionId)).toBeDefined();
  });
});
