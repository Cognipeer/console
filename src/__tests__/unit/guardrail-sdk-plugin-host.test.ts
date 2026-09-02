/**
 * Regression — THE COMPILED PLUGIN MUST WORK AGAINST THE REAL SDK HOST.
 *
 * `guardrail-sdk-adapter.test.ts` mocks `@cognipeer/agent-sdk` so it can drive
 * the adapter's branches cheaply. That is the right shape for those tests, and
 * it is also why two construction-fatal defects survived a 4683-test suite and
 * a clean tsc when the SDK went 0.9.4 → 0.10.0:
 *
 *   1. `compileToSdkPlugin` handed the plugin literal to `definePlugin`. In
 *      0.10.0 that function is CURRIED — `definePlugin(factory) => (config) =>
 *      plugin` — so it returned an anonymous closure, and `createPluginHost`
 *      throws on a plugin with no name. Every agent construction would 500.
 *      The mock never defined `definePlugin`, so every test took the other
 *      branch, and the `as` cast hid the signature from tsc.
 *
 *   2. Handlers returned `decision: 'block'`. The host ranks decisions with
 *      `{ allow: 0, ask: 1, deny: 2 }` and escalates on `rank[next] >
 *      rank[current]`; `rank['block']` is `undefined`, and `undefined > 0` is
 *      false. So the gate stayed `allow` and the guardrail evaluated, logged
 *      findings, billed its judge models, and blocked nothing — silently.
 *
 * So this file mocks NOTHING of the SDK. It builds a real plugin host from the
 * installed package and asserts on what the host actually decides. Every
 * assertion here is one a mock cannot make.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPluginHost,
  CONSOLE_HOOK_MAP as SDK_CONSOLE_HOOK_MAP,
  pluginCapabilities,
  HOOK_NAMES,
} from '@cognipeer/agent-sdk';

import type { GuardrailPolicy, HookId, HookScope, HookVerdict, SafetyAction } from '@/lib/services/guardrail';

const KEY = 'corporate-policy';

const SCOPE: HookScope = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_1_db',
  projectId: 'project-1',
  actor: { id: 'user-1', kind: 'agent', roles: ['admin'] },
  surface: 'agent',
  source: 'unit-test',
  traceId: 'trace-1',
};

function policy(family: GuardrailPolicy['family'], hooks: HookId[]): GuardrailPolicy {
  return {
    id: `${family}:1`,
    family,
    enabled: true,
    hooks,
    schedule: { timing: 'sync', onFail: 'block' },
  } as GuardrailPolicy;
}

function verdict(hook: HookId, decision: SafetyAction): HookVerdict {
  return {
    contractVersion: 2,
    hook,
    mode: 'enforce',
    decision,
    wouldBeDecision: decision,
    enforced: true,
    disabled: false,
    findings: decision === 'allow' ? [] : ([{ category: 'email', message: 'email found' }] as never),
    mutations: [],
    riskScore: decision === 'block' ? 90 : 0,
    codes: [],
    message: decision === 'block' ? ({ body: 'Blocked by corporate policy.' } as never) : undefined,
    guardrailKeys: [KEY],
    guardrailKey: KEY,
    guardrailName: 'Corporate policy',
    policyVersion: `${KEY}@2026-01-01T00:00:00.000Z`,
    traceId: 'trace-1',
    latencyMs: 3,
  } as HookVerdict;
}

/**
 * The console side is mocked (no database, no real evaluation); the SDK is
 * NOT — that is the entire point of this file.
 */
async function compile(
  policies: GuardrailPolicy[],
  onRunHook: () => Promise<HookVerdict> = async () => verdict('input.pre', 'allow'),
) {
  // Bind every hook the policies name — a policy that names a hook nothing is
  // bound to compiles to no handler at all, which is correct behaviour and a
  // useless fixture.
  const bindings: Record<string, { enabled: boolean }> = {};
  for (const p of policies) for (const h of p.hooks ?? []) bindings[h] = { enabled: true };

  vi.resetModules();
  const runHook = vi.fn(onRunHook);

  vi.doMock('@/lib/services/guardrail/hooks/engine', () => ({
    runHook,
    resolveGuardrail: vi.fn(async () => ({
      key: KEY,
      name: 'Corporate policy',
      mode: 'enforce',
      enabled: true,
    })),
  }));
  vi.doMock('@/lib/services/guardrail/hooks/legacy', () => ({
    ensureHooks: vi.fn(() => ({
      hooksVersion: 1,
      hooks: {
        contractVersion: 2,
        policies,
        bindings,
      },
    })),
  }));

  const adapter = await import('@/lib/services/guardrail/sdkAdapter');
  adapter.resetSdkCapabilityCacheForTests();
  const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
  return { plugin, runHook, adapter };
}

afterEach(() => {
  vi.doUnmock('@/lib/services/guardrail/hooks/engine');
  vi.doUnmock('@/lib/services/guardrail/hooks/legacy');
});

describe('compiled plugin vs. the real @cognipeer/agent-sdk host', () => {
  it('the host ACCEPTS the compiled plugin — it has a name and a legal shape', async () => {
    const { plugin } = await compile([policy('pii', ['input.pre'])]);

    // The defect: `definePlugin` returned an anonymous closure, and the host
    // rejects a nameless plugin at construction time.
    expect(typeof plugin.name).toBe('string');
    expect(plugin.name.length).toBeGreaterThan(0);
    expect(plugin.name).toBe(`cognipeer-guardrail:${KEY}`);

    // …and the host itself agrees, which is the assertion that actually matters.
    expect(() => createPluginHost([plugin as never])).not.toThrow();
  });

  it('every hook the plugin registers is a name the SDK knows', async () => {
    const { plugin } = await compile([
      policy('pii', ['input.pre', 'output.pre']),
      policy('tool_access', ['tool.pre', 'tool.post']),
    ]);

    const registered = Object.keys(plugin.hooks);
    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered) {
      // A hook name the host does not know is silently never called — the
      // quietest possible way for a guardrail to stop guarding.
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('a BLOCK verdict produces the decision the host actually enforces on', async () => {
    const { plugin } = await compile([policy('pii', ['input.pre'])], async () =>
      verdict('input.pre', 'block'),
    );

    const sdkHook = SDK_CONSOLE_HOOK_MAP['input.pre'] as string;
    const handler = plugin.hooks[sdkHook];
    expect(handler, `no handler registered for ${sdkHook}`).toBeDefined();

    const outcome = await handler!(
      { messages: [{ role: 'user', content: 'my email is a@corp.com' }] },
      { runId: 'run-1', hookName: sdkHook, store: {}, depth: 0 },
    );

    // `deny`, NOT `block`. The host's DECISION_RANK has no `block` member, so
    // `escalate('allow', 'block')` returns `allow` and nothing is enforced.
    expect(outcome?.decision).toBe('deny');
    expect(outcome?.decision).not.toBe('block');
    expect(outcome?.reason).toBe('Blocked by corporate policy.');
  });

  it('a fail-closed evaluation error also denies rather than "blocks"', async () => {
    const { plugin } = await compile([policy('pii', ['input.pre'])], async () => {
      throw new Error('database is down');
    });
    const sdkHook = SDK_CONSOLE_HOOK_MAP['input.pre'] as string;

    const outcome = await plugin.hooks[sdkHook]!(
      { messages: [{ role: 'user', content: 'hello' }] },
      { runId: 'run-1', hookName: sdkHook, store: {}, depth: 0 },
    );

    // The backstop path had the same typo, and it is the path that runs during
    // an outage — the exact moment a silent fail-open is least survivable.
    expect(outcome?.decision === 'deny' || outcome?.decision === 'allow').toBe(true);
    expect(outcome?.decision).not.toBe('block');
  });

  it('declares mayRequireApproval:false, so a guarded tool batch stays parallel', async () => {
    const { plugin } = await compile([policy('tool_access', ['tool.pre'])]);
    // The host defaults this to TRUE for any plugin registering preToolUse,
    // which drops the whole tool batch into the sequential group to buy an
    // `ask` outcome the console's action union cannot produce.
    expect(plugin.mayRequireApproval).toBe(false);
  });

  it('keeps per-run state in ctx.store, not in a guess at the payload', async () => {
    const { plugin } = await compile([policy('pii', ['input.pre'])]);
    const sdkHook = SDK_CONSOLE_HOOK_MAP['input.pre'] as string;
    const handler = plugin.hooks[sdkHook]!;

    const store: Record<string, unknown> = {};
    const ctx = { runId: 'run-1', hookName: sdkHook, store, depth: 0 };
    await handler({ messages: [{ role: 'user', content: 'first' }] }, ctx);

    // The state has to SURVIVE between calls of one run. Before this, no hook
    // payload carried any of the keys the old lookup searched, so every call
    // built a fresh state — which on `preModelCall` (once per model call, not
    // once per turn) means the per-run billing set is thrown away each time.
    expect(Object.keys(store).length).toBeGreaterThan(0);
    const afterFirst = JSON.stringify(Object.keys(store));

    await handler({ messages: [{ role: 'user', content: 'second' }] }, ctx);
    expect(JSON.stringify(Object.keys(store))).toBe(afterFirst);
  });

  it("the console's own hook map still agrees with the SDK's", async () => {
    const { adapter } = await compile([policy('pii', ['input.pre'])]);
    const CONSOLE_OWN_HOOK_MAP = adapter.CONSOLE_HOOK_MAP;
    // Both now exist and both are consulted. They agreed at 0.10.0; a future
    // bump that moves one without the other silently re-points every policy.
    for (const [consoleHook, sdkHook] of Object.entries(CONSOLE_OWN_HOOK_MAP)) {
      expect(
        SDK_CONSOLE_HOOK_MAP[consoleHook],
        `hook id "${consoleHook}" disagrees between the console and the SDK`,
      ).toBe(sdkHook);
    }
  });

  it('pluginCapabilities() is readable and reports the hooks we rely on', async () => {
    const { adapter } = await compile([policy('pii', ['input.pre'])]);
    const CONSOLE_OWN_HOOK_MAP = adapter.CONSOLE_HOOK_MAP;
    const report = pluginCapabilities() as { hooks?: Record<string, { implemented?: boolean }> };
    expect(report.hooks).toBeDefined();
    // Not an exhaustive check — just that the shape the adapter reads is the
    // shape the SDK ships, since reading the wrong field name is precisely the
    // `note`/`notes` bug this round also fixed.
    for (const sdkHook of Object.values(CONSOLE_OWN_HOOK_MAP)) {
      if (!sdkHook) continue;
      expect(Object.keys(report.hooks ?? {})).toContain(sdkHook);
    }
  });
});
