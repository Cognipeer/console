/**
 * GAP 1 — the internal agent's OWN tools.
 *
 * An agent's MCP tools were guarded downstream (`executeMcpToolLocal` fires
 * `tool.pre` / `tool.post` itself); its action, knowledge and browser tools ran
 * unevaluated. So `tool_access` was bypassable by moving a capability out of an
 * MCP server and into the unified tool system — the agent kept the capability
 * and lost the policy. These cases pin the fix, and the three things that are
 * easy to get subtly wrong while making it:
 *
 *   1. a BLOCK must reach the model as a tool RESULT, not as a throw;
 *   2. an MCP tool must be evaluated EXACTLY ONCE, downstream, never here;
 *   3. a LEGACY config (no `guardrails` array) must bind nothing to the tool
 *      hooks, or an upgrade starts blocking calls that worked yesterday.
 *
 * WHY `runHook` IS MOCKED. The engine, the nine families and the binding
 * resolver each have their own suites; what is untested is the WIRING — which
 * tools get a hook, which do not, and what the caller does with the verdict. A
 * spy answers "how many evaluations, under which name" exactly, which is the
 * whole question in cases 2 and 3. Everything else here is real: the binding
 * resolver, the subject builders, `GuardrailEnforcementError`, and the
 * `createTool` records the agent SDK actually builds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMcpServer, ITool } from '@/lib/database';
import { __resetChannelToolsHostForTests, registerChannelToolsHost, type ChannelToolsBuildInput } from '@/enterprise/channel-tools';
import {
  GUARDRAIL_CONTRACT_VERSION,
  allowVerdict,
  toolCallSubject,
  toolResultSubject,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  HookCall,
  HookId,
  HookSubject,
  HookVerdict,
  SafetyFinding,
} from '@/lib/services/guardrail/hooks/contract';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// SYNC factories throughout. An `async` factory with `await importOriginal()`
// silently fails to intercept in this repo (vitest 4 + pool 'forks'): the
// module under test binds the REAL export and the assertions then watch a spy
// nothing calls.

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  getToolByKey: vi.fn(),
  executeToolAction: vi.fn(),
  logToolRequest: vi.fn(),
  getMcpServerByKey: vi.fn(),
  executeMcpTool: vi.fn(),
  mcpServerGuardrailKey: vi.fn(),
  isMcpPiiProtected: vi.fn((): boolean => false),
  openMcpPiiRoundTrip: vi.fn(async (): Promise<unknown> => null),
  piiLogOf: vi.fn((): unknown => undefined),
  buildBrowserAgentTools: vi.fn(),
  resolveBrowser: vi.fn(),
  createBrowserSession: vi.fn(),
  closeBrowserSession: vi.fn(),
  buildWebSearchAgentTools: vi.fn(),
  // The access-list gate of a shared MCP server: by default what it answers for a run made for no one (open only).
  mayUseSharedResource: vi.fn(async (_run: unknown, record: { access?: { mode?: string } }) => !record.access || record.access.mode === 'all'),
}));

// The engine, not the barrel: mocking `@/lib/services/guardrail` would take the
// real `GuardrailEnforcementError` and the real subject builders with it, and
// then `instanceof` inside the guard would be comparing two different classes.
vi.mock('@/lib/services/guardrail/hooks/engine', () => ({
  runHook: hoisted.runHook,
  resolveGuardrail: vi.fn(async () => null),
  ensureDefaultToolGuardrail: vi.fn(async () => ({ key: 'tool-safety-default' })),
  DEFAULT_TOOL_GUARDRAIL_KEY: 'tool-safety-default',
  mergeVerdicts: vi.fn(),
  assertContractVersion: vi.fn(),
}));

vi.mock('@/lib/services/tools', () => ({
  getToolByKey: hoisted.getToolByKey,
  executeToolAction: hoisted.executeToolAction,
  logToolRequest: hoisted.logToolRequest,
  toolRequestSecretValues: () => [],
}));

vi.mock('@/lib/services/mcp', () => ({
  getMcpServerByKey: hoisted.getMcpServerByKey,
  executeMcpTool: hoisted.executeMcpTool,
  isMcpToolEnabled: () => true,
}));

// The guardrail a server evaluates itself, imported by path in `agentService`.
// Scripted per case: undefined is a server with no guardrail of its own.
vi.mock('@/lib/services/mcp/mcpService', () => ({
  mcpServerGuardrailKey: hoisted.mcpServerGuardrailKey,
  getToolAnnotationOverrides: () => ({}),
  resolveSourceType: (server: { sourceType?: string }) => server.sourceType ?? 'openapi',
}));

// PII protection of a server's calls: off unless a case turns it on.
vi.mock('@/lib/services/mcp/mcpPii', () => ({
  isMcpPiiProtected: hoisted.isMcpPiiProtected,
  openMcpPiiRoundTrip: hoisted.openMcpPiiRoundTrip,
  piiLogOf: hoisted.piiLogOf,
}));

vi.mock('@/lib/services/browser', () => ({
  buildBrowserAgentTools: hoisted.buildBrowserAgentTools,
  resolveBrowser: hoisted.resolveBrowser,
  createBrowserSession: hoisted.createBrowserSession,
  closeBrowserSession: hoisted.closeBrowserSession,
}));

vi.mock('@/lib/services/webSearch', () => ({
  buildWebSearchAgentTools: hoisted.buildWebSearchAgentTools,
}));

vi.mock('@/lib/services/agents/sharedResourceAccess', () => ({
  mayUseSharedResource: hoisted.mayUseSharedResource,
}));

import { buildBoundTools, createAgentToolGuard } from '@/lib/services/agents/agentService';
import type { GuardrailBindingSource } from '@/lib/services/guardrail/hooks/binding';

// ── Fixtures ────────────────────────────────────────────────────────────────

const SCOPE = {
  tenantDbName: 't_acme',
  tenantId: 'tenant-acme',
  projectId: 'proj-1',
  agentKey: 'support-agent',
} as const;

/** Bound to BOTH tool hooks — the shape the multi-binding UI writes. */
const ARMED: GuardrailBindingSource = {
  guardrails: [{ key: 'gr-tools', hooks: ['tool.pre', 'tool.post'] }],
};

/**
 * A row written before the hook plane: two single slots, no array. This is the
 * compatibility case — it must arm the TEXT hooks and nothing else.
 */
const LEGACY: GuardrailBindingSource = {
  inputGuardrailKey: 'gr-in',
  outputGuardrailKey: 'gr-out',
};

function guardFor(config: GuardrailBindingSource) {
  return createAgentToolGuard({
    ...SCOPE,
    config,
    actorId: 'user-1',
    source: 'agent',
  });
}

/** Shaped as `runToolAccessPolicy` emits one — `type` persists as the legacy
 *  'custom', the family is what identifies it. */
function finding(message: string): SafetyFinding {
  return {
    family: 'tool_access',
    hook: 'tool.pre',
    policyId: 'tp1',
    type: 'custom',
    category: 'tool_not_allowed',
    severity: 'high',
    action: 'block',
    message,
    block: true,
  };
}

/** A blocking verdict, shaped exactly as the engine returns one. */
function blockVerdict(hook: HookId, body?: string): HookVerdict {
  return {
    ...allowVerdict({ hook, traceId: 'trace-1', guardrailKey: 'gr-tools' }),
    mode: 'enforce',
    decision: 'block',
    wouldBeDecision: 'block',
    enforced: true,
    disabled: false,
    findings: [finding('tool_not_allowed: create_ticket')],
    codes: ['tool_not_allowed'],
    ...(body
      ? {
          message: {
            reasonClass: 'tool_denied' as const,
            body,
            mode: 'error' as const,
            status: 400,
            traceId: 'trace-1',
          },
        }
      : {}),
  };
}

/** An allow verdict whose subject carries a rewritten copy — a redaction. */
function redactVerdict<S extends HookSubject>(hook: HookId, subject: S): HookVerdict<S> {
  return {
    ...allowVerdict<S>({ hook, traceId: 'trace-1', guardrailKey: 'gr-tools' }),
    mode: 'enforce',
    decision: 'redact',
    wouldBeDecision: 'redact',
    enforced: true,
    disabled: false,
    subject,
  };
}

/** Vacuous allow — what an unbound or passing evaluation returns. */
function pass(hook: HookId): HookVerdict {
  return allowVerdict({ hook, traceId: 'trace-1' });
}

function toolRecord(): ITool {
  return {
    tenantId: SCOPE.tenantId,
    projectId: SCOPE.projectId,
    key: 'crm',
    name: 'CRM',
    type: 'openapi',
    status: 'active',
    actions: [
      {
        key: 'create_ticket',
        name: 'createTicket',
        description: 'Open a support ticket',
        inputSchema: { type: 'object' },
        executionType: 'openapi_http',
      },
    ],
    createdBy: 'user-1',
  } as ITool;
}

function mcpServer(): IMcpServer {
  return {
    tenantId: SCOPE.tenantId,
    projectId: SCOPE.projectId,
    key: 'acme-api',
    name: 'Acme API',
    status: 'active',
    tools: [{ name: 'search_orders', description: 'Search orders', inputSchema: { type: 'object' } }],
    upstreamAuth: { type: 'none' },
    endpointSlug: 'slug',
    createdBy: 'user-1',
  } as IMcpServer;
}

/**
 * Build the agent's bound tools with the REAL `createTool` and the real zod, so
 * the records under test are the ones the SDK would actually run.
 */
async function build(
  bindings: Array<{ source: string; sourceKey: string; toolNames: string[]; config?: Record<string, unknown> }>,
  config: GuardrailBindingSource,
) {
  const { createTool } = await import('@cognipeer/agent-sdk');
  const { z } = await import('zod');
  return buildBoundTools(
    SCOPE.tenantDbName,
    SCOPE.tenantId,
    SCOPE.projectId,
    bindings,
    createTool,
    z,
    guardFor(config),
  );
}

/** Invoke a built tool the way the SDK's tools node does. */
async function invoke(tool: { invoke?: (input: Record<string, unknown>) => unknown }, args: Record<string, unknown>) {
  if (!tool.invoke) throw new Error('tool has no invoke');
  return tool.invoke(args);
}

/** Every `runHook` call the agent layer made, as (hook, canonical name) pairs. */
function evaluations(): Array<[HookId, string]> {
  return hoisted.runHook.mock.calls.map(([call]) => {
    const hookCall = call as HookCall;
    const subject = hookCall.subject;
    const name = subject.kind === 'tool_call' || subject.kind === 'tool_result' ? subject.toolName : '';
    return [hookCall.hook, name];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.runHook.mockImplementation(async ({ hook }: HookCall) => pass(hook));
  hoisted.getToolByKey.mockResolvedValue(toolRecord());
  hoisted.getMcpServerByKey.mockResolvedValue(mcpServer());
  // Default: a server WITH its own guardrail, which the MCP layer evaluates.
  hoisted.mcpServerGuardrailKey.mockReturnValue('gr-mcp');
  hoisted.isMcpPiiProtected.mockReturnValue(false);
  hoisted.openMcpPiiRoundTrip.mockResolvedValue(null);
  hoisted.piiLogOf.mockReturnValue(undefined);
  hoisted.executeToolAction.mockResolvedValue({ result: { ticket: 'T-1' }, latencyMs: 4 });
  hoisted.executeMcpTool.mockResolvedValue({ result: 'ok', latencyMs: 3 });
});

const ACTION_BINDING = { source: 'tool', sourceKey: 'crm', toolNames: ['createTicket'] };
const MCP_BINDING = { source: 'mcp', sourceKey: 'acme-api', toolNames: ['search_orders'] };

// ── 1. A block is a decision, not a crash ───────────────────────────────────

describe('action tool blocked at tool.pre', () => {
  it('returns the policy message to the model instead of throwing', async () => {
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.pre' ? blockVerdict(hook, 'Ticket creation is not permitted from chat.') : pass(hook),
    );

    const { tools } = await build([ACTION_BINDING], ARMED);
    const result = await invoke(tools[0], { subject: 'refund' });

    // A STRING, resolved — the agent keeps running and can tell the user.
    expect(typeof result).toBe('string');
    expect(result).toContain('Ticket creation is not permitted from chat.');
    // The pre/post distinction is load-bearing: nothing ran, so retrying the
    // same call is pointless rather than dangerous.
    expect(result).toContain('did not run');
    expect(hoisted.executeToolAction).not.toHaveBeenCalled();
  });

  it('never lets a tool.pre block reach the tool-request log as an error', async () => {
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.pre' ? blockVerdict(hook) : pass(hook),
    );

    const { tools } = await build([ACTION_BINDING], ARMED);
    await invoke(tools[0], { subject: 'refund' });

    // 'error' would corrupt this tool's failure rate and trip its breaker; a
    // policy decision belongs in the guardrail evaluation log alone.
    expect(hoisted.logToolRequest).not.toHaveBeenCalled();
  });

  it('falls back to the findings when the operator wrote no blocked message', async () => {
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.pre' ? blockVerdict(hook) : pass(hook),
    );

    const { tools } = await build([ACTION_BINDING], ARMED);
    const result = await invoke(tools[0], {});

    expect(result).toContain('tool_not_allowed: create_ticket');
  });

  it('tells the model a tool.post block ALREADY ran, so it does not repeat it', async () => {
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.post' ? blockVerdict(hook, 'Result withheld.') : pass(hook),
    );

    const { tools } = await build([ACTION_BINDING], ARMED);
    const result = await invoke(tools[0], {});

    expect(hoisted.executeToolAction).toHaveBeenCalledOnce();
    expect(result).toContain('The call DID run, so do not repeat it');
    expect(result).toContain('Result withheld.');
  });

  it('propagates a real executor failure instead of dressing it as a policy message', async () => {
    hoisted.executeToolAction.mockRejectedValue(new Error('upstream 502'));

    const { tools } = await build([ACTION_BINDING], ARMED);

    // Swallowing this would be indistinguishable from running unguarded.
    await expect(invoke(tools[0], {})).rejects.toThrow('upstream 502');
    expect(hoisted.logToolRequest).toHaveBeenCalledOnce();
  });
});

// ── 2. Names, and mutations ─────────────────────────────────────────────────

describe('policy-visible names and mutations', () => {
  it('evaluates an action under its canonical name, not the display name', async () => {
    const { tools } = await build([ACTION_BINDING], ARMED);
    await invoke(tools[0], {});

    // Keys, not names: renaming the action must not disarm the policy.
    expect(evaluations()).toEqual([
      ['tool.pre', 'agent.tool.crm.create_ticket'],
      ['tool.post', 'agent.tool.crm.create_ticket'],
    ]);
    // The name the model called still rides along, for the deny direction.
    const [preCall] = hoisted.runHook.mock.calls[0] as [HookCall];
    expect(preCall.subject.kind === 'tool_call' && preCall.subject.requestedName).toBe('createTicket');
    expect(preCall.contractVersion).toBe(GUARDRAIL_CONTRACT_VERSION);
    expect(preCall.scope.surface).toBe('agent');
    expect(preCall.scope.actor.roles).toEqual(['agent']);
  });

  it('gives tool.pre and tool.post of one call the same trace id, and a fresh one per call', async () => {
    const { tools } = await build([ACTION_BINDING], ARMED);
    await invoke(tools[0], {});
    await invoke(tools[0], {});

    const traceIds = hoisted.runHook.mock.calls.map(([call]) => (call as HookCall).scope.traceId);
    expect(traceIds).toHaveLength(4);
    expect(traceIds[0]).toBe(traceIds[1]);
    expect(traceIds[2]).toBe(traceIds[3]);
    expect(traceIds[0]).not.toBe(traceIds[2]);
  });

  it('hands the executor the REDACTED arguments when tool.pre rewrote them', async () => {
    hoisted.runHook.mockImplementation(async (call: HookCall) => {
      if (call.hook !== 'tool.pre') return pass(call.hook);
      return redactVerdict(
        call.hook,
        toolCallSubject({
          toolName: 'agent.tool.crm.create_ticket',
          args: { note: '[REDACTED]' },
          providerRef: `agent:${SCOPE.agentKey}`,
        }),
      );
    });

    const { tools } = await build([ACTION_BINDING], ARMED);
    await invoke(tools[0], { note: 'card 4111 1111 1111 1111' });

    const [, , args] = hoisted.executeToolAction.mock.calls[0];
    expect(args).toEqual({ note: '[REDACTED]' });
  });

  it('hands the executor what the SDK passes after the arguments (the call context)', async () => {
    // agent-sdk 0.15: `func(args, { toolCallId, cancellationToken, signal })`. A tool that stops on the
    // run's abort signal reads it from there, so the guard must not swallow it.
    const context = { toolCallId: 'call-1', cancellationToken: { isCancelled: () => false }, signal: new AbortController().signal };
    const execute = vi.fn(async () => 'done');
    const guarded = guardFor(ARMED).protect({ name: 'agent.tool.crm.create_ticket', requestedName: 'create_ticket' }, execute);

    expect(await guarded({ note: 'hello' }, context)).toBe('done');

    expect(execute).toHaveBeenCalledWith({ note: 'hello' }, context);
  });

  it('returns the REDACTED result when tool.post rewrote it', async () => {
    hoisted.runHook.mockImplementation(async (call: HookCall) => {
      if (call.hook !== 'tool.post') return pass(call.hook);
      return redactVerdict(
        call.hook,
        toolResultSubject({
          toolName: 'agent.tool.crm.create_ticket',
          args: {},
          result: '{"ticket":"[REDACTED]"}',
          providerRef: `agent:${SCOPE.agentKey}`,
        }),
      );
    });

    const { tools } = await build([ACTION_BINDING], ARMED);
    expect(await invoke(tools[0], {})).toBe('{"ticket":"[REDACTED]"}');
  });
});

// ── 3. MCP tools: the agent's guardrails and the server's own both run ──────

describe('MCP tools run the agent guardrails and the server guardrail in turn', () => {
  /** Every `runHook` call as (hook, guardrail keys). */
  function evaluatedKeys(): Array<[HookId, string[]]> {
    return hoisted.runHook.mock.calls.map(([call]) => [(call as HookCall).hook, (call as HookCall).guardrailKeys]);
  }

  /** Stands in for `executeMcpToolLocal`, which runs the server's own guardrail around its dispatch. */
  function serverEvaluates(key: string) {
    hoisted.executeMcpTool.mockImplementation(async (_server, toolName: string, args) => {
      const providerRef = 'mcp:acme-api';
      const name = `acme-api/${toolName}`;
      await hoisted.runHook({
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        hook: 'tool.pre',
        subject: toolCallSubject({ toolName: name, args, providerRef }),
        scope: { traceId: 'mcp-trace' },
        guardrailKeys: [key],
      });
      const result = 'ok';
      await hoisted.runHook({
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        hook: 'tool.post',
        subject: toolResultSubject({ toolName: name, args, result, providerRef }),
        scope: { traceId: 'mcp-trace' },
        guardrailKeys: [key],
      });
      return { result, latencyMs: 3 };
    });
  }

  it('runs the agent guardrails around a server that has its own: agent, server, server, agent', async () => {
    serverEvaluates('gr-mcp');
    const { tools } = await build([MCP_BINDING], ARMED);
    await invoke(tools[0], { q: 'orders' });

    expect(evaluatedKeys()).toEqual([
      ['tool.pre', ['gr-tools']],
      ['tool.pre', ['gr-mcp']],
      ['tool.post', ['gr-mcp']],
      ['tool.post', ['gr-tools']],
    ]);
    // Both layers name the call the same way, so one policy matches on either.
    expect(new Set(evaluations().map(([, name]) => name))).toEqual(new Set(['acme-api/search_orders']));
  });

  it('skips the guardrail the server evaluates itself, so it runs once per call', async () => {
    serverEvaluates('gr-mcp');
    const { tools } = await build([MCP_BINDING], {
      guardrails: [{ key: 'gr-mcp', hooks: ['tool.pre', 'tool.post'] }, { key: 'gr-tools', hooks: ['tool.pre', 'tool.post'] }],
    });
    await invoke(tools[0], { q: 'orders' });

    expect(evaluatedKeys()).toEqual([
      ['tool.pre', ['gr-tools']],
      ['tool.pre', ['gr-mcp']],
      ['tool.post', ['gr-mcp']],
      ['tool.post', ['gr-tools']],
    ]);
  });

  it('adds nothing when the agent binds only the server’s own guardrail', async () => {
    const { tools } = await build([MCP_BINDING], { guardrails: [{ key: 'gr-mcp', hooks: ['tool.pre', 'tool.post'] }] });
    await invoke(tools[0], { q: 'orders' });

    expect(evaluations()).toEqual([]);
    expect(hoisted.executeMcpTool).toHaveBeenCalledOnce();
  });

  it('does not skip a key of a server in another scope, where it may name another guardrail', async () => {
    hoisted.getMcpServerByKey.mockResolvedValue({ ...mcpServer(), projectId: undefined });
    const { tools } = await build([MCP_BINDING], { guardrails: [{ key: 'gr-mcp', hooks: ['tool.pre', 'tool.post'] }] });
    await invoke(tools[0], { q: 'orders' });

    expect(evaluatedKeys()).toEqual([
      ['tool.pre', ['gr-mcp']],
      ['tool.post', ['gr-mcp']],
    ]);
  });

  it('guards a server with no guardrail of its own under the MCP canonical name', async () => {
    hoisted.mcpServerGuardrailKey.mockReturnValue(undefined);
    const { tools } = await build([MCP_BINDING], ARMED);
    await invoke(tools[0], { q: 'orders' });

    expect(evaluations()).toEqual([
      ['tool.pre', 'acme-api/search_orders'],
      ['tool.post', 'acme-api/search_orders'],
    ]);
    expect(hoisted.executeMcpTool).toHaveBeenCalledOnce();
  });

  it('blocks at tool.pre before the MCP dispatch runs', async () => {
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.pre' ? blockVerdict('tool.pre', 'MCP writes are not permitted.') : pass(hook),
    );
    const { tools } = await build([MCP_BINDING], ARMED);
    const result = await invoke(tools[0], { q: 'orders' });

    expect(String(result)).toContain('blocked by a guardrail policy');
    expect(String(result)).toContain('MCP writes are not permitted.');
    expect(hoisted.executeMcpTool).not.toHaveBeenCalled();
  });

  it('leaves the tool alone when the agent binds nothing to the tool hooks', async () => {
    hoisted.mcpServerGuardrailKey.mockReturnValue(undefined);
    const { tools } = await build([MCP_BINDING], LEGACY);
    await invoke(tools[0], { q: 'orders' });

    expect(evaluations()).toEqual([]);
    expect(hoisted.executeMcpTool).toHaveBeenCalledOnce();
  });

  it('judges the real values of a PII-protected server’s call and logs its tokens', async () => {
    hoisted.isMcpPiiProtected.mockReturnValue(true);
    hoisted.openMcpPiiRoundTrip.mockResolvedValue({
      protect: async (args: Record<string, unknown>) => ({ ...args, email: '[EMAIL_kqzvtmwb]' }),
    });
    hoisted.piiLogOf.mockReturnValue({ arguments: { email: '[EMAIL_kqzvtmwb]' }, result: { owner: '[EMAIL_kqzvtmwb]' } });
    hoisted.executeMcpTool.mockResolvedValue({ result: { owner: 'ada@example.com' }, latencyMs: 3 });
    const { tools } = await build([MCP_BINDING], ARMED);
    await invoke(tools[0], { email: 'ada@example.com' });

    const [pre, post] = hoisted.runHook.mock.calls.map(([call]) => call as HookCall);
    expect(pre.subject.text).toContain('ada@example.com');
    expect(pre.logText).toBe('[EMAIL_kqzvtmwb]');
    expect(post.subject.text).toContain('ada@example.com');
    expect(post.logText).toBe(JSON.stringify({ owner: '[EMAIL_kqzvtmwb]' }));
  });

  it('withholds a side of a PII-protected call it has no tokenized view of', async () => {
    hoisted.isMcpPiiProtected.mockReturnValue(true);
    hoisted.openMcpPiiRoundTrip.mockRejectedValue(new Error('PII policy not found'));
    const { tools } = await build([MCP_BINDING], ARMED);
    await invoke(tools[0], { email: 'ada@example.com' });

    const [pre, post] = hoisted.runHook.mock.calls.map(([call]) => call as HookCall);
    expect(pre.logText).toBe('Not logged: PII protection is on for this tool');
    expect(post.logText).toBe('Not logged: PII protection is on for this tool');
  });

  it('logs the values themselves for a server without PII protection', async () => {
    const { tools } = await build([MCP_BINDING], ARMED);
    await invoke(tools[0], { email: 'ada@example.com' });

    for (const [call] of hoisted.runHook.mock.calls) expect((call as HookCall).logText).toBeUndefined();
  });
});

// ── 4. Legacy configs bind nothing to the tool hooks ────────────────────────

describe('the access list of an MCP server', () => {
  const RESTRICTED = { mode: 'selected' as const, userIds: ['u-listed'], groupIds: [] };

  async function buildFor(userId: string | undefined) {
    const { createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');
    return buildBoundTools(
      SCOPE.tenantDbName,
      SCOPE.tenantId,
      SCOPE.projectId,
      [MCP_BINDING],
      createTool,
      z,
      guardFor(ARMED),
      { source: 'api' },
      userId ? { userId, source: 'api' } as never : undefined,
    );
  }

  it('asks the gate for the person the run is made for, with the server as the resource', async () => {
    hoisted.getMcpServerByKey.mockResolvedValue({ ...mcpServer(), _id: 'srv-1', access: RESTRICTED });
    hoisted.mayUseSharedResource.mockResolvedValueOnce(true);
    const { tools } = await buildFor('u-listed');
    expect(tools).toHaveLength(1);
    expect(hoisted.mayUseSharedResource).toHaveBeenCalledWith(
      expect.objectContaining({ tenantDbName: SCOPE.tenantDbName, tenantId: SCOPE.tenantId, source: 'api', caller: expect.objectContaining({ userId: 'u-listed' }) }),
      { type: 'mcp-server', id: 'srv-1', key: 'acme-api', projectId: SCOPE.projectId, access: RESTRICTED },
    );
  });

  it('leaves every tool of the server out when the gate says no, so the model never sees them', async () => {
    hoisted.getMcpServerByKey.mockResolvedValue({ ...mcpServer(), _id: 'srv-1', access: RESTRICTED });
    hoisted.mayUseSharedResource.mockResolvedValueOnce(false);
    const { tools, definitions } = await buildFor('u-other');
    expect(tools).toEqual([]);
    expect(definitions).toEqual([]);
    expect(hoisted.executeMcpTool).not.toHaveBeenCalled();
  });

  it('keeps an open server in a run made for no one, and a restricted one out', async () => {
    expect((await buildFor(undefined)).tools).toHaveLength(1);
    hoisted.getMcpServerByKey.mockResolvedValue({ ...mcpServer(), access: RESTRICTED });
    expect((await buildFor(undefined)).tools).toEqual([]);
  });
});

describe('legacy single-slot config', () => {
  it('binds nothing to tool.pre / tool.post, so yesterday\'s calls still run', async () => {
    const { tools } = await build([ACTION_BINDING], LEGACY);
    const result = await invoke(tools[0], { subject: 'refund' });

    // Not "allowed by an empty policy" — NOT EVALUATED. The tenant default
    // tool guardrail must not be materialised for a config nobody armed.
    expect(evaluations()).toEqual([]);
    expect(hoisted.executeToolAction).toHaveBeenCalledOnce();
    expect(result).toBe(JSON.stringify({ ticket: 'T-1' }));
  });

  it('is not armed by a config with no guardrail fields at all', async () => {
    const { tools } = await build([ACTION_BINDING], {});
    await invoke(tools[0], {});

    expect(evaluations()).toEqual([]);
  });

  it('arms only the hooks a binding actually names', async () => {
    const { tools } = await build([ACTION_BINDING], {
      guardrails: [{ key: 'gr-post-only', hooks: ['tool.post'] }],
    });
    await invoke(tools[0], {});

    // A `tool.post`-only binding must not be evaluated (logged, and for the
    // model-backed families billed) at `tool.pre` as well.
    expect(evaluations()).toEqual([['tool.post', 'agent.tool.crm.create_ticket']]);
  });

  it('arms the tool hooks when a binding omits `hooks` entirely', async () => {
    const { tools } = await build([ACTION_BINDING], { guardrails: [{ key: 'gr-all' }] });
    await invoke(tools[0], {});

    // An omitted list delegates to whatever the guardrail itself declares, so
    // the binding is live on every hook and the engine narrows it.
    expect(evaluations()).toEqual([
      ['tool.pre', 'agent.tool.crm.create_ticket'],
      ['tool.post', 'agent.tool.crm.create_ticket'],
    ]);
  });
});

// ── 5. Tools built elsewhere ────────────────────────────────────────────────

describe('browser system tools', () => {
  /** A record shaped like `createTool`'s: one closure behind four aliases. */
  function browserTool(name: string, run: (args: Record<string, unknown>) => Promise<unknown>) {
    return { name, description: `${name} description`, invoke: run, call: run, run, func: run };
  }

  beforeEach(() => {
    hoisted.resolveBrowser.mockResolvedValue({ _id: 'browser-1', status: 'active' });
    hoisted.createBrowserSession.mockResolvedValue({ sessionKey: 'sess-1' });
  });

  const BROWSER_BINDING = {
    source: 'system',
    sourceKey: 'browser_use',
    toolNames: [],
    config: { browserId: 'browser-1' },
  };

  it('guards every executor alias, not just `invoke`', async () => {
    const executor = vi.fn(async () => 'navigated');
    hoisted.buildBrowserAgentTools.mockReturnValue([browserTool('browser_navigate', executor)]);
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.pre' ? blockVerdict(hook, 'Navigation is not permitted.') : pass(hook),
    );

    const { tools } = await build([BROWSER_BINDING], ARMED);
    const record = tools[0] as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

    // The SDK resolves an executor by walking invoke -> call -> func -> run;
    // an unreplaced alias is a silently unguarded tool.
    for (const alias of ['invoke', 'call', 'func', 'run']) {
      expect(await record[alias]({ url: 'https://example.com' })).toContain('Navigation is not permitted.');
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it('hands the tool the SDK\'s call context, whichever alias the SDK calls', async () => {
    const context = { toolCallId: 'call-1', cancellationToken: { isCancelled: () => false }, signal: new AbortController().signal };
    const executor = vi.fn(async () => 'navigated');
    hoisted.buildBrowserAgentTools.mockReturnValue([browserTool('browser_navigate', executor)]);

    const { tools } = await build([BROWSER_BINDING], ARMED);
    const record = tools[0] as unknown as Record<string, (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>>;

    for (const alias of ['invoke', 'call', 'func', 'run']) {
      executor.mockClear();
      expect(await record[alias]({ url: 'https://example.com' }, context)).toBe('navigated');
      expect(executor).toHaveBeenCalledWith({ url: 'https://example.com' }, context);
    }
  });

  it('evaluates a browser tool under its own name, verbatim', async () => {
    hoisted.buildBrowserAgentTools.mockReturnValue([
      browserTool('browser_navigate', async () => 'navigated'),
    ]);

    const { tools, definitions } = await build([BROWSER_BINDING], ARMED);
    expect(await invoke(tools[0], { url: 'https://example.com' })).toBe('navigated');

    expect(evaluations()).toEqual([
      ['tool.pre', 'agent.browser.browser_navigate'],
      ['tool.post', 'agent.browser.browser_navigate'],
    ]);
    // The trace menu still describes the tool the model sees.
    expect(definitions[0]).toEqual({
      name: 'browser_navigate',
      description: 'browser_navigate description',
    });
  });

  it('leaves a tool with no callable alone rather than fabricating one', async () => {
    hoisted.buildBrowserAgentTools.mockReturnValue([{ name: 'browser_broken' }]);

    const { tools } = await build([BROWSER_BINDING], ARMED);

    expect(tools[0]).toEqual({ name: 'browser_broken' });
  });
});

describe('web search system tools', () => {
  /** A record shaped like `createTool`'s: one closure behind four aliases. */
  function webSearchTool(name: string, run: (args: Record<string, unknown>) => Promise<unknown>) {
    return { name, description: `${name} description`, invoke: run, call: run, run, func: run };
  }

  const WEB_SEARCH_BINDING = {
    source: 'system',
    sourceKey: 'web_search',
    toolNames: [],
    config: { providerKey: 'ws-1' },
  };

  it('guards every executor alias, not just `invoke`', async () => {
    const executor = vi.fn(async () => ({ results: [] }));
    hoisted.buildWebSearchAgentTools.mockReturnValue([webSearchTool('web_search', executor)]);
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.pre' ? blockVerdict(hook, 'Web search is not permitted.') : pass(hook),
    );

    const { tools } = await build([WEB_SEARCH_BINDING], ARMED);
    const record = tools[0] as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

    // The SDK resolves an executor by walking invoke -> call -> func -> run;
    // an unreplaced alias is a silently unguarded tool.
    for (const alias of ['invoke', 'call', 'func', 'run']) {
      expect(await record[alias]({ query: 'weather today' })).toContain('Web search is not permitted.');
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it('evaluates the web search tool under its own name, verbatim', async () => {
    hoisted.buildWebSearchAgentTools.mockReturnValue([
      webSearchTool('web_search', async () => ({ results: [] })),
    ]);

    const { tools, definitions } = await build([WEB_SEARCH_BINDING], ARMED);
    expect(await invoke(tools[0], { query: 'weather today' })).toEqual({ results: [] });

    expect(evaluations()).toEqual([
      ['tool.pre', 'agent.websearch.web_search'],
      ['tool.post', 'agent.websearch.web_search'],
    ]);
    // The trace menu still describes the tool the model sees.
    expect(definitions[0]).toEqual({
      name: 'web_search',
      description: 'web_search description',
    });
  });

  it('leaves a tool with no callable alone rather than fabricating one', async () => {
    hoisted.buildWebSearchAgentTools.mockReturnValue([{ name: 'web_search_broken' }]);

    const { tools } = await build([WEB_SEARCH_BINDING], ARMED);

    expect(tools[0]).toEqual({ name: 'web_search_broken' });
  });
});

describe('channel system tools', () => {
  function channelTool(name: string, run: (args: Record<string, unknown>) => Promise<unknown>) {
    return { name, description: `${name} description`, invoke: run, call: run, run, func: run };
  }

  const CHANNEL_BINDING = {
    source: 'system',
    sourceKey: 'channel',
    toolNames: ['send_direct_message', 'not_a_channel_tool'],
  };

  beforeEach(() => __resetChannelToolsHostForTests());

  async function buildFor(bindings: Array<{ source: string; sourceKey: string; toolNames: string[] }>) {
    const { createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');
    return buildBoundTools(
      SCOPE.tenantDbName,
      SCOPE.tenantId,
      SCOPE.projectId,
      bindings,
      createTool,
      z,
      guardFor(ARMED),
      { source: 'trigger' },
      { agentKey: 'agent-1', userId: 'user-1', projectId: SCOPE.projectId },
      { conversationId: 'conv-1', accountableUserId: 'owner-1' },
    );
  }

  it('binds nothing in an edition without the Channels module', async () => {
    const { tools } = await buildFor([CHANNEL_BINDING]);
    expect(tools).toEqual([]);
  });

  it('hands the host the run it builds for, with only the known tool names', async () => {
    const seen: ChannelToolsBuildInput[] = [];
    registerChannelToolsHost({
      buildTools: async (input) => {
        seen.push(input);
        return [channelTool('slack_send_direct_message', async () => ({ ok: true }))];
      },
    });

    const { tools } = await buildFor([CHANNEL_BINDING]);

    expect(tools).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenantDbName: SCOPE.tenantDbName,
      projectId: SCOPE.projectId,
      agentKey: 'agent-1',
      toolNames: ['send_direct_message'],
      // The accountable person of an unattended run wins over the caller.
      userId: 'owner-1',
      conversationId: 'conv-1',
      runtimeContext: { source: 'trigger' },
    });
  });

  it('evaluates a channel tool under agent.channel.<name> and blocks it like any other', async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    registerChannelToolsHost({ buildTools: async () => [channelTool('slack_send_channel_message', executor)] });
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.pre' ? blockVerdict(hook, 'Posting is not permitted.') : pass(hook),
    );

    const { tools } = await buildFor([CHANNEL_BINDING]);
    const record = tools[0] as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
    for (const alias of ['invoke', 'call', 'func', 'run']) {
      expect(await record[alias]({ channel: '#general', text: 'hi' })).toContain('Posting is not permitted.');
    }
    expect(executor).not.toHaveBeenCalled();
    expect(evaluations()[0]).toEqual(['tool.pre', 'agent.channel.slack_send_channel_message']);
  });

  it('skips the binding when the host fails, without failing the run', async () => {
    registerChannelToolsHost({ buildTools: async () => { throw new Error('boom'); } });
    const { tools } = await buildFor([CHANNEL_BINDING]);
    expect(tools).toEqual([]);
  });
});
