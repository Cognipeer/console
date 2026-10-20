/**
 * Connected agents set up for Console identity (`connection.authType: console_identity`): what is
 * stored (no credential beside it) and what each request carries (a token for the person behind
 * the call, for the connection's URL, over any other Authorization value). Minting itself is
 * covered by console-identity.test.ts; here it is stubbed so the request can be read exactly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  consoleIdentityHeaders: vi.fn(),
}));

vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));
vi.mock('@/lib/services/providers/providerService', () => ({ loadProviderRuntimeData: vi.fn() }));
vi.mock('@/lib/iam/consoleIdentity', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/iam/consoleIdentity')>()),
  consoleIdentityHeaders: hoisted.consoleIdentityHeaders,
}));

import type { IExternalAgentConnection } from '@/lib/database';
import { ConsoleIdentityError } from '@/lib/iam/consoleIdentity';
import { encryptObject } from '@/lib/utils/crypto';
import { invokeExternalAgent, prepareConnectionForStorage, resetExternalStreamSupportCache } from '@/lib/services/agents/externalAgent';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl';
const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'proj-1' };

function connection(overrides: Partial<IExternalAgentConnection> = {}): IExternalAgentConnection {
  return { protocol: 'openai-chat', url: 'https://agents.example.com/v1', model: 'crm-agent', authType: 'console_identity', ...overrides };
}

function chatResponse(text: string, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content: text } }] } : { error: text }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamResponse(deltas: string[]): Response {
  const body = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sentHeaders(): Record<string, string> {
  return (hoisted.safeFetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
}

beforeEach(() => {
  resetExternalStreamSupportCache();
  hoisted.safeFetch.mockReset();
  hoisted.consoleIdentityHeaders.mockReset();
  hoisted.consoleIdentityHeaders.mockResolvedValue({
    headers: { Authorization: `Bearer ${TOKEN}` },
    token: TOKEN,
    summary: { type: 'console_identity', sub: 'u-1', via: 'session', src: 'portal', jti: 'j' },
  });
});

describe('stored connection', () => {
  it('keeps the auth type and no credential beside it', () => {
    const stored = prepareConnectionForStorage({
      protocol: 'a2a',
      url: 'https://agents.example.com/a2a',
      authType: 'console_identity',
      apiKey: 'sk-live-should-not-be-kept',
      apiKeyEnc: encryptObject('older-key'),
      credentialProviderKey: 'crm-provider',
    });
    expect(stored).toEqual({ protocol: 'a2a', url: 'https://agents.example.com/a2a', authType: 'console_identity' });
  });

  it('ignores an unknown auth type and keeps the stored key flow', () => {
    const stored = prepareConnectionForStorage({ protocol: 'a2a', url: 'https://agents.example.com/a2a', authType: 'magic', apiKey: 'sk-1' });
    expect(stored.authType).toBeUndefined();
    expect(typeof stored.apiKeyEnc).toBe('string');
  });
});

describe('requests', () => {
  it('carries a token for the person behind the call, for the connection URL, over any other Authorization', async () => {
    hoisted.safeFetch.mockResolvedValue(chatResponse('hello'));
    const result = await invokeExternalAgent(
      connection({ headers: { Authorization: 'Bearer static-header', 'X-Tenant': 'crm' } }),
      [{ role: 'user', content: 'hi' }],
      { ...CTX, identity: { userId: 'u-1', source: 'portal', agentKey: 'crm-proxy' } },
      { authorization: 'Bearer runtime-header', 'x-trace-id': 't-1' },
    );
    expect(result.content).toBe('hello');
    expect(hoisted.consoleIdentityHeaders).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      tenantDbName: 'tenant_db',
      audience: 'https://agents.example.com/v1',
      caller: { userId: 'u-1', source: 'portal', agentKey: 'crm-proxy', projectId: 'proj-1' },
    });
    const headers = sentHeaders();
    const authNames = Object.keys(headers).filter((name) => name.toLowerCase() === 'authorization');
    expect(authNames).toEqual(['Authorization']);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['X-Tenant']).toBe('crm');
    expect(headers['x-trace-id']).toBe('t-1');
  });

  it('sends nothing when there is nobody to mint a token for', async () => {
    hoisted.consoleIdentityHeaders.mockRejectedValue(new ConsoleIdentityError('no_person'));
    await expect(invokeExternalAgent(connection(), [{ role: 'user', content: 'hi' }], CTX))
      .rejects.toThrow(/^Console identity: /);
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('masks the token in an error the agent echoes back', async () => {
    hoisted.safeFetch.mockResolvedValue(chatResponse(`bad token ${TOKEN}`, 401));
    const failure = await invokeExternalAgent(connection(), [{ role: 'user', content: 'hi' }], { ...CTX, identity: { userId: 'u-1' } })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('401');
    expect((failure as Error).message).not.toContain(TOKEN);
    expect((failure as Error).stack).not.toContain(TOKEN);
  });

  it('masks the token in an answer that echoes it', async () => {
    hoisted.safeFetch.mockResolvedValue(chatResponse(`your token is ${TOKEN}`));
    const result = await invokeExternalAgent(connection(), [{ role: 'user', content: 'hi' }], { ...CTX, identity: { userId: 'u-1' } });
    expect(result.content).toBe('your token is [redacted]');
    expect(JSON.stringify(result.raw)).not.toContain(TOKEN);
  });

  it('masks the token in a streamed answer, also when it arrives split across chunks', async () => {
    hoisted.safeFetch.mockResolvedValue(streamResponse(['echo: ', TOKEN.slice(0, 12), TOKEN.slice(12), '!']));
    const chunks: string[] = [];
    const result = await invokeExternalAgent(
      connection(),
      [{ role: 'user', content: 'hi' }],
      { ...CTX, identity: { userId: 'u-1' } },
      undefined,
      { onTextChunk: (text) => chunks.push(text) },
    );
    expect(result.streamed).toBe(true);
    expect(chunks.join('')).toBe('echo: [redacted]!');
    expect(chunks.some((text) => text.includes(TOKEN.slice(0, 12)))).toBe(false);
    expect(result.content).toBe('echo: [redacted]!');
  });

  it('leaves a connection without the auth type to its stored key', async () => {
    hoisted.safeFetch.mockResolvedValue(chatResponse('ok'));
    await invokeExternalAgent(
      connection({ authType: undefined, apiKeyEnc: encryptObject('sk-stored') }),
      [{ role: 'user', content: 'hi' }],
      { ...CTX, identity: { userId: 'u-1' } },
    );
    expect(hoisted.consoleIdentityHeaders).not.toHaveBeenCalled();
    expect(sentHeaders().Authorization).toBe('Bearer sk-stored');
  });
});
