/**
 * Groundedness scorer — is the target's ANSWER supported by the passages it
 * retrieved?
 *
 * The other half of retrieval quality: perfect context still produces a
 * hallucination when the generator answers from its own weights instead. Same
 * machinery as context-recall, with the produced answer standing in for the
 * gold one — each sentence of the answer is scored by its best embedding
 * similarity to any retrieved chunk, and the score is their mean, so an answer
 * that is half quoted and half invented reads as half grounded.
 *
 * On a pure retrieval target the answer IS the concatenated context, so this
 * scores ~1 by construction; it earns its keep on a target that both retrieves
 * and generates.
 */

import type { DatasetItem, EmbedInvoker, GroundednessScorerConfig, ScoreResult, TargetOutput } from '../types';
import { bestMatch, embedBatched, requireRetrieval, scorerError, splitClaims, toChunkRefs, usableChunks } from './retrievalSimilarity';

const DEFAULT_THRESHOLD = 0.7;

export async function scoreGroundedness(
  _item: DatasetItem,
  output: TargetOutput,
  config: GroundednessScorerConfig,
  invokeEmbed: EmbedInvoker,
): Promise<ScoreResult> {
  const weight = config.weight ?? 1;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;

  const misconfigured = requireRetrieval('groundedness', output, weight);
  if (misconfigured) return misconfigured;

  const { chunks, skippedEmpty } = usableChunks(output);
  const claims = splitClaims(output.text ?? '');
  // An answer with nothing in it, or one with no context behind it, is not
  // grounded — a real failure of the target rather than a broken suite, so it
  // scores 0 without an error and stays visible in the pass rate.
  if (chunks.length === 0 || claims.length === 0) {
    return {
      scorerType: 'groundedness',
      score: 0,
      passed: false,
      weight,
      detail: {
        threshold,
        retrieved: output.retrieved?.length ?? 0,
        scoredChunks: chunks.length,
        claims: claims.length,
        skippedEmpty,
      },
    };
  }

  try {
    const vectors = await embedBatched([...claims, ...chunks.map((chunk) => chunk.content)], invokeEmbed);
    const claimVectors = vectors.slice(0, claims.length);
    const chunkVectors = vectors.slice(claims.length);

    const support = claimVectors.map((vector) => bestMatch(vector, chunkVectors).similarity);
    const score = support.reduce((sum, value) => sum + value, 0) / support.length;
    const chunkSimilarity = chunkVectors.map((vector) => bestMatch(vector, claimVectors).similarity);
    const weakest = support.reduce((min, value, i) => (value < support[min] ? i : min), 0);

    return {
      scorerType: 'groundedness',
      score,
      passed: score >= threshold,
      weight,
      detail: {
        threshold,
        claims: claims.length,
        scoredChunks: chunks.length,
        skippedEmpty,
        // The least-supported sentence is where a hallucination shows up.
        weakestClaim: { text: claims[weakest], support: support[weakest] },
        chunks: toChunkRefs(chunks, chunkSimilarity),
      },
    };
  } catch (err) {
    return scorerError('groundedness', weight, err, 'groundedness scoring failed');
  }
}
