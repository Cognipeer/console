/**
 * Red-team runner — orchestrates probe → target → detect → decide across all
 * attempts with bounded concurrency, then aggregates into an attack-success /
 * resilience report. Pure with respect to the platform: the target and judge
 * are injected, so the whole pipeline is unit-testable without live models.
 *
 * Bounds: every call to the target, the judge and the attacker has a time limit;
 * a run executes a capped number of attempts; `shouldStop` ends it between
 * attempts and between turns. An attempt that loses its target half-way is
 * judged on what it got (a partial result) rather than thrown away.
 */

import { hasHardProof, decide } from './decisionPolicy';
import { ATTACKER_STOP, buildAttackerMessages } from './attacker';
import { computeAggregate } from './aggregate';
import { attemptKeyOf } from './attemptKey';
import { createRefusalDetector } from './detectors/refusalDetector';
import { INCONCLUSIVE_THRESHOLDS, RUN_LIMITS, clampConcurrency } from './limits';
import type {
  AttackerInvoker,
  AttemptResult,
  DetectionSignal,
  Detector,
  DetectorContext,
  JudgeInvoker,
  Probe,
  ProbeAttempt,
  RedTeamRunConfig,
  RedTeamRunResult,
  TargetInvoker,
  Turn,
  Verdict,
} from './types';

export { summarizeJudgeErrors } from './aggregate';

/** Judge errors above this share of the judged attempts make a scan inconclusive. */
export const JUDGE_ERROR_INCONCLUSIVE_SHARE = INCONCLUSIVE_THRESHOLDS.judgeErrorShare;

/** Default adaptive-conversation length when a campaign doesn't set maxTurns. */
const DEFAULT_ADAPTIVE_TURNS = 4;
const MAX_ADAPTIVE_TURNS = 10;

/** How often a running scan re-reads `shouldStop`, so a stop also ends a call that is still waiting. */
const STOP_POLL_MS = 1_000;

/** Per-call time limits; the defaults are RUN_LIMITS (the override is for tests). */
export interface RunTimeouts {
  targetMs?: number;
  judgeMs?: number;
  attackerMs?: number;
}

export interface RunRedTeamParams {
  probes: Probe[];
  invokeTarget: TargetInvoker;
  invokeJudge?: JudgeInvoker;
  /** Drives adaptive multi-turn attacks; when absent, adaptive probes fall back to their script. */
  invokeAttacker?: AttackerInvoker;
  config?: RedTeamRunConfig;
  /**
   * Progress hook, invoked once per completed attempt (awaited; an error in it is logged
   * and never ends the run). `index` is the attempt's position in execution order.
   */
  onAttempt?: (result: AttemptResult, index: number) => void | Promise<void>;
  /** Runs one attempt (`run`) in a context of the caller's, e.g. to mark what it used. */
  scope?: (run: () => Promise<AttemptResult>) => Promise<AttemptResult>;
  timeouts?: RunTimeouts;
}

interface WorkItem {
  probe: Probe;
  attempt: ProbeAttempt;
}

/** What an attempt needs from its run. */
interface AttemptEnv {
  invokeTarget: TargetInvoker;
  invokeJudge?: JudgeInvoker;
  invokeAttacker?: AttackerInvoker;
  config?: RedTeamRunConfig;
  targetMs: number;
  judgeMs: number;
  attackerMs: number;
  /** Aborted once the run is stopped. */
  runSignal: AbortSignal;
  isStopped: () => boolean;
  /** Results of attempts the stop cut short: they are dropped, not recorded. */
  discarded: WeakSet<object>;
}

/** The target's reply, or the error that ended the conversation (`stopped` when the run's stop did). */
type TargetReply = { text: string } | { error: string; stopped?: boolean };

class RunStoppedError extends Error {
  constructor() {
    super('The run was stopped');
    this.name = 'RunStoppedError';
  }
}

function describeLimit(ms: number): string {
  return `${Number((ms / 1000).toFixed(2))}s`;
}

/**
 * Run `fn` with a time limit. `fn` gets a signal that aborts when the limit passes or the run stops;
 * the call rejects at that moment even when `fn` ignores the signal (a judge or attacker invoker has none).
 */
function withLimit<T>(
  ms: number,
  label: string,
  runSignal: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runSignal.removeEventListener('abort', onStop);
      settle();
    };
    const onStop = () => {
      controller.abort();
      finish(() => reject(new RunStoppedError()));
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error(`${label ? `${label} ` : ''}timed out after ${describeLimit(ms)}`)));
    }, ms);
    if (runSignal.aborted) {
      onStop();
      return;
    }
    runSignal.addEventListener('abort', onStop, { once: true });
    let pending: Promise<T>;
    try {
      pending = fn(controller.signal);
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

export async function runRedTeam(params: RunRedTeamParams): Promise<RedTeamRunResult> {
  const { probes, invokeTarget, invokeJudge, invokeAttacker, config, onAttempt } = params;
  const concurrency = clampConcurrency(config?.concurrency);
  const acceptsSystem = config?.targetAcceptsSystem !== false;
  const acceptsHistory = config?.targetAcceptsHistory !== false;
  const targetKind = config?.targetKind;
  const maxAttempts =
    typeof config?.maxAttempts === 'number' && Number.isFinite(config.maxAttempts) && config.maxAttempts >= 1
      ? Math.floor(config.maxAttempts)
      : RUN_LIMITS.maxAttemptsPerRun;

  const runnable: WorkItem[] = [];
  let notApplicable = 0;
  for (const probe of probes) {
    const wrongKind = targetKind !== undefined && probe.targets !== undefined && !probe.targets.includes(targetKind);
    for (const attempt of probe.generate()) {
      // A target that keeps its own instructions cannot be tested with a planted system prompt, an
      // agent keeps its own conversation (no forged history), and a probe can name the kinds it fits.
      if (wrongKind || (!acceptsSystem && attempt.system) || (!acceptsHistory && attempt.history?.length)) {
        notApplicable += 1;
        continue;
      }
      runnable.push({ probe, attempt });
    }
  }
  const work = runnable.slice(0, maxAttempts);
  const skipped = runnable.length - work.length;

  const runAbort = new AbortController();
  let stopLatched = false;
  const isStopped = (): boolean => {
    if (stopLatched) return true;
    try {
      if (config?.shouldStop?.()) {
        stopLatched = true;
        runAbort.abort();
      }
    } catch {
      // a broken stop hook never ends or fails the run
    }
    return stopLatched;
  };
  const watcher = config?.shouldStop ? setInterval(isStopped, STOP_POLL_MS) : undefined;
  watcher?.unref?.();

  const env: AttemptEnv = {
    invokeTarget,
    invokeJudge,
    invokeAttacker,
    config,
    targetMs: params.timeouts?.targetMs ?? RUN_LIMITS.targetTimeoutMs,
    judgeMs: params.timeouts?.judgeMs ?? RUN_LIMITS.judgeTimeoutMs,
    attackerMs: params.timeouts?.attackerMs ?? RUN_LIMITS.attackerTimeoutMs,
    runSignal: runAbort.signal,
    isStopped,
    discarded: new WeakSet<object>(),
  };

  const results: Array<AttemptResult | undefined> = new Array(work.length);
  let cursor = 0;
  /** A stop left attempts unstarted or cut one short (a stop after the last attempt is not a stop of the run). */
  let cutShort = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      // Polled before each attempt: once stopped no new attempt starts.
      if (isStopped()) {
        if (cursor < work.length) cutShort = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= work.length) return;
      const { probe, attempt } = work[index];
      // The discard mark is identity based, so it is read on the raw result before a scope hook can copy it.
      let rawDiscarded = false;
      const run = async () => {
        const raw = await runAttempt(probe, attempt, env);
        if (env.discarded.has(raw)) rawDiscarded = true;
        return raw;
      };
      const result = await (params.scope ? params.scope(run) : run());
      if (rawDiscarded || env.discarded.has(result)) {
        cutShort = true;
        continue;
      }
      results[index] = result;
      if (onAttempt) {
        try {
          await onAttempt(result, index);
        } catch (err) {
          await logHookError(err);
        }
      }
    }
  };

  try {
    const poolSize = Math.max(1, Math.min(concurrency, work.length));
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
  } finally {
    if (watcher) clearInterval(watcher);
  }

  const finished = results.filter((r): r is AttemptResult => r !== undefined);
  return {
    aggregate: computeAggregate(finished.map(toAggregateAttempt)),
    attempts: finished,
    ...(cutShort ? { stopped: true } : {}),
    ...(skipped > 0 ? { skipped } : {}),
    ...(notApplicable > 0 ? { notApplicable } : {}),
  };
}

function toAggregateAttempt(a: AttemptResult) {
  return {
    outcome: a.outcome,
    error: a.error,
    partial: a.partial,
    severity: a.severity,
    category: a.category,
    latencyMs: a.latencyMs,
    signals: a.verdict.signals,
    polarity: a.polarity,
  };
}

async function logHookError(err: unknown): Promise<void> {
  try {
    const { createLogger } = await import('@/lib/core/logger');
    createLogger('redteam:runner').warn('The progress hook failed; the run goes on', { error: err });
  } catch {
    // logging must never end the run either
  }
}

/** What driving the target produced: the transcript so far, and why it ended early, if it did. */
interface Drive {
  transcript: Turn[];
  /** The target failed (or timed out) on the turn after `transcript`. */
  error?: string;
  /** A note on how the conversation ended (the attacker stopped), kept with the verdict. */
  note?: string;
  /** The run's stop ended the conversation before it was done. */
  cut?: boolean;
}

/** The messages every call starts with: the planted system turn, then the forged history. */
function openingMessages(attempt: ProbeAttempt): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (attempt.system) messages.push({ role: 'system', content: attempt.system });
  for (const m of attempt.history ?? []) messages.push({ role: m.role, content: m.content });
  return messages;
}

async function runAttempt(probe: Probe, attempt: ProbeAttempt, env: AttemptEnv): Promise<AttemptResult> {
  const started = Date.now();
  const base = baseResult(probe, attempt);
  const key = attemptKeyOf({ probeKey: probe.key, attemptId: attempt.id });

  const drive =
    attempt.adaptive && env.invokeAttacker
      ? await driveAdaptive(probe, attempt, key, env, env.invokeAttacker)
      : await driveTarget(attempt, key, env);

  // Cut short by a stop: a half-played conversation is not a finding.
  if (drive.cut) return dropped(env, base, drive.transcript, probe);

  if (drive.error !== undefined && drive.transcript.length === 0) {
    // The target never answered: an errored attempt, never a vulnerability, never an abort of the run.
    return {
      ...base,
      transcript: [],
      verdict: noVerdict(probe, 'target-error'),
      outcome: 'needs_review',
      latencyMs: Date.now() - started,
      error: drive.error,
    };
  }

  const { transcript } = drive;
  const ctx: DetectorContext = {
    probe,
    attempt,
    transcript,
    allOutputs: transcript.map((t) => t.assistant),
    finalOutput: transcript.length ? transcript[transcript.length - 1].assistant : '',
    invokeJudge: env.invokeJudge
      ? (messages) => withLimit(env.judgeMs, 'the judge', env.runSignal, () => env.invokeJudge!(messages))
      : undefined,
  };

  const signals = await runDetectors(probe, ctx, env.config);
  // A stop that arrived while a judge was working leaves judge errors of the stop's making.
  if (env.isStopped() && signals.some((s) => s.error)) return dropped(env, base, transcript, probe);
  const decided = decide(signals, probe, env.config?.policy);
  const verdict: Verdict = drive.note
    ? { ...decided, signals: [...decided.signals, noteSignal(drive.note)] }
    : decided;

  return {
    ...base,
    transcript,
    verdict,
    outcome: verdict.outcome,
    latencyMs: Date.now() - started,
    ...(drive.error !== undefined ? { error: drive.error, partial: true } : {}),
  };
}

function dropped(
  env: AttemptEnv,
  base: Omit<AttemptResult, 'transcript' | 'verdict' | 'outcome'>,
  transcript: Turn[],
  probe: Probe,
): AttemptResult {
  const result: AttemptResult = { ...base, transcript, verdict: noVerdict(probe, 'stopped'), outcome: 'needs_review' };
  env.discarded.add(result);
  return result;
}

function noVerdict(probe: Probe, decidedBy: string): Verdict {
  return { outcome: 'needs_review', severity: probe.severity, confidence: 0, decidedBy, signals: [] };
}

/** A record of how the conversation ended; it carries no weight in the decision (it is added after it). */
function noteSignal(rationale: string): DetectionSignal {
  return {
    detectorKey: 'attacker',
    kind: 'deterministic',
    cost: 'free',
    hit: false,
    score: 0,
    confidence: 0,
    rationale,
  };
}

/**
 * One target call: its conversation is the attempt's (`attemptKey`), it ends at the target time limit
 * or when the run stops. Returns the reply text, or the error that ended the conversation.
 */
async function callTarget(
  env: AttemptEnv,
  key: string,
  turnIndex: number,
  history: { role: 'system' | 'user' | 'assistant'; content: string }[],
): Promise<TargetReply> {
  try {
    const output = await withLimit(env.targetMs, '', env.runSignal, (signal) =>
      env.invokeTarget(
        history.map((m) => ({ role: m.role, content: m.content })),
        { attemptKey: key, turnIndex, signal },
      ),
    );
    return { text: output.text ?? '' };
  } catch (err) {
    if (err instanceof RunStoppedError) return { error: err.message, stopped: true };
    return { error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Feed the attempt's user turns to the target one at a time, building a transcript. */
async function driveTarget(attempt: ProbeAttempt, key: string, env: AttemptEnv): Promise<Drive> {
  const maxTurns = env.config?.maxTurns;
  const transcript: Turn[] = [];
  const history = openingMessages(attempt);

  const turns = typeof maxTurns === 'number' && maxTurns > 0 ? attempt.turns.slice(0, maxTurns) : attempt.turns;
  for (let i = 0; i < turns.length; i += 1) {
    // Polled before each further turn (the opening turn is covered by the attempt-level poll).
    if (i > 0 && env.isStopped()) return { transcript, cut: true };
    const userTurn = turns[i];
    history.push({ role: 'user', content: userTurn });
    const reply = await callTarget(env, key, i, history);
    if ('error' in reply) return reply.stopped ? { transcript, cut: true } : { transcript, error: reply.error };
    history.push({ role: 'assistant', content: reply.text });
    transcript.push({ user: userTurn, assistant: reply.text });
  }
  return { transcript };
}

/**
 * Adaptive multi-turn attack: an attacker model reads each target reply and
 * crafts the next escalating message toward the objective, up to `maxTurns`
 * rounds (or until it emits the stop sentinel). This is what makes the scan
 * "really push" — gradual crescendo / tactic-switching instead of a single shot.
 *
 * The attacker is a model like any other: it may come back empty, time out, or
 * refuse to write the attack. In each case escalation stops and the attempt is
 * decided on the transcript so far; a refusal is never forwarded to the target.
 */
async function driveAdaptive(
  probe: Probe,
  attempt: ProbeAttempt,
  key: string,
  env: AttemptEnv,
  invokeAttacker: AttackerInvoker,
): Promise<Drive> {
  const limit = Math.min(MAX_ADAPTIVE_TURNS, Math.max(1, env.config?.maxTurns ?? DEFAULT_ADAPTIVE_TURNS));
  const transcript: Turn[] = [];
  const history = openingMessages(attempt);

  let attackerMessage = attempt.turns[0] ?? attempt.objective ?? 'Hello.';
  for (let i = 0; i < limit; i += 1) {
    if (i > 0 && env.isStopped()) return { transcript, cut: true };
    history.push({ role: 'user', content: attackerMessage });
    const reply = await callTarget(env, key, i, history);
    if ('error' in reply) return reply.stopped ? { transcript, cut: true } : { transcript, error: reply.error };
    history.push({ role: 'assistant', content: reply.text });
    transcript.push({ user: attackerMessage, assistant: reply.text });

    if (i === limit - 1) break;
    // Ask the attacker for the next move; stop early if it signals completion.
    let next: string;
    try {
      next = (
        await withLimit(env.attackerMs, 'the attacker', env.runSignal, () =>
          invokeAttacker(buildAttackerMessages(attempt.objective ?? '', transcript)),
        )
      ).trim();
    } catch (err) {
      if (err instanceof RunStoppedError) return { transcript, cut: true };
      return { transcript, note: `attacker stopped: ${errorMessage(err)}` }; // attacker failure → stop adapting, keep what we have
    }
    if (next.includes(ATTACKER_STOP)) break;
    if (!next || (await isRefusal(probe, attempt, transcript, next))) {
      return { transcript, note: 'attacker declined to continue' };
    }
    attackerMessage = next;
  }
  return { transcript };
}

/** Whether the attacker's reply is itself a refusal (the refusal detector's call, not a second list). */
async function isRefusal(probe: Probe, attempt: ProbeAttempt, transcript: Turn[], text: string): Promise<boolean> {
  try {
    const signal = await createRefusalDetector().detect({
      probe,
      attempt,
      transcript,
      allOutputs: [text],
      finalOutput: text,
    });
    return signal.gate === 'safe';
  } catch {
    return false;
  }
}

async function runOne(detector: Detector, ctx: DetectorContext): Promise<DetectionSignal> {
  try {
    return await detector.detect(ctx);
  } catch (err) {
    return {
      detectorKey: detector.key,
      kind: detector.kind,
      cost: detector.cost,
      hit: false,
      score: 0,
      confidence: 0,
      rationale: `detector threw: ${errorMessage(err)}`,
      error: errorMessage(err),
    };
  }
}

/**
 * Run the detectors in two phases: the deterministic and service ones first, and the judges only when
 * they did not already prove the compromise (a judge call is the expensive part). A thrown detector
 * becomes an errored signal, not a crash. Signals come back in the probe's detector order.
 */
async function runDetectors(probe: Probe, ctx: DetectorContext, config?: RedTeamRunConfig): Promise<DetectionSignal[]> {
  const indexed = probe.detectors.map((detector, index) => ({ detector, index }));
  const cheap = indexed.filter((d) => d.detector.kind !== 'llm-judge');
  const judges = indexed.filter((d) => d.detector.kind === 'llm-judge');

  const first = await Promise.all(cheap.map(async (d) => ({ index: d.index, signal: await runOne(d.detector, ctx) })));
  const collected = [...first];
  if (judges.length > 0 && !hasHardProof(first.map((s) => s.signal), config?.policy)) {
    collected.push(...(await Promise.all(judges.map(async (d) => ({ index: d.index, signal: await runOne(d.detector, ctx) })))));
  }
  return collected.sort((a, b) => a.index - b.index).map((s) => s.signal);
}

function baseResult(probe: Probe, attempt: ProbeAttempt): Omit<AttemptResult, 'transcript' | 'verdict' | 'outcome'> {
  return {
    probeKey: probe.key,
    attemptId: attempt.id,
    family: probe.family,
    category: probe.category,
    severity: probe.severity,
    ...(probe.polarity === 'over-refusal' ? { polarity: 'over-refusal' as const } : {}),
  };
}
