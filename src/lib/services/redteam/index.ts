/**
 * Red-team (adversarial agent testing) engine — public surface.
 *
 * A self-contained, dependency-injected pipeline: probes generate adversarial
 * attempts, detectors emit signals, and a three-state decision policy turns
 * those signals into auditable verdicts. It has no database or queue coupling;
 * the live target/judge adapters, persistence, scheduling, and HTTP API are
 * layered on top separately.
 */

export * from './types';
export { runRedTeam, JUDGE_ERROR_INCONCLUSIVE_SHARE } from './runner';
export type { RunRedTeamParams, RunTimeouts } from './runner';
export { decide, hasHardProof, resolvePolicyConfig, variance } from './decisionPolicy';
export {
  OWASP_LLM_VERSION,
  OWASP_LLM_CATEGORIES,
  OWASP_LLM_LABELS,
  LEGACY_OWASP_CATEGORY_MAP,
  isOwaspLlmCategory,
  isKnownOwaspCategory,
  normalizeOwaspCategory,
  owaspCategoryLabel,
} from './owasp';
export { ATTEMPT_KEY_SEPARATOR, attemptKeyOf, parseAttemptKey } from './attemptKey';
export {
  RUN_LIMITS,
  CUSTOM_PROBE_LIMITS,
  ATTEMPT_ID_PATTERN,
  RUN_LIFECYCLE,
  INCONCLUSIVE_THRESHOLDS,
  clampConcurrency,
  clampMaxOutputTokens,
  truncateText,
} from './limits';
export { computeAggregate, effectiveOutcome, isFailedAttempt, summarizeJudgeErrors } from './aggregate';
export type { AggregateAttempt } from './aggregate';
export { compareRedTeamRuns } from './compare';
export type {
  ComparisonStatus,
  RedTeamComparison,
  RedTeamComparisonAttempt,
  RedTeamComparisonAttempts,
} from './compare';
export {
  createRefusalDetector,
  createPatternDetector,
  createLlmJudgeDetector,
  parseJudgeVerdict,
  createPiiDetector,
  createInsecureOutputDetector,
  createEncodingLeakDetector,
  analyzeRefusal,
  looksLikeRefusal,
  findPii,
  findPiiDetailed,
} from './detectors';
export type { LlmJudgeDetectorOptions } from './detectors';
export {
  PROBE_REGISTRY,
  BUILTIN_PROBE_KEYS,
  buildProbes,
  buildProbesLenient,
  validateCustomProbeDefinition,
  listProbeCatalog,
  createPromptInjectionProbe,
  createJailbreakProbe,
  createSensitiveInfoProbe,
  createEncodingInjectionProbe,
  createInsecureOutputProbe,
  createExcessiveAgencyProbe,
  createOverrelianceProbe,
  createPiiGenerationProbe,
  createDataExtractionProbe,
} from './probes';
export type { ProbeCatalogEntry } from './probes';
export { buildTargetInvoker, buildJudgeInvoker, buildAttackerInvoker } from './adapters';
export type { RedTeamModelContext, RedTeamTargetSpec } from './adapters';
export { buildAttackerMessages, ATTACKER_STOP } from './attacker';
export { isDue, computeNextRun, validateCron } from './schedulePlanner';
export type { RedTeamSchedule } from './schedulePlanner';
export { runCalibration } from './calibration/calibrationRunner';
export type { CalibrationResult, CalibrationCaseResult } from './calibration/calibrationRunner';
export { GOLDEN_SET } from './calibration/goldenSet';
export type { CalibrationCase } from './calibration/goldenSet';
