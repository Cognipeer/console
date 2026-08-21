/**
 * Context-recall scorer — is the gold answer semantically COVERED by what the
 * target retrieved?
 *
 * Judged by embedding cosine similarity, never string overlap: a passage that
 * answers the question in different words is a hit, and an exact-match scorer
 * would call it a miss. The reference is compared claim by claim (see
 * `splitClaims`) and the score is the mean coverage of its claims, so an answer
 * whose first fact was retrieved and whose remaining facts were not reads as
 * partially recalled rather than as a pass.
 */

import type { ContextRecallScorerConfig, DatasetItem, EmbedInvoker, ScoreResult, TargetOutput } from '../types';
import { bestMatch, embedBatched, requireRetrieval, scorerError, splitClaims, toChunkRefs, usableChunks } from './retrievalSimilarity';

const DEFAULT_THRESHOLD = 0.7;

export async function scoreContextRecall(
  item: DatasetItem,
  output: TargetOutput,
  config: ContextRecallScorerConfig,
  invokeEmbed: EmbedInvoker,
): Promise<ScoreResult> {
  const weight = config.weight ?? 1;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const reference = item.expected?.reference;

  if (!reference || !reference.trim()) {
    return {
      scorerType: 'context-recall',
      score: 0,
      passed: false,
      weight,
      error: 'context-recall scorer requires expected.reference (the gold answer) on the dataset item',
    };
  }
  const misconfigured = requireRetrieval('context-recall', output, weight);
  if (misconfigured) return misconfigured;

  const { chunks, skippedEmpty } = usableChunks(output);
  if (chunks.length === 0) {
    return {
      scorerType: 'context-recall',
      score: 0,
      passed: false,
      weight,
      detail: { retrieved: output.retrieved?.length ?? 0, scoredChunks: 0, skippedEmpty, threshold },
    };
  }

  try {
    const claims = splitClaims(reference);
    const vectors = await embedBatched([...claims, ...chunks.map((chunk) => chunk.content)], invokeEmbed);
    const claimVectors = vectors.slice(0, claims.length);
    const chunkVectors = vectors.slice(claims.length);

    const coverage = claimVectors.map((vector) => bestMatch(vector, chunkVectors).similarity);
    const score = coverage.reduce((sum, value) => sum + value, 0) / coverage.length;
    // Per-chunk similarity here is "how well does this chunk cover any claim",
    // which is what makes the evidence trail readable: a chunk sitting at 0.1
    // was retrieved for nothing.
    const chunkSimilarity = chunkVectors.map((vector) => bestMatch(vector, claimVectors).similarity);
    const weakest = coverage.reduce((min, value, i) => (value < coverage[min] ? i : min), 0);

    return {
      scorerType: 'context-recall',
      score,
      passed: score >= threshold,
      weight,
      detail: {
        threshold,
        claims: claims.length,
        scoredChunks: chunks.length,
        skippedEmpty,
        weakestClaim: { text: claims[weakest], coverage: coverage[weakest] },
        chunks: toChunkRefs(chunks, chunkSimilarity),
      },
    };
  } catch (err) {
    return scorerError('context-recall', weight, err, 'context-recall scoring failed');
  }
}
