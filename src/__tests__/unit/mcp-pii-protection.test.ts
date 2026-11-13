/**
 * PII protection of an MCP server's upstream calls (mcpPii.ts, wired into
 * executeMcpToolLocal): the upstream gets tokens, the caller gets the values,
 * and the request log keeps the tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { remoteCallTool, loadPolicyScanner } = vi.hoisted(() => ({
  remoteCallTool: vi.fn(),
  loadPolicyScanner: vi.fn(),
}));

vi.mock('@/lib/services/mcp/remoteMcpClient', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/mcp/remoteMcpClient')>()),
  remoteCallTool,
}));
vi.mock('@/lib/services/pii/piiService', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/pii/piiService')>()),
  loadPolicyScanner,
}));
vi.mock('@/lib/services/models/gatewayPii', () => ({ roundTripSecret: () => 'test-round-trip-secret' }));
vi.mock('@/lib/services/guardrail/hooks/recordCache', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/guardrail/hooks/recordCache')>()),
  resolveTenantDbName: vi.fn().mockResolvedValue('tenant_acme'),
}));
vi.mock('@/lib/services/availability/serviceAvailability', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/availability/serviceAvailability')>()),
  assertServiceEnabled: vi.fn().mockResolvedValue(undefined),
}));

import type { IMcpServer } from '@/lib/database';
import { mcpGuardrailHook, type McpGuardrailContext, type McpGuardrailHook } from '@/enterprise/registry';
import { getMcpGuardrailLogView } from '@/lib/services/guardrail/hooks/mcpHook';
import { executeMcpToolLocal } from '@/lib/services/mcp/mcpService';
import { isMcpPiiProtected, piiLoggedPayloads } from '@/lib/services/mcp/mcpPii';

const EMAIL = /[\w.+-]+@[\w-]+\.[a-z]+/g;
const SCANNER = {
  policyKey: 'contacts',
  version: 'contacts@1',
  scan: async (text: string) => [...text.matchAll(EMAIL)].map((match) => ({
    category: 'email',
    source: 'builtin' as const,
    severity: 'high' as const,
    value: match[0],
    start: match.index!,
    end: match.index! + match[0].length,
  })),
};
const TOKEN = /^\[EMAIL_[a-z]{8}\]$/;

function server(patch: Partial<IMcpServer> = {}): IMcpServer {
  return {
    _id: 'srv-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'crm',
    name: 'CRM',
    status: 'active',
    sourceType: 'remote',
    remoteConfig: { url: 'https://crm.example.com/mcp', transport: 'streamable-http' },
    upstreamAuth: { type: 'none' },
    endpointSlug: 'crm',
    createdBy: 'user-1',
    tools: [
      { name: 'find_contact', description: 'Find a contact', inputSchema: { type: 'object' } },
      { name: 'send_mail', description: 'Send a mail', inputSchema: { type: 'object' } },
    ],
    metadata: { piiProtection: { policyKey: 'contacts' }, piiPassthroughTools: ['send_mail'] },
    ...patch,
  } as unknown as IMcpServer;
}

const echo = async (_config: unknown, _tool: string, args: Record<string, unknown>) => ({
  content: [{ type: 'text', text: `Contact ${String(args.email)} found` }],
  structuredContent: { email: args.email },
});

describe('MCP PII protection', () => {
  beforeEach(() => {
    remoteCallTool.mockReset();
    loadPolicyScanner.mockReset();
    loadPolicyScanner.mockResolvedValue(SCANNER);
  });

  it('sends tokens upstream, gives the caller the values and logs the tokens', async () => {
    remoteCallTool.mockImplementation(echo);
    const args = { email: 'ayse@example.com', note: 'cc ayse@example.com', count: 2 };

    const outcome = await executeMcpToolLocal(server(), 'find_contact', args);

    const sent = remoteCallTool.mock.calls[0][2] as Record<string, unknown>;
    expect(sent.email).toMatch(TOKEN);
    expect(sent.note).toBe(`cc ${String(sent.email)}`);
    expect(sent.count).toBe(2);
    expect(JSON.stringify(sent)).not.toContain('ayse@example.com');
    expect(outcome.result).toEqual({
      content: [{ type: 'text', text: 'Contact ayse@example.com found' }],
      structuredContent: { email: 'ayse@example.com' },
    });
    // The caller's own arguments object is left as it was.
    expect(args.email).toBe('ayse@example.com');

    const logged = piiLoggedPayloads({ tool: 'find_contact', arguments: args }, outcome.result as Record<string, unknown>);
    expect(logged.requestPayload.arguments).toEqual(sent);
    expect(JSON.stringify(logged)).not.toContain('ayse@example.com');
    expect(outcome.piiLog?.arguments).toEqual(sent);
  });

  it('gives a value the same token on every call to the server', async () => {
    remoteCallTool.mockImplementation(echo);
    await executeMcpToolLocal(server(), 'find_contact', { email: 'ayse@example.com' });
    await executeMcpToolLocal(server(), 'find_contact', { email: 'ayse@example.com' });
    expect(remoteCallTool.mock.calls[0][2]).toEqual(remoteCallTool.mock.calls[1][2]);
    // Another server cannot match it.
    await executeMcpToolLocal(server({ _id: 'srv-2', key: 'crm-2' } as Partial<IMcpServer>), 'find_contact', {
      email: 'ayse@example.com',
    });
    expect(remoteCallTool.mock.calls[2][2]).not.toEqual(remoteCallTool.mock.calls[0][2]);
  });

  it('sends real values to a tool listed for them and logs that call as before', async () => {
    remoteCallTool.mockImplementation(echo);
    const args = { email: 'ayse@example.com' };
    const outcome = await executeMcpToolLocal(server(), 'send_mail', args);
    expect(remoteCallTool.mock.calls[0][2]).toEqual({ email: 'ayse@example.com' });
    expect(outcome.piiLog).toBeUndefined();
    const logged = piiLoggedPayloads({ arguments: args }, outcome.result);
    expect(logged.requestPayload.arguments).toBe(args);
    expect(loadPolicyScanner).not.toHaveBeenCalled();
  });

  it('matches a text result through the { value } wrapper the routes log it in', async () => {
    remoteCallTool.mockImplementation(async (_c: unknown, _t: string, args: Record<string, unknown>) => `Mail ${String(args.email)}`);
    const args = { email: 'ayse@example.com' };
    const outcome = await executeMcpToolLocal(server(), 'find_contact', args);
    expect(outcome.result).toBe('Mail ayse@example.com');
    const logged = piiLoggedPayloads({ arguments: args }, { value: outcome.result });
    expect(String((logged.responsePayload as { value: string }).value)).toMatch(/^Mail \[EMAIL_[a-z]{8}\]$/);
  });

  it('withholds a logged response that is not the result the call returned', async () => {
    remoteCallTool.mockImplementation(echo);
    const args = { email: 'ayse@example.com' };
    await executeMcpToolLocal(server(), 'find_contact', args);
    const logged = piiLoggedPayloads({ arguments: args }, { copy: 'ayse@example.com' });
    expect(logged.responsePayload).toEqual({ withheld: expect.any(String) });
  });

  it('keeps the arguments out of the log when the call fails before they are tokenized', async () => {
    loadPolicyScanner.mockRejectedValueOnce(new Error('PII policy with key "contacts" not found'));
    const args = { email: 'ayse@example.com' };
    await expect(executeMcpToolLocal(server(), 'find_contact', args)).rejects.toThrow('not found');
    expect(remoteCallTool).not.toHaveBeenCalled();
    const logged = piiLoggedPayloads({ arguments: args }, undefined);
    expect(logged.requestPayload.arguments).toEqual({ withheld: expect.any(String) });
  });

  it('logs the tokenized arguments of a call the upstream failed', async () => {
    remoteCallTool.mockRejectedValueOnce(new Error('upstream down'));
    const args = { email: 'ayse@example.com' };
    await expect(executeMcpToolLocal(server(), 'find_contact', args)).rejects.toThrow();
    const logged = piiLoggedPayloads({ arguments: args }, undefined);
    expect((logged.requestPayload.arguments as { email: string }).email).toMatch(TOKEN);
  });

  it('sends a call as it is while the policy is turned off', async () => {
    loadPolicyScanner.mockResolvedValueOnce(null);
    remoteCallTool.mockImplementation(echo);
    const args = { email: 'ayse@example.com' };
    await executeMcpToolLocal(server(), 'find_contact', args);
    expect(remoteCallTool.mock.calls[0][2]).toEqual({ email: 'ayse@example.com' });
    expect(piiLoggedPayloads({ arguments: args }, undefined).requestPayload.arguments).toBe(args);
  });

  it('protects only sources with an upstream outside Console', () => {
    const metadata = { piiProtection: { policyKey: 'contacts' } };
    expect(isMcpPiiProtected({ metadata }, 'remote', 'a')).toBe(true);
    expect(isMcpPiiProtected({ metadata }, 'openapi', 'a')).toBe(true);
    expect(isMcpPiiProtected({ metadata }, 'stdio', 'a')).toBe(true);
    expect(isMcpPiiProtected({ metadata }, 'internal', 'a')).toBe(false);
    expect(isMcpPiiProtected({ metadata }, 'composite', 'a')).toBe(false);
    expect(isMcpPiiProtected({ metadata: {} }, 'remote', 'a')).toBe(false);
  });
});

describe('MCP PII protection with a guardrail on the server', () => {
  /** What the server's guardrail was handed, and what its evaluation log would keep. */
  const seen: Array<{ hook: 'pre' | 'post'; value: unknown; logged: unknown }> = [];
  let claimed: McpGuardrailHook | null = null;

  function guardrail(patch: Partial<McpGuardrailHook> = {}): McpGuardrailHook {
    return {
      beforeToolCall: async (ctx: McpGuardrailContext, args) => {
        seen.push({ hook: 'pre', value: args, logged: getMcpGuardrailLogView(ctx)?.args });
        return { allowed: true };
      },
      afterToolCall: async (ctx: McpGuardrailContext, result) => {
        seen.push({ hook: 'post', value: result, logged: getMcpGuardrailLogView(ctx)?.result?.value });
        return { allowed: true };
      },
      ...patch,
    };
  }

  const guarded = (patch: Partial<IMcpServer> = {}) => server({ guardrail: { guardrailKey: 'checks', mode: 'enforce' }, ...patch });

  beforeEach(() => {
    remoteCallTool.mockReset();
    loadPolicyScanner.mockReset();
    loadPolicyScanner.mockResolvedValue(SCANNER);
    seen.length = 0;
    claimed = mcpGuardrailHook.current;
  });
  afterEach(() => {
    mcpGuardrailHook.current = claimed;
  });

  it('judges the real values on both sides and logs their tokens', async () => {
    mcpGuardrailHook.current = guardrail();
    remoteCallTool.mockImplementation(echo);
    const args = { email: 'ayse@example.com' };

    const outcome = await executeMcpToolLocal(guarded(), 'find_contact', args);

    const [pre, post] = seen;
    expect(pre.value).toEqual({ email: 'ayse@example.com' });
    expect((pre.logged as { email: string }).email).toMatch(TOKEN);
    expect(JSON.stringify(post.value)).toContain('ayse@example.com');
    expect(JSON.stringify(post.logged)).not.toContain('ayse@example.com');
    expect(JSON.stringify(post.logged)).toMatch(/\[EMAIL_[a-z]{8}\]/);
    // The request log keeps what crossed: the same tokens.
    expect(outcome.piiLog?.result).toEqual(post.logged);
    expect(JSON.stringify(outcome.result)).toContain('ayse@example.com');
  });

  it('logs a result the guardrail rewrote as the caller got it, tokenized again', async () => {
    mcpGuardrailHook.current = guardrail({
      afterToolCall: async () => ({ allowed: true, result: { note: 'Owner ayse@example.com, phone [REDACTED]' } }),
    });
    remoteCallTool.mockImplementation(echo);

    const outcome = await executeMcpToolLocal(guarded(), 'find_contact', { email: 'ayse@example.com' });

    expect(outcome.result).toEqual({ note: 'Owner ayse@example.com, phone [REDACTED]' });
    const loggedNote = (outcome.piiLog?.result as { note: string }).note;
    expect(loggedNote).toMatch(/^Owner \[EMAIL_[a-z]{8}\], phone \[REDACTED\]$/);
    // The same value gets the same token it had on the way out.
    const sent = remoteCallTool.mock.calls[0][2] as { email: string };
    expect(loggedNote).toContain(sent.email);
  });

  it('logs a call the guardrail blocks with its tokens, not the values', async () => {
    mcpGuardrailHook.current = guardrail({ beforeToolCall: async () => ({ allowed: false, reason: 'not allowed' }) });
    const args = { email: 'ayse@example.com' };

    await expect(executeMcpToolLocal(guarded(), 'find_contact', args)).rejects.toThrow('not allowed');

    expect(remoteCallTool).not.toHaveBeenCalled();
    const logged = piiLoggedPayloads({ arguments: args }, undefined);
    expect((logged.requestPayload.arguments as { email: string }).email).toMatch(TOKEN);
  });

  it('sends arguments the guardrail rewrote, tokenized', async () => {
    mcpGuardrailHook.current = guardrail({
      beforeToolCall: async () => ({ allowed: true, args: { email: 'other@example.com' } }),
    });
    remoteCallTool.mockImplementation(echo);

    await executeMcpToolLocal(guarded(), 'find_contact', { email: 'ayse@example.com' });
    await executeMcpToolLocal(server(), 'find_contact', { email: 'ayse@example.com' });

    const [rewritten, original] = remoteCallTool.mock.calls.map((call) => (call[2] as { email: string }).email);
    expect(rewritten).toMatch(TOKEN);
    expect(rewritten).not.toBe(original);
  });

  it('hands a server without PII protection the values, with no log view', async () => {
    mcpGuardrailHook.current = guardrail();
    remoteCallTool.mockImplementation(echo);

    await executeMcpToolLocal(guarded({ metadata: {} } as Partial<IMcpServer>), 'find_contact', { email: 'ayse@example.com' });

    expect(seen.map((entry) => entry.logged)).toEqual([undefined, undefined]);
    expect(remoteCallTool.mock.calls[0][2]).toEqual({ email: 'ayse@example.com' });
  });
});
