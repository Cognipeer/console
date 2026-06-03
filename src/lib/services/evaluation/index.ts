/**
 * Evaluation service — public surface of the engine core.
 *
 * This module is a self-contained, dependency-injected scoring engine: it has
 * no database, queue, or model-runtime imports. Higher layers (persistence,
 * live target/judge adapters, HTTP API, dashboard) build on top of it.
 */

export * from './types';
export { runEvaluation } from './runner';
export type { RunEvaluationParams } from './runner';
export { runScorers, SUPPORTED_SCORERS, scoreAssertion, scoreLlmJudge } from './scorers';
export type { ScorerDeps } from './scorers';
