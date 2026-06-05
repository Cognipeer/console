/**
 * Semantic (vector) scorer — embeds the target output and the expected gold
 * answer (`expected.reference`) and scores their cosine similarity in [0..1].
 *
 * Useful when an answer can be phrased many ways: instead of exact/substring
 * assertions, it rewards outputs that are *meaning-close* to the reference.
 * Requires an injected EmbedInvoker (backed by a registered embedding model).
 */

import type { DatasetItem, EmbedInvoker, ScoreResult, SemanticScorerConfig, TargetOutput } from '../types';

const DEFAULT_THRESHOLD = 0.75;

/** Cosine similarity of two equal-length vectors, in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function scoreSemantic(
  item: DatasetItem,
  output: TargetOutput,
  config: SemanticScorerConfig,
  invokeEmbed: EmbedInvoker,
): Promise<ScoreResult> {
  const weight = config.weight ?? 1;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const reference = item.expected?.reference;

  if (!reference || !reference.trim()) {
    return {
      scorerType: 'semantic',
      score: 0,
      passed: false,
      weight,
      error: 'semantic scorer requires expected.reference (the gold answer) on the dataset item',
    };
  }

  try {
    const [outVec, refVec] = await invokeEmbed([output.text ?? '', reference]);
    if (!outVec || !refVec) {
      return { scorerType: 'semantic', score: 0, passed: false, weight, error: 'embedding provider returned no vectors' };
    }
    const similarity = cosineSimilarity(outVec, refVec);
    // Cosine for text embeddings is effectively in [0, 1]; clamp to be safe.
    const score = Math.min(1, Math.max(0, similarity));
    return {
      scorerType: 'semantic',
      score,
      passed: score >= threshold,
      weight,
      detail: { similarity, threshold },
    };
  } catch (err) {
    return {
      scorerType: 'semantic',
      score: 0,
      passed: false,
      weight,
      error: err instanceof Error ? err.message : 'semantic scoring failed',
    };
  }
}
