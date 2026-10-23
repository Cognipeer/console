/**
 * Conversation Analysis service — public surface of the engine core.
 *
 * A self-contained, dependency-injected pipeline (extraction, decision
 * answers, judge, accuracy and calibration) with no database, queue, or model-runtime imports. Higher layers
 * (persistence, live model adapters, nightly scheduling, alerting, dashboard)
 * build on top of it.
 */

export * from './types';
export { runAnalysis, aggregateItems } from './runner';
export type { RunAnalysisParams } from './runner';
export {
  extractFields,
  parseExtraction,
  buildExtractionPrompt,
  coerceField,
  renderTranscript,
} from './extraction';
export { judgeConversation, parseJudgeResponse, normaliseScore, buildJudgePrompt } from './judge';
export { scoreAccuracy, valuesMatch } from './accuracy';
export {
  isDecisionField,
  renderDecisionInput,
  buildDecisionQuestions,
  mapDecisionAnswer,
  decideFields,
  applyReviewFlags,
  fnv1a32,
  MAX_DECISION_INPUT_CHARS,
  DEFAULT_REVIEW_THRESHOLD,
} from './decision';
export type { DecisionFieldsResult, ReviewFlags } from './decision';
export { computeCalibration } from './calibration';
export type { CalibrationQuestion, CalibrationReport } from './calibration';

// Types of the service layer (type-only: importing this barrel still pulls in no database code).
export type { RunEstimate, ResultDetail, ResultSource, AgentSessionRow, AnalysisViewer } from './results';
