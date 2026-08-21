/**
 * Context-precision scorer — how much of what the target retrieved was
 * actually relevant, weighted by rank.
 *
 * A chunk counts as relevant when its embedding cosine similarity to the gold
 * answer clears RELEVANCE_SIMILARITY; the score is the rank-weighted share of
 * relevant chunks, using the discounted-gain weight 1/log2(rank+1). Rank
 * matters because position is not cosmetic: the generator reads rank 1 first
 * and, with a context window to fill, may never reach rank 10 — so a set whose
 * one relevant passage sits last is worse retrieval than the same set reversed,
 * and an unweighted share cannot tell them apart.
 *
 * The comparison is against the whole reference rather than its individual
 * claims: precision asks whether a passage is about the answer at all, not
 * whether it covers every part of it (that is context-recall's question).
 */

import type { ContextPrecisionScorerConfig, DatasetItem, EmbedInvoker, ScoreResult, TargetOutput } from '../types';
import { bestMatch, embedBatched, requireRetrieval, scorerError, toChunkRefs, usableChunks } from './retrievalSimilarity';

const DEFAULT_THRESHOLD = 0.5;

/**
 * Cosine similarity at which a retrieved passage counts as relevant.
 *
 * Fixed rather than configurable because `IEvaluationScorerConfig` carries a
 * single `threshold`, which is spent on the pass gate to stay consistent with
 * every other scorer — and a knob the API silently drops is worse than a
 * documented constant.
 */
export const RELEVANCE_SIMILARITY = 0.6;

/** Discounted-gain weight for a 1-based rank. */
function rankWeight(rank: number): number {
  return 1 / Math.log2(rank + 1);
}

export async function scoreContextPrecision(
  item: DatasetItem,
  output: TargetOutput,
  config: ContextPrecisionScorerConfig,
  invokeEmbed: EmbedInvoker,
): Promise<ScoreResult> {
  const weight = config.weight ?? 1;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const reference = item.expected?.reference;

  if (!reference || !reference.trim()) {
    return {
      scorerType: 'context-precision',
      score: 0,
      passed: false,
      weight,
      error: 'context-precision scorer requires expected.reference (the gold answer) on the dataset item',
    };
  }
  const misconfigured = requireRetrieval('context-precision', output, weight);
  if (misconfigured) return misconfigured;

  const { chunks, skippedEmpty } = usableChunks(output);
  if (chunks.length === 0) {
    return {
      scorerType: 'context-precision',
      score: 0,
      passed: false,
      weight,
      detail: { retrieved: output.retrieved?.length ?? 0, scoredChunks: 0, skippedEmpty, threshold },
    };
  }

  try {
    const vectors = await embedBatched([reference, ...chunks.map((chunk) => chunk.content)], invokeEmbed);
    const referenceVector = vectors[0];
    const chunkVectors = vectors.slice(1);

    const similarities = chunkVectors.map((vector) => bestMatch(vector, [referenceVector]).similarity);
    let gained = 0;
    let possible = 0;
    let relevant = 0;
    chunks.forEach((chunk, i) => {
      const w = rankWeight(chunk.rank);
      possible += w;
      if (similarities[i] >= RELEVANCE_SIMILARITY) {
        gained += w;
        relevant += 1;
      }
    });
    const score = possible > 0 ? gained / possible : 0;

    return {
      scorerType: 'context-precision',
      score,
      passed: score >= threshold,
      weight,
      detail: {
        threshold,
        relevanceSimilarity: RELEVANCE_SIMILARITY,
        scoredChunks: chunks.length,
        relevantChunks: relevant,
        skippedEmpty,
        chunks: toChunkRefs(chunks, similarities),
      },
    };
  } catch (err) {
    return scorerError('context-precision', weight, err, 'context-precision scoring failed');
  }
}
