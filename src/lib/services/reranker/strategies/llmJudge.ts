/**
 * llm-judge strategy
 *
 * For each candidate document, send a scoring prompt to an LLM and parse a
 * numeric relevance score in [0, 1]. Scoring runs in parallel batches.
 */

import { createLogger } from '@/lib/core/logger';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import type { RerankerStrategyImpl } from './index';

const logger = createLogger('reranker:llm-judge');

const DEFAULT_PROMPT_TEMPLATE = `You are a relevance scorer. Read the user query and the candidate document.
Reply with a single floating-point number between 0 and 1 indicating how relevant the document is to the query (1 = highly relevant, 0 = irrelevant). Reply with the number only, no explanation.

Query:
{{query}}

Document:
{{document}}

Score:`;

function renderPrompt(template: string, query: string, document: string): string {
  return template
    .replaceAll('{{query}}', query)
    .replaceAll('{{document}}', document);
}

function parseScore(text: string): number {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) return 0;
  if (value > 1 && value <= 10) return Math.max(0, Math.min(1, value / 10));
  return Math.max(0, Math.min(1, value));
}

export const llmJudgeStrategy: RerankerStrategyImpl = {
  async run(ctx, query, documents, _topN) {
    if (!ctx.model) {
      throw new Error('llm-judge strategy requires a model with category=llm.');
    }
    if (ctx.model.category !== 'llm') {
      throw new Error(
        `Model "${ctx.model.key}" has category "${ctx.model.category}". The llm-judge strategy requires a model with category "llm".`,
      );
    }
    const cfg = ctx.reranker.config ?? {};
    const template = cfg.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
    const batchSize = Math.max(1, cfg.batchSize ?? 4);
    const temperature = cfg.temperature ?? 0;

    const scores: Array<{ index: number; score: number }> = new Array(documents.length);

    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (doc) => {
          try {
            const prompt = renderPrompt(template, query, doc.content);
            const { response } = await handleChatCompletion({
              tenantDbName: ctx.tenantDbName,
              tenantId: ctx.tenantId,
              modelKey: ctx.model!.key,
              projectId: ctx.projectId ?? '',
              body: {
                messages: [{ role: 'user', content: prompt }],
                temperature,
                max_tokens: 8,
              },
            });
            const text =
              (response as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content
              ?? '';
            return { index: doc.index, score: parseScore(text) };
          } catch (err) {
            logger.warn('llm-judge scoring failed for one document', {
              error: err instanceof Error ? err.message : err,
              index: doc.index,
            });
            return { index: doc.index, score: 0 };
          }
        }),
      );
      for (let j = 0; j < results.length; j++) {
        scores[i + j] = results[j];
      }
    }
    return scores;
  },
};
