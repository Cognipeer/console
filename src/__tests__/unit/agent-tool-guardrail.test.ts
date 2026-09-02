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
  resolveMcpGuardrailBinding: vi.fn(),
  buildBrowserAgentTools: vi.fn(),
  resolveBrowser: vi.fn(),
  createBrowserSession: vi.fn(),
  closeBrowserSession: vi.fn(),
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

// The ONE reader of a server's guardrail binding, imported by path in
// `agentService`. Scripted per case: `mode: 'off'` is a server nobody
// configured, `enforce` one with its own binding.
vi.mock('@/lib/services/mcp/mcpService', () => ({
  resolveMcpGuardrailBinding: hoisted.resolveMcpGuardrailBinding,
}));

vi.mock('@/lib/services/browser', () => ({
  buildBrowserAgentTools: hoisted.buildBrowserAgentTools,
  resolveBrowser: hoisted.resolveBrowser,
  createBrowserSession: hoisted.createBrowserSession,
  closeBrowserSession: hoisted.closeBrowserSession,
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
  // Default: a server WITH its own binding, i.e. the MCP layer evaluates it and
  // the agent must add nothing. The unbound case is opted into per test.
  hoisted.resolveMcpGuardrailBinding.mockReturnValue({ mode: 'enforce', guardrailKey: 'gr-mcp' });
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

// ── 3. MCP is guarded exactly once — downstream when the server has a binding,
//       by the agent when it has none ─────────────────────────────────────────

describe('MCP tools are evaluated exactly once', () => {
  /** A server with its OWN guardrail binding: the MCP layer evaluates it. */
  const BOUND_SERVER = { mode: 'enforce' as const, guardrailKey: 'gr-mcp' };
  /** A server nobody configured: the MCP layer evaluates NOTHING. */
  const UNBOUND_SERVER = { mode: 'off' as const };

  it('adds no evaluation of its own when the server carries a binding', async () => {
    hoisted.resolveMcpGuardrailBinding.mockReturnValue(BOUND_SERVER);
    const { tools } = await build([MCP_BINDING], ARMED);
    await invoke(tools[0], { q: 'orders' });

    // The guard IS armed (the action-tool cases above prove it fires), so zero
    // calls here can only mean the MCP branch was deliberately left alone.
    expect(evaluations()).toEqual([]);
    expect(hoisted.executeMcpTool).toHaveBeenCalledOnce();
  });

  it('wraps an UNBOUND server under the MCP canonical name, so the agent policy still applies', async () => {
    // The bypass this closes: bind `tool_access { allow: ['agent.knowledge.*'] }`
    // to the agent, attach an MCP server with no guardrail (the default), and
    // every `<server>/<tool>` call ran with no hook firing anywhere.
    hoisted.resolveMcpGuardrailBinding.mockReturnValue(UNBOUND_SERVER);
    const { tools } = await build([MCP_BINDING], ARMED);
    await invoke(tools[0], { q: 'orders' });

    // Under the spelling `mcpHook` would have used, so a stored `tool_access`
    // policy matches identically whichever layer evaluates.
    expect(evaluations()).toEqual([
      ['tool.pre', 'acme-api/search_orders'],
      ['tool.post', 'acme-api/search_orders'],
    ]);
    expect(hoisted.executeMcpTool).toHaveBeenCalledOnce();
  });

  it('blocks an UNBOUND server call at tool.pre before the MCP dispatch runs', async () => {
    hoisted.resolveMcpGuardrailBinding.mockReturnValue(UNBOUND_SERVER);
    hoisted.runHook.mockImplementation(async ({ hook }: HookCall) =>
      hook === 'tool.pre' ? blockVerdict('tool.pre', 'MCP writes are not permitted.') : pass(hook),
    );
    const { tools } = await build([MCP_BINDING], ARMED);
    const result = await invoke(tools[0], { q: 'orders' });

    expect(String(result)).toContain('blocked by a guardrail policy');
    expect(String(result)).toContain('MCP writes are not permitted.');
    expect(hoisted.executeMcpTool).not.toHaveBeenCalled();
  });

  it('leaves an UNBOUND server alone when the agent binds nothing to the tool hooks', async () => {
    // Compatibility: a legacy config arms no tool hook, so an unconfigured
    // server keeps working exactly as it did yesterday — unguarded, as before.
    hoisted.resolveMcpGuardrailBinding.mockReturnValue(UNBOUND_SERVER);
    const { tools } = await build([MCP_BINDING], LEGACY);
    await invoke(tools[0], { q: 'orders' });

    expect(evaluations()).toEqual([]);
    expect(hoisted.executeMcpTool).toHaveBeenCalledOnce();
  });

  it('totals ONE tool.pre and ONE tool.post once the MCP layer does its own', async () => {
    hoisted.resolveMcpGuardrailBinding.mockReturnValue(BOUND_SERVER);
    // Stands in for `executeMcpToolLocal`, which fires both hooks around its
    // dispatch under the SERVER's guardrail binding and the MCP layer's own
    // `<serverKey>/<toolName>` policy name.
    hoisted.executeMcpTool.mockImplementation(async (_server, toolName: string, args) => {
      const providerRef = 'mcp:acme-api';
      const name = `acme-api/${toolName}`;
      await hoisted.runHook({
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        hook: 'tool.pre',
        subject: toolCallSubject({ toolName: name, args, providerRef }),
        scope: { traceId: 'mcp-trace' },
        guardrailKeys: ['gr-mcp'],
      });
      const result = 'ok';
      await hoisted.runHook({
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        hook: 'tool.post',
        subject: toolResultSubject({ toolName: name, args, result, providerRef }),
        scope: { traceId: 'mcp-trace' },
        guardrailKeys: ['gr-mcp'],
      });
      return { result, latencyMs: 3 };
    });

    const { tools } = await build([MCP_BINDING], ARMED);
    await invoke(tools[0], { q: 'orders' });

    // Exactly one evaluation per hook, under ONE name. A second agent-side
    // wrap would show up here as four calls under two different names —
    // double-logged, double-billed, and unreadable in the evaluation log.
    expect(evaluations()).toEqual([
      ['tool.pre', 'acme-api/search_orders'],
      ['tool.post', 'acme-api/search_orders'],
    ]);
  });
});

// ── 4. Legacy configs bind nothing to the tool hooks ────────────────────────

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
