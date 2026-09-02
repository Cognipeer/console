/**
 * THE AGENT-SDK BRIDGE, both planes.
 *
 * The bug this file exists to keep closed: the console reported `tool.pre` and
 * `tool.post` as "not servable — GuardrailPhase has no tool-level member" on
 * every build, including one whose PLUGIN layer serves them with `preToolUse`
 * and `postToolUse`. That sentence described the ConversationGuardrail plane and
 * was published as though it described the agent path. So the assertions here
 * are mostly about WHICH PLANE A CLAIM IS ABOUT, not about mechanics:
 *
 *   · a plugin build must report the tool hooks as served, and its reason must
 *     not contain the words "not servable";
 *   · a legacy build must say the INSTALLED SDK IS TOO OLD, and must not say
 *     "not servable, ever" — the two send an operator to different places;
 *   · `output.stream.delta` must stay unservable on BOTH, quoting the SDK's own
 *     `features.streamGate` note;
 *   · a redact verdict must LAND as a rewrite on the plugin plane rather than
 *     degrade to a block or to a warning — that capability is the entire reason
 *     for the move;
 *   · `failureMode` must be written from the console record's own `failMode`
 *     (default OPEN) and never left to the SDK's `'closed'` default.
 *
 * Every test loads the adapter through `loadAdapter()`, which re-mocks
 * `@cognipeer/agent-sdk` and the two database-reaching hook modules and then
 * imports the adapter fresh. The SDK module is memoised inside the adapter, so
 * varying the installed build within one file requires `vi.resetModules()` —
 * and the mock factories are all SYNCHRONOUS, because an async `vi.mock` factory
 * silently fails to intercept.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  GuardrailPolicy,
  HookId,
  HookScope,
  HookSubject,
  HookVerdict,
  SafetyAction,
} from '@/lib/services/guardrail/hooks/contract';

// ── fixtures ──────────────────────────────────────────────────────────────

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

/** The 13 hooks the plugin build reports, all implemented. */
const PLUGIN_HOOK_NAMES = [
  'userPromptSubmit',
  'preModelCall',
  'postModelCall',
  'preToolUse',
  'postToolUse',
  'preFinalAnswer',
  'postFinalAnswer',
  'onRunStart',
  'onRunEnd',
  'onError',
  'onStateChange',
  'preCompact',
  'postCompact',
] as const;

/**
 * `implemented: false` is EXACTLY these seven, per the SDK team. Written out
 * rather than derived so a change to the report shows up here as a failing
 * expectation instead of as a silently different diagnostic list.
 */
const UNIMPLEMENTED = [
  'features.streamGate',
  'features.traceSinkContribution',
  'slots.approvalTransport',
  'slots.contextBuilder',
  'slots.promptSource',
  'slots.skillSource',
  'slots.summarizer',
] as const;

const STREAM_GATE_NOTE =
  'There is no hook on stream deltas. onStream is synchronous and void, so a chunk '
  + 'cannot be held back or blocked in real time. A postModelCall rewrite fixes the '
  + 'transcript, never what was already emitted.';

function pluginReport(overrides?: { hooks?: Record<string, unknown> }): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const name of PLUGIN_HOOK_NAMES) hooks[name] = { implemented: true };
  return {
    hookContractVersion: 1,
    hooks: { ...hooks, ...(overrides?.hooks ?? {}) },
    slots: {
      summarizer: { implemented: false },
      approvalTransport: { implemented: false },
      skillSource: { implemented: false },
      promptSource: { implemented: false },
      contextBuilder: { implemented: false },
    },
    features: {
      streamGate: { implemented: false, note: STREAM_GATE_NOTE },
      traceSinkContribution: { implemented: false },
    },
  };
}

/** The SDK's own console-hook map, exactly as the team published it. */
const SDK_CONSOLE_HOOK_MAP: Record<string, string | null> = {
  'prompt.pre': 'userPromptSubmit',
  'input.pre': 'preModelCall',
  'output.pre': 'postModelCall',
  'output.stream.delta': null,
  'tool.pre': 'preToolUse',
  'tool.post': 'postToolUse',
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

function verdict(input: {
  hook: HookId;
  decision: SafetyAction;
  subject?: HookSubject;
  message?: string;
}): HookVerdict {
  return {
    contractVersion: 2,
    hook: input.hook,
    mode: 'enforce',
    decision: input.decision,
    wouldBeDecision: input.decision,
    enforced: true,
    disabled: false,
    findings: input.decision === 'allow' ? [] : ([{ category: 'email' }] as never),
    mutations: [],
    subject: input.subject,
    text: input.subject?.text,
    riskScore: input.decision === 'block' ? 90 : 40,
    codes: [],
    message: input.message ? ({ body: input.message } as never) : undefined,
    guardrailKeys: [KEY],
    guardrailKey: KEY,
    guardrailName: 'Corporate policy',
    policyVersion: `${KEY}@2026-01-01T00:00:00.000Z`,
    traceId: 'trace-1',
    latencyMs: 3,
  };
}

// ── the loader ────────────────────────────────────────────────────────────

interface AdapterOptions {
  /** Whether the installed build carries the plugin layer. */
  plugin: boolean;
  /** Overrides for the plugin capability report's `hooks` table. */
  pluginHooks?: Record<string, unknown>;
  /** The `GuardrailPhase` enum the (legacy) build declares. */
  phases?: Record<string, string>;
  runHook?: (call: unknown) => Promise<HookVerdict>;
  record?: Record<string, unknown> | null;
  policies?: GuardrailPolicy[];
  bindings?: Partial<Record<HookId, boolean>>;
}

async function loadAdapter(options: AdapterOptions) {
  vi.resetModules();

  const runHook = vi.fn(
    options.runHook
      ?? (async () => verdict({ hook: 'input.pre', decision: 'allow' })),
  );

  const record =
    options.record === undefined
      ? { key: KEY, name: 'Corporate policy', mode: 'enforce', enabled: true }
      : options.record;

  const bindings: Record<string, { enabled: boolean }> = {};
  for (const [hook, enabled] of Object.entries(options.bindings ?? {})) {
    bindings[hook] = { enabled: enabled === true };
  }

  vi.doMock('@cognipeer/agent-sdk', () => {
    const GuardrailPhase = options.phases ?? { Request: 'request', Response: 'response' };
    const base: Record<string, unknown> = {
      GuardrailPhase,
      version: options.plugin ? '0.10.0-plugin' : '0.9.4',
      createGuardrail: (opts: Record<string, unknown>) => ({
        ...opts,
        rules: (opts.checks as unknown[]) ?? [],
      }),
      customCallbackRule: (opts: Record<string, unknown>) => ({
        id: opts.id,
        title: opts.title,
        evaluate: opts.callback,
      }),
    };
    if (options.plugin) {
      base.pluginCapabilities = () => pluginReport({ hooks: options.pluginHooks });
      base.CONSOLE_HOOK_MAP = SDK_CONSOLE_HOOK_MAP;
    }
    return base;
  });

  vi.doMock('@/lib/services/guardrail/hooks/engine', () => ({
    runHook,
    resolveGuardrail: vi.fn(async () => record),
  }));

  vi.doMock('@/lib/services/guardrail/hooks/legacy', () => ({
    ensureHooks: vi.fn(() => ({
      hooksVersion: 1,
      hooks: {
        contractVersion: 2,
        policies: options.policies ?? [policy('secrets', ['tool.pre'])],
        bindings,
      },
    })),
  }));

  const adapter = await import('@/lib/services/guardrail/sdkAdapter');
  adapter.resetSdkCapabilityCacheForTests();
  return { adapter, runHook };
}

afterEach(() => {
  vi.doUnmock('@cognipeer/agent-sdk');
  vi.doUnmock('@/lib/services/guardrail/hooks/engine');
  vi.doUnmock('@/lib/services/guardrail/hooks/legacy');
});

// ═══════════════════════════════════════════════════════════════════════════

describe('CONSOLE_HOOK_MAP', () => {
  it('is the SDK team’s table, single-valued, with the stream hook explicitly null', async () => {
    const { adapter } = await loadAdapter({ plugin: true });
    expect(adapter.CONSOLE_HOOK_MAP).toEqual(SDK_CONSOLE_HOOK_MAP);

    // Single-valued in BOTH directions: one console hook per plugin hook. The
    // reverse lookup in the capability table depends on it.
    const targets = Object.values(adapter.CONSOLE_HOOK_MAP).filter(
      (value): value is string => value !== null,
    );
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('capability reasons are per-plane', () => {
  it('the PLUGIN plane says the tool hooks are served, and never says "not servable"', async () => {
    const { adapter } = await loadAdapter({ plugin: true });
    const caps = adapter.capabilities('plugin');

    for (const hook of ['tool.pre', 'tool.post'] as const) {
      expect(caps.hooks[hook].supported).toBe(true);
      expect(caps.hooks[hook].reason.toLowerCase()).not.toContain('not servable');
      // The old string blamed GuardrailPhase — a fact about the wrong plane.
      expect(caps.hooks[hook].reason).not.toContain('GuardrailPhase');
    }
    expect(caps.hooks['tool.pre'].sdkHook).toBe('preToolUse');
    expect(caps.hooks['tool.post'].sdkHook).toBe('postToolUse');
    expect(caps.hooks['tool.pre'].reason).toContain('preToolUse');
    expect(caps.hooks['tool.post'].reason).toContain('postToolUse');
  });

  it('carries the three hook caveats where they change what an operator expects', async () => {
    const { adapter } = await loadAdapter({ plugin: true });
    const caps = adapter.capabilities('plugin');

    // userPromptSubmit does not fire on resume.
    expect(caps.hooks['prompt.pre'].reason).toMatch(/resume/i);
    // postToolUse does not fire for a call that parks the run for approval.
    expect(caps.hooks['tool.post'].reason).toMatch(/approval/i);
    // preModelCall rewrites PER MESSAGE now — and says the rewrite reaches the
    // wire transcript, not the persisted one, which is the caveat that matters.
    expect(caps.hooks['input.pre'].rewrites).toBe(true);
    expect(caps.hooks['input.pre'].reason).toMatch(/per message/i);
    expect(caps.hooks['input.pre'].reason).toMatch(/wire/i);
    expect(caps.hooks['input.pre'].reason).not.toMatch(/cannot rewrite|but not rewrite/i);
  });

  it('the LEGACY plane says the INSTALLED SDK is too old, not that the hook is impossible', async () => {
    const { adapter } = await loadAdapter({ plugin: false });
    const caps = adapter.capabilities('legacy');

    for (const hook of ['tool.pre', 'tool.post'] as const) {
      expect(caps.hooks[hook].supported).toBe(false);
      expect(caps.hooks[hook].reason).toMatch(/too old/i);
      // It must name the fix rather than close the door.
      expect(caps.hooks[hook].reason).toMatch(/plugin layer/i);
    }
    // And the security consequence of the legacy plane travels with it.
    expect(caps.hooks['tool.pre'].reason).toMatch(/sub-agent/i);
    expect(caps.subagentInheritance).toBe(false);
    expect(caps.mutations).toBe(false);
  });

  it('the UNKNOWN plane promises nothing it has not verified', async () => {
    const { adapter } = await loadAdapter({ plugin: true });
    const caps = adapter.capabilities('unknown');

    // Never over-promise: an unprobed build must not report a tool hook as
    // served, because that sentence is a security claim.
    expect(caps.hooks['tool.pre'].supported).toBe(false);
    expect(caps.hooks['tool.post'].supported).toBe(false);
    expect(caps.subagentInheritance).toBe(false);
    // ...but it must not repeat the old lie either.
    expect(caps.hooks['tool.pre'].reason.toLowerCase()).not.toContain('not servable');
    expect(caps.hooks['tool.pre'].reason).toMatch(/not been probed|has not been determined/i);
  });

  it('output.stream.delta stays unservable on BOTH planes, quoting the SDK’s own note', async () => {
    const { adapter } = await loadAdapter({ plugin: true });
    for (const plane of ['plugin', 'legacy', 'unknown'] as const) {
      const entry = adapter.capabilities(plane).hooks['output.stream.delta'];
      expect(entry.supported).toBe(false);
      expect(entry.reason).toContain('onStream is synchronous and void');
      // The console's own half of the answer: where enforcement DOES exist.
      expect(entry.reason).toMatch(/gateway/i);
    }
  });
});

describe('probeSdkCapabilities asks the SDK', () => {
  it('prefers pluginCapabilities() and derives supported from what it reports', async () => {
    const { adapter } = await loadAdapter({ plugin: true });
    const caps = await adapter.probeSdkCapabilities();

    expect(caps.plane).toBe('plugin');
    expect(caps.probed).toBe(true);
    expect(caps.hookContractVersion).toBe(1);
    expect(caps.hooks['tool.pre'].supported).toBe(true);
    expect(caps.hooks['tool.post'].supported).toBe(true);
    expect(caps.subagentInheritance).toBe(true);
    expect(caps.mutations).toBe(true);
    expect(caps.mutationProvenance).toBe('plugin');
    // Every served hook but the stream one: `preModelCall.messages` joined the
    // writable set when the adapter learned to address messages by index.
    expect(caps.mutableHooks).toEqual(['prompt.pre', 'input.pre', 'output.pre', 'tool.pre', 'tool.post']);
    // Derived from features.streamGate, never from "there is a plugin layer".
    expect(caps.streamHoldBack).toBe(false);
    expect(caps.unimplemented).toEqual([...UNIMPLEMENTED]);
  });

  it('downgrades a mapped hook the installed build reports as NOT implemented', async () => {
    const { adapter } = await loadAdapter({
      plugin: true,
      pluginHooks: { preToolUse: { implemented: false } },
    });
    const caps = await adapter.probeSdkCapabilities();

    expect(caps.hooks['tool.pre'].supported).toBe(false);
    expect(caps.hooks['tool.pre'].reason).toContain('not implemented');
    // The sibling is untouched — the downgrade is per hook, not per plane.
    expect(caps.hooks['tool.post'].supported).toBe(true);
  });

  it('falls back to the GuardrailPhase probe only when there is no plugin layer', async () => {
    const { adapter } = await loadAdapter({ plugin: false });
    const caps = await adapter.probeSdkCapabilities();

    expect(caps.plane).toBe('legacy');
    expect(caps.probed).toBe(true);
    expect(caps.sdkVersion).toBe('0.9.4');
    expect(caps.hooks['input.pre'].supported).toBe(true);
    expect(caps.hooks['output.pre'].supported).toBe(true);
    // 0.9.x declares no userPromptSubmit phase, so prompt.pre is downgraded
    // with a reason that names the missing surface.
    expect(caps.hooks['prompt.pre'].supported).toBe(false);
    expect(caps.hooks['prompt.pre'].reason).toContain('does not declare');
  });

  it('reports a phase the installed SDK declares that the adapter does not map', async () => {
    const { adapter } = await loadAdapter({
      plugin: false,
      phases: { Request: 'request', Response: 'response', Tool: 'tool' },
    });
    const caps = await adapter.probeSdkCapabilities();
    expect(caps.unmappedPhases).toEqual(['tool']);
  });

  it('capabilities() serves the probed table once the probe has answered', async () => {
    const { adapter } = await loadAdapter({ plugin: true });
    // Before: honest about not knowing, and never claiming a tool hook.
    const before = adapter.capabilities();
    expect(before.plane).toBe('unknown');
    expect(before.probed).toBe(false);

    await adapter.probeSdkCapabilities();

    const after = adapter.capabilities();
    expect(after.plane).toBe('plugin');
    expect(after.probed).toBe(true);
    expect(after.hooks['tool.pre'].supported).toBe(true);
  });
});

describe('compileToSdkPlugin', () => {
  const toolPlan = {
    policies: [policy('secrets', ['tool.pre', 'tool.post'])],
    bindings: { 'tool.pre': true, 'tool.post': true } as Partial<Record<HookId, boolean>>,
  };

  it('registers handlers under the plugin hook names and never one for the stream hook', async () => {
    const { adapter } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['prompt.pre', 'input.pre', 'output.pre', 'tool.pre', 'tool.post'])],
      bindings: {
        'prompt.pre': true,
        'input.pre': true,
        'output.pre': true,
        'output.stream.delta': true,
        'tool.pre': true,
        'tool.post': true,
      },
    });
    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });

    expect(Object.keys(plugin.hooks).sort()).toEqual(
      ['postModelCall', 'postToolUse', 'preModelCall', 'preToolUse', 'userPromptSubmit'].sort(),
    );
    // CONSOLE_HOOK_MAP maps the stream hook to null; a handler here would be a
    // handler that can never hold anything back.
    expect(plugin.hooks.onStream).toBeUndefined();
  });

  it('sets failureMode from the console record, not from the SDK’s "closed" default', async () => {
    const open = await loadAdapter({
      plugin: true,
      // No failMode column: the CONSOLE default is open. Leaving the field off
      // the plugin would inherit the SDK's 'closed' and invert this guardrail.
      record: { key: KEY, name: 'Corporate policy', mode: 'enforce' },
      ...toolPlan,
    });
    const openPlugin = await open.adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    expect(openPlugin.failureMode).toBe('open');

    const closed = await loadAdapter({
      plugin: true,
      record: { key: KEY, name: 'Corporate policy', mode: 'enforce', failMode: 'closed' },
      ...toolPlan,
    });
    const closedPlugin = await closed.adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    expect(closedPlugin.failureMode).toBe('closed');
  });

  it('inherits into sub-agents by default, and says so only when it does', async () => {
    const { adapter } = await loadAdapter({ plugin: true, ...toolPlan });

    const inherited = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    expect(inherited.inheritToSubagents).toBe(true);

    const isolated = await adapter.compileToSdkPlugin(KEY, {
      scope: SCOPE,
      inheritToSubagents: false,
    });
    expect(isolated.inheritToSubagents).toBe(false);
  });

  it('throws on a build with no plugin layer instead of emitting a plugin nothing runs', async () => {
    const { adapter } = await loadAdapter({ plugin: false, ...toolPlan });
    await expect(adapter.compileToSdkPlugin(KEY, { scope: SCOPE })).rejects.toThrow(
      /no plugin layer/i,
    );
  });

  it('compiles to an inert plugin — no handlers — when nothing is bound to a served hook', async () => {
    const { adapter } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['output.stream.delta'])],
      bindings: { 'output.stream.delta': true },
    });
    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    expect(Object.keys(plugin.hooks)).toEqual([]);
    expect(plugin.metadata.inert).toBe(true);
  });
});

describe('a redact verdict LANDS as a rewrite', () => {
  it('rewrites preToolUse.args, and does not degrade to a block', async () => {
    const rewritten: HookSubject = {
      kind: 'tool_call',
      text: '[REDACTED:email]',
      segments: [{ path: '/args/to', text: '[REDACTED:email]' }],
      toolName: 'crm/send_email',
      args: { to: '[REDACTED:email]' },
      providerRef: 'agent:plugin',
    };
    const { adapter } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['tool.pre'])],
      bindings: { 'tool.pre': true },
      runHook: async () => verdict({ hook: 'tool.pre', decision: 'redact', subject: rewritten }),
    });

    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const outcome = await plugin.hooks.preToolUse({
      toolName: 'crm/send_email',
      args: { to: 'john@example.com' },
      ctx: {},
    });

    // The whole point of the migration: the tool runs against the REDACTED
    // arguments. Not blocked, not warned-and-passed-through.
    expect(outcome?.decision).toBe('allow');
    expect(outcome?.block).toBe(false);
    expect(outcome?.args).toEqual({ to: '[REDACTED:email]' });
    expect(outcome?.metadata.rewrittenField).toBe('args');
    expect(outcome?.metadata.mutatedBy).toBe(`cognipeer-guardrail:${KEY}`);
  });

  it('rewrites postToolUse.output before the model sees the result', async () => {
    const rewritten: HookSubject = {
      kind: 'tool_result',
      text: '[REDACTED:email]',
      segments: [{ path: '/result/email', text: '[REDACTED:email]' }],
      toolName: 'crm/lookup',
      args: {},
      result: { email: '[REDACTED:email]' },
      providerRef: 'agent:plugin',
    };
    const { adapter } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['tool.post'])],
      bindings: { 'tool.post': true },
      runHook: async () => verdict({ hook: 'tool.post', decision: 'redact', subject: rewritten }),
    });

    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const outcome = await plugin.hooks.postToolUse({
      toolName: 'crm/lookup',
      args: {},
      output: { email: 'john@example.com' },
      ctx: {},
    });

    expect(outcome?.decision).toBe('allow');
    expect(outcome?.output).toEqual({ email: '[REDACTED:email]' });
  });

  it('rewrites userPromptSubmit.text', async () => {
    const rewritten: HookSubject = {
      kind: 'text',
      text: 'card [REDACTED:creditCard]',
      segments: [{ path: '/text', text: 'card [REDACTED:creditCard]' }],
    };
    const { adapter } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['prompt.pre'])],
      bindings: { 'prompt.pre': true },
      runHook: async () => verdict({ hook: 'prompt.pre', decision: 'redact', subject: rewritten }),
    });

    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const outcome = await plugin.hooks.userPromptSubmit({
      text: 'card 4111 1111 1111 1111',
      ctx: {},
    });

    expect(outcome?.text).toBe('card [REDACTED:creditCard]');
    expect(outcome?.block).toBe(false);
  });

  it('rewrites postModelCall.message, MULTI-PART content included', async () => {
    // One segment per text part, addressed by pointer — which is what lets the
    // rewrite go back where it came from and leave the image part alone.
    const rewritten: HookSubject = {
      kind: 'text',
      text: 'hello\n[REDACTED:secret]',
      segments: [
        { path: '/content/0/text', text: 'hello' },
        { path: '/content/2/text', text: '[REDACTED:secret]' },
      ],
    };
    const { adapter } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['output.pre'])],
      bindings: { 'output.pre': true },
      runHook: async () => verdict({ hook: 'output.pre', decision: 'redact', subject: rewritten }),
    });

    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const outcome = await plugin.hooks.postModelCall({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', url: 'https://example.com/a.png' },
          { type: 'text', text: 'the key is sk-live-123' },
        ],
      },
      ctx: {},
    });

    expect(outcome?.message).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', url: 'https://example.com/a.png' },
        { type: 'text', text: '[REDACTED:secret]' },
      ],
    });
  });

  it('rewrites preModelCall.messages PER MESSAGE, leaving the other messages by identity', async () => {
    // The slice is segmented by message index (`/messages/<i>/content`), so a
    // redaction lands on the message it came from and nothing else moves. The
    // system prompt is never scanned, and an already-scanned message is
    // returned by identity so the host's `mutated` flag stays honest.
    const { adapter, runHook } = await loadAdapter({
      plugin: true,
      policies: [policy('pii', ['input.pre'])],
      bindings: { 'input.pre': true },
      runHook: async (call: unknown) => {
        const subject = (call as { subject: HookSubject }).subject;
        const segments = subject.segments.map((segment) => ({
          ...segment,
          text: segment.text.replace('4111 1111 1111 1111', '[REDACTED]'),
        }));
        return verdict({
          hook: 'input.pre',
          decision: 'redact',
          subject: { kind: 'text', text: segments.map((s) => s.text).join('\n'), segments },
        });
      },
    });

    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const system = { role: 'system', content: 'You are terse.' };
    const user = { role: 'user', content: 'card 4111 1111 1111 1111 please' };
    const outcome = await plugin.hooks.preModelCall(
      { messages: [system, user] },
      { runId: 'run-1', hookName: 'preModelCall', store: {}, depth: 0 },
    );

    expect(outcome?.decision).toBe('allow');
    expect(outcome?.messages?.[0]).toBe(system);
    expect(outcome?.messages?.[1]).toEqual({ role: 'user', content: 'card [REDACTED] please' });
    expect(outcome?.metadata.rewrittenField).toBe('messages');
    // The subject the engine saw was addressed by message index, not `/text`.
    const seen = (runHook.mock.calls[0]![0] as { subject: HookSubject }).subject;
    expect(seen.segments.map((s) => s.path)).toEqual(['/messages/1/content']);
  });

  it('reports a redaction that cannot land, and still does not block', async () => {
    // The engine answered with a rewritten subject whose pointer (`/text`) does
    // not address any message, so the adapter has nowhere to put it. That must
    // be visible, and it must not be escalated into a refusal the operator
    // never asked for.
    const { adapter } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['input.pre'])],
      bindings: { 'input.pre': true },
      runHook: async () =>
        verdict({
          hook: 'input.pre',
          decision: 'redact',
          subject: { kind: 'text', text: 'x', segments: [{ path: '/text', text: 'x' }] },
        }),
    });

    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const outcome = await plugin.hooks.preModelCall({
      messages: [{ role: 'user', content: 'card 4111 1111 1111 1111' }],
      ctx: {},
    });

    expect(outcome?.decision).toBe('allow');
    expect(outcome?.block).toBe(false);
    expect(outcome?.metadata.limitations).toEqual(['redact_not_applied']);
  });
});

describe('plugin handler decisions', () => {
  const bound = {
    policies: [policy('secrets', ['tool.pre'])],
    bindings: { 'tool.pre': true } as Partial<Record<HookId, boolean>>,
  };

  it("denies with the user-facing message, in the HOST's vocabulary", async () => {
    const { adapter } = await loadAdapter({
      plugin: true,
      ...bound,
      runHook: async () =>
        verdict({ hook: 'tool.pre', decision: 'block', message: 'That tool is not permitted.' }),
    });

    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const outcome = await plugin.hooks.preToolUse({ toolName: 't', args: { q: 'x' }, ctx: {} });

    // `deny`, not `block`. The host ranks decisions with
    // `{ allow: 0, ask: 1, deny: 2 }`, so `'block'` ranks `undefined`, never
    // escalates past `allow`, and enforcement — which only reads
    // `gate.decision === 'deny'` — never fires. See
    // `guardrail-sdk-plugin-host.test.ts`, which asserts this against the real
    // host rather than the mock.
    expect(outcome?.decision).toBe('deny');
    expect(outcome?.block).toBe(true);
    expect(outcome?.reason).toBe('That tool is not permitted.');
    expect(outcome?.metadata.plane).toBe('plugin');
    expect(outcome?.metadata.sdkHook).toBe('preToolUse');
  });

  it('applies the record’s own failMode when the engine throws — open passes, closed blocks', async () => {
    const open = await loadAdapter({
      plugin: true,
      ...bound,
      record: { key: KEY, name: 'Corporate policy', mode: 'enforce' },
      runHook: async () => {
        throw new Error('tenant database unavailable');
      },
    });
    const openPlugin = await open.adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const openOutcome = await openPlugin.hooks.preToolUse({ toolName: 't', args: { q: 'x' } });
    // Fail OPEN: a database blip must not block every agent turn while the same
    // guardrail on the gateway passes.
    expect(openOutcome?.block).toBe(false);
    expect(openOutcome?.metadata.failMode).toBe('open');
    expect(openOutcome?.metadata.error).toContain('tenant database unavailable');

    const closed = await loadAdapter({
      plugin: true,
      ...bound,
      record: { key: KEY, name: 'Corporate policy', mode: 'enforce', failMode: 'closed' },
      runHook: async () => {
        throw new Error('tenant database unavailable');
      },
    });
    const closedPlugin = await closed.adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    const closedOutcome = await closedPlugin.hooks.preToolUse({ toolName: 't', args: { q: 'x' } });
    expect(closedOutcome?.block).toBe(true);
    // The backstop path speaks the host's vocabulary too — and it is the path
    // that runs DURING an outage, which is the least survivable moment for a
    // silent fail-open.
    expect(closedOutcome?.decision).toBe('deny');
  });

  it('returns nothing for a clean allow, so the common case costs no GateResult entry', async () => {
    const { adapter } = await loadAdapter({
      plugin: true,
      ...bound,
      runHook: async () => verdict({ hook: 'tool.pre', decision: 'allow' }),
    });
    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    expect(await plugin.hooks.preToolUse({ toolName: 't', args: { q: 'x' } })).toBeUndefined();
  });

  it('does not evaluate a hook whose binding is off', async () => {
    const { adapter, runHook } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['tool.pre'])],
      bindings: { 'tool.pre': false },
    });
    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });
    expect(plugin.hooks.preToolUse).toBeUndefined();
    expect(runHook).not.toHaveBeenCalled();
  });
});

describe('the legacy bridge is kept, not replaced', () => {
  it('still compiles a ConversationGuardrail on a build with no plugin layer', async () => {
    const { adapter } = await loadAdapter({
      plugin: false,
      policies: [policy('secrets', ['input.pre', 'output.pre'])],
      bindings: { 'input.pre': true, 'output.pre': true },
    });

    const guardrail = await adapter.compileToSdkGuardrail(KEY, { scope: SCOPE });
    expect(guardrail.id).toBe(KEY);
    expect([...guardrail.appliesTo].map(String).sort()).toEqual(['request', 'response']);
    expect(guardrail.rules.length).toBeGreaterThan(0);
    // The metadata describes the plane it was compiled for, not the process.
    const caps = (guardrail.metadata as { capabilities: { plane: string } }).capabilities;
    expect(caps.plane).toBe('legacy');
  });

  it('a redact verdict on the legacy plane is a warning carrying redact_unsupported', async () => {
    const { adapter } = await loadAdapter({ plugin: false });
    const result = adapter.verdictToRuleResult(
      verdict({ hook: 'input.pre', decision: 'redact' }),
      { phase: 'request', roles: ['user'] },
    );
    expect(result.passed).toBe(true);
    expect(result.disposition).toBe('warn');
    expect(result.details?.limitations).toEqual(['redact_unsupported']);
  });
});

/**
 * The Usage tab renders the adapter's report, so these assertions are about the
 * ONE thing a screen can get wrong that a compiler cannot: publishing a claim
 * about the wrong plane. The panel is imported dynamically because the module
 * under test above re-mocks the SDK; the panel imports nothing from it.
 */
describe('the Usage panel presents the plugin path', () => {
  async function panel() {
    return import('@/components/guardrails/GuardrailUsagePanel');
  }

  it('shows compileToSdkPlugin as the integration, and plugins: [] on the agent', async () => {
    const { sdkSnippet } = await panel();
    const snippet = sdkSnippet({ guardrailKey: KEY, plane: 'plugin' });

    expect(snippet).toContain('compileToSdkPlugin');
    expect(snippet).toContain('plugins: [plugin]');
    expect(snippet).not.toContain('guardrails: [guardrail]');
    // The two facts an operator copying this needs to know about it.
    expect(snippet).toMatch(/failureMode/);
    expect(snippet).toMatch(/inheritToSubagents/);
  });

  it('falls back to the legacy one-liner only when the build has no plugin layer', async () => {
    const { sdkSnippet } = await panel();
    const legacy = sdkSnippet({ guardrailKey: KEY, plane: 'legacy' });

    expect(legacy).toContain('compileToSdkGuardrail');
    expect(legacy).toContain('guardrails: [guardrail]');
    // ...and it says why, rather than presenting the older bridge as the target.
    expect(legacy).toMatch(/no plugin layer/i);

    // An unprobed build still shows the path being migrated to.
    expect(sdkSnippet({ guardrailKey: KEY, plane: 'unknown' })).toContain('compileToSdkPlugin');
  });

  it('never infers the sub-agent guarantee from a payload that does not state it', async () => {
    const { parseSdkCapabilities } = await panel();
    // An older console serves no `plane` / `subagentInheritance`. Reading that
    // as "plugin, inherited" would publish a security guarantee nobody made.
    const old = parseSdkCapabilities({
      capabilities: {
        contractVersion: 2,
        hooks: { 'input.pre': { supported: true, phase: 'request', reason: 'Served.' } },
        mutations: false,
        streamHoldBack: false,
      },
    });
    expect(old?.plane).toBe('unknown');
    expect(old?.probed).toBe(false);
    expect(old?.subagentInheritance).toBe(false);
    expect(old?.mutationProvenance).toBe('none');
  });

  it('round-trips the adapter’s probed plugin table without losing a claim', async () => {
    const { adapter } = await loadAdapter({ plugin: true });
    const caps = await adapter.probeSdkCapabilities();
    const { parseSdkCapabilities } = await panel();

    // The payload the compiled-policy endpoint actually serves.
    const parsed = parseSdkCapabilities(JSON.parse(JSON.stringify({ capabilities: caps })));
    expect(parsed?.plane).toBe('plugin');
    expect(parsed?.probed).toBe(true);
    expect(parsed?.subagentInheritance).toBe(true);
    expect(parsed?.hooks['tool.pre']?.supported).toBe(true);
    expect(parsed?.hooks['tool.pre']?.sdkHook).toBe('preToolUse');
    expect(parsed?.hooks['tool.pre']?.rewrites).toBe(true);
    expect(parsed?.hooks['output.stream.delta']?.supported).toBe(false);
    expect(parsed?.mutationProvenance).toBe('plugin');
    expect(parsed?.hookContractVersion).toBe(1);
    expect(parsed?.unimplemented).toEqual([...UNIMPLEMENTED]);
  });
});

describe('compileConsoleGuardrail picks the plane at runtime', () => {
  it('emits a PLUGIN when the installed build has the plugin layer', async () => {
    const { adapter } = await loadAdapter({
      plugin: true,
      policies: [policy('secrets', ['tool.pre'])],
      bindings: { 'tool.pre': true },
    });
    const compiled = await adapter.compileConsoleGuardrail(KEY, { scope: SCOPE });
    expect(compiled.plane).toBe('plugin');
    expect(compiled.plugin?.hooks.preToolUse).toBeTypeOf('function');
    expect(compiled.guardrail).toBeUndefined();
    expect(compiled.capabilities.subagentInheritance).toBe(true);
  });

  it('falls back to the ConversationGuardrail bridge when it does not', async () => {
    const { adapter } = await loadAdapter({
      plugin: false,
      policies: [policy('secrets', ['input.pre'])],
      bindings: { 'input.pre': true },
    });
    const compiled = await adapter.compileConsoleGuardrail(KEY, { scope: SCOPE });
    expect(compiled.plane).toBe('legacy');
    expect(compiled.plugin).toBeUndefined();
    expect(compiled.guardrail?.id).toBe(KEY);
    // The claim a caller must not make on this plane.
    expect(compiled.capabilities.subagentInheritance).toBe(false);
  });
});
