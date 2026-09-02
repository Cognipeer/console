/**
 * REAL-TIME STREAMING ENFORCEMENT.
 *
 * Today a streamed answer is audited AFTER the fact: `inferenceService`'s
 * `auditStreamedOutput` (:1285-1310) evaluates the aggregated text once the
 * stream is over, and its own comment says why that is all it can do — "the
 * text has already reached the client". A credential the model emitted is in
 * the user's browser before the guardrail ever sees it. This file is the fix:
 * text is withheld behind a release frontier, adjudicated, and only then
 * written to the socket.
 *
 * ── THE GATE OPERATES ON CHUNK OBJECTS, NOT STRINGS ────────────────────────
 * `inferenceService` builds a full OpenAI chunk with `toOpenAIStreamChunk` and
 * enqueues it verbatim; that same payload carries `delta.tool_calls`,
 * `finish_reason` and `usage`, and the surrounding code reads
 * `terminalFinishReason`, `hasFinalOutput` and `finalUsagePayload` off it. A
 * `push(text) -> {emit: string}` gate could not express "hold this text back
 * but pass the tool-call delta through in order", and holding a chunk to hold
 * its text would also hold its `finish_reason` — hanging every client that
 * waits for one.
 *
 * ── THE HOLD-BACK INVARIANT ────────────────────────────────────────────────
 * This is the whole correctness argument, and everything else here exists to
 * serve it:
 *
 *   THE RELEASE POINT STAYS AT LEAST `overlap` CHARACTERS BEHIND THE
 *   DETECTION FRONTIER, WHERE `overlap >= max(policyMaxMatchChars)` OVER THE
 *   ENABLED STREAM-BOUND POLICIES.
 *
 * Detection runs over `releasedTail(overlap) + pending`. Take any match that
 * ends at or after the release point R: its length is at most `overlap`, so it
 * begins after `R - overlap`, so it lies wholly inside the scanned window and
 * IS found. A 16-digit card number split "12345678" / "90123456" across two
 * provider chunks is therefore caught on the second one — which is the single
 * behaviour a naive per-chunk scanner gets wrong, and the reason the red-team
 * battery carries a `secret-split` probe.
 *
 * The converse also matters: by induction, text that has already been released
 * contained no undetected match at the moment it was released, so a finding
 * lying WHOLLY inside the overlap tail is a re-detection of something already
 * adjudicated. Its rewrite cannot be honoured — those bytes are on the wire —
 * so mutations are rebased onto the pending region and anything pointing behind
 * the frontier is dropped with a reason rather than silently corrupting the
 * offsets of everything after it.
 *
 * ── WHY THE GATE APPLIES ITS OWN MUTATIONS ─────────────────────────────────
 * `runHook` already applies the merged mutation list to the subject it was
 * given, and `verdict.subject.buffer` comes back rewritten. The gate ignores
 * that result and re-applies the list itself to the PENDING region only. The
 * engine has no way to know that the first `releasedTo` characters of the
 * window are immutable, so its rewrite is free to touch them; using it would
 * mean emitting a correction for bytes that were flushed several windows ago.
 *
 * ── NEVER ABORT BEFORE CLOSING ─────────────────────────────────────────────
 * The block sequence the caller must follow is spelled out on `push()` below.
 * It is not a style preference: aborting the upstream controller first makes
 * the provider iterator throw into `inferenceService`'s catch, which tests
 * `abortController.signal.aborted` (:1464), logs `status: 'cancelled'` and
 * RETURNS — so the content-filter frame, the error frame and `[DONE]` are never
 * written, and a policy block is billed and alerted as a user pressing stop.
 * `abandon()` exists to keep that cancel path's audit intact.
 */

import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';

import {
  DEFAULT_STREAM_SETTINGS,
  GUARDRAIL_CONTRACT_VERSION,
  STREAM_ELIGIBLE_FAMILIES,
  policyMaxMatchChars,
  textSubject,
  toGuardrailMode,
} from './contract';
import type {
  PolicyFamily,
  GuardrailPolicy,
  HookScope,
  HookSubject,
  HookVerdict,
  Mutation,
  StreamGuardSettings,
} from './contract';
import { runHook, resolveGuardrail } from './engine';
import { ensureHooks } from './legacy';
import { resolveBlockMessage } from './messages';
import { applyMutations } from './mutations';

const logger = createLogger('guardrail-stream-gate');

/** The subject shape this file is specialised to. */
type StreamDeltaSubject = Extract<HookSubject, { kind: 'stream_delta' }>;

/**
 * The pointer every stream segment is addressed by.
 *
 * A `stream_delta` subject carries exactly ONE segment covering the whole
 * window (the invariant documented on `HookSubject`), so the path is a constant
 * rather than something a detector could vary. `applyMutations` resolves a
 * mutation by matching its path against a segment, which is what lets the gate
 * recognise — and reject — a mutation aimed at some other subject entirely.
 */
const STREAM_SEGMENT_PATH = '/buffer';

/**
 * `only` is passed on every window call even though `isDispatchable` already
 * routes the delta hook to the stream-eligible families.
 *
 * The redundancy is deliberate and it is a hard requirement, not a belt: a
 * window is evaluated ~17 times for a 4K answer, so an LLM family reached here
 * would multiply model spend by the window count and a webhook family would put
 * a third-party socket in the middle of every 256 characters. `only` is the
 * contract's own mechanism for "just the fast, local part", and stating it here
 * means a future change to the engine's routing table cannot quietly put a
 * network call on the token path.
 */
const STREAM_ONLY_FAMILIES: PolicyFamily[] = [...STREAM_ELIGIBLE_FAMILIES];

/**
 * How many catch-up windows one `advance` may run before it gives up on
 * adjudicating an over-size pending region and falls back to
 * `onBudgetExceeded`.
 *
 * A single provider chunk larger than `maxHeldChars` — the normal case when
 * `disableStreamingWithTools` makes `inferenceService` yield a whole answer as
 * one chunk — used to release everything but its last `maxHeldChars` characters
 * UNSCANNED. Now the pending region is walked in successive windows first, each
 * through the same adjudication as any other window. The cap only bounds the
 * pathological case (a rewrite that keeps the frontier from advancing); with
 * the default 4000/64 settings, 256 windows cover roughly a megabyte of pending
 * text, four times the regex family's own per-segment input cap.
 */
const MAX_CATCH_UP_WINDOWS = 256;

// ═══════════════════════════════════════════════════════════════════════════
// Wire shapes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structurally what `toOpenAIStreamChunk` returns, kept deliberately loose.
 *
 * The index signature is what makes the gate transparent: it re-emits a chunk's
 * unrecognised top-level fields untouched, so a provider field this build has
 * never heard of survives the round trip instead of being dropped by a stricter
 * type.
 */
export interface OpenAiStreamChunkLike {
  choices?: Array<{
    index?: number;
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
  usage?: unknown;
  [k: string]: unknown;
}

export interface StreamGateEmission {
  /** Chunks safe to enqueue NOW, in order. May be empty. */
  emit: OpenAiStreamChunkLike[];
  /**
   * True exactly once, on the window that blocked. The gate then latches: every
   * later `push` returns `{emit: [], blocked: true}` with the same verdict, so
   * a caller that forgets to break out of its loop still cannot leak content.
   */
  blocked: boolean;
  /** The window's verdict. Present whenever a window was actually adjudicated. */
  verdict?: HookVerdict<StreamDeltaSubject>;
}

export interface StreamGate {
  /**
   * Feed one provider chunk. NEVER throws and NEVER rejects — it sits inside
   * the provider's `for await` loop, and an exception there is a dropped
   * response.
   *
   * BLOCK SEQUENCE, inside `inferenceService`'s `ReadableStream start()`:
   *
   *   const out = await gate.push(payload);
   *   for (const c of out.emit) controller.enqueue(enc(`data: ${JSON.stringify(c)}\n\n`));
   *   if (out.blocked) {
   *     blockedByGuardrail = out.verdict;
   *     // 1. the OpenAI-native signal every SDK already understands
   *     controller.enqueue(enc(`data: ${JSON.stringify(
   *       openAIStreamStopChunk(chunkOptions, 'content_filter'))}\n\n`));
   *     // 2. the same error-frame shape the output-limit path already emits
   *     controller.enqueue(enc(`data: ${JSON.stringify({
   *       error: { type: 'guardrail_block',
   *                code: out.verdict?.message?.reasonClass,
   *                message: out.verdict?.message?.body,
   *                guardrail_key: out.verdict?.guardrailKey },
   *       request_id: requestId })}\n\n`));
   *     // 3. ALWAYS. Withholding it hangs every client that reads to the sentinel.
   *     controller.enqueue(enc('data: [DONE]\n\n'));
   *     controller.close();
   *     abortController.abort();     // ONLY NOW — after the socket is closed
   *     break;
   *   }
   */
  push(chunk: OpenAiStreamChunkLike): Promise<StreamGateEmission>;
  /**
   * Adjudicate and release without a terminal chunk, honouring `holdBackMs`.
   *
   * ADDITIVE — not in the contract's interface. `holdBackMs` is otherwise
   * unimplementable: the gate is push-driven, so a model that emits 100
   * characters and then thinks for three seconds would leave those characters
   * withheld with nothing to trigger their release. A caller that cares about
   * that tail latency runs a timer and enqueues whatever this returns.
   */
  flush(): Promise<StreamGateEmission>;
  /**
   * Terminal for the SUCCESS path: adjudicate the tail with no hold-back left
   * (nothing more can arrive, so there is no boundary to straddle), release it,
   * then schedule the post-hoc `output.pre` audit.
   */
  end(): Promise<StreamGateEmission>;
  /**
   * Terminal for the CANCEL path. Releases nothing — the socket is gone — but
   * still schedules the audit, for the reason `inferenceService` already states
   * at :1288-1290: "auditing only completed answers would let a caller skip the
   * audit by hanging up."
   */
  abandon(): void;
  /** Characters generated but not yet written to the client. */
  readonly pendingChars: number;
  /** Everything the model has produced on the gated channel, PRE-redaction. */
  readonly bufferedText: string;
  /** The currently withheld tail, post-redaction — what `emit` would carry. */
  readonly heldText: string;
  /** True once a window blocked. */
  readonly isBlocked: boolean;
  /**
   * True when the gate gave up and fell back to pass-through — the settings
   * lookup failed, or a window threw. The stream is then no better protected
   * than it is today (the terminal audit still runs), and the caller should say
   * so in its own log line rather than reporting a clean guarded response.
   */
  readonly isDegraded: boolean;
}

export interface CreateStreamGateOptions {
  scope: HookScope;
  /**
   * Every guardrail bound to this response. The gate splits them itself: only
   * the ENFORCING, stream-configured subset adjudicates windows, while the
   * terminal audit runs the full list — a monitor-mode guardrail still gets its
   * dry-run verdict, it just gets it once at the end instead of paying for a
   * hold-back it can never act on.
   */
  guardrailKeys: string[];
  /**
   * Overrides the settings folded from the records. The SAFETY FLOORS are
   * re-applied on top of it: an override may make the gate slower or more
   * cautious, never less sound.
   */
  settings?: StreamGuardSettings;
  /**
   * Builds a synthetic content chunk from released text. The gate cannot
   * forward the provider's own chunk once it has delayed or rewritten that
   * chunk's content, so the caller supplies the envelope (id, model, created)
   * it wants those characters to arrive in.
   */
  makeChunk: (text: string) => OpenAiStreamChunkLike;
  /**
   * Write an evaluation-log row per window. Default FALSE.
   *
   * A 4K answer is ~17 windows; logging each would put 17 rows in the audit
   * trail for one response, all of them re-reporting the same findings as the
   * overlap tail is re-scanned. The terminal `output.pre` audit covers the
   * whole answer in ONE row — including the withheld text on a block — which is
   * exactly the row count today's post-hoc audit produces.
   */
  logWindows?: boolean;
  /** Suppress the terminal audit too. For previews and the red-team runner. */
  shadow?: boolean;
  /** Set false when the caller keeps its own post-hoc audit. */
  audit?: boolean;
  /**
   * `source` for the terminal audit's evaluation log. Defaults reproduce
   * today's strings when `scope.source` is 'chat.completions:stream':
   * that value on `end`, and it with ':cancelled' appended on `abandon`.
   */
  auditSource?: { end?: string; abandon?: string };
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings resolution
// ═══════════════════════════════════════════════════════════════════════════

interface ResolvedSettings extends Required<StreamGuardSettings> {
  /** The subset of `guardrailKeys` that actually adjudicates windows. */
  streamKeys: string[];
}

/** Gating off: pass every chunk through untouched and audit at the end. */
const PASS_THROUGH: ResolvedSettings = {
  ...DEFAULT_STREAM_SETTINGS,
  enabled: false,
  streamKeys: [],
};

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;

/**
 * Fold the stream settings of every bound guardrail into one set of window
 * parameters, and compute the overlap the hold-back invariant requires.
 *
 * The fold is by STRICTNESS, not by "the first guardrail wins": two guardrails
 * on one response are two independent policies over the same bytes, and a
 * window that satisfies the looser of them satisfies neither. So hold-back and
 * overlap take the max, the latency promise (`holdBackMs`) takes the min, and
 * the two enum settings take whichever member refuses to release.
 */
async function foldStreamSettings(
  scope: HookScope,
  guardrailKeys: string[],
  override?: StreamGuardSettings,
): Promise<ResolvedSettings> {
  const streamKeys: string[] = [];
  let holdBackChars = 0;
  let overlapChars = 0;
  let holdBackMs = Number.POSITIVE_INFINITY;
  let maxHeldChars = 0;
  let onBudgetExceeded: 'release' | 'terminate' = 'release';
  let onBlock: 'truncate' | 'replace' = 'replace';

  for (const key of guardrailKeys) {
    const record = await resolveGuardrail(scope.tenantDbName, key, scope.projectId);
    if (!record) continue;

    // A monitor-mode guardrail cannot block and cannot redact — `runHook`
    // neutralises its decision and drops its mutations — so gating windows for
    // it would buy nothing but latency. Its dry-run verdict comes from the
    // terminal audit, which is also the only place it would ever be logged.
    if (toGuardrailMode(record.mode, record.enabled) !== 'enforce') continue;

    const { hooks } = ensureHooks(record);
    if (hooks.stream?.enabled !== true) continue;
    if (hooks.bindings?.['output.stream.delta']?.enabled !== true) continue;

    const policies = (hooks.policies ?? []).filter(
      (policy: GuardrailPolicy) =>
        policy.enabled &&
        policy.hooks?.includes('output.stream.delta') &&
        STREAM_ELIGIBLE_FAMILIES.has(policy.family),
    );
    if (policies.length === 0) continue;

    // THE FAIL-SAFE. `policyMaxMatchChars` returns 0 for "unbounded or
    // non-deterministic" — a PII policy with obfuscation detection on, a regex
    // rule with no declared bound. No window can make such a policy correct, so
    // there is no honest hold-back to size. `validateGuardrailHooks` already
    // refuses to SAVE that config; a row that has one came from an older build
    // or a direct write, and the answer is to stop pretending this guardrail
    // enforces on the stream, not to under-scan silently.
    let required = 0;
    let unbounded: GuardrailPolicy | undefined;
    for (const policy of policies) {
      const bound = policyMaxMatchChars(policy);
      if (bound <= 0) {
        unbounded = policy;
        break;
      }
      required = Math.max(required, bound);
    }
    if (unbounded) {
      logger.error('Guardrail cannot enforce on a stream: policy has no bounded match length', {
        guardrailKey: key,
        policyId: unbounded.id,
        family: unbounded.family,
        traceId: scope.traceId,
      });
      continue;
    }

    const stream = hooks.stream;
    streamKeys.push(key);
    overlapChars = Math.max(
      overlapChars,
      required,
      positive(stream.overlapChars, DEFAULT_STREAM_SETTINGS.overlapChars),
    );
    holdBackChars = Math.max(
      holdBackChars,
      positive(stream.holdBackChars, DEFAULT_STREAM_SETTINGS.holdBackChars),
    );
    holdBackMs = Math.min(
      holdBackMs,
      positive(stream.holdBackMs, DEFAULT_STREAM_SETTINGS.holdBackMs),
    );
    maxHeldChars = Math.max(
      maxHeldChars,
      positive(stream.maxHeldChars, DEFAULT_STREAM_SETTINGS.maxHeldChars),
    );
    if (stream.onBudgetExceeded === 'terminate') onBudgetExceeded = 'terminate';
    // 'truncate' is the honest member: 'replace' can only be delivered when
    // nothing has been flushed yet, so one guardrail asking for truncation
    // decides for all of them.
    if ((stream.onBlock ?? DEFAULT_STREAM_SETTINGS.onBlock) === 'truncate') onBlock = 'truncate';
  }

  if (streamKeys.length === 0) return PASS_THROUGH;

  const merged: Required<StreamGuardSettings> = {
    enabled: true,
    holdBackChars: positive(override?.holdBackChars, holdBackChars),
    overlapChars: positive(override?.overlapChars, overlapChars),
    holdBackMs: positive(
      override?.holdBackMs,
      Number.isFinite(holdBackMs) ? holdBackMs : DEFAULT_STREAM_SETTINGS.holdBackMs,
    ),
    maxHeldChars: positive(override?.maxHeldChars, maxHeldChars),
    onBudgetExceeded: override?.onBudgetExceeded ?? onBudgetExceeded,
    onBlock: override?.onBlock ?? onBlock,
  };

  // ── the floors, re-applied AFTER the override ──
  // `overlapChars` is not a preference: it is max(policyMaxMatchChars), and a
  // caller lowering it would silently reintroduce the split-secret hole this
  // file exists to close. `holdBackChars` must in turn be at least the overlap,
  // because the release point is the frontier minus the hold-back and it has to
  // stay behind the overlap. `maxHeldChars` below the hold-back would put the
  // gate in permanent overflow, degrading every window of every stream.
  merged.overlapChars = Math.max(merged.overlapChars, overlapChars);
  merged.holdBackChars = Math.max(merged.holdBackChars, merged.overlapChars);
  merged.maxHeldChars = Math.max(merged.maxHeldChars, merged.holdBackChars + merged.overlapChars);

  return { ...merged, streamKeys };
}

// ═══════════════════════════════════════════════════════════════════════════
// Chunk surgery
// ═══════════════════════════════════════════════════════════════════════════

interface SplitChunk {
  /** Gated text lifted out of `delta.content`. */
  text: string;
  /** Everything else, safe to emit now. Null when nothing is left to say. */
  residual: OpenAiStreamChunkLike | null;
  /** This chunk closes a choice, so the tail must be flushed before it goes out. */
  terminal: boolean;
}

/**
 * True when a frame would carry no information at all once its content has been
 * lifted out. Mirrors `openaiAdapter.isEmptyStreamDelta`, deliberately not
 * imported: this file must not depend on the model layer, which is the layer
 * that will import IT.
 */
function isSilentResidual(chunk: OpenAiStreamChunkLike): boolean {
  if (chunk.usage !== undefined && chunk.usage !== null) return false;
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return true;
  return choices.every((choice) => {
    if (typeof choice.finish_reason === 'string') return false;
    const delta = choice.delta;
    if (!delta) return true;
    return Object.values(delta).every((value) => value === '' || value === undefined);
  });
}

/**
 * Lift `delta.content` out of the gated choice, leaving everything else in
 * place and in order.
 *
 * WHY ONLY `content`. `delta.tool_calls` is already fully buffered downstream
 * for JSON parsing and is adjudicated by `tool.pre` against the parsed
 * arguments, where the policies can see structure instead of a stream of
 * half-formed JSON fragments — gating it here would block on a partial
 * `{"path": "/etc/pas` and could never produce a coherent rewrite.
 * `delta.role` and an EMPTY `delta.content` are left alone: the opening frame's
 * `content: ''` is part of the shape strict clients expect, and stripping it
 * would change a frame the gate has no reason to touch.
 *
 * KNOWN GAP: `delta.reasoning_content` and `delta.reasoning` pass through
 * UNGATED. They are a second, independently ordered channel, and one buffer
 * cannot hold two — a gate that folded them into `content` would interleave two
 * texts and corrupt every span. So a credential the model states in visible
 * reasoning is redacted from the answer and not from the reasoning. The fix is
 * a SECOND gate over that channel with its own `makeChunk`, not a wider buffer
 * here; the terminal `output.pre` audit does not see it either, because
 * `bufferedText` is the content channel. See the report.
 */
function splitChunk(chunk: OpenAiStreamChunkLike, warn: (reason: string) => void): SplitChunk {
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { text: '', residual: chunk, terminal: false };
  }

  // The gated channel is choice 0 — the only one this codebase's streaming path
  // produces (`toOpenAIStreamChunk` always builds `choices: [{index: 0, ...}]`).
  // An `n > 1` response would need one gate per choice, each with its own
  // buffer; folding several choices into one buffer would interleave two
  // answers and corrupt every span. Content on any other choice is therefore
  // passed through UNGATED and reported, because a silent hole is worse than a
  // loud one.
  let gatedAt = choices.findIndex((choice) => choice.index === 0);
  if (gatedAt < 0 && choices.every((choice) => choice.index === undefined)) gatedAt = 0;

  let text = '';
  let terminal = false;
  const nextChoices = choices.map((choice, i) => {
    if (typeof choice.finish_reason === 'string') terminal = true;
    const delta = choice.delta;
    const content = delta?.content;
    if (content === undefined || content === '') return choice;
    if (typeof content !== 'string') {
      // A non-string `delta.content` (multimodal parts) is not something this
      // gate can scan or splice, so it goes out untouched.
      warn('non_string_content');
      return choice;
    }
    if (i !== gatedAt) {
      warn('content_on_secondary_choice');
      return choice;
    }
    text += content;
    const rest: Record<string, unknown> = { ...delta };
    delete rest.content;
    return { ...choice, delta: rest };
  });

  const residual: OpenAiStreamChunkLike = { ...chunk, choices: nextChoices };
  return { text, residual: isSilentResidual(residual) ? null : residual, terminal };
}

// ═══════════════════════════════════════════════════════════════════════════
// Mutation rebasing
// ═══════════════════════════════════════════════════════════════════════════

interface RebaseResult {
  mutations: Mutation[];
  /** Rewrites that pointed behind the release frontier, i.e. at bytes already
   *  on the wire. Reported, never applied. */
  unreachable: number;
}

/**
 * Move a window's mutations onto the pending region.
 *
 * Spans arrive as offsets into the WINDOW (overlap tail + pending). The pending
 * region starts at `releasedInWindow`, so every span shifts by that much, and
 * anything ending at or before it is a re-detection of already-released text —
 * dropped, because "redact" applied to bytes the client already has is not a
 * redaction, it is a second, contradictory copy of the same sentence.
 *
 * A span that STRADDLES the frontier should be unreachable (the previous window
 * would have caught the same match while it was still wholly pending), so one
 * appearing here means the invariant was violated — most plausibly by a rewrite
 * that `applyMutations` had to skip. It is clamped to the pending side and
 * reported at error level: the tail of a credential is still worth removing
 * even when its head escaped.
 */
function rebaseMutations(mutations: readonly Mutation[], releasedInWindow: number): RebaseResult {
  const out: Mutation[] = [];
  let unreachable = 0;

  for (const mutation of mutations) {
    if (mutation.op === 'remove') {
      // A stream subject is scalar: there is no property to delete, and
      // `applyMutations` would report it as unsupported anyway.
      unreachable += 1;
      continue;
    }
    if (mutation.path !== STREAM_SEGMENT_PATH) {
      unreachable += 1;
      continue;
    }
    if (mutation.op === 'replace_value') {
      // Scoped to the segment by `applyMutations`, and the segment is now the
      // pending text alone — so occurrences in the overlap tail are untouched
      // without any offset arithmetic. Exactly the behaviour wanted.
      out.push(mutation);
      continue;
    }
    if (mutation.end <= releasedInWindow) {
      unreachable += 1;
      continue;
    }
    const start = mutation.start - releasedInWindow;
    out.push({ ...mutation, start: Math.max(0, start), end: mutation.end - releasedInWindow });
    if (start < 0) unreachable += 1;
  }

  return { mutations: out, unreachable };
}

// ═══════════════════════════════════════════════════════════════════════════
// The gate
// ═══════════════════════════════════════════════════════════════════════════

/** A fresh object every time: `emit` is handed to the caller, which iterates and
 *  sometimes concatenates it, and a shared array would make two windows alias. */
const nothing = (): StreamGateEmission => ({ emit: [], blocked: false });

export function createStreamGate(opts: CreateStreamGateOptions): StreamGate {
  const { scope, makeChunk } = opts;
  const guardrailKeys = [...new Set(opts.guardrailKeys.filter(Boolean))];

  /** Everything the model produced, never rewritten — what the audit sees. */
  let rawText = '';
  /** The working buffer: released prefix (immutable) + pending tail. */
  let buffer = '';
  let releasedTo = 0;
  let seq = 0;
  let lastReleaseAt = Date.now();

  let blocked = false;
  let blockVerdict: HookVerdict<StreamDeltaSubject> | undefined;
  let audited = false;
  /** Set when the gate could not do its job and fell back to pass-through. */
  let degraded = false;
  const warnedOnce = new Set<string>();

  let settingsPromise: Promise<ResolvedSettings> | undefined;

  const warnOnce = (reason: string, detail?: Record<string, unknown>): void => {
    if (warnedOnce.has(reason)) return;
    warnedOnce.add(reason);
    logger.warn('Stream gate could not gate part of a response', {
      reason,
      traceId: scope.traceId,
      ...detail,
    });
  };

  /**
   * Resolved once per stream, then memoised. A failure resolves to PASS_THROUGH
   * rather than rejecting: "we could not find out whether streaming enforcement
   * is configured" is not the same as "it is configured and a policy failed",
   * and the second is what `failMode` exists for. Blocking every streamed
   * response in the tenant on a guardrail-store blip would be a far larger
   * incident than the one it prevents, and today's behaviour — audit only, no
   * gating — is exactly what this fallback restores. The terminal audit still
   * runs and still records the findings.
   */
  const settings = (): Promise<ResolvedSettings> => {
    if (!settingsPromise) {
      settingsPromise = foldStreamSettings(scope, guardrailKeys, opts.settings).catch((error) => {
        logger.error('Stream gate could not resolve guardrail settings; not gating this stream', {
          traceId: scope.traceId,
          guardrailKeys,
          error: error instanceof Error ? error.message : String(error),
        });
        degraded = true;
        return PASS_THROUGH;
      });
    }
    return settingsPromise;
  };

  /**
   * The post-hoc `output.pre` audit, scheduled at most once.
   *
   * It runs on BOTH terminal paths and on a block, with `{timing: 'async',
   * onFail: 'log'}` semantics — byte-identical in effect to today's
   * `auditStreamedOutput` calls, including the one on the cancel path.
   *
   * It audits `rawText`, NOT the released text: the question the audit answers
   * is what the MODEL produced, and a redaction the gate performed successfully
   * would otherwise erase its own evidence from the audit trail. It is also the
   * only evaluation this stream logs, so it is what carries a mid-stream block
   * into the evaluation log — the withheld text is part of `rawText`, so the
   * finding that caused the block is in the row.
   */
  const scheduleAudit = (reason: 'end' | 'abandon'): void => {
    if (audited) return;
    audited = true;
    if (opts.audit === false || opts.shadow) return;
    if (guardrailKeys.length === 0) return;
    const text = rawText;
    if (!text.trim()) return;

    const source =
      reason === 'end'
        ? (opts.auditSource?.end ?? scope.source)
        : (opts.auditSource?.abandon ?? `${scope.source}:cancelled`);

    fireAndForget('guardrail-stream-output-audit', async () => {
      await runHook({
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        hook: 'output.pre',
        subject: textSubject(text),
        // `source` is the only field that differs between the two terminal
        // paths, and it is the field the evaluation log persists.
        scope: { ...scope, source },
        guardrailKeys,
      });
    });
  };

  /** The current withheld tail. */
  const pending = (): string => buffer.slice(releasedTo);

  const release = (upTo: number, emit: OpenAiStreamChunkLike[]): void => {
    if (upTo <= releasedTo) return;
    const text = buffer.slice(releasedTo, upTo);
    releasedTo = upTo;
    lastReleaseAt = Date.now();
    if (text) emit.push(makeChunk(text));
  };

  /**
   * The verdict for a termination the GATE decided, not a policy: the held
   * region outgrew `maxHeldChars`, so part of the answer would have to go out
   * unadjudicated and this guardrail is configured to stop instead.
   *
   * It is shaped like any other blocking verdict — same reason class as a policy
   * that could not run, a `degraded` entry naming the gap, `disabled: false`
   * (something DID run) — so nothing downstream needs a special case for it.
   */
  const budgetVerdict = (
    unadjudicated: number,
    s: ResolvedSettings,
  ): HookVerdict<StreamDeltaSubject> => {
    const reason = `${unadjudicated} characters could not be adjudicated within maxHeldChars=${s.maxHeldChars}`;
    return {
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      hook: 'output.stream.delta',
      mode: 'enforce',
      decision: 'block',
      wouldBeDecision: 'block',
      enforced: true,
      disabled: false,
      findings: [],
      mutations: [],
      riskScore: 0,
      codes: ['stream_budget_exceeded'],
      message: resolveBlockMessage({ reasonClass: 'unavailable', traceId: scope.traceId }),
      guardrailKeys: s.streamKeys,
      guardrailKey: s.streamKeys[0] ?? '',
      guardrailName: '',
      policyVersion: '',
      traceId: scope.traceId,
      latencyMs: 0,
      degraded: [{ policyId: 'stream.window', family: 'custom', reason }],
    };
  };

  /**
   * Enter the blocked state.
   *
   * Latching here — rather than trusting the caller's `break` — is what makes a
   * caller that mishandles the block sequence fail CLOSED: every later `push`
   * returns the same empty, blocked emission instead of resuming delivery.
   */
  const latchBlock = (
    verdict: HookVerdict<StreamDeltaSubject> | undefined,
    s: ResolvedSettings,
  ): StreamGateEmission => {
    blocked = true;
    blockVerdict = verdict;
    const emit: OpenAiStreamChunkLike[] = [];
    // 'replace' is only honest while nothing has been flushed: substituting the
    // block message for an answer whose first half is already on screen would
    // leave the user reading a refusal appended to the text it refuses.
    if (s.onBlock === 'replace' && releasedTo === 0 && verdict?.message?.body) {
      emit.push(makeChunk(verdict.message.body));
    }
    // The caller closes the stream from here, so `end()` may never be reached
    // and the audit has to be scheduled from the block itself.
    scheduleAudit('end');
    return { emit, blocked: true, verdict };
  };

  /**
   * Adjudicate `[windowStart, windowEnd)` — the overlap tail plus a slice of
   * the pending region — and apply the verdict's redactions to the PENDING
   * part of that slice.
   *
   * Returns the verdict and where the window now ends: a rewrite changes the
   * buffer's length, so a release point computed from the old end would be an
   * offset into a string that no longer exists. Releasing is the caller's job,
   * because how much to keep back depends on whether this is a catch-up
   * window, a timed flush or the final one.
   */
  const adjudicate = async (
    windowStart: number,
    windowEnd: number,
    final: boolean,
    s: ResolvedSettings,
  ): Promise<{ verdict: HookVerdict<StreamDeltaSubject>; windowEnd: number }> => {
    const windowText = buffer.slice(windowStart, windowEnd);
    const releasedInWindow = releasedTo - windowStart;

    const subject: StreamDeltaSubject = {
      kind: 'stream_delta',
      text: windowText,
      segments: [{ path: STREAM_SEGMENT_PATH, text: windowText }],
      delta: buffer.slice(releasedTo, windowEnd),
      buffer: windowText,
      releasedTo: releasedInWindow,
      seq: seq,
      final,
    };
    seq += 1;

    const verdict = await runHook<StreamDeltaSubject>({
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      hook: 'output.stream.delta',
      subject,
      scope,
      guardrailKeys: s.streamKeys,
      only: STREAM_ONLY_FAMILIES,
      shadow: opts.shadow,
      skipLogging: opts.logWindows !== true,
    });

    if (verdict.decision === 'block') return { verdict, windowEnd };

    // ── redaction, applied to the PENDING part of this window only ──
    if (verdict.mutations.length > 0) {
      const rebased = rebaseMutations(verdict.mutations, releasedInWindow);
      if (rebased.unreachable > 0) {
        logger.error('Stream gate could not apply a redaction: it targets released text', {
          traceId: scope.traceId,
          guardrailKeys: verdict.guardrailKeys,
          unreachable: rebased.unreachable,
        });
      }
      if (rebased.mutations.length > 0) {
        const outcome = applyMutations(
          textSubject(buffer.slice(releasedTo, windowEnd), STREAM_SEGMENT_PATH),
          rebased.mutations,
        );
        if (outcome.applied.length > 0) {
          buffer = buffer.slice(0, releasedTo) + outcome.text + buffer.slice(windowEnd);
          windowEnd = releasedTo + outcome.text.length;
        }
        if (outcome.skipped.length > 0) {
          // Never dropped in silence: a skipped rewrite means the finding stands
          // but the text goes out as the model wrote it, and this line is the
          // only place that gap is visible.
          logger.warn('Stream gate redactions could not be applied', {
            traceId: scope.traceId,
            guardrailKeys: verdict.guardrailKeys,
            skipped: outcome.skipped.map((entry) => ({
              op: entry.mutation.op,
              family: entry.mutation.family,
              reason: entry.reason,
            })),
          });
        }
      }
    }

    return { verdict, windowEnd };
  };

  /** A block reached after some catch-up windows already cleared text: those
   *  chunks WERE adjudicated, so they go out ahead of the block. */
  const blockAfter = (
    emit: OpenAiStreamChunkLike[],
    verdict: HookVerdict<StreamDeltaSubject> | undefined,
    s: ResolvedSettings,
  ): StreamGateEmission => {
    const latched = latchBlock(verdict, s);
    return { ...latched, emit: [...emit, ...latched.emit] };
  };

  /**
   * Adjudicate the current window and release what it clears.
   *
   * `final` drops the hold-back to zero — nothing more can arrive, so there is
   * no boundary left to straddle. `timed` drops it to the overlap, NOT to zero:
   * `holdBackMs` is a latency promise, and honouring it by releasing everything
   * would break the very invariant the hold-back exists for. Keeping `overlap`
   * characters back is the smallest window that is still sound.
   */
  const advance = async (
    mode: { final: boolean; timed: boolean },
  ): Promise<StreamGateEmission> => {
    const s = await settings();
    if (!s.enabled) {
      // Pass-through: `push` already emitted the original chunk, so the only
      // thing left is to keep the accounting honest.
      releasedTo = buffer.length;
      return nothing();
    }

    const keepBack = mode.final ? 0 : mode.timed ? s.overlapChars : s.holdBackChars;
    const held = buffer.length - releasedTo;
    if (held <= 0) return nothing();
    if (!mode.final && held <= keepBack) return nothing();

    const emit: OpenAiStreamChunkLike[] = [];

    // ── catch-up: a pending region larger than one window ──
    // One provider chunk can outgrow `maxHeldChars` (a whole answer delivered
    // as a single chunk is the normal case under `disableStreamingWithTools`).
    // The region is all in memory, so it is walked in successive windows of
    // `maxHeldChars`, each starting `overlapChars` behind the frontier and
    // each releasing all but its last `overlapChars` — the smallest hold-back
    // under which a match straddling the release point is still seen whole by
    // the next window. Only what no window can reach falls through to
    // `onBudgetExceeded` below.
    let catchUpWindows = 0;
    let stalled = false;
    while (buffer.length - releasedTo > s.maxHeldChars) {
      const windowStart = Math.max(0, releasedTo - s.overlapChars);
      const windowEnd = Math.min(buffer.length, windowStart + s.maxHeldChars);
      // No progress is possible when the window is all overlap (a config with
      // `maxHeldChars <= 2 * overlapChars`), and a rewrite that keeps shrinking
      // the frontier could otherwise spin — both are the fallback's case.
      if (windowEnd - s.overlapChars <= releasedTo || catchUpWindows >= MAX_CATCH_UP_WINDOWS) {
        stalled = true;
        break;
      }
      catchUpWindows += 1;

      const out = await adjudicate(windowStart, windowEnd, false, s);
      if (out.verdict.decision === 'block') return blockAfter(emit, out.verdict, s);
      release(Math.max(releasedTo, out.windowEnd - s.overlapChars), emit);
    }

    // ── the window ──
    // It starts `overlapChars` behind the frontier so a match beginning in
    // already-released text and ending in pending text is seen whole. After
    // the catch-up above the `maxHeldChars` clamp only bites when the catch-up
    // stalled, and then it leaves real characters unadjudicated — which is why
    // it is reported rather than quietly accepted.
    const scanFrom = Math.max(0, releasedTo - s.overlapChars);
    const windowStart = Math.max(scanFrom, buffer.length - s.maxHeldChars);
    const unadjudicated = Math.max(0, windowStart - releasedTo);

    if (unadjudicated > 0) {
      if (s.onBudgetExceeded === 'terminate') {
        logger.error('Stream gate held region exceeded maxHeldChars; terminating', {
          traceId: scope.traceId,
          unadjudicated,
          maxHeldChars: s.maxHeldChars,
          catchUpWindows,
          stalled,
        });
        // A synthesised verdict, not `undefined`: the caller renders
        // `verdict.message.body` into the error frame, and terminating a
        // response with no reason at all is the one thing worse than
        // terminating it. 'unavailable' is the reason class the contract
        // already defines for "a required safety policy could not run".
        return blockAfter(emit, budgetVerdict(unadjudicated, s), s);
      }
      logger.error('Stream gate released text without adjudicating it', {
        traceId: scope.traceId,
        unadjudicated,
        maxHeldChars: s.maxHeldChars,
        catchUpWindows,
        stalled,
      });
    }

    const out = await adjudicate(windowStart, buffer.length, mode.final, s);
    const verdict = out.verdict;

    if (unadjudicated > 0) {
      // The verdict is the only artefact of this window that outlives it, so
      // the gap is recorded on it — a stream that was not fully adjudicated
      // must never read as one that passed.
      //
      // `family` is a lie of omission and there is no honest alternative:
      // `PolicyFamily` is a closed nine-member union naming DETECTORS, and this
      // degradation belongs to the gate, not to any policy. 'custom' is the
      // member whose meaning is least specific, and `BLOCK_REASON_FOR_FAMILY`
      // maps it to the 'custom' reason class, which is also the least wrong
      // thing to tell a user. A tenth member ('stream') would be a schema
      // change in `types.domain.ts` — see the report.
      verdict.degraded = [
        ...(verdict.degraded ?? []),
        {
          policyId: 'stream.window',
          family: 'custom',
          reason: `${unadjudicated} characters released without adjudication (maxHeldChars=${s.maxHeldChars})`,
        },
      ];
    }

    if (verdict.decision === 'block') return blockAfter(emit, verdict, s);

    // Recomputed AFTER the rewrite: a redaction changes the buffer's length, so
    // a release point computed before it would be an offset into a string that
    // no longer exists.
    release(Math.max(releasedTo, buffer.length - keepBack), emit);
    return { emit, blocked: false, verdict };
  };

  /**
   * The emission a latched gate returns for every later call.
   */
  const blockedEmission = (): StreamGateEmission => ({
    emit: [],
    blocked: true,
    verdict: blockVerdict,
  });

  /**
   * SERIALISE EVERY ENTRY POINT. `advance` reads `buffer` and `releasedTo`,
   * awaits `runHook`, and then writes both — so two overlapping calls would
   * compute their mutation offsets against one `releasedTo` and apply them
   * against another, splicing a redaction into the wrong bytes.
   *
   * `push` alone is safe (the caller awaits it inside `for await`), but `flush`
   * exists precisely to be called from a TIMER, which is a second entry point
   * with no such ordering. A queue costs one microtask and removes the whole
   * class of interleaving; a rejection is absorbed so one failure cannot
   * deadlock every later call.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const pushOne = async (chunk: OpenAiStreamChunkLike): Promise<StreamGateEmission> => {
    if (blocked) return blockedEmission();
    try {
      const split = splitChunk(chunk, (reason) => warnOnce(reason));
      if (split.text) {
        rawText += split.text;
        buffer += split.text;
      }

      const s = await settings();
      if (!s.enabled) {
        // Verbatim, so a stream nobody gates is byte-identical to today's.
        releasedTo = buffer.length;
        return { emit: [chunk], blocked: false };
      }

      // A chunk carrying a `finish_reason` closes the choice, so the tail is
      // adjudicated and released BEFORE it goes out. Emitting the terminal frame
      // first would tell every client the answer was complete while the gate
      // still held its last sentence.
      const timed =
        !split.terminal &&
        Date.now() - lastReleaseAt >= s.holdBackMs &&
        buffer.length > releasedTo;
      const out = await advance({ final: split.terminal, timed });
      if (out.blocked) return out;

      const emit = split.residual ? [...out.emit, split.residual] : out.emit;
      return { emit, blocked: false, verdict: out.verdict };
    } catch (error) {
      // `runHook` does not throw and `applyMutations` is pure, so reaching here
      // means a defect. The response is worth more than the gate: the held text
      // is released, gating is abandoned for the rest of the stream, and the
      // terminal audit still records what the model produced.
      logger.error('Stream gate failed; releasing held text and disabling gating', {
        traceId: scope.traceId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      degraded = true;
      settingsPromise = Promise.resolve(PASS_THROUGH);
      const emit: OpenAiStreamChunkLike[] = [];
      release(buffer.length, emit);
      return { emit, blocked: false };
    }
  };

  const flushOne = async (): Promise<StreamGateEmission> => {
    if (blocked) return blockedEmission();
    try {
      return await advance({ final: false, timed: true });
    } catch (error) {
      logger.error('Stream gate flush failed', {
        traceId: scope.traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return nothing();
    }
  };

  const endOne = async (): Promise<StreamGateEmission> => {
    if (blocked) {
      scheduleAudit('end');
      return blockedEmission();
    }
    try {
      const out = await advance({ final: true, timed: false });
      scheduleAudit('end');
      return out;
    } catch (error) {
      logger.error('Stream gate end failed; releasing held text', {
        traceId: scope.traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      const emit: OpenAiStreamChunkLike[] = [];
      release(buffer.length, emit);
      scheduleAudit('end');
      return { emit, blocked: false };
    }
  };

  return {
    push: (chunk: OpenAiStreamChunkLike) => exclusive(() => pushOne(chunk)),
    flush: () => exclusive(flushOne),
    end: () => exclusive(endOne),

    abandon(): void {
      // Deliberately releases nothing: the socket is gone, and `push`/`end` are
      // the only paths that may write to it.
      scheduleAudit('abandon');
    },

    get pendingChars() {
      return buffer.length - releasedTo;
    },
    get bufferedText() {
      return rawText;
    },
    get heldText() {
      return pending();
    },
    get isBlocked() {
      return blocked;
    },
    get isDegraded() {
      return degraded;
    },
  };
}

/** Exposed for the wiring's diagnostics and for tests; not part of the flow. */
export const __streamGateInternals = {
  STREAM_SEGMENT_PATH,
  foldStreamSettings,
  splitChunk,
  rebaseMutations,
};
