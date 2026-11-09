/**
 * Bounds on what one red-team scan may do, in one place so the API, the
 * service, the runner and the forms agree.
 *
 * Pure module with no imports, so client components can use it too.
 */

export const RUN_LIMITS = {
  /** Parallel attempts in one run. */
  concurrency: { min: 1, max: 16, default: 4 },
  /** Attempts one run executes at most; the rest are counted as skipped. */
  maxAttemptsPerRun: 500,
  /** Probe keys one campaign may select. */
  maxProbeKeysPerCampaign: 100,
  /** Output tokens the target may produce per turn. */
  maxOutputTokens: { default: 4096, max: 16384 },
  /** Per-call time limits. */
  targetTimeoutMs: 120_000,
  judgeTimeoutMs: 60_000,
  attackerTimeoutMs: 60_000,
  /** Characters of each target output a judge reads. */
  judgeInputCharsPerOutput: 8_000,
  /** Characters of each turn the attacker reads, and how many recent turns. */
  attackerTurnChars: 4_000,
  attackerHistoryTurns: 6,
  /** Characters of each stored transcript message. */
  transcriptMessageChars: 20_000,
} as const;

export const CUSTOM_PROBE_LIMITS = {
  maxAttempts: 50,
  maxTurnsPerAttempt: 10,
  maxJudges: 5,
  maxTurnChars: 8_000,
  maxSystemChars: 16_000,
  maxObjectiveChars: 2_000,
  maxRubricChars: 4_000,
  /** Attempt ids: letters, digits, `.`, `_`, `-`; unique within the probe. */
  maxAttemptIdLength: 64,
  /** Forged history messages per attempt (ProbeAttempt.history), each at most maxTurnChars. */
  maxHistoryMessages: 10,
  /** Named detectors per probe (ProbeDetectorSpec.named). */
  maxNamedDetectors: 8,
} as const;

/** File import (redteam/import): parsed in the browser, then sent as probe drafts. */
export const IMPORT_LIMITS = {
  /** Largest file the import reads. */
  maxFileBytes: 10 * 1024 * 1024,
  /** Rows read from one file; the rest are ignored and counted. */
  maxRows: 200_000,
  /** Probes one import may create. */
  maxProbesPerImport: 20,
  /** Attempts per imported probe; more usable rows are sampled with a fixed seed. */
  maxAttemptsPerProbe: CUSTOM_PROBE_LIMITS.maxAttempts,
  /** Source metadata lengths. */
  maxSourceNameChars: 200,
  maxSourceLicenseChars: 100,
  maxSourceAttributionChars: 500,
  maxSourceUrlChars: 500,
  maxSourceFormatChars: 64,
  maxSourceFileNameChars: 255,
} as const;

export const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Worker lease on a running scan: renewed by a heartbeat, reaped once expired. */
export const RUN_LIFECYCLE = {
  leaseMs: 60_000,
  heartbeatMs: 10_000,
  /** A scan still pending after this long never reached a worker. */
  pendingTimeoutMs: 30 * 60_000,
  /** A running scan recorded before leases existed is stale once untouched this long. */
  legacyRunningTimeoutMs: 60 * 60_000,
} as const;

/** Share of attempts above which a run's rates are not trusted. */
export const INCONCLUSIVE_THRESHOLDS = {
  targetErrorShare: 0.2,
  judgeErrorShare: 0.2,
} as const;

export function clampConcurrency(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return RUN_LIMITS.concurrency.default;
  return Math.min(RUN_LIMITS.concurrency.max, Math.max(RUN_LIMITS.concurrency.min, Math.floor(n)));
}

export function clampMaxOutputTokens(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return RUN_LIMITS.maxOutputTokens.default;
  return Math.min(RUN_LIMITS.maxOutputTokens.max, Math.floor(n));
}

/** Cut a stored text to `max` characters, marking the cut. */
export function truncateText(text: string, max: number): string {
  if (typeof text !== 'string' || text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`;
}
