/**
 * llm-listwise strategy (RankGPT-style)
 *
 * Send the query and the entire list of candidates to an LLM and ask for a
 * JSON ranking. Cheaper than llm-judge for short lists, but quality degrades
 * with very long lists.
 */

import { createLogger } from '@/lib/core/logger';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import type { RerankerStrategyImpl } from './index';

const logger = createLogger('reranker:llm-listwise');

const DEFAULT_PROMPT_TEMPLATE = `You are a relevance ranker. Given a query and a numbered list of candidate documents, return a JSON array of objects with shape {"index": number, "score": number} where score is between 0 and 1 indicating relevance. Return JSON only.

Query:
{{query}}

Candidates:
{{documents}}

JSON:`;

function renderPrompt(template: string, query: string, formatted: string): string {
  return template
    .replaceAll('{{query}}', query)
    .replaceAll('{{documents}}', formatted);
}

function parseRanking(text: string): Array<{ index: number; score: number }> {
  // Extract JSON array, even if the model wraps with prose.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as Array<{ index?: unknown; score?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const idx = Number(item.index);
        const sc = Number(item.score);
        if (!Number.isFinite(idx) || !Number.isFinite(sc)) return null;
        return { index: idx, score: Math.max(0, Math.min(1, sc)) };
      })
      .filter((v): v is { index: number; score: number } => v !== null);
  } catch {
    return [];
  }
}

export const llmListwiseStrategy: RerankerStrategyImpl = {
  async run(ctx, query, documents, _topN) {
    if (!ctx.model) {
      throw new Error('llm-listwise strategy requires a model with category=llm.');
    }
    if (ctx.model.category !== 'llm') {
      throw new Error(
        `Model "${ctx.model.key}" has category "${ctx.model.category}". The llm-listwise strategy requires a model with category "llm".`,
      );
    }
    const cfg = ctx.reranker.config ?? {};
    const template = cfg.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
    const temperature = cfg.temperature ?? 0;

    const formatted = documents
      .map((d, i) => `[${i}] ${d.content.slice(0, 800)}`)
      .join('\n\n');
    const prompt = renderPrompt(template, query, formatted);

    try {
      const { response } = await handleChatCompletion({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        modelKey: ctx.model.key,
        projectId: ctx.projectId ?? '',
        body: {
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: 1024,
        },
      });
      const text =
        (response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content
        ?? '';
      const ranking = parseRanking(text);

      // Translate local indices (0..N-1 in the prompt) back to caller indices.
      const result = ranking
        .filter((r) => r.index >= 0 && r.index < documents.length)
        .map((r) => ({
          index: documents[r.index].index,
          score: r.score,
        }));

      // Fill any missing documents with score 0 so callers can still sort fully.
      const seen = new Set(result.map((r) => r.index));
      for (const doc of documents) {
        if (!seen.has(doc.index)) {
          result.push({ index: doc.index, score: 0 });
        }
      }
      return result;
    } catch (err) {
      logger.error('llm-listwise scoring failed', {
        error: err instanceof Error ? err.message : err,
      });
      throw err;
    }
  },
};
