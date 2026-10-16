/**
 * MCP SSE across nodes: the stream lives on the node that served `GET /sse`,
 * the `POST /message` can land on another. Two managers share one fake Redis
 * (KV + pub/sub) to model that.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRelayTransportForTests, type RelayTransport } from '@/lib/core/cluster/streamRelay';
import {
  createSseSession,
  deliverSseResponse,
  getRemoteSseSession,
  getRemoteSseSessionFor,
  getSseSession,
  removeSseSession,
} from '@/lib/services/mcp/sseSessionManager';

function fakeRedis(): RelayTransport & { kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const subs = new Map<string, Set<(m: string) => void>>();
  return {
    kv,
    async publish(channel, message) {
      for (const l of subs.get(channel) ?? []) l(message);
    },
    async subscribe(channel, onMessage) {
      const set = subs.get(channel) ?? new Set();
      subs.set(channel, set);
      set.add(onMessage);
      return async () => { set.delete(onMessage); };
    },
    async setKey(key, value) { kv.set(key, value); },
    async getKey(key) { return kv.get(key) ?? null; },
    async delKey(key) { kv.delete(key); },
  };
}

function makeSession(serverKey = 'srv', tenantId = 't1') {
  const chunks: string[] = [];
  const controller = { enqueue: (b: Uint8Array) => chunks.push(new TextDecoder().decode(b)) } as unknown as ReadableStreamDefaultController;
  return {
    chunks,
    session: { serverKey, tenantId, tenantDbName: 'db', projectId: undefined, tokenId: undefined, controller },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  setRelayTransportForTests(undefined);
  vi.useRealTimers();
});

describe('MCP SSE session relay', () => {
  it('delivers a response into the stream when the id is not held locally', async () => {
    const redis = fakeRedis();
    setRelayTransportForTests(redis);
    const { session, chunks } = makeSession();
    createSseSession('s1', session);
    await tick();

    expect(await getRemoteSseSession('s1')).toEqual({ serverKey: 'srv', tenantId: 't1', projectId: undefined, principal: 'public' });

    // The cross-node lookup also checks the binding the stream was opened under.
    const binding = { tenantId: 't1', serverKey: 'srv', principal: 'public' };
    expect(await getRemoteSseSessionFor('s1', binding)).toBeDefined();
    expect(await getRemoteSseSessionFor('s1', { ...binding, principal: 'token:abc' })).toBeUndefined();
    expect(await getRemoteSseSessionFor('s1', { ...binding, tenantId: 't2' })).toBeUndefined();
    expect(await getRemoteSseSessionFor('s1', { ...binding, serverKey: 'other' })).toBeUndefined();
    expect(await getRemoteSseSessionFor('s1', { ...binding, projectId: 'p1' })).toBeUndefined();

    // Simulate "another node": it does not hold the session locally.
    const local = getSseSession('s1');
    expect(local).toBeDefined();
    await redis.publish('mcp:sse:down:s1', JSON.stringify({ id: 1, result: {} }));
    expect(chunks.join('')).toContain('event: message');
    expect(chunks.join('')).toContain('"id":1');
    removeSseSession('s1');
  });

  it('writes locally without touching Redis when the stream is local', async () => {
    const redis = fakeRedis();
    const publish = vi.spyOn(redis, 'publish');
    setRelayTransportForTests(redis);
    const { session, chunks } = makeSession();
    createSseSession('s2', session);
    await tick();
    await deliverSseResponse('s2', { id: 2 });
    expect(chunks.join('')).toContain('"id":2');
    expect(publish).not.toHaveBeenCalled();
    removeSseSession('s2');
  });

  it('publishes over Redis for an unknown local id', async () => {
    const redis = fakeRedis();
    const publish = vi.spyOn(redis, 'publish');
    setRelayTransportForTests(redis);
    await deliverSseResponse('elsewhere', { id: 3 });
    expect(publish).toHaveBeenCalledWith('mcp:sse:down:elsewhere', JSON.stringify({ id: 3 }));
  });

  it('removes the registry key when the session closes', async () => {
    const redis = fakeRedis();
    setRelayTransportForTests(redis);
    const { session } = makeSession();
    createSseSession('s3', session);
    await tick();
    expect(redis.kv.has('mcp:sse:session:s3')).toBe(true);
    removeSseSession('s3');
    await tick();
    expect(redis.kv.has('mcp:sse:session:s3')).toBe(false);
  });

  it('sends keep-alive pings and refreshes the registry', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const setKey = vi.spyOn(redis, 'setKey');
    setRelayTransportForTests(redis);
    const { session, chunks } = makeSession();
    createSseSession('s4', session);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chunks.join('')).toContain(': keepalive');
    expect(setKey.mock.calls.length).toBeGreaterThanOrEqual(2);
    removeSseSession('s4');
  });

  it('does not match a record that carries no principal', async () => {
    const redis = fakeRedis();
    setRelayTransportForTests(redis);
    redis.kv.set('mcp:sse:session:legacy', JSON.stringify({ serverKey: 'srv', tenantId: 't1' }));
    expect(await getRemoteSseSession('legacy')).toBeDefined();
    expect(await getRemoteSseSessionFor('legacy', { tenantId: 't1', serverKey: 'srv', principal: 'public' })).toBeUndefined();
  });

  it('has no remote lookup without Redis', async () => {
    setRelayTransportForTests(null);
    expect(await getRemoteSseSession('x')).toBeUndefined();
    const { session } = makeSession();
    createSseSession('s5', session);
    expect(getSseSession('s5')).toBeDefined();
    await expect(deliverSseResponse('nobody', {})).resolves.toBeUndefined();
    removeSseSession('s5');
  });
});
