/**
 * Scorer dispatch. Runs the configured scorers for one item against the
 * target output, returning one ScoreResult per scorer.
 */

import type { DatasetItem, EmbedInvoker, JudgeInvoker, ScorerConfig, ScorerType, ScoreResult, TargetOutput } from '../types';
import { scoreAssertion } from './assertionScorer';
import { scoreLlmJudge } from './llmJudgeScorer';
import { scoreSemantic } from './semanticScorer';
import { scoreToolCall } from './toolCallScorer';
import { scoreJsonShape } from './jsonShapeScorer';
import { scoreContextRecall } from './contextRecallScorer';
import { scoreContextPrecision } from './contextPrecisionScorer';
import { scoreGroundedness } from './groundednessScorer';

export const SUPPORTED_SCORERS: ScorerType[] = [
  'assertion',
  'llm-judge',
  'semantic',
  'tool-call',
  'json-shape',
  'context-recall',
  'context-precision',
  'groundedness',
];

/**
 * Scorers that need an EmbedInvoker, and the ones that need a JudgeInvoker.
 *
 * Exported so callers select the invokers from this registry instead of
 * hardcoding scorer names: a run that builds no embed invoker hands every
 * embedding-backed scorer `undefined`, and the whole suite silently scores 0
 * with 'no embed invoker configured'.
 */
export const EMBEDDING_SCORERS: ScorerType[] = ['semantic', 'context-recall', 'context-precision', 'groundedness'];
export const JUDGE_SCORERS: ScorerType[] = ['llm-judge'];

export interface ScorerDeps {
  invokeJudge?: JudgeInvoker;
  invokeEmbed?: EmbedInvoker;
}

function missingInvoker(scorerType: ScorerType, weight: number, invoker: 'judge' | 'embed'): ScoreResult {
  return { scorerType, score: 0, passed: false, weight, error: `no ${invoker} invoker configured` };
}

export async function runScorers(
  item: DatasetItem,
  output: TargetOutput,
  scorers: ScorerConfig[],
  deps: ScorerDeps = {},
): Promise<ScoreResult[]> {
  const results: ScoreResult[] = [];
  for (const config of scorers) {
    const weight = config.weight ?? 1;
    switch (config.type) {
      case 'assertion':
        results.push(scoreAssertion(item, output, config));
        break;
      case 'tool-call':
        results.push(scoreToolCall(item, output, config));
        break;
      case 'json-shape':
        results.push(scoreJsonShape(item, output, config));
        break;
      case 'llm-judge':
        if (!deps.invokeJudge) {
          results.push(missingInvoker('llm-judge', weight, 'judge'));
        } else {
          results.push(await scoreLlmJudge(item, output, config, deps.invokeJudge));
        }
        break;
      case 'semantic':
        if (!deps.invokeEmbed) {
          results.push(missingInvoker('semantic', weight, 'embed'));
        } else {
          results.push(await scoreSemantic(item, output, config, deps.invokeEmbed));
        }
        break;
      case 'context-recall':
        if (!deps.invokeEmbed) {
          results.push(missingInvoker('context-recall', weight, 'embed'));
        } else {
          results.push(await scoreContextRecall(item, output, config, deps.invokeEmbed));
        }
        break;
      case 'context-precision':
        if (!deps.invokeEmbed) {
          results.push(missingInvoker('context-precision', weight, 'embed'));
        } else {
          results.push(await scoreContextPrecision(item, output, config, deps.invokeEmbed));
        }
        break;
      case 'groundedness':
        if (!deps.invokeEmbed) {
          results.push(missingInvoker('groundedness', weight, 'embed'));
        } else {
          results.push(await scoreGroundedness(item, output, config, deps.invokeEmbed));
        }
        break;
      default: {
        // Exhaustiveness guard — a new ScorerConfig variant must be handled.
        const _never: never = config;
        throw new Error(`unsupported scorer: ${JSON.stringify(_never)}`);
      }
    }
  }
  return results;
}

export { scoreAssertion } from './assertionScorer';
export { scoreLlmJudge, buildJudgePrompt, parseJudgeResponse, normaliseScore } from './llmJudgeScorer';
export { scoreSemantic, cosineSimilarity } from './semanticScorer';
export { scoreToolCall, canonicalJson } from './toolCallScorer';
export { scoreContextRecall } from './contextRecallScorer';
export { scoreContextPrecision, RELEVANCE_SIMILARITY } from './contextPrecisionScorer';
export { scoreGroundedness } from './groundednessScorer';
