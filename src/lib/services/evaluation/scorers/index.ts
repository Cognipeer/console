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
import { hasReference, skippedScore } from './skip';

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

/**
 * Why a scorer does not apply to this item, or undefined when it does. Explicit
 * `applyWhen` is checked first; the built-in rules cover scorers that are
 * meaningless without a gold answer (the item is not wrong, the scorer is just
 * not applicable). Tool-call abstention and the judge stay always-applicable
 * unless the suite says otherwise.
 */
function inapplicableReason(item: DatasetItem, config: ScorerConfig): string | undefined {
  const expectedCalls = item.expected?.toolCalls;
  if (config.applyWhen === 'has-reference' && !hasReference(item.expected?.reference)) {
    return 'item has no reference answer';
  }
  if (config.applyWhen === 'has-expected-tool-calls' && !(Array.isArray(expectedCalls) && expectedCalls.length > 0)) {
    return 'item has no expected tool calls';
  }
  if (
    (config.type === 'semantic' || config.type === 'context-recall' || config.type === 'context-precision') &&
    !hasReference(item.expected?.reference)
  ) {
    return 'item has no reference answer';
  }
  return undefined;
}

async function runOne(
  item: DatasetItem,
  output: TargetOutput,
  config: ScorerConfig,
  deps: ScorerDeps,
): Promise<ScoreResult> {
  const weight = config.weight ?? 1;
  switch (config.type) {
    case 'assertion':
      return scoreAssertion(item, output, config);
    case 'tool-call':
      return scoreToolCall(item, output, config);
    case 'json-shape':
      return scoreJsonShape(item, output, config);
    case 'llm-judge':
      return deps.invokeJudge
        ? scoreLlmJudge(item, output, config, deps.invokeJudge)
        : missingInvoker('llm-judge', weight, 'judge');
    case 'semantic':
      return deps.invokeEmbed
        ? scoreSemantic(item, output, config, deps.invokeEmbed)
        : missingInvoker('semantic', weight, 'embed');
    case 'context-recall':
      return deps.invokeEmbed
        ? scoreContextRecall(item, output, config, deps.invokeEmbed)
        : missingInvoker('context-recall', weight, 'embed');
    case 'context-precision':
      return deps.invokeEmbed
        ? scoreContextPrecision(item, output, config, deps.invokeEmbed)
        : missingInvoker('context-precision', weight, 'embed');
    case 'groundedness':
      return deps.invokeEmbed
        ? scoreGroundedness(item, output, config, deps.invokeEmbed)
        : missingInvoker('groundedness', weight, 'embed');
    default: {
      // Exhaustiveness guard — a new ScorerConfig variant must be handled.
      const _never: never = config;
      throw new Error(`unsupported scorer: ${JSON.stringify(_never)}`);
    }
  }
}

export async function runScorers(
  item: DatasetItem,
  output: TargetOutput,
  scorers: ScorerConfig[],
  deps: ScorerDeps = {},
): Promise<ScoreResult[]> {
  const results: ScoreResult[] = [];
  for (const config of scorers) {
    const reason = inapplicableReason(item, config);
    if (reason) {
      results.push(skippedScore(config.type, config.weight ?? 1, reason));
      continue;
    }
    try {
      results.push(await runOne(item, output, config, deps));
    } catch (err) {
      // One scorer blowing up must not erase the other scores of the item.
      results.push({
        scorerType: config.type,
        score: 0,
        passed: false,
        weight: config.weight ?? 1,
        error: err instanceof Error ? err.message : String(err),
      });
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
