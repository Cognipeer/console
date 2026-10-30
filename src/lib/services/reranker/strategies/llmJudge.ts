/**
 * llm-judge strategy
 *
 * For each candidate document, send a scoring prompt to an LLM and parse a
 * numeric relevance score in [0, 1]. Scoring runs in parallel batches.
 */

import { createLogger } from '@/lib/core/logger';
import { sideCallReasoning, sideCallThinkingUncontrolled } from '@/lib/services/agents/agentReasoning';
import { getDynamicRoutingConfig } from '@/lib/services/models/dynamicRouting';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { CONTEXT_WINDOW_EXCEEDED_REASON, OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { AGENT_REASONING_OVERRIDE } from '@/lib/services/models/reasoning';
import type { RerankerStrategyImpl } from './index';

const logger = createLogger('reranker:llm-judge');

/** One score is a single number: a small default, raised in the reranker config (`maxTokens`) for a model that thinks. */
const DEFAULT_MAX_TOKENS = 32;

const DEFAULT_PROMPT_TEMPLATE = `You are a relevance scorer. Read the user query and the candidate document.
Reply with a single floating-point number between 0 and 1 indicating how relevant the document is to the query (1 = highly relevant, 0 = irrelevant). Reply with the number only, no explanation.

Query:
{{query}}

Document:
{{document}}

Score:`;

/**
 * An LLM strategy could not score most of the documents. Thrown instead of returning placeholder
 * scores, so the caller falls back (RAG keeps the vector order) rather than ranking on zeros.
 */
export class RerankerScoringError extends Error {
  readonly strategy: string;
  /** Documents that got no score. */
  readonly failed: number;
  readonly total: number;
  /** The scoring calls stopped at the output limit (`maxTokens` of the reranker config). */
  readonly outputLimit: boolean;

  constructor(
    strategy: string,
    failed: number,
    total: number,
    detail: { reason?: string; outputLimit?: boolean; maxTokens?: number } = {},
  ) {
    const reason = detail.reason ? `: ${detail.reason}` : '';
    const hint = detail.outputLimit
      ? ` Raise "maxTokens" in the reranker config${detail.maxTokens ? ` (${detail.maxTokens} tokens now)` : ''} or use a model that does not reason by default.`
      : '';
    super(`${strategy} could not score ${failed} of ${total} documents${reason}.${hint}`);
    this.name = 'RerankerScoringError';
    this.strategy = strategy;
    this.failed = failed;
    this.total = total;
    this.outputLimit = detail.outputLimit === true;
  }
}

/** The model stopped at its OUTPUT limit before it answered (a full context window is another failure, left to its own message). */
export function isOutputLimitHit(error: unknown): boolean {
  return error instanceof OutputTokenLimitError && error.rawFinishReason !== CONTEXT_WINDOW_EXCEEDED_REASON;
}

/** The reranker config's `maxTokens` when it is a usable limit, else the strategy's default. */
export function scoringMaxTokens(configured: unknown, fallback: number): number {
  return typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
}

function renderPrompt(template: string, query: string, document: string): string {
  return template
    .replaceAll('{{query}}', query)
    .replaceAll('{{document}}', document);
}

/** The score in the reply, or undefined when it holds none. */
function parseScore(text: string): number | undefined {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) return undefined;
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
    const sideOptions = { dynamic: Boolean(getDynamicRoutingConfig(ctx.model)) };
    // The strategy's small default is only for a model whose thinking can be turned off; one stuck with its thinking
    // (Vertex Gemini, ...) runs on the model default unless the reranker config sets a limit itself.
    const maxTokens = scoringMaxTokens(cfg.maxTokens, 0) || (sideCallThinkingUncontrolled(ctx.model, sideOptions) ? undefined : DEFAULT_MAX_TOKENS);
    // The score shares the small limit with the thinking: ask for the lowest thinking the model allows.
    const thinking = sideCallReasoning(ctx.model, sideOptions);

    const scores: Array<{ index: number; score: number }> = new Array(documents.length);
    const failures: string[] = [];
    let outputLimit = false;

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
                ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
                ...(thinking ? { [AGENT_REASONING_OVERRIDE]: thinking } : {}),
              },
            });
            const choice = (response as {
              choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
            })?.choices?.[0];
            // A score cut off by the limit ("0." of "0.85") would read as 0: it is no score at all.
            if (choice?.finish_reason === 'length') {
              outputLimit = true;
              throw new Error('the score was cut off at the output limit');
            }
            const score = parseScore(choice?.message?.content ?? '');
            if (score === undefined) throw new Error('the reply held no score');
            return { index: doc.index, score };
          } catch (err) {
            const limitHit = isOutputLimitHit(err);
            if (limitHit) outputLimit = true;
            const reason = limitHit
              ? 'the model stopped at its output limit before it answered'
              : err instanceof Error ? err.message : String(err);
            failures.push(reason);
            logger.warn('llm-judge scoring failed for one document', {
              error: reason,
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

    // A few failures cost those documents their score; most of them failing is no ranking at all.
    if (failures.length * 2 > documents.length) {
      throw new RerankerScoringError('llm-judge', failures.length, documents.length, {
        reason: failures[0],
        outputLimit,
        maxTokens,
      });
    }
    return scores;
  },
};
