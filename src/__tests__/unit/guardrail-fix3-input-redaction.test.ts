/**
 * Fix 3 / #1 — INPUT REDACTION ON THE LOCAL AGENT PATH.
 *
 * The regression: `input.pre` is served by the plugin hook `preModelCall`,
 * whose adapter could BLOCK but not rewrite, so a PII-redact guardrail bound to
 * `input.pre` (what every legacy `inputGuardrailKey` projects onto) let the raw
 * PII reach the provider and be persisted. Two facts about the SDK shape the
 * fix, and both are pinned here against the REAL plugin host:
 *
 *   1. the host applies a `preModelCall` `messages` mutation to the WIRE
 *      transcript (`wireMessages = gate.input.messages`) — so the adapter now
 *      segments the scanned slice PER MESSAGE and hands back a rewritten array;
 *   2. the host never writes that mutation into `state.messages`, so
 *      `result.messages` still carries the raw turn — so the adapter reports
 *      every rewrite through `onMessageRewrite`, and the console persists the
 *      user turn from that ledger instead of from the request text.
 *
 * The console side (`MessageRewriteLedger`, `persistedUserTurn`) is exported
 * through `__testables`; `guardrail-fix3-agent-chat-redaction.test.ts` drives
 * `executeAgentChatLocal` end to end.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, CONSOLE_HOOK_MAP as SDK_CONSOLE_HOOK_MAP } from '@cognipeer/agent-sdk';
import type { Message, SmartState } from '@cognipeer/agent-sdk';

import type {
  GuardrailPolicy,
  HookCall,
  HookId,
  HookScope,
  HookSubject,
  HookVerdict,
  SafetyAction,
} from '@/lib/services/guardrail/hooks/contract';
import type { PluginMessageRewrite } from '@/lib/services/guardrail/sdkAdapter';
import { __testables, AgentGuardrailBlockedError } from '@/lib/services/agents/agentService';

const KEY = 'pii-redact';
const CARD = '4111 1111 1111 1111';
const MASK = '[REDACTED]';

const SCOPE: HookScope = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_1_db',
  projectId: 'project-1',
  actor: { id: 'user-1', kind: 'agent', roles: ['agent'] },
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

function verdict(hook: HookId, decision: SafetyAction, subject?: HookSubject): HookVerdict {
  return {
    contractVersion: 2,
    hook,
    mode: 'enforce',
    decision,
    wouldBeDecision: decision,
    enforced: true,
    disabled: false,
    findings: decision === 'allow' ? [] : ([{ category: 'credit_card', message: 'card number' }] as never),
    mutations: [],
    subject,
    riskScore: 0,
    codes: [],
    guardrailKeys: [KEY],
    guardrailKey: KEY,
    guardrailName: 'PII redact',
    policyVersion: `${KEY}@2026-01-01T00:00:00.000Z`,
    traceId: 'trace-1',
    latencyMs: 3,
  } as HookVerdict;
}

/** An engine that redacts the card number wherever it appears in the subject, segment by segment. */
async function redactingRunHook(call: HookCall): Promise<HookVerdict> {
  const subject = call.subject;
  if (subject.kind !== 'text' || !subject.text.includes(CARD)) return verdict(call.hook, 'allow');
  const segments = subject.segments.map((segment) => ({
    ...segment,
    text: segment.text.split(CARD).join(MASK),
  }));
  return verdict(call.hook, 'redact', {
    kind: 'text',
    text: segments.map((segment) => segment.text).join('\n'),
    segments,
  });
}

async function compile(onMessageRewrite?: (rewrite: PluginMessageRewrite) => void) {
  vi.resetModules();
  const runHook = vi.fn(redactingRunHook);

  vi.doMock('@/lib/services/guardrail/hooks/engine', () => ({
    runHook,
    resolveGuardrail: vi.fn(async () => ({ key: KEY, name: 'PII redact', mode: 'enforce', enabled: true })),
  }));
  vi.doMock('@/lib/services/guardrail/hooks/legacy', () => ({
    ensureHooks: vi.fn(() => ({
      hooksVersion: 1,
      hooks: {
        contractVersion: 2,
        policies: [policy('pii', ['input.pre'])],
        bindings: { 'input.pre': { enabled: true } },
      },
    })),
  }));

  const adapter = await import('@/lib/services/guardrail/sdkAdapter');
  adapter.resetSdkCapabilityCacheForTests();
  const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE, onMessageRewrite });
  return { plugin, runHook, adapter };
}

afterEach(() => {
  vi.doUnmock('@/lib/services/guardrail/hooks/engine');
  vi.doUnmock('@/lib/services/guardrail/hooks/legacy');
});

const PRE_MODEL_CALL = SDK_CONSOLE_HOOK_MAP['input.pre'] as string;

function state(messages: Message[]): SmartState {
  return {
    messages,
    toolHistory: [],
    toolHistoryArchived: [],
    summaries: [],
    summaryRecords: [],
  } as unknown as SmartState;
}

describe('preModelCall redaction lands per message', () => {
  it('rewrites only the message that carried the PII and returns the rest by identity', async () => {
    const { plugin } = await compile();
    const system = { role: 'system', content: 'Be terse.' };
    const user = { role: 'user', content: `my card is ${CARD}` };

    const outcome = await plugin.hooks[PRE_MODEL_CALL]!(
      { messages: [system, user], tools: [], params: {}, model: {}, iteration: 1 },
      { runId: 'run-1', hookName: PRE_MODEL_CALL, store: {}, depth: 0 },
    );

    expect(outcome?.decision).toBe('allow');
    expect(outcome?.messages).toHaveLength(2);
    expect(outcome?.messages?.[0]).toBe(system);
    expect(outcome?.messages?.[1]).toEqual({ role: 'user', content: `my card is ${MASK}` });
    expect(outcome?.metadata.limitations).toBeUndefined();
  });

  it('the REAL host hands the provider the rewritten transcript, and the ledger sees the rewrite', async () => {
    const rewrites: PluginMessageRewrite[] = [];
    const { plugin, adapter } = await compile((rewrite) => rewrites.push(rewrite));

    const messages: Message[] = [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: `my card is ${CARD}` },
    ];
    const host = createPluginHost([adapter.toAgentPlugin(plugin)]);
    const run = host.beginRun({ runId: 'run-1', getState: () => state(messages), depth: 0 });
    const gate = await run.runGate('preModelCall', {
      messages,
      tools: [],
      params: {},
      model: {},
      iteration: 1,
    });
    run.end();

    // What the SDK sends to the provider is `gate.input.messages`.
    expect(gate.decision).toBe('allow');
    expect(gate.mutated).toBe(true);
    expect(gate.input.messages[1]?.content).toBe(`my card is ${MASK}`);
    expect(JSON.stringify(gate.input.messages)).not.toContain(CARD);

    // …and the console was told exactly which message changed, by content.
    expect(rewrites).toEqual([
      expect.objectContaining({
        guardrailKey: KEY,
        hook: 'input.pre',
        sdkHook: 'preModelCall',
        index: 1,
        role: 'user',
        before: `my card is ${CARD}`,
        after: `my card is ${MASK}`,
      }),
    ]);
  });

  it('maps a multi-message slice per segment — two new messages, two independent rewrites', async () => {
    const { plugin } = await compile();
    const store: Record<string, unknown> = {};
    const ctx = { runId: 'run-1', hookName: PRE_MODEL_CALL, store, depth: 0 };

    // Iteration 1: the user turn is scanned and redacted.
    const first = await plugin.hooks[PRE_MODEL_CALL]!(
      { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: `pay ${CARD}` }] },
      ctx,
    );
    expect(first?.messages?.[1]?.content).toBe(`pay ${MASK}`);

    // Iteration 2: two tool results were appended, each with a card number.
    const second = await plugin.hooks[PRE_MODEL_CALL]!(
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: `pay ${CARD}` },
          { role: 'assistant', content: '', tool_calls: [{ id: 't1' }, { id: 't2' }] },
          { role: 'tool', content: `record A: ${CARD}` },
          { role: 'tool', content: [{ type: 'text', text: `record B: ${CARD}` }, { type: 'image', url: 'x' }] },
        ],
      },
      ctx,
    );

    expect(second?.messages?.[3]?.content).toBe(`record A: ${MASK}`);
    // Multi-part content: the text part is rewritten in place, the image part survives.
    expect(second?.messages?.[4]?.content).toEqual([
      { type: 'text', text: `record B: ${MASK}` },
      { type: 'image', url: 'x' },
    ]);
    // The already-scanned user turn is carried forward redacted, not re-scanned raw.
    expect(second?.messages?.[1]?.content).toBe(`pay ${MASK}`);
    expect(JSON.stringify(second?.messages)).not.toContain(CARD);
  });

  it('never silently allows a rewrite it could not place', async () => {
    // An engine answering with a pointer that addresses no message.
    vi.resetModules();
    vi.doMock('@/lib/services/guardrail/hooks/engine', () => ({
      runHook: vi.fn(async (call: HookCall) =>
        verdict(call.hook, 'redact', { kind: 'text', text: 'x', segments: [{ path: '/elsewhere', text: 'x' }] }),
      ),
      resolveGuardrail: vi.fn(async () => ({ key: KEY, name: 'PII redact', mode: 'enforce', enabled: true })),
    }));
    vi.doMock('@/lib/services/guardrail/hooks/legacy', () => ({
      ensureHooks: vi.fn(() => ({
        hooksVersion: 1,
        hooks: { contractVersion: 2, policies: [policy('pii', ['input.pre'])], bindings: { 'input.pre': { enabled: true } } },
      })),
    }));
    const adapter = await import('@/lib/services/guardrail/sdkAdapter');
    adapter.resetSdkCapabilityCacheForTests();
    const plugin = await adapter.compileToSdkPlugin(KEY, { scope: SCOPE });

    const outcome = await plugin.hooks[PRE_MODEL_CALL]!(
      { messages: [{ role: 'user', content: `pay ${CARD}` }] },
      { runId: 'run-1', hookName: PRE_MODEL_CALL, store: {}, depth: 0 },
    );
    expect(outcome?.decision).toBe('allow');
    expect(outcome?.messages).toBeUndefined();
    expect(outcome?.metadata.limitations).toEqual(['redact_not_applied']);
  });
});

describe('the console persists what the model saw', () => {
  const { MessageRewriteLedger, persistedUserTurn } = __testables;

  it('follows a rewrite chain across guardrails and leaves unrelated text alone', () => {
    const ledger = new MessageRewriteLedger();
    const base = { guardrailKey: KEY, hook: 'input.pre' as const, sdkHook: 'preModelCall', index: 1, role: 'user' };
    ledger.record({ ...base, before: `card ${CARD} for a@b.com`, after: `card ${MASK} for a@b.com` });
    ledger.record({ ...base, guardrailKey: 'pii-email', before: `card ${MASK} for a@b.com`, after: `card ${MASK} for [EMAIL]` });

    expect(ledger.resolve(`card ${CARD} for a@b.com`)).toBe(`card ${MASK} for [EMAIL]`);
    expect(ledger.resolve('hello')).toBe('hello');
    expect(ledger.size).toBe(2);
  });

  it('prefers the prompt.pre rewrite in result.messages, then applies the input.pre ledger', () => {
    const ledger = new MessageRewriteLedger();
    // input.pre saw the PROMPT-rewritten text (userPromptSubmit runs first).
    ledger.record({
      guardrailKey: KEY, hook: 'input.pre', sdkHook: 'preModelCall', index: 1, role: 'user',
      before: `[NAME] pays ${CARD}`, after: `[NAME] pays ${MASK}`,
    });
    const result = {
      messages: [
        { role: 'user', content: 'earlier turn' },
        { role: 'assistant', content: 'earlier answer' },
        // The host wrote the prompt.pre rewrite into state in place.
        { role: 'user', content: `[NAME] pays ${CARD}` },
        { role: 'assistant', content: 'Noted.' },
      ],
    };
    expect(persistedUserTurn({ result, index: 2, fallback: `Jane pays ${CARD}`, ledger }))
      .toBe(`[NAME] pays ${MASK}`);
  });

  it('falls back to the request text when the result no longer holds a user turn at that index', () => {
    const ledger = new MessageRewriteLedger();
    ledger.record({
      guardrailKey: KEY, hook: 'input.pre', sdkHook: 'preModelCall', index: 1, role: 'user',
      before: `pay ${CARD}`, after: `pay ${MASK}`,
    });
    // A compaction moved things: index 0 is now a summary, not the user turn.
    const result = { messages: [{ role: 'system', content: 'summary' }, { role: 'assistant', content: 'ok' }] };
    expect(persistedUserTurn({ result, index: 0, fallback: `pay ${CARD}`, ledger })).toBe(`pay ${MASK}`);
  });
});

describe('AgentGuardrailBlockedError', () => {
  it('is a 400 carrying the key, the reason and the hook', () => {
    const error = new AgentGuardrailBlockedError('Agent response blocked by guardrail: no', {
      guardrailKey: KEY,
      reason: 'no',
      hook: 'prompt.pre',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AgentGuardrailBlockedError');
    expect(error.status).toBe(400);
    expect(error.guardrailKey).toBe(KEY);
    expect(error.reason).toBe('no');
    expect(error.hook).toBe('prompt.pre');
  });

  it('is built from a plugin denial with the key and hook recovered from the incident', () => {
    const blocked = __testables.guardrailBlockedError({
      state: {
        ctx: {
          __guardrailBlocked: {
            phase: 'request',
            incident: { reason: `cognipeer-guardrail:${KEY}: Not this.`, deniedBy: `cognipeer-guardrail:${KEY}`, hook: 'userPromptSubmit' },
          },
        },
      },
    });
    expect(blocked).toBeInstanceOf(AgentGuardrailBlockedError);
    expect(blocked?.reason).toBe('Not this.');
    expect(blocked?.guardrailKey).toBe(KEY);
    expect(blocked?.hook).toBe('prompt.pre');
    expect(blocked?.message).toBe('Agent response blocked by guardrail: Not this.');
  });

  it('is undefined for an ordinary answer', () => {
    expect(__testables.guardrailBlockedError({ messages: [{ role: 'assistant', content: 'Hello.' }] })).toBeUndefined();
  });
});
