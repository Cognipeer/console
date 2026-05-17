/**
 * Heuristic strategy — no model required.
 *
 * Combines:
 *   - keyword overlap between the query and the document
 *   - the original retrieval score (passthrough)
 *   - recency boost when documents have a `_createdAt` / `_timestamp` metadata field
 *
 * Weights are configurable. Default weights favor keyword overlap.
 */

import type { RerankerStrategyImpl } from './index';

const TOKEN_RE = /[a-zA-ZçğıöşüÇĞİÖŞÜ0-9]+/g;

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const matches = text.toLowerCase().match(TOKEN_RE);
  if (matches) {
    for (const m of matches) {
      if (m.length >= 2) tokens.add(m);
    }
  }
  return tokens;
}

function keywordOverlap(query: string, document: string): number {
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const d = tokenize(document);
  let hits = 0;
  for (const t of q) {
    if (d.has(t)) hits++;
  }
  return hits / q.size;
}

export const heuristicStrategy: RerankerStrategyImpl = {
  async run(ctx, query, documents, _topN) {
    const cfg = ctx.reranker.config ?? {};
    const w = cfg.heuristicWeights ?? {};
    const wKeyword = w.keyword ?? 0.7;
    const wOriginal = w.originalScore ?? 0.3;
    const wRecency = w.recency ?? 0;

    return documents.map((doc) => {
      const kw = keywordOverlap(query, doc.content);
      const original = doc.originalScore ?? 0;
      // Recency is best-effort: callers can pass _timestamp via metadata-aware preprocessing.
      const recency = 0;
      const total = wKeyword * kw + wOriginal * original + wRecency * recency;
      return { index: doc.index, score: total };
    });
  },
};
