/**
 * Fix 3 / #2, #7, #12 — HOW THE AGENT'S GUARDRAIL PLUGINS ARE COMPILED.
 *
 *   #2  `buildAgentGuardrailPlugins` settles PER KEY. One key that cannot be
 *       compiled no longer takes the others down: a fail-CLOSED (or unreadable)
 *       record becomes a plugin that denies its hooks, a fail-OPEN record is
 *       skipped with a warning, and the rest compile as before.
 *   #7  The compiled plugin declares its own `timeoutMs` (floor 30 s, raised by
 *       the bound callback policies' budgets) and hands `runHook` a budget just
 *       below it, so the engine degrades per policy before the host's timer
 *       drops the verdict.
 *   #12 `HookContext.signal` reaches `scope.signal`.
 *
 * The SDK is REAL; the engine and the record reader are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost } from '@cognipeer/agent-sdk';

import type {
  GuardrailPolicy,
  HookCall,
  HookId,
  HookScope,
  HookVerdict,
} from '@/lib/services/guardrail/hooks/contract';

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  ensureHooks: vi.fn(),
}));

vi.mock('@/lib/services/guardrail/hooks/engine', () => ({
  runHook: hoisted.runHook,
  resolveGuardrail: hoisted.resolveGuardrail,
  ensureDefaultToolGuardrail: vi.fn(async () => ({ key: 'tool-safety-default' })),
  DEFAULT_TOOL_GUARDRAIL_KEY: 'tool-safety-default',
  mergeVerdicts: vi.fn(),
  assertContractVersion: vi.fn(),
}));

vi.mock('@/lib/services/guardrail/hooks/legacy', () => ({
  ensureHooks: hoisted.ensureHooks,
}));

import { __testables } from '@/lib/services/agents/agentService';
import {
  GUARDRAIL_PLUGIN_TIMEOUT_MS,
  compileToSdkPlugin,
  resetSdkCapabilityCacheForTests,
  toAgentPlugin,
} from '@/lib/services/guardrail/sdkAdapter';

const { buildAgentGuardrailPlugins } = __testables;

const SCOPE: HookScope = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_1_db',
  projectId: 'project-1',
  actor: { id: 'user-1', kind: 'agent', roles: ['agent'] },
  surface: 'agent',
  source: 'unit-test',
  traceId: 'trace-1',
};

function policy(
  family: GuardrailPolicy['family'],
  hooks: HookId[],
  extra: Record<string, unknown> = {},
): GuardrailPolicy {
  return {
    id: `${family}:1`,
    family,
    enabled: true,
    hooks,
    schedule: { timing: 'sync', onFail: 'block' },
    ...extra,
  } as GuardrailPolicy;
}

function allow(call: HookCall): HookVerdict {
  return {
    contractVersion: 2,
    hook: call.hook,
    mode: 'enforce',
    decision: 'allow',
    wouldBeDecision: 'allow',
    enforced: true,
    disabled: false,
    findings: [],
    mutations: [],
    riskScore: 0,
    codes: [],
    guardrailKeys: call.guardrailKeys,
    guardrailKey: call.guardrailKeys[0] ?? '',
    guardrailName: 'x',
    policyVersion: 'x@1',
    traceId: 'trace-1',
    latencyMs: 1,
  } as HookVerdict;
}

/** Records by key: `null` = deleted; `broken` = readable but its config cannot be lifted. */
type Fixture = { failMode?: 'open' | 'closed'; broken?: boolean; policies?: GuardrailPolicy[] } | null;

function script(records: Record<string, Fixture>) {
  hoisted.resolveGuardrail.mockImplementation(async (_db: string, key: string) => {
    const fixture = records[key];
    if (fixture === undefined || fixture === null) return null;
    return { key, name: key, mode: 'enforce', enabled: true, failMode: fixture.failMode, __broken: fixture.broken, __policies: fixture.policies };
  });
  hoisted.ensureHooks.mockImplementation((record: { key: string; __broken?: boolean; __policies?: GuardrailPolicy[] }) => {
    if (record.__broken) throw new Error(`config of ${record.key} is unreadable`);
    const policies = record.__policies ?? [policy('pii', ['input.pre', 'output.pre'])];
    const bindings: Record<string, { enabled: boolean }> = {};
    for (const p of policies) for (const h of p.hooks ?? []) bindings[h] = { enabled: true };
    return { hooksVersion: 1, hooks: { contractVersion: 2, policies, bindings } };
  });
}

const AGENT = {
  tenantDbName: SCOPE.tenantDbName,
  tenantId: SCOPE.tenantId,
  projectId: SCOPE.projectId!,
  agentKey: 'support-agent',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSdkCapabilityCacheForTests();
  hoisted.runHook.mockImplementation(async (call: HookCall) => allow(call));
});

describe('buildAgentGuardrailPlugins settles per key', () => {
  it('keeps the compiled key and DENIES for a deleted key (unreadable record = fail closed)', async () => {
    script({ 'gr-ok': {}, 'gr-missing': null });

    const plugins = await buildAgentGuardrailPlugins({
      ...AGENT,
      config: { guardrails: [{ key: 'gr-ok', hooks: ['input.pre'] }, { key: 'gr-missing', hooks: ['input.pre'] }] },
    });

    expect(plugins.map((plugin) => plugin.name)).toEqual([
      'cognipeer-guardrail:gr-ok',
      'cognipeer-guardrail:gr-missing',
    ]);

    // The compiled one still evaluates…
    const ok = plugins[0].hooks?.preModelCall;
    expect(typeof ok).toBe('function');
    await (ok as (input: unknown, ctx: unknown) => Promise<unknown>)(
      { messages: [{ role: 'user', content: 'hello' }] },
      { runId: 'r', hookName: 'preModelCall', store: {}, depth: 0 },
    );
    expect(hoisted.runHook).toHaveBeenCalledTimes(1);

    // …and the missing one denies its bound hook, with the compile error attached.
    const denying = plugins[1].hooks?.preModelCall as (input: unknown, ctx: unknown) => Promise<{ decision?: string; reason?: string; metadata?: Record<string, unknown> } | undefined>;
    const outcome = await denying({ messages: [] }, { runId: 'r', hookName: 'preModelCall', store: {}, depth: 0 });
    expect(outcome?.decision).toBe('deny');
    expect(outcome?.reason).toContain('gr-missing');
    expect(outcome?.metadata?.compileError).toContain('not found');
    expect(plugins[1].failureMode).toBe('closed');
    // Only the hooks the BINDING asked for are denied — output.pre was not bound.
    expect(plugins[1].hooks?.postModelCall).toBeUndefined();
  });

  it('the real host enforces the denying stand-in', async () => {
    script({ 'gr-missing': null });
    const plugins = await buildAgentGuardrailPlugins({
      ...AGENT,
      config: { guardrails: [{ key: 'gr-missing', hooks: ['input.pre'] }] },
    });
    const host = createPluginHost(plugins);
    const run = host.beginRun({ runId: 'run-1', getState: () => ({ messages: [] }) as never, depth: 0 });
    const gate = await run.runGate('preModelCall', { messages: [], tools: [], params: {}, model: {}, iteration: 1 });
    run.end();
    expect(gate.decision).toBe('deny');
    expect(gate.deniedBy).toBe('cognipeer-guardrail:gr-missing');
  });

  it('a readable record with failMode closed whose compile fails also denies', async () => {
    script({ 'gr-closed': { failMode: 'closed', broken: true } });
    const plugins = await buildAgentGuardrailPlugins({
      ...AGENT,
      config: { guardrails: [{ key: 'gr-closed', hooks: ['output.pre'] }] },
    });
    expect(plugins).toHaveLength(1);
    expect(plugins[0].failureMode).toBe('closed');
    expect(plugins[0].hooks?.postModelCall).toBeDefined();
    expect(plugins[0].hooks?.preModelCall).toBeUndefined();
  });

  it('SKIPS a fail-open record whose compile fails, and keeps the others', async () => {
    script({ 'gr-ok': {}, 'gr-open': { failMode: 'open', broken: true } });
    const plugins = await buildAgentGuardrailPlugins({
      ...AGENT,
      config: { guardrails: [{ key: 'gr-open', hooks: ['input.pre'] }, { key: 'gr-ok', hooks: ['input.pre'] }] },
    });
    expect(plugins.map((plugin) => plugin.name)).toEqual(['cognipeer-guardrail:gr-ok']);
  });

  it('the console default (no failMode) is OPEN, so an unlifted record is skipped, not denied', async () => {
    script({ 'gr-default': { broken: true } });
    const plugins = await buildAgentGuardrailPlugins({
      ...AGENT,
      config: { guardrails: [{ key: 'gr-default', hooks: ['input.pre'] }] },
    });
    expect(plugins).toEqual([]);
  });

  it('returns [] when nothing is bound to a text hook', async () => {
    script({});
    expect(await buildAgentGuardrailPlugins({ ...AGENT, config: {} })).toEqual([]);
    expect(await buildAgentGuardrailPlugins({
      ...AGENT,
      config: { guardrails: [{ key: 'gr-tools', hooks: ['tool.pre'] }] },
    })).toEqual([]);
    expect(hoisted.resolveGuardrail).not.toHaveBeenCalled();
  });
});

describe('the compiled plugin owns its timeout', () => {
  it('declares timeoutMs at the floor for a deterministic-only plan', async () => {
    script({ 'gr-pii': {} });
    const plugin = await compileToSdkPlugin('gr-pii', { scope: SCOPE });
    expect(plugin.timeoutMs).toBe(GUARDRAIL_PLUGIN_TIMEOUT_MS);
    expect(GUARDRAIL_PLUGIN_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    // …and the SDK-facing literal carries it too.
    expect(toAgentPlugin(plugin).timeoutMs).toBe(GUARDRAIL_PLUGIN_TIMEOUT_MS);
  });

  it('raises timeoutMs above the bound callback budgets, per hook', async () => {
    script({
      'gr-judge': {
        policies: [
          policy('moderation', ['output.pre'], { timeoutMs: 40_000 }),
          policy('webhook', ['output.pre'], { timeoutMs: 2_000 }),
          // A different hook: budgets are summed PER handler, not across hooks.
          policy('custom', ['input.pre'], { timeoutMs: 1_000 }),
        ],
      },
    });
    const plugin = await compileToSdkPlugin('gr-judge', { scope: SCOPE });
    // 40 s + 2 s on output.pre, plus the margin; input.pre's 1 s does not add.
    expect(plugin.timeoutMs).toBe(47_000);
  });

  it('hands runHook a budget below timeoutMs and the run signal from the hook context', async () => {
    script({ 'gr-pii': {} });
    const plugin = await compileToSdkPlugin('gr-pii', { scope: SCOPE });
    const controller = new AbortController();

    await plugin.hooks.preModelCall!(
      { messages: [{ role: 'user', content: 'hello' }] },
      { runId: 'r', hookName: 'preModelCall', store: {}, depth: 0, signal: controller.signal },
    );

    expect(hoisted.runHook).toHaveBeenCalledTimes(1);
    const call = hoisted.runHook.mock.calls[0]![0] as HookCall;
    expect(call.scope.budgetMs).toBeDefined();
    expect(call.scope.budgetMs!).toBeLessThan(plugin.timeoutMs);
    expect(call.scope.budgetMs!).toBeGreaterThan(0);
    expect(call.scope.signal).toBe(controller.signal);
    // The caller's own scope fields survive the overlay.
    expect(call.scope.tenantDbName).toBe(SCOPE.tenantDbName);
    expect(call.scope.traceId).toBe(SCOPE.traceId);
  });
});

describe('toAgentPlugin', () => {
  it('carries the fields the host reads, under the SDK types, without a cast at the call site', async () => {
    script({ 'gr-pii': {} });
    const plugin = await compileToSdkPlugin('gr-pii', { scope: SCOPE, priority: 3, inheritToSubagents: false });
    const agentPlugin = toAgentPlugin(plugin);
    expect(agentPlugin.name).toBe('cognipeer-guardrail:gr-pii');
    expect(agentPlugin.version).toBe(String(plugin.version));
    expect(agentPlugin.priority).toBe(3);
    expect(agentPlugin.failureMode).toBe('open');
    expect(agentPlugin.inheritToSubagents).toBe(false);
    expect(agentPlugin.mayRequireApproval).toBe(false);
    expect(Object.keys(agentPlugin.hooks ?? {}).sort()).toEqual(['postModelCall', 'preModelCall']);
    expect(() => createPluginHost([agentPlugin])).not.toThrow();
  });
});
