/**
 * Shared machinery for the three retrieval scorers (context-recall,
 * context-precision, groundedness).
 *
 * All three reduce to one question — how close is a piece of text to the
 * retrieved passages, measured by embedding cosine similarity — so the
 * embedding, batching and splitting rules live here instead of being
 * re-derived (and drifting) three times.
 */

import type { EmbedInvoker, RetrievedChunk, ScorerType, ScoreResult, TargetOutput } from '../types';
import { cosineSimilarity } from './semanticScorer';

/**
 * Texts embedded per provider call. `buildEmbedInvoker` sends everything it is
 * handed in a SINGLE request, and several embedding providers cap the number
 * of inputs per request — so a topK large enough to be interesting would 400
 * the whole item rather than score it.
 */
export const EMBED_BATCH_SIZE = 32;

/**
 * Chunks scored per item. topK is user-configurable and unbounded from here;
 * beyond a few dozen passages the extra embeddings cost more than they tell us,
 * and rank weighting has already driven the tail's contribution to near zero.
 */
export const MAX_SCORED_CHUNKS = 50;

/** Claim sentences scored per item — bounds the embed cost of a long answer. */
export const MAX_CLAIMS = 40;

/**
 * Chunk references kept on `ScoreResult.detail`. A run is ONE document, so the
 * evidence trail is capped and never carries chunk CONTENT — ids and scores are
 * enough to find the passage in the Knowledge Engine module.
 */
export const DETAIL_CHUNK_CAP = 20;

/** Fragments shorter than this are punctuation noise, not claims. */
const MIN_CLAIM_CHARS = 12;

/** One chunk's reference, as persisted on a score's detail. */
export interface ChunkRef {
  id: string;
  rank: number;
  /** Retrieval score reported by the vector store. */
  score: number;
  /** Cosine similarity against whatever this scorer compared the chunk to. */
  similarity: number;
}

export interface UsableChunks {
  chunks: RetrievedChunk[];
  /**
   * Chunks dropped for having no text. Vectors ingested outside our pipeline
   * have no `rag_chunks` row and hydrate to '' — embedding those yields a zero
   * vector, and `cosineSimilarity` scores a zero vector 0, which would deflate
   * every retrieval score without any hint of why.
   */
  skippedEmpty: number;
}

/** Non-empty retrieved chunks, in rank order, capped at MAX_SCORED_CHUNKS. */
export function usableChunks(output: TargetOutput): UsableChunks {
  const retrieved = output.retrieved ?? [];
  const withText = retrieved.filter((chunk) => (chunk.content ?? '').trim().length > 0);
  return {
    chunks: withText.slice(0, MAX_SCORED_CHUNKS),
    skippedEmpty: retrieved.length - withText.length,
  };
}

/**
 * Embed in bounded batches, preserving input order. Batches run sequentially:
 * an evaluation run is already parallel across items, and firing every batch of
 * every item at the provider at once is how a run turns into a rate-limit wall.
 */
export async function embedBatched(texts: string[], invokeEmbed: EmbedInvoker): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const embedded = await invokeEmbed(batch);
    if (!embedded || embedded.length < batch.length) {
      throw new Error('embedding provider returned fewer vectors than requested');
    }
    for (let i = 0; i < batch.length; i += 1) {
      const vector = embedded[i];
      if (!vector) throw new Error('embedding provider returned an empty vector');
      vectors.push(vector);
    }
  }
  return vectors;
}

/**
 * Split text into the claims it makes, one per sentence.
 *
 * Coverage is asked per claim rather than over the whole text because a long
 * passage embeds to its overall TOPIC: a gold answer whose opening sentence
 * appears verbatim in a chunk and whose remaining facts appear nowhere still
 * scores high on whole-text similarity. Per-sentence coverage averages that
 * out, so a half-supported answer reads as half supported.
 *
 * Text that does not split (a single clause, a JSON blob) falls back to itself,
 * which degrades exactly to the whole-text comparison.
 */
export function splitClaims(text: string, cap: number = MAX_CLAIMS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= MIN_CLAIM_CHARS);
  if (parts.length === 0) return [trimmed];
  return parts.slice(0, cap);
}

/** Highest cosine similarity between `vector` and any candidate, with its index. */
export function bestMatch(vector: number[], candidates: number[][]): { similarity: number; index: number } {
  let similarity = 0;
  let index = -1;
  for (let i = 0; i < candidates.length; i += 1) {
    // Cosine for text embeddings is effectively in [0, 1]; clamp so a negative
    // never drags a mean below zero.
    const value = Math.min(1, Math.max(0, cosineSimilarity(vector, candidates[i])));
    if (value > similarity || index === -1) {
      similarity = value;
      index = i;
    }
  }
  return { similarity, index };
}

/** Chunk references for a score's detail, capped and content-free. */
export function toChunkRefs(chunks: RetrievedChunk[], similarities: number[]): ChunkRef[] {
  return chunks.slice(0, DETAIL_CHUNK_CAP).map((chunk, i) => ({
    id: chunk.id,
    rank: chunk.rank,
    score: chunk.score,
    similarity: similarities[i] ?? 0,
  }));
}

/**
 * A retrieval scorer's precondition check.
 *
 * `retrieved` absent means the suite points a retrieval scorer at a target that
 * does not retrieve — a configuration mistake, reported as an error. An EMPTY
 * `retrieved` is a real result (the module returned nothing, or the minScore
 * floor discarded everything) and scores 0 without an error, because that is a
 * retrieval failure worth seeing in the pass rate rather than a broken suite.
 */
export function requireRetrieval(
  scorerType: ScorerType,
  output: TargetOutput,
  weight: number,
): ScoreResult | null {
  if (output.retrieved !== undefined) return null;
  return {
    scorerType,
    score: 0,
    passed: false,
    weight,
    error: `${scorerType} scorer requires a target that reports retrieved context (a Knowledge Engine target)`,
  };
}

/** Uniform failure result for a scorer that could not run to completion. */
export function scorerError(scorerType: ScorerType, weight: number, err: unknown, fallback: string): ScoreResult {
  return {
    scorerType,
    score: 0,
    passed: false,
    weight,
    error: err instanceof Error ? err.message : fallback,
  };
}
