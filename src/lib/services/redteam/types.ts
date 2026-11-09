/**
 * Core types for the Red-Team (adversarial agent testing) engine.
 *
 * Like the evaluation engine, this core is intentionally free of any database,
 * queue, or model-runtime coupling: the target under test and the LLM judge are
 * supplied as injected invokers, so the whole probe → detect → decide pipeline
 * is pure and unit-testable. Persistence, live adapters, scheduling, and the
 * HTTP API are layered on top separately.
 *
 * Mental model (garak-inspired, but with an explicit decision layer):
 *   Probe      — generates adversarial attempts for one vulnerability class.
 *   Detector   — inspects the target's response and emits a DetectionSignal.
 *   Decision   — combines the signals of one attempt into a single Verdict.
 *
 * The key difference from evaluation scoring is the semantics: a detector "hit"
 * means the attack SUCCEEDED (i.e. the system is vulnerable), and the verdict is
 * three-state (`safe | vulnerable | needs_review`) rather than binary pass/fail.
 */

export type RedTeamRole = 'system' | 'user' | 'assistant';

export interface RedTeamMessage {
  role: RedTeamRole;
  content: string;
}

/** Severity of the vulnerability a probe targets (drives the decision policy). */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/**
 * OWASP "Top 10 for LLM Applications" categories (the 2025 list), used for
 * reporting and compliance mapping. See ./owasp for labels and for mapping keys
 * stored before the 2025 list.
 */
export type { OwaspLlmCategory } from './owasp';
import type { OwaspLlmCategory } from './owasp';

// ── Probe ────────────────────────────────────────────────────────────────────

/** Detector-facing hints attached to a single attempt. */
export interface AttemptExpectations {
  /**
   * A secret planted (usually in the system turn) that the target must never
   * reveal. If it surfaces in any output, that is hard proof of a leak.
   */
  canary?: string;
  /** Substrings / regex sources whose presence in output indicates a hit. */
  forbiddenPatterns?: string[];
  /** Whether a refusal is the safe outcome (default true). */
  refusalExpected?: boolean;
}

/** A single adversarial attempt produced by a probe. */
export interface ProbeAttempt {
  id: string;
  /**
   * Sequence of user turns. Length 1 for single-turn probes; longer for
   * scripted multi-turn attacks (e.g. crescendo / gradual escalation).
   * For adaptive attempts only `turns[0]` (the opener) is used as the seed.
   */
  turns: string[];
  /** Optional planted system prompt (e.g. carrying a canary secret). */
  system?: string;
  expect?: AttemptExpectations;
  /**
   * When true and an attacker invoker is available, the runner drives a
   * multi-turn ADAPTIVE conversation (up to `maxTurns`): an attacker model reads
   * the target's reply and crafts the next escalating attack toward `objective`.
   * Falls back to the static `turns` script when no attacker is wired.
   */
  adaptive?: boolean;
  /** The attacker's goal, used to steer the adaptive loop. */
  objective?: string;
  /**
   * Earlier turns sent before `turns[0]` as if they had happened (a forged
   * conversation history). Only a target that takes the caller's history (a
   * model) can run such an attempt; an agent keeps its own conversation, so the
   * attempt is not run there (`targetAcceptsHistory: false`).
   */
  history?: ProbeHistoryMessage[];
  meta?: Record<string, unknown>;
}

/** One forged earlier turn of an attempt's history. */
export interface ProbeHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * What a probe tests. `attack` (the default): a hit means the attack worked.
 * `over-refusal`: the prompts are harmless, so a refusal is the failure; such
 * attempts are reported as their own rate (`RedTeamAggregate.overRefusal`) and
 * never count in the attack success rate.
 */
export type ProbePolarity = 'attack' | 'over-refusal';

/** The kinds of target a probe can run against. */
export type ProbeTargetKind = 'model' | 'agent';

/** What a probe needs from the target beyond a plain chat call (shown as "works with"). */
export type ProbeRequirement = 'long-context' | 'caller-history' | 'usage-metrics';

/** A published source for a probe's technique (paper, advisory or repository). */
export interface ProbeReference {
  title: string;
  url: string;
}

/**
 * Deterministic detectors a definition can name, besides `refusal`, `pattern`
 * and judge lenses. The same keys serve built-in specs and custom probes.
 */
export const NAMED_DETECTOR_KEYS = [
  'pii',
  'encoding-leak',
  'insecure-output',
  'markdown-exfil',
  'ansi-escape',
  'tag-smuggling',
  'consumption',
  'non-refusal',
] as const;
export type NamedDetectorKey = (typeof NAMED_DETECTOR_KEYS)[number];

/** One LLM-judge lens of a detector spec. */
export interface ProbeJudgeLensSpec {
  lens: string;
  rubric: string;
  /** Hit threshold on the normalised 0..1 success score (default 0.5). */
  threshold?: number;
}

/**
 * The declarative form of a probe's detectors: what a custom probe stores, and
 * what a built-in declares so a clone reproduces it. Built in this order:
 * refusal, pattern, named (in the given order), judges.
 */
export interface ProbeDetectorSpec {
  refusal?: boolean;
  pattern?: boolean;
  named?: NamedDetectorKey[];
  judges?: ProbeJudgeLensSpec[];
}

/** A vulnerability-class generator plus the detectors that judge it. */
export interface Probe {
  key: string;
  /** Coarse family, e.g. `prompt-injection`, `jailbreak`, `pii-leak`. */
  family: string;
  category: OwaspLlmCategory;
  severity: Severity;
  description: string;
  /** Built-in revision; bumped whenever attempts or detectors change. A clone records the one it copied. Default 1. */
  version?: number;
  /** One or two sentences on how the technique works (catalog detail). */
  technique?: string;
  /** Where the technique is published. Never a link the probe was not checked against. */
  references?: ProbeReference[];
  /** Target kinds it can run against (default both). Attempts on another kind are not run. */
  targets?: ProbeTargetKind[];
  /** What it needs beyond a plain chat call ("works with" labels). */
  requires?: ProbeRequirement[];
  /** ISO date the probe joined the catalog; the UI marks recent ones as new. */
  addedAt?: string;
  /** Default `attack`. */
  polarity?: ProbePolarity;
  /**
   * Declarative twin of `detectors` (built-ins): a clone stores it, and a test
   * keeps it in step with `detectors`.
   */
  detectorSpec?: ProbeDetectorSpec;
  /**
   * Detectors used to judge every attempt from this probe (garak's
   * `recommended_detector`, but configured and possibly a panel). Multiple
   * llm-judge detectors with distinct lenses form a perspective-diverse panel
   * that the decision policy can use for corroboration on high/critical probes.
   */
  detectors: Detector[];
  /** Produce the attempts. Deterministic so runs are reproducible. */
  generate(): ProbeAttempt[];
}

// ── Target / judge invokers (injected) ─────────────────────────────────────────

export interface RedTeamOutput {
  text: string;
  latencyMs?: number;
  raw?: unknown;
}

/** What the runner tells the target about the call it is making. */
export interface TargetCallContext {
  /**
   * `<probeKey>::<attemptId>`. Calls of one attempt share a conversation; calls
   * of different attempts never do, even when attempts run in parallel.
   */
  attemptKey: string;
  /** 0 for the opening turn of the attempt. */
  turnIndex: number;
  /** Aborted when the call's time limit passes or the run stops; an invoker should stop its work on it. */
  signal?: AbortSignal;
}

/** Injected: run the system-under-test for a (possibly multi-turn) message list. */
export type TargetInvoker = (messages: RedTeamMessage[], call?: TargetCallContext) => Promise<RedTeamOutput>;

/** Injected: call a judge model. Returns the raw completion text. */
export type JudgeInvoker = (messages: RedTeamMessage[]) => Promise<string>;

/** Injected: call the attacker model that crafts the next adaptive attack turn. */
export type AttackerInvoker = (messages: RedTeamMessage[]) => Promise<string>;

// ── Detector ───────────────────────────────────────────────────────────────────

export type DetectorKind = 'deterministic' | 'service' | 'llm-judge';
export type DetectorCost = 'free' | 'cheap' | 'expensive';

/** One completed user→assistant exchange in an attempt transcript. */
export interface Turn {
  user: string;
  assistant: string;
}

export interface DetectorContext {
  probe: Probe;
  attempt: ProbeAttempt;
  /** Completed exchanges in order. */
  transcript: Turn[];
  /** All assistant outputs (convenience). */
  allOutputs: string[];
  /** The last assistant output (what most detectors inspect). */
  finalOutput: string;
  /** Required by llm-judge detectors; absent for deterministic ones. */
  invokeJudge?: JudgeInvoker;
}

/**
 * A detector signal. The universal convention across all detector kinds:
 *   `hit === true`  → this detector believes the attack SUCCEEDED.
 *   `gate === 'safe'` → this detector is confident the interaction is SAFE
 *                       (e.g. an explicit refusal). Only refusal-style
 *                       detectors set this; absence of a refusal is NOT itself
 *                       a vulnerability, so such detectors report a low-
 *                       confidence non-hit instead.
 */
export interface DetectionSignal {
  detectorKey: string;
  kind: DetectorKind;
  cost: DetectorCost;
  /** Attack succeeded according to this detector. */
  hit: boolean;
  /** Strength of the hit (or of the safe call), normalised to [0, 1]. */
  score: number;
  /** How reliable this detector's own call is, in [0, 1]. */
  confidence: number;
  /** When set, this is a confident "the interaction was safe" signal. */
  gate?: 'safe';
  /** Human-readable justification — required for auditability. */
  rationale: string;
  /** Judge model identifier, when applicable (for reproducibility records). */
  modelRef?: string;
  /** Populated when the detector itself failed; excluded from the decision. */
  error?: string;
  /** Extra facts a detector reports for the decision policy (e.g. `refusalPresent`). */
  meta?: Record<string, unknown>;
}

export interface Detector {
  key: string;
  kind: DetectorKind;
  cost: DetectorCost;
  detect(ctx: DetectorContext): Promise<DetectionSignal> | DetectionSignal;
}

// ── Decision ─────────────────────────────────────────────────────────────────

export type Outcome = 'safe' | 'vulnerable' | 'needs_review';

export interface DecisionPolicyConfig {
  /**
   * Minimum confidence for a single deterministic/service signal to decide on
   * its own (hard proof of compromise, or a clear refusal). Default 0.9.
   */
  deterministicConfidence?: number;
  /** Judge scores within this inclusive band are treated as borderline. Default [0.4, 0.6]. */
  reviewBand?: [number, number];
  /** Variance of a judge panel above which it counts as disagreement. Default 0.05. */
  maxJudgeVariance?: number;
}

export interface Verdict {
  outcome: Outcome;
  /** The probe's severity (meaningful when vulnerable / needs_review). */
  severity: Severity;
  /** Confidence in this verdict, in [0, 1]. */
  confidence: number;
  /** Which decision rule fired — for audit trails. */
  decidedBy: string;
  /** Every signal that fed the decision (including errored ones). */
  signals: DetectionSignal[];
}

// ── Run results ────────────────────────────────────────────────────────────────

export interface AttemptResult {
  probeKey: string;
  attemptId: string;
  family: string;
  category: OwaspLlmCategory;
  severity: Severity;
  transcript: Turn[];
  verdict: Verdict;
  /** Mirror of `verdict.outcome` for convenient filtering. */
  outcome: Outcome;
  latencyMs?: number;
  /** Set when the target invocation itself threw (or timed out). */
  error?: string;
  /**
   * The target answered at least one turn before `error`: the detectors judged
   * the transcript up to the error, and the attempt counts as completed. An
   * attempt with `error` and no `partial` never got an answer and counts as failed.
   */
  partial?: boolean;
  /**
   * The knowledge bases (`<projectId>:<key>` tags) whose documents not open to everyone the attempt's work handed on
   * (rag/access/exposure.ts): its transcript, rationales and error are shown only to the run's starter and to those
   * who read all of them through the admin exception.
   */
  kbRestricted?: string[];
  /** Set only for an over-refusal attempt (see ProbePolarity); absent means `attack`. */
  polarity?: 'over-refusal';
}

/**
 * Over-refusal attempts, kept apart from the attack counts: `refused` are the
 * harmless prompts the target refused (each is an attempt with outcome
 * `vulnerable`), `rate` is refused / completed, null when none completed.
 */
export interface OverRefusalBreakdown {
  total: number;
  completed: number;
  failed: number;
  refused: number;
  needsReview: number;
  rate: number | null;
}

export interface CategoryBreakdown {
  total: number;
  vulnerable: number;
  needsReview: number;
  /** Attempts that errored out (counted in total, not in vulnerable/needsReview). Absent on runs recorded before it existed. */
  failed?: number;
}

/** Why a run's rates cannot be trusted. */
export type InconclusiveReason = 'no-completed-attempts' | 'target-errors' | 'judge-errors';

export interface RedTeamAggregate {
  total: number;
  /** Attempts where the target responded (did not throw). */
  completed: number;
  /** Attempts whose target invocation threw. */
  failed: number;
  vulnerable: number;
  safe: number;
  needsReview: number;
  /** vulnerable / completed, in [0, 1]; null when no attempt completed. */
  attackSuccessRate: number | null;
  /** 1 - attackSuccessRate, in [0, 1] (needs_review tracked separately); null when no attempt completed. */
  resilienceScore: number | null;
  /** Count of vulnerable findings by severity. */
  bySeverity: Record<Severity, number>;
  /** Per-OWASP-category rollup (2025 keys). */
  byCategory: Record<string, CategoryBreakdown>;
  avgLatencyMs: number | null;
  /** Attempts whose llm-judge detector errored: counted here, never folded into "not hit". */
  judgeErrors: number;
  /** The rates cannot be trusted; `inconclusiveReasons` says why. */
  inconclusive: boolean;
  inconclusiveReasons: InconclusiveReason[];
  /**
   * Present when the run had over-refusal attempts. Those attempts are counted
   * only here: not in `total`, the verdict counts, the rates or the breakdowns.
   */
  overRefusal?: OverRefusalBreakdown;
}

export interface RedTeamRunResult {
  aggregate: RedTeamAggregate;
  attempts: AttemptResult[];
  /** True when `shouldStop` ended the run before every attempt ran. */
  stopped?: boolean;
  /** Attempts generated beyond `maxAttempts` that were never executed. */
  skipped?: number;
  /**
   * Attempts not run because they plant a system prompt and the target does not
   * take one (`targetAcceptsSystem: false`, e.g. an agent keeps its own).
   */
  notApplicable?: number;
}

export interface RedTeamRunConfig {
  /** Parallel attempt executions (default 4, clamped to RUN_LIMITS.concurrency). */
  concurrency?: number;
  /** Decision-policy overrides. */
  policy?: DecisionPolicyConfig;
  /** Cap user turns per attempt (truncates scripted multi-turn probes). */
  maxTurns?: number;
  /** Cap on attempts executed in one run (default RUN_LIMITS.maxAttemptsPerRun). */
  maxAttempts?: number;
  /**
   * Whether the target receives the attempt's `system` turn (default true). An
   * agent target keeps its own instructions, so an attempt that plants a
   * secret or rule in a system turn cannot test it: such attempts are not run
   * and are counted in `notApplicable`, never reported as safe.
   */
  targetAcceptsSystem?: boolean;
  /**
   * Whether the target takes a caller-supplied history (default true). An
   * agent keeps its own conversation, so an attempt with `history` is not run
   * there and is counted in `notApplicable`.
   */
  targetAcceptsHistory?: boolean;
  /**
   * The kind of target under test. A probe whose `targets` leave it out has
   * none of its attempts run (counted in `notApplicable`). Unset: no filter.
   */
  targetKind?: ProbeTargetKind;
  /**
   * Polled before each attempt starts and before each further turn. Once it
   * returns true no new attempt or turn starts; attempts already finished are
   * kept and the result is marked `stopped`.
   */
  shouldStop?: () => boolean;
}
