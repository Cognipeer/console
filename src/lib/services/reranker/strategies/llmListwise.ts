/**
 * llm-listwise strategy (RankGPT-style)
 *
 * Send the query and the entire list of candidates to an LLM and ask for a
 * JSON ranking. Cheaper than llm-judge for short lists, but quality degrades
 * with very long lists.
 */

import { createLogger } from '@/lib/core/logger';
import { sideCallReasoning, sideCallThinkingUncontrolled } from '@/lib/services/agents/agentReasoning';
import { getDynamicRoutingConfig } from '@/lib/services/models/dynamicRouting';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { AGENT_REASONING_OVERRIDE } from '@/lib/services/models/reasoning';
import type { RerankerStrategyImpl } from './index';
import { RerankerScoringError, isOutputLimitHit, scoringMaxTokens } from './llmJudge';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';

const logger = createLogger('reranker:llm-listwise');

/** The whole ranking is one JSON array: raise it in the reranker config (`maxTokens`) for a long list or a model that thinks. */
const DEFAULT_MAX_TOKENS = 1024;

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
  // Extract JSON array, even if the model wraps with prose. Leaked
  // `<reasoning>` markup goes first: a chain-of-thought often contains
  // bracketed text that would win the match.
  const match = stripInlineReasoning(text).match(/\[[\s\S]*\]/);
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
    const sideOptions = { dynamic: Boolean(getDynamicRoutingConfig(ctx.model)) };
    // The strategy's small default is only for a model whose thinking can be turned off; one stuck with its thinking
    // (Vertex Gemini, ...) runs on the model default unless the reranker config sets a limit itself.
    const maxTokens = scoringMaxTokens(cfg.maxTokens, 0) || (sideCallThinkingUncontrolled(ctx.model, sideOptions) ? undefined : DEFAULT_MAX_TOKENS);
    // The ranking shares the limit with the thinking: ask for the lowest thinking the model allows.
    const thinking = sideCallReasoning(ctx.model, sideOptions);

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
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          ...(thinking ? { [AGENT_REASONING_OVERRIDE]: thinking } : {}),
        },
      });
      const choice = (response as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
      })?.choices?.[0];
      const text = choice?.message?.content ?? '';
      const cutOff = choice?.finish_reason === 'length';
      const ranking = parseRanking(text);

      // Translate local indices (0..N-1 in the prompt) back to caller indices.
      const result = ranking
        .filter((r) => r.index >= 0 && r.index < documents.length)
        .map((r) => ({
          index: documents[r.index].index,
          score: r.score,
        }));

      // Documents the ranking left out get score 0 so callers can still sort fully, unless it left out
      // most of them: that is no ranking, and ordering on zeros is worse than not reranking.
      const seen = new Set(result.map((r) => r.index));
      const missing = documents.filter((doc) => !seen.has(doc.index));
      if (missing.length * 2 > documents.length) {
        throw new RerankerScoringError('llm-listwise', missing.length, documents.length, {
          reason: cutOff ? 'the ranking was cut off at the output limit' : 'the reply did not rank them',
          outputLimit: cutOff,
          maxTokens,
        });
      }
      if (cutOff) {
        logger.warn('llm-listwise ranking was cut off at the output limit', { maxTokens, missing: missing.length });
      }
      for (const doc of missing) {
        result.push({ index: doc.index, score: 0 });
      }
      return result;
    } catch (err) {
      logger.error('llm-listwise scoring failed', {
        error: err instanceof Error ? err.message : err,
      });
      // The model's own limit error names the request parameter; here the limit is the reranker config's.
      if (isOutputLimitHit(err)) {
        throw new RerankerScoringError('llm-listwise', documents.length, documents.length, {
          reason: 'the model stopped at its output limit before it answered',
          outputLimit: true,
          maxTokens,
        });
      }
      throw err;
    }
  },
};
