/**
 * Hybrid retrieval: the dense channel every vector driver already runs, plus an
 * optional keyword channel, and the single place their two rankings are fused.
 *
 * Pure vector search misses exact terms — error codes, SKUs, acronyms, proper
 * nouns — because they carry almost no semantic signal. The keyword channel is
 * opt-in per query (`VectorQueryInput.text`) and per driver
 * (the `vector.supportsHybrid` capability); a driver that cannot run it reports
 * that instead of returning dense results labelled as hybrid.
 *
 * ── The score scale ───────────────────────────────────────────────────────
 * Reciprocal Rank Fusion sums 1/(k + rank), so its raw output sits around
 * 1/60 ≈ 0.016 — two orders of magnitude below the cosine similarity every
 * caller thresholds against (ragService `minScore`, semanticCacheService
 * `similarityThreshold`). Handing those numbers back untouched would make a
 * module with `defaultMinScore: 0.5` return nothing at all the moment hybrid
 * was switched on.
 *
 * So every fused score — the ones fused here and the ones a store fuses
 * natively — is mapped back into 0..1, higher still meaning better, before it
 * leaves the driver:
 *
 *     score = sqrt(fused / (channels / (k + 1)))
 *
 * The divisor is the theoretical maximum, rank 1 in every channel, never the
 * best score observed in this result set: a set-relative maximum would rescale
 * a page of uniformly bad matches so the least bad of them scored 1.0, which is
 * exactly what a `minScore` gate exists to catch. The square root is
 * deliberate — without it a document that tops one channel but is missing from
 * the other caps out at 0.5, and a keyword-only hit on an exact term is
 * precisely what hybrid was switched on to surface.
 *
 * What this scale is NOT is a similarity. Under 'rrf' it expresses rank
 * confidence: with the default k of 60 a match still scores ≈0.5 at rank 60, so
 * a threshold tuned for cosine filters far less than it used to. Callers that
 * need the real number read `denseScore`, which every locally fused match
 * carries. 'weighted' keeps the cosine scale and is the mode to pick when
 * absolute thresholds matter.
 */

export type VectorHybridMode = 'rrf' | 'weighted';

export interface VectorHybridOptions {
  /** How the two rankings are combined. Default 'rrf'. */
  mode?: VectorHybridMode;
  /** weighted mode: 1 = pure dense, 0 = pure keyword. Default 0.5. */
  alpha?: number;
  /** rrf mode: rank constant. Larger flattens the advantage of the top ranks. Default 60. */
  k?: number;
}

export const DEFAULT_HYBRID_MODE: VectorHybridMode = 'rrf';
export const DEFAULT_HYBRID_ALPHA = 0.5;
export const DEFAULT_RRF_K = 60;

/**
 * Channels a hybrid query draws from, dense and keyword. Fixed rather than
 * counted per query on purpose: normalising against the channels that happened
 * to return something would make one document's score depend on whether an
 * unrelated document matched, which is the set-relative behaviour the scale is
 * built to avoid.
 */
const HYBRID_CHANNELS = 2;

/** Resolved hybrid settings, every field filled in. */
export interface ResolvedHybridOptions {
  mode: VectorHybridMode;
  alpha: number;
  k: number;
}

export function resolveHybridOptions(options?: VectorHybridOptions): ResolvedHybridOptions {
  const alpha = typeof options?.alpha === 'number' && Number.isFinite(options.alpha)
    ? Math.min(1, Math.max(0, options.alpha))
    : DEFAULT_HYBRID_ALPHA;
  const k = typeof options?.k === 'number' && Number.isFinite(options.k) && options.k >= 1
    ? options.k
    : DEFAULT_RRF_K;

  return { mode: options?.mode ?? DEFAULT_HYBRID_MODE, alpha, k };
}

/**
 * Metadata keys a vector's searchable text may live under, in priority order.
 *
 * No adapter stored raw text before hybrid existed, so the keyword channel has
 * nothing to match on unless `upsertVectors` writes one out. This mirrors how
 * ragService resolves chunk content for vectors written by a pipeline of
 * someone else's, so an index ingested either way stays searchable.
 */
export const CONTENT_METADATA_KEYS = [
  '_content',
  'content',
  'text',
  'chunk',
  'chunk_text',
  'page_content',
  'body',
] as const;

/** Searchable text carried by a vector's metadata, if any. */
export function extractVectorText(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  for (const key of CONTENT_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * How many candidates each channel should retrieve before fusion.
 *
 * A channel that returns only `topK` rows cannot contribute anything the other
 * channel did not already find near the top: a document ranked 4th by vectors
 * and 1st by keywords only wins if both lists reach past the final slice.
 */
export function hybridCandidateCount(topK: number): number {
  return Math.max(topK * 2, 20);
}

/** One channel's hit, ordered best-first by the caller. */
export interface VectorHybridChannelHit {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** A fused match, shaped for `VectorQueryResult.matches`. */
export interface VectorFusedMatch {
  id: string;
  score: number;
  denseScore?: number;
  lexicalScore?: number;
  metadata?: Record<string, unknown>;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

/**
 * Map a Reciprocal Rank Fusion score back onto the 0..1 scale callers
 * threshold against. See the module header for why the anchor is the
 * theoretical maximum and why the curve is a square root.
 *
 * Also the entry point for stores that fuse natively — Azure AI Search returns
 * its own RRF score, on exactly the ~0.016 scale that would otherwise wipe out
 * every result behind a `minScore`.
 */
export function normalizeFusedScore(
  fused: number,
  k: number = DEFAULT_RRF_K,
  channels: number = HYBRID_CHANNELS,
): number {
  const best = channels / (k + 1);
  if (best <= 0) return 0;
  return clamp01(Math.sqrt(fused / best));
}

interface FusionEntry {
  id: string;
  metadata?: Record<string, unknown>;
  denseRank?: number;
  denseScore?: number;
  lexicalRank?: number;
  lexicalScore?: number;
}

function collect(
  entries: Map<string, FusionEntry>,
  hits: VectorHybridChannelHit[],
  channel: 'dense' | 'lexical',
): void {
  hits.forEach((hit, index) => {
    const entry = entries.get(hit.id) ?? { id: hit.id };
    // Both channels carry the same stored metadata; keep whichever arrived
    // first so a channel that projects less does not erase it.
    if (entry.metadata === undefined && hit.metadata !== undefined) {
      entry.metadata = hit.metadata;
    }
    if (channel === 'dense') {
      entry.denseRank = index + 1;
      entry.denseScore = hit.score;
    } else {
      entry.lexicalRank = index + 1;
      entry.lexicalScore = hit.score;
    }
    entries.set(hit.id, entry);
  });
}

/**
 * Fuse a dense and a keyword ranking into one ordered result set.
 *
 * 'rrf' ranks by 1/(k + rank) summed over the channels, then rescales as the
 * module header describes — robust, because it never compares a cosine
 * similarity against a BM25 score, but it discards how similar anything
 * actually was.
 *
 * 'weighted' blends `alpha · dense + (1 - alpha) · lexical`, with the weights
 * renormalised over the channels that actually found the document. That last
 * detail is what keeps the cosine scale intact: without it a strong dense-only
 * hit at 0.8 would be reported as 0.4 and disappear behind the very threshold
 * it used to clear. The keyword side is divided by the best keyword score in
 * the set, because BM25 has no absolute scale to normalise against.
 */
export function fuseHybridMatches(input: {
  dense: VectorHybridChannelHit[];
  lexical: VectorHybridChannelHit[];
  topK: number;
  options?: VectorHybridOptions;
}): VectorFusedMatch[] {
  const { mode, alpha, k } = resolveHybridOptions(input.options);

  const entries = new Map<string, FusionEntry>();
  collect(entries, input.dense, 'dense');
  collect(entries, input.lexical, 'lexical');

  const bestLexical = input.lexical.reduce(
    (best, hit) => (Number.isFinite(hit.score) && hit.score > best ? hit.score : best),
    0,
  );

  const fused: VectorFusedMatch[] = [];

  for (const entry of entries.values()) {
    let score: number;

    if (mode === 'weighted') {
      const denseWeight = entry.denseRank !== undefined ? alpha : 0;
      const lexicalWeight = entry.lexicalRank !== undefined ? 1 - alpha : 0;
      const totalWeight = denseWeight + lexicalWeight;
      const lexicalNormalized = bestLexical > 0 ? clamp01((entry.lexicalScore ?? 0) / bestLexical) : 0;
      score = totalWeight > 0
        ? (denseWeight * clamp01(entry.denseScore ?? 0) + lexicalWeight * lexicalNormalized) / totalWeight
        : 0;
    } else {
      const raw = (entry.denseRank !== undefined ? 1 / (k + entry.denseRank) : 0)
        + (entry.lexicalRank !== undefined ? 1 / (k + entry.lexicalRank) : 0);
      score = normalizeFusedScore(raw, k);
    }

    fused.push({
      id: entry.id,
      score,
      ...(entry.denseScore !== undefined ? { denseScore: entry.denseScore } : {}),
      ...(entry.lexicalScore !== undefined ? { lexicalScore: entry.lexicalScore } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    });
  }

  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, Math.max(0, input.topK));
}

/** Why a query that asked for hybrid ran dense-only after all. */
export type VectorHybridUnavailableReason =
  /** The driver has no keyword channel at all. */
  | 'driver'
  /** The index predates the searchable text field, so there is nothing to match. */
  | 'index-schema'
  /** The store needs a text index that the operator has not created. */
  | 'not-configured';

/**
 * The `usage` keys a result carries about hybrid retrieval.
 *
 * A driver handed `text` MUST report one of these on every result it returns:
 * fused and dense-only matches look identical from the outside, and guessing is
 * how a search stays quietly dense forever while its dashboard claims hybrid.
 */
export function describeHybrid(input: {
  ran: boolean;
  mode?: VectorHybridMode;
  reason?: VectorHybridUnavailableReason;
}): Record<string, unknown> {
  return {
    hybrid: input.ran,
    ...(input.ran && input.mode ? { hybridMode: input.mode } : {}),
    ...(!input.ran && input.reason ? { hybridUnavailable: input.reason } : {}),
  };
}
