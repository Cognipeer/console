/**
 * Review finding #3 — the stream gate RELEASED text it never scanned when one
 * chunk exceeded `maxHeldChars`.
 *
 * `windowStart = max(scanFrom, buffer.length - maxHeldChars)`, and everything in
 * `[releasedTo, windowStart)` was counted as "unadjudicated", logged, and then
 * released by `release(buffer.length - keepBack)` without any policy seeing it.
 * That is the normal case under `disableStreamingWithTools`, where
 * `inferenceService` yields a whole answer as ONE chunk: a 10 000-character
 * answer with a credential at offset 500 reached the client intact and only
 * its last 4 000 characters were scanned.
 *
 * The fix walks the pending region in successive windows of `maxHeldChars`,
 * each through the same adjudication, before anything is released; only what
 * no window can reach falls back to the configured `onBudgetExceeded`.
 *
 * `runHook` is a fake detector: it looks for one known secret in the window
 * it is handed. Everything the gate does with windows and offsets is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  ensureHooks: vi.fn(),
  fireAndForget: vi.fn(),
}));

vi.mock('@/lib/services/guardrail/hooks/engine', () => ({
  runHook: hoisted.runHook,
  resolveGuardrail: hoisted.resolveGuardrail,
}));
vi.mock('@/lib/services/guardrail/hooks/legacy', () => ({
  ensureHooks: hoisted.ensureHooks,
}));
// The terminal audit is fire-and-forget through the (mocked) engine; kept out
// of the call counts so every `runHook` call below is a WINDOW.
vi.mock('@/lib/core/asyncTask', () => ({ fireAndForget: hoisted.fireAndForget }));

import { GUARDRAIL_CONTRACT_VERSION } from '@/lib/services/guardrail/hooks/contract';
import type {
  HookCall,
  HookScope,
  HookSubject,
  HookVerdict,
  Mutation,
  SafetyAction,
  StreamGuardSettings,
} from '@/lib/services/guardrail/hooks/contract';
import { createStreamGate } from '@/lib/services/guardrail/hooks/streamGate';
import type { OpenAiStreamChunkLike } from '@/lib/services/guardrail/hooks/streamGate';

const KEY = 'stream-guard';
const SECRET = 'sk-live-SECRETSECRETSECRET1234567890';
const REDACTED = '[REDACTED:apiKey]';
const MAX_HELD = 4000;

const scope: HookScope = {
  tenantId: 'tenant-a',
  tenantDbName: 't_tenant_a',
  actor: { id: 'u1', kind: 'user', roles: [] },
  surface: 'api',
  source: 'chat.completions:stream',
  traceId: 'trace-stream-overflow',
};

type StreamSubject = Extract<HookSubject, { kind: 'stream_delta' }>;

function verdict(input: {
  decision: SafetyAction;
  mutations?: Mutation[];
}): HookVerdict<StreamSubject> {
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook: 'output.stream.delta',
    mode: 'enforce',
    decision: input.decision,
    wouldBeDecision: input.decision,
    enforced: true,
    disabled: false,
    findings: [],
    mutations: input.mutations ?? [],
    riskScore: input.decision === 'allow' ? 0 : 90,
    codes: [],
    message: input.decision === 'block' ? ({ body: 'Blocked by policy.' } as never) : undefined,
    guardrailKeys: [KEY],
    guardrailKey: KEY,
    guardrailName: 'Stream guard',
    policyVersion: `${KEY}@1`,
    traceId: scope.traceId,
    latencyMs: 1,
  };
}

/** A detector that BLOCKS any window containing the secret. */
function blockingDetector(): void {
  hoisted.runHook.mockImplementation(async (call: HookCall<StreamSubject>) =>
    verdict({ decision: call.subject.text.includes(SECRET) ? 'block' : 'allow' }),
  );
}

/** A detector that REDACTS the secret wherever it sees it, with window offsets. */
function redactingDetector(): void {
  hoisted.runHook.mockImplementation(async (call: HookCall<StreamSubject>) => {
    const at = call.subject.text.indexOf(SECRET);
    if (at < 0) return verdict({ decision: 'allow' });
    return verdict({
      decision: 'redact',
      mutations: [
        {
          op: 'replace_span',
          path: '/buffer',
          start: at,
          end: at + SECRET.length,
          replacement: REDACTED,
          family: 'secrets',
          policyId: 'sec',
          category: 'apiKey',
        },
      ],
    });
  });
}

function gateWith(settings?: StreamGuardSettings) {
  return createStreamGate({
    scope,
    guardrailKeys: [KEY],
    settings,
    makeChunk: (text) => ({ choices: [{ index: 0, delta: { content: text } }] }),
    audit: false,
  });
}

function contentChunk(text: string): OpenAiStreamChunkLike {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

function emittedText(emit: OpenAiStreamChunkLike[]): string {
  return emit
    .map((chunk) => {
      const content = chunk.choices?.[0]?.delta?.content;
      return typeof content === 'string' ? content : '';
    })
    .join('');
}

/** 10 000 characters with the secret at offset 500. */
function bigChunk(): string {
  const head = 'x'.repeat(500);
  const tail = 'y'.repeat(10_000 - head.length - SECRET.length);
  return `${head}${SECRET}${tail}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.resolveGuardrail.mockResolvedValue({ key: KEY, name: 'Stream guard', mode: 'enforce', enabled: true });
  hoisted.ensureHooks.mockReturnValue({
    hooksVersion: 1,
    hooks: {
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      stream: {
        enabled: true,
        holdBackChars: 256,
        overlapChars: 64,
        maxHeldChars: MAX_HELD,
        onBudgetExceeded: 'release',
        onBlock: 'truncate',
      },
      bindings: { 'output.stream.delta': { enabled: true } },
      policies: [
        {
          id: 'sec',
          family: 'secrets',
          enabled: true,
          hooks: ['output.stream.delta'],
          schedule: { timing: 'sync', onFail: 'block' },
          known: true,
        },
      ],
    },
  });
});

describe('a single chunk larger than maxHeldChars', () => {
  it('is BLOCKED when the secret sits in the part that used to be released unscanned', async () => {
    blockingDetector();
    const gate = gateWith();
    const chunk = bigChunk();

    const out = await gate.push(contentChunk(chunk));

    expect(out.blocked).toBe(true);
    // Nothing containing the secret reached the wire — and since the secret is
    // in the FIRST window, nothing at all was released before the block.
    expect(emittedText(out.emit)).not.toContain(SECRET);
    expect(emittedText(out.emit)).toBe('');
    expect(gate.isBlocked).toBe(true);

    // The window that blocked actually contained the secret and respected the
    // hold-back bound — the pre-fix gate scanned only the LAST 4000 characters.
    const first = hoisted.runHook.mock.calls[0]?.[0] as HookCall<StreamSubject>;
    expect(first.subject.text).toContain(SECRET);
    expect(first.subject.text.length).toBeLessThanOrEqual(MAX_HELD);
  });

  it('is REDACTED in place when the policy redacts, and the secret never reaches the wire', async () => {
    redactingDetector();
    const gate = gateWith();
    const chunk = bigChunk();

    const out = await gate.push(contentChunk(chunk));
    expect(out.blocked).toBe(false);

    const released = emittedText(out.emit);
    expect(released).not.toContain(SECRET);
    expect(released).toContain(REDACTED);
    // Released + still-held is the whole answer with exactly one rewrite; the
    // gate held back no more than one window's worth for the next chunk.
    expect(released + gate.heldText).toBe(chunk.replace(SECRET, REDACTED));
    expect(gate.pendingChars).toBeLessThanOrEqual(MAX_HELD);

    const end = await gate.end();
    expect(end.blocked).toBe(false);
    expect(released + emittedText(end.emit)).toBe(chunk.replace(SECRET, REDACTED));
  });

  it('adjudicates EVERY character: the windows cover the whole chunk and none exceeds maxHeldChars', async () => {
    hoisted.runHook.mockImplementation(async () => verdict({ decision: 'allow' }));
    const gate = gateWith();
    // 2000 distinct zero-padded blocks: any window is a unique substring, so
    // its absolute position in the chunk can be recovered with `indexOf`.
    const chunk = Array.from({ length: 2000 }, (_, i) => String(i).padStart(5, '0')).join('');
    expect(chunk).toHaveLength(10_000);

    const out = await gate.push(contentChunk(chunk));
    expect(out.blocked).toBe(false);

    const calls = hoisted.runHook.mock.calls.map((c) => c[0] as HookCall<StreamSubject>);
    expect(calls.length).toBeGreaterThan(1);

    // Every window respects the hold-back bound, and the PENDING part of each
    // window — `[releasedTo, end)` in window coordinates — covers the chunk
    // without a gap. Consecutive windows overlap by `overlapChars` on purpose
    // (that is the straddle guarantee), so the check is coverage, not tiling.
    let coveredTo = 0;
    for (const call of calls) {
      const { text, releasedTo, delta, segments } = call.subject;
      expect(text.length).toBeLessThanOrEqual(MAX_HELD);
      expect(segments).toHaveLength(1);
      expect(segments[0].path).toBe('/buffer');
      const start = chunk.indexOf(text);
      expect(start).toBeGreaterThanOrEqual(0);
      const pendingFrom = start + releasedTo;
      const pendingTo = start + text.length;
      expect(delta).toBe(chunk.slice(pendingFrom, pendingTo));
      // No gap: this window's pending region starts at or before where the
      // previous one stopped.
      expect(pendingFrom).toBeLessThanOrEqual(coveredTo);
      coveredTo = Math.max(coveredTo, pendingTo);
    }
    expect(coveredTo).toBe(chunk.length);
    // And no window carried the "released without adjudication" degradation.
    expect(out.verdict?.degraded ?? []).toEqual([]);
  });
});

describe('when no window can make progress, onBudgetExceeded still decides', () => {
  // `maxHeldChars == 2 * overlapChars`: after the first window every further
  // window is all overlap, so the catch-up cannot advance the frontier and
  // the configured fallback applies to the remainder.
  const stalledSettings: StreamGuardSettings = {
    enabled: true,
    overlapChars: 2000,
    holdBackChars: 2000,
    maxHeldChars: 4000,
  };

  it("'terminate' stays terminate: the stream is stopped with stream_budget_exceeded", async () => {
    hoisted.runHook.mockImplementation(async () => verdict({ decision: 'allow' }));
    const gate = gateWith({ ...stalledSettings, onBudgetExceeded: 'terminate' });

    const out = await gate.push(contentChunk('z'.repeat(10_000)));

    expect(out.blocked).toBe(true);
    expect(out.verdict?.codes).toEqual(['stream_budget_exceeded']);
    expect(out.verdict?.degraded?.[0]?.policyId).toBe('stream.window');
    // The one window that DID clear went out ahead of the termination; the
    // rest never did.
    expect(emittedText(out.emit).length).toBeLessThanOrEqual(2000);
  });

  it("'release' still records the gap on the verdict rather than reading as a clean pass", async () => {
    hoisted.runHook.mockImplementation(async () => verdict({ decision: 'allow' }));
    const gate = gateWith({ ...stalledSettings, onBudgetExceeded: 'release' });

    const out = await gate.push(contentChunk('z'.repeat(10_000)));

    expect(out.blocked).toBe(false);
    expect(out.verdict?.degraded?.some((d) => d.policyId === 'stream.window' && /without adjudication/.test(d.reason))).toBe(true);
  });
});
