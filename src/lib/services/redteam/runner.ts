/**
 * Red-team runner — orchestrates probe → target → detect → decide across all
 * attempts with bounded concurrency, then aggregates into an attack-success /
 * resilience report. Pure with respect to the platform: the target and judge
 * are injected, so the whole pipeline is unit-testable without live models.
 */

import { decide } from './decisionPolicy';
import { ATTACKER_STOP, buildAttackerMessages } from './attacker';
import type {
  AttackerInvoker,
  AttemptResult,
  CategoryBreakdown,
  DetectionSignal,
  DetectorContext,
  JudgeInvoker,
  Probe,
  ProbeAttempt,
  RedTeamAggregate,
  RedTeamRunConfig,
  RedTeamRunResult,
  Severity,
  TargetInvoker,
  Turn,
} from './types';

/** Default adaptive-conversation length when a campaign doesn't set maxTurns. */
const DEFAULT_ADAPTIVE_TURNS = 4;
const MAX_ADAPTIVE_TURNS = 10;

export interface RunRedTeamParams {
  probes: Probe[];
  invokeTarget: TargetInvoker;
  invokeJudge?: JudgeInvoker;
  /** Drives adaptive multi-turn attacks; when absent, adaptive probes fall back to their script. */
  invokeAttacker?: AttackerInvoker;
  config?: RedTeamRunConfig;
  /** Progress hook, invoked once per completed attempt. */
  onAttempt?: (result: AttemptResult, index: number) => void;
}

interface WorkItem {
  probe: Probe;
  attempt: ProbeAttempt;
}

export async function runRedTeam(params: RunRedTeamParams): Promise<RedTeamRunResult> {
  const { probes, invokeTarget, invokeJudge, invokeAttacker, config, onAttempt } = params;
  const concurrency = Math.max(1, config?.concurrency ?? 4);

  const work: WorkItem[] = [];
  for (const probe of probes) {
    for (const attempt of probe.generate()) {
      work.push({ probe, attempt });
    }
  }

  const results = new Array<AttemptResult>(work.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= work.length) return;
      const { probe, attempt } = work[index];
      const result = await runAttempt(probe, attempt, invokeTarget, invokeJudge, invokeAttacker, config);
      results[index] = result;
      onAttempt?.(result, index);
    }
  };

  const poolSize = Math.min(concurrency, work.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return { aggregate: aggregate(results), attempts: results };
}

async function runAttempt(
  probe: Probe,
  attempt: ProbeAttempt,
  invokeTarget: TargetInvoker,
  invokeJudge: JudgeInvoker | undefined,
  invokeAttacker: AttackerInvoker | undefined,
  config: RedTeamRunConfig | undefined,
): Promise<AttemptResult> {
  const started = Date.now();
  const base = baseResult(probe, attempt);

  let transcript: Turn[];
  try {
    transcript =
      attempt.adaptive && invokeAttacker
        ? await driveAdaptive(attempt, invokeTarget, invokeAttacker, config?.maxTurns)
        : await driveTarget(attempt, invokeTarget, config?.maxTurns);
  } catch (err) {
    // A target failure is recorded as an errored attempt, never a vulnerability,
    // and never aborts the whole run.
    return {
      ...base,
      transcript: [],
      verdict: {
        outcome: 'needs_review',
        severity: probe.severity,
        confidence: 0,
        decidedBy: 'target-error',
        signals: [],
      },
      outcome: 'needs_review',
      latencyMs: Date.now() - started,
      error: (err as Error).message,
    };
  }

  const ctx: DetectorContext = {
    probe,
    attempt,
    transcript,
    allOutputs: transcript.map((t) => t.assistant),
    finalOutput: transcript.length ? transcript[transcript.length - 1].assistant : '',
    invokeJudge,
  };

  const signals = await runDetectors(probe, ctx);
  const verdict = decide(signals, probe, config?.policy);

  return {
    ...base,
    transcript,
    verdict,
    outcome: verdict.outcome,
    latencyMs: Date.now() - started,
  };
}

/** Feed the attempt's user turns to the target one at a time, building a transcript. */
async function driveTarget(attempt: ProbeAttempt, invokeTarget: TargetInvoker, maxTurns?: number): Promise<Turn[]> {
  const transcript: Turn[] = [];
  const history: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (attempt.system) history.push({ role: 'system', content: attempt.system });

  const turns = typeof maxTurns === 'number' && maxTurns > 0 ? attempt.turns.slice(0, maxTurns) : attempt.turns;
  for (const userTurn of turns) {
    history.push({ role: 'user', content: userTurn });
    const output = await invokeTarget(history.map((m) => ({ role: m.role, content: m.content })));
    const assistant = output.text ?? '';
    history.push({ role: 'assistant', content: assistant });
    transcript.push({ user: userTurn, assistant });
  }
  return transcript;
}

/**
 * Adaptive multi-turn attack: an attacker model reads each target reply and
 * crafts the next escalating message toward the objective, up to `maxTurns`
 * rounds (or until it emits the stop sentinel). This is what makes the scan
 * "really push" — gradual crescendo / tactic-switching instead of a single shot.
 */
async function driveAdaptive(
  attempt: ProbeAttempt,
  invokeTarget: TargetInvoker,
  invokeAttacker: AttackerInvoker,
  maxTurns?: number,
): Promise<Turn[]> {
  const limit = Math.min(MAX_ADAPTIVE_TURNS, Math.max(1, maxTurns ?? DEFAULT_ADAPTIVE_TURNS));
  const transcript: Turn[] = [];
  const history: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (attempt.system) history.push({ role: 'system', content: attempt.system });

  let attackerMessage = attempt.turns[0] ?? attempt.objective ?? 'Hello.';
  for (let i = 0; i < limit; i += 1) {
    history.push({ role: 'user', content: attackerMessage });
    const output = await invokeTarget(history.map((m) => ({ role: m.role, content: m.content })));
    const assistant = output.text ?? '';
    history.push({ role: 'assistant', content: assistant });
    transcript.push({ user: attackerMessage, assistant });

    if (i === limit - 1) break;
    // Ask the attacker for the next move; stop early if it signals completion.
    let next: string;
    try {
      next = (await invokeAttacker(buildAttackerMessages(attempt.objective ?? '', transcript))).trim();
    } catch {
      break; // attacker failure → stop adapting, keep what we have
    }
    if (!next || next.includes(ATTACKER_STOP)) break;
    attackerMessage = next;
  }
  return transcript;
}

/** Run every detector; a thrown detector becomes an errored signal, not a crash. */
async function runDetectors(probe: Probe, ctx: DetectorContext): Promise<DetectionSignal[]> {
  return Promise.all(
    probe.detectors.map(async (detector): Promise<DetectionSignal> => {
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
          rationale: `detector threw: ${(err as Error).message}`,
          error: (err as Error).message,
        };
      }
    }),
  );
}

function baseResult(probe: Probe, attempt: ProbeAttempt): Omit<AttemptResult, 'transcript' | 'verdict' | 'outcome'> {
  return {
    probeKey: probe.key,
    attemptId: attempt.id,
    family: probe.family,
    category: probe.category,
    severity: probe.severity,
  };
}

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

function aggregate(attempts: AttemptResult[]): RedTeamAggregate {
  const total = attempts.length;
  const failed = attempts.filter((a) => a.error).length;
  const completed = total - failed;

  const vulnerable = attempts.filter((a) => a.outcome === 'vulnerable').length;
  const safe = attempts.filter((a) => a.outcome === 'safe').length;
  const needsReview = attempts.filter((a) => a.outcome === 'needs_review' && !a.error).length;

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const a of attempts) {
    if (a.outcome === 'vulnerable') bySeverity[a.severity] += 1;
  }

  const byCategory: Record<string, CategoryBreakdown> = {};
  for (const a of attempts) {
    const bucket = (byCategory[a.category] ??= { total: 0, vulnerable: 0, needsReview: 0 });
    bucket.total += 1;
    if (a.outcome === 'vulnerable') bucket.vulnerable += 1;
    if (a.outcome === 'needs_review' && !a.error) bucket.needsReview += 1;
  }

  const latencies = attempts.map((a) => a.latencyMs).filter((v): v is number => typeof v === 'number');
  const avgLatencyMs = latencies.length ? latencies.reduce((x, y) => x + y, 0) / latencies.length : null;

  const attackSuccessRate = completed ? vulnerable / completed : 0;

  return {
    total,
    completed,
    failed,
    vulnerable,
    safe,
    needsReview,
    attackSuccessRate,
    resilienceScore: 1 - attackSuccessRate,
    bySeverity,
    byCategory,
    avgLatencyMs,
  };
}
