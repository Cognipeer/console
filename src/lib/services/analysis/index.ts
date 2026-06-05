/**
 * Conversation Analysis service — public surface of the engine core.
 *
 * A self-contained, dependency-injected pipeline (extraction + judge +
 * accuracy) with no database, queue, or model-runtime imports. Higher layers
 * (persistence, live model adapters, nightly scheduling, alerting, dashboard)
 * build on top of it.
 */

export * from './types';
export { runAnalysis } from './runner';
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
