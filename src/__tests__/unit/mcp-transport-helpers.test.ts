/**
 * Helpers shared by the MCP HTTP plugins: reading a JSON-RPC request, the
 * content-type rule for JSON bodies, the URL a stream advertises for its
 * messages, and the lookup of the session a message names.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import {
  createSseSession,
  PUBLIC_SSE_PRINCIPAL,
  removeSseSession,
  tokenSsePrincipal,
} from '@/lib/services/mcp/sseSessionManager';
import {
  hasJsonContentType,
  jsonRpcErrorBody,
  lookupMessageSession,
  mcpEndpointUrl,
  readJsonObjectBody,
  readJsonRpcRequest,
} from '@/server/api/mcpTransport';

const originalSource = getConfigSource();

function requestWith(parts: {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
}): FastifyRequest {
  return { body: parts.body, headers: parts.headers ?? {}, query: parts.query ?? {} } as unknown as FastifyRequest;
}

afterEach(() => {
  setConfigSource(originalSource);
});

describe('readJsonRpcRequest', () => {
  it('returns a JSON object body, given as text or already parsed', () => {
    expect(readJsonRpcRequest(requestWith({ body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }))).toEqual({
      ok: true,
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(readJsonRpcRequest(requestWith({ body: { method: 'ping' } }))).toEqual({ ok: true, body: { method: 'ping' } });
    expect(readJsonRpcRequest(requestWith({ body: Buffer.from('{"method":"ping"}') }))).toEqual({
      ok: true,
      body: { method: 'ping' },
    });
  });

  it.each([['{'], [''], ['not json'], ['{"method":']])('reports %j as a parse error', (body) => {
    expect(readJsonRpcRequest(requestWith({ body }))).toEqual({ ok: false, code: -32700, message: 'Parse error' });
  });

  it('reports a missing body as a parse error', () => {
    expect(readJsonRpcRequest(requestWith({ body: undefined }))).toMatchObject({ ok: false, code: -32700 });
  });

  it.each([['null'], ['[]'], ['[{"method":"ping"}]'], ['123'], ['"ping"'], ['true'], ['false']])(
    'reports %s as an invalid request',
    (body) => {
      expect(readJsonRpcRequest(requestWith({ body }))).toEqual({ ok: false, code: -32600, message: 'Invalid Request' });
    },
  );

  it('does the same for a body the framework already parsed', () => {
    for (const body of [[], 7, true]) {
      expect(readJsonRpcRequest(requestWith({ body })), String(body)).toMatchObject({ ok: false, code: -32600 });
    }
    // Text is read as JSON text; no body at all is not a request.
    expect(readJsonRpcRequest(requestWith({ body: 'x' }))).toMatchObject({ ok: false, code: -32700 });
    expect(readJsonRpcRequest(requestWith({ body: null }))).toMatchObject({ ok: false, code: -32700 });
  });
});

describe('readJsonObjectBody', () => {
  it('returns an object and nothing else', () => {
    expect(readJsonObjectBody(requestWith({ body: '{"tool":"x"}' }))).toEqual({ tool: 'x' });
    for (const body of ['null', '[]', '1', '"x"', '{', '', undefined]) {
      expect(readJsonObjectBody(requestWith({ body })), String(body)).toBeNull();
    }
  });
});

describe('hasJsonContentType', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/JSON;charset=UTF-8', true],
    ['application/vnd.mcp+json', true],
    ['application/problem+json; charset=utf-8', true],
    ['text/plain', false],
    ['text/plain; charset=utf-8', false],
    ['multipart/form-data; boundary=x', false],
    ['application/x-www-form-urlencoded', false],
    ['application/json-seq', false],
    ['application/jsonx', false],
    ['text/json', false],
    ['', false],
  ])('%j -> %s', (contentType, expected) => {
    expect(hasJsonContentType(requestWith({ headers: { 'content-type': contentType } }))).toBe(expected);
  });

  it('is false when the header is absent', () => {
    expect(hasJsonContentType(requestWith({}))).toBe(false);
  });

  it('reads the first of a repeated header', () => {
    expect(hasJsonContentType(requestWith({ headers: { 'content-type': ['application/json', 'text/plain'] } }))).toBe(true);
  });
});

describe('mcpEndpointUrl', () => {
  function useEnv(values: Record<string, string | undefined>) {
    setConfigSource({ name: 'test', get: (key) => values[key] });
  }

  it('is the path and the session id alone', () => {
    useEnv({});
    expect(mcpEndpointUrl('/api/public/mcp/t/s/message', 'abc-123')).toBe('/api/public/mcp/t/s/message?sessionId=abc-123');
  });

  // The configured public URL must make no difference. Each of these values
  // would have produced an absolute URL (or a prefixed one) if it were used.
  it.each([
    ['a public https URL', { APP_URL: 'https://console.example.test' }],
    ['the legacy variable', { NEXT_PUBLIC_APP_URL: 'https://legacy.example.test/' }],
    ['a URL with a port, a path prefix and credentials', { APP_URL: 'https://user:secret@gw.example.test:8443/console/?a=1#f' }],
    ['a plain http URL', { APP_URL: 'http://127.0.0.1:3000' }],
    ['a value that is not a URL', { APP_URL: 'console.example.test' }],
    ['a relative value', { APP_URL: '/relative' }],
    ['another scheme', { APP_URL: 'ftp://files.example.test' }],
  ])('is the same path whatever the configured public URL is: %s', (_label, env) => {
    useEnv(env);
    expect(mcpEndpointUrl('/api/x/message', 'abc')).toBe('/api/x/message?sessionId=abc');
  });

  it('starts with a single slash, so it names no scheme and no host', () => {
    useEnv({ APP_URL: 'https://console.example.test' });
    const endpoint = mcpEndpointUrl('/api/x/message', 'abc');
    expect(endpoint).toMatch(/^\/(?!\/)/);
    expect(endpoint).not.toContain('://');
  });

  it.each([
    ['http://127.0.0.1:3000/api/x/sse'],
    ['https://gateway.internal.example.test/api/x/sse'],
    ['https://public.example.test:8443/api/x/sse'],
  ])('resolves against the URL the stream was opened on: %s', (streamUrl) => {
    useEnv({ APP_URL: 'https://console.example.test' });
    const resolved = new URL(mcpEndpointUrl('/api/x/message', 'abc'), streamUrl);
    const opened = new URL(streamUrl);
    expect(resolved.origin).toBe(opened.origin);
    expect(`${resolved.pathname}${resolved.search}`).toBe('/api/x/message?sessionId=abc');
  });

  it('encodes the session id', () => {
    useEnv({});
    expect(mcpEndpointUrl('/m', 'a b&c')).toBe('/m?sessionId=a%20b%26c');
  });
});

describe('lookupMessageSession', () => {
  const binding = { tenantId: 'tenant-1', projectId: 'proj-1', serverKey: 'srv', principal: tokenSsePrincipal('tok-1') };
  const ids: string[] = [];

  function open(sessionId: string, overrides: Record<string, unknown> = {}) {
    ids.push(sessionId);
    createSseSession(sessionId, {
      serverKey: 'srv',
      tenantDbName: 'tenant_a',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      tokenId: 'tok-1',
      principal: tokenSsePrincipal('tok-1'),
      controller: null,
      ...overrides,
    });
  }

  afterEach(() => {
    for (const id of ids.splice(0)) removeSseSession(id);
  });

  it('is stateless when the request names no session', () => {
    for (const query of [{}, { sessionId: '' }, { sessionId: undefined }]) {
      expect(lookupMessageSession(requestWith({ query }), binding)).toEqual({ kind: 'stateless' });
    }
  });

  it('finds a session opened under the caller\'s binding', () => {
    open('11111111-1111-4111-8111-111111111111');
    const result = lookupMessageSession(requestWith({ query: { sessionId: '11111111-1111-4111-8111-111111111111' } }), binding);
    expect(result.kind).toBe('session');
  });

  it('reports an unknown id, a foreign session and a malformed id alike', () => {
    open('22222222-2222-4222-8222-222222222222', { principal: PUBLIC_SSE_PRINCIPAL, tokenId: undefined });
    for (const sessionId of ['33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', ['a', 'b'], 42, {}]) {
      expect(lookupMessageSession(requestWith({ query: { sessionId } }), binding), String(sessionId)).toEqual({ kind: 'unknown' });
    }
  });
});

describe('jsonRpcErrorBody', () => {
  it('has the JSON-RPC error shape', () => {
    expect(jsonRpcErrorBody(7, -32001, 'Session not found')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32001, message: 'Session not found' },
    });
  });
});
