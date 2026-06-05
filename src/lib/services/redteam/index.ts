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
export { runRedTeam } from './runner';
export type { RunRedTeamParams } from './runner';
export { decide, resolvePolicyConfig, variance } from './decisionPolicy';
export {
  createRefusalDetector,
  createPatternDetector,
  createLlmJudgeDetector,
  parseJudgeVerdict,
  createPiiDetector,
  createInsecureOutputDetector,
  createEncodingLeakDetector,
} from './detectors';
export type { LlmJudgeDetectorOptions } from './detectors';
export {
  PROBE_REGISTRY,
  BUILTIN_PROBE_KEYS,
  buildProbes,
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
