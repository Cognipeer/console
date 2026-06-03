/**
 * Scorer dispatch. Runs the configured scorers for one item against the
 * target output, returning one ScoreResult per scorer.
 */

import type { DatasetItem, JudgeInvoker, ScorerConfig, ScorerType, ScoreResult, TargetOutput } from '../types';
import { scoreAssertion } from './assertionScorer';
import { scoreLlmJudge } from './llmJudgeScorer';

export const SUPPORTED_SCORERS: ScorerType[] = ['assertion', 'llm-judge'];

export interface ScorerDeps {
  invokeJudge?: JudgeInvoker;
}

export async function runScorers(
  item: DatasetItem,
  output: TargetOutput,
  scorers: ScorerConfig[],
  deps: ScorerDeps = {},
): Promise<ScoreResult[]> {
  const results: ScoreResult[] = [];
  for (const config of scorers) {
    switch (config.type) {
      case 'assertion':
        results.push(scoreAssertion(item, output, config));
        break;
      case 'llm-judge':
        if (!deps.invokeJudge) {
          results.push({
            scorerType: 'llm-judge',
            score: 0,
            passed: false,
            weight: config.weight ?? 1,
            error: 'no judge invoker configured',
          });
        } else {
          results.push(await scoreLlmJudge(item, output, config, deps.invokeJudge));
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
