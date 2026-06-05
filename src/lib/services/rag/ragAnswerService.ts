/**
 * RAG Answer Service (Q&A with generation).
 *
 * Bridges retrieval (`queryRag`) and answer generation (`handleChatCompletion`)
 * into a grounded, citation-aware question-answering pipeline that works across
 * long single documents and large multi-document corpora.
 *
 * This module is purely additive — it wraps `queryRag` and the inference
 * service without modifying either. Retrieval quality strategies (multi-query
 * expansion, MMR / per-document diversity) and generation strategies (stuff /
 * map-reduce / refine) are all opt-in via the request config; the defaults give
 * a simple, fast "stuff" pipeline.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { handleChatCompletion, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { queryRag } from './ragService';
import type { RagQueryMatch } from './types';
import {
  DEFAULT_RAG_SYSTEM_PROMPT,
  buildMapMessages,
  buildMultiQueryMessages,
  buildReduceMessages,
  buildRefineMessages,
  buildStuffMessages,
  numberPassages,
  parseQueryVariants,
  type NumberedPassage,
  type RagChatMessage,
  type RagHistoryMessage,
} from './ragPrompt';

const logger = createLogger('rag-answer');

/* ── Public types ────────────────────────────────────────────────────── */

export type RagGenerationStrategy = 'stuff' | 'map_reduce' | 'refine';

export interface RagRetrievalOptions {
  /** Expand the question into alternative phrasings before searching. */
  multiQuery?: boolean | { variants?: number };
  /** Diversify results so a single document cannot dominate the context. */
  diversity?: {
    /** Use Maximal Marginal Relevance over candidate embeddings. */
    mmr?: boolean;
    /** MMR trade-off: 1 = pure relevance, 0 = pure diversity. Default 0.5. */
    lambda?: number;
    /** Hard cap on chunks kept from any single document. */
    perDocumentLimit?: number;
  };
  /** Pass-through metadata filter for the vector query. */
  filter?: Record<string, unknown>;
}

export interface RagGenerationOptions {
  strategy?: RagGenerationStrategy;
  temperature?: number;
  maxTokens?: number;
  /** Override the grounding system prompt. */
  systemPrompt?: string;
  /**
   * When strategy is "stuff" and the assembled context exceeds this many
   * characters, the pipeline auto-escalates to "map_reduce" so very long
   * contexts don't overflow the model. Default 16000. Set 0 to disable.
   */
  maxContextChars?: number;
  /** Passages per group for map_reduce / refine steps. Default 4. */
  groupSize?: number;
}

export interface RagAnswerRequest {
  ragModuleKey: string;
  question: string;
  answerModelKey: string;
  history?: RagHistoryMessage[];
  topK?: number;
  retrieval?: RagRetrievalOptions;
  generation?: RagGenerationOptions;
}

export interface RagCitation {
  ref: number;
  documentId?: string;
  fileName?: string;
  chunkIndex?: number;
  score: number;
  /** Whether the answer text actually referenced this passage ([n]). */
  cited: boolean;
}

export interface RagAnswerResult {
  answer: string;
  citations: RagCitation[];
  usedChunks: RagQueryMatch[];
  strategy: RagGenerationStrategy;
  retrieval: {
    queries: string[];
    candidateCount: number;
    finalCount: number;
  };
  latencyMs: number;
  usage?: unknown;
}

/* ── Internal model context ──────────────────────────────────────────── */

interface AnswerContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  modelKey: string;
}

interface ChatLikeResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** Pull assistant text out of an OpenAI-shaped chat completion response. */
function extractAssistantText(response: unknown): string {
  const content = (response as ChatLikeResponse | null | undefined)?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

async function invokeChat(
  ctx: AnswerContext,
  messages: RagChatMessage[],
  opts: { temperature?: number; maxTokens?: number },
): Promise<{ text: string; usage?: unknown }> {
  const body: Record<string, unknown> = { messages };
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
  const result = (await handleChatCompletion({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    modelKey: ctx.modelKey,
    projectId: ctx.projectId ?? '',
    body,
  })) as { response?: unknown; usage?: unknown };
  return { text: extractAssistantText(result.response), usage: result.usage };
}

/* ── Retrieval ───────────────────────────────────────────────────────── */

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Merge matches from several sub-queries, keeping the best score per chunk. */
function mergeMatches(groups: RagQueryMatch[][]): RagQueryMatch[] {
  const byId = new Map<string, RagQueryMatch>();
  for (const group of groups) {
    for (const m of group) {
      const existing = byId.get(m.id);
      if (!existing || m.score > existing.score) byId.set(m.id, m);
    }
  }
  return Array.from(byId.values()).sort((x, y) => y.score - x.score);
}

/** Cap how many chunks may come from any single document, preserving order. */
function applyPerDocumentLimit(matches: RagQueryMatch[], limit: number): RagQueryMatch[] {
  if (limit <= 0) return matches;
  const counts = new Map<string, number>();
  const out: RagQueryMatch[] = [];
  for (const m of matches) {
    const key = m.documentId ?? m.id;
    const n = counts.get(key) ?? 0;
    if (n >= limit) continue;
    counts.set(key, n + 1);
    out.push(m);
  }
  return out;
}

/**
 * Maximal Marginal Relevance selection over candidate embeddings. Embeds the
 * query and each candidate's content, then greedily picks items that are
 * relevant to the query yet dissimilar to already-picked items.
 */
async function applyMmr(
  ctx: AnswerContext,
  embeddingModelKey: string,
  query: string,
  candidates: RagQueryMatch[],
  topK: number,
  lambda: number,
): Promise<RagQueryMatch[]> {
  const withContent = candidates.filter((c) => (c.content ?? '').trim().length > 0);
  if (withContent.length <= topK) return withContent;

  const inputs = [query, ...withContent.map((c) => c.content as string)];
  let vectors: number[][];
  try {
    vectors = await embedTexts(ctx, embeddingModelKey, inputs);
  } catch (err) {
    logger.warn('MMR embedding failed, falling back to score order', { error: err });
    return withContent.slice(0, topK);
  }
  const queryVec = vectors[0];
  const candVecs = vectors.slice(1);

  const selected: number[] = [];
  const remaining = withContent.map((_, i) => i);
  const lam = Math.min(1, Math.max(0, lambda));

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (const idx of remaining) {
      const relevance = cosineSimilarity(queryVec, candVecs[idx]);
      let maxSimToSelected = 0;
      for (const s of selected) {
        const sim = cosineSimilarity(candVecs[idx], candVecs[s]);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const mmr = lam * relevance - (1 - lam) * maxSimToSelected;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = idx;
      }
    }
    if (bestIdx === -1) break;
    selected.push(bestIdx);
    remaining.splice(remaining.indexOf(bestIdx), 1);
  }
  return selected.map((i) => withContent[i]);
}

async function embedTexts(
  ctx: AnswerContext,
  embeddingModelKey: string,
  texts: string[],
): Promise<number[][]> {
  const result = await handleEmbeddingRequest({
    tenantDbName: ctx.tenantDbName,
    modelKey: embeddingModelKey,
    projectId: ctx.projectId ?? '',
    body: { input: texts },
  });
  const data = result.response?.data as Array<{ embedding?: number[] }> | undefined;
  if (!data || data.length === 0) throw new Error('Failed to generate embeddings');
  return data.map((d) => {
    if (!d.embedding) throw new Error('Missing embedding in response');
    return d.embedding;
  });
}

/* ── Generation strategies ───────────────────────────────────────────── */

function groupPassages(passages: NumberedPassage[], size: number): NumberedPassage[][] {
  const groups: NumberedPassage[][] = [];
  const n = Math.max(1, size);
  for (let i = 0; i < passages.length; i += n) groups.push(passages.slice(i, i + n));
  return groups;
}

function totalContextChars(passages: NumberedPassage[]): number {
  return passages.reduce((sum, p) => sum + (p.match.content?.length ?? 0), 0);
}

async function generateStuff(
  ctx: AnswerContext,
  question: string,
  passages: NumberedPassage[],
  history: RagHistoryMessage[],
  gen: RagGenerationOptions,
): Promise<{ text: string; usage?: unknown }> {
  const messages = buildStuffMessages({
    question,
    passages,
    history,
    systemPrompt: gen.systemPrompt,
  });
  return invokeChat(ctx, messages, { temperature: gen.temperature, maxTokens: gen.maxTokens });
}

async function generateMapReduce(
  ctx: AnswerContext,
  question: string,
  passages: NumberedPassage[],
  history: RagHistoryMessage[],
  gen: RagGenerationOptions,
): Promise<{ text: string; usage?: unknown }> {
  const groups = groupPassages(passages, gen.groupSize ?? 4);
  const mapped = await Promise.all(
    groups.map((group) =>
      invokeChat(ctx, buildMapMessages({ question, passages: group }), {
        temperature: gen.temperature,
      }),
    ),
  );
  const extracts = mapped
    .map((m) => m.text.trim())
    .filter((t) => t.length > 0 && t.toUpperCase() !== 'NONE');
  if (extracts.length === 0) {
    // Nothing relevant surfaced — fall back to stuffing what we have.
    return generateStuff(ctx, question, passages, history, gen);
  }
  const reduceMessages = buildReduceMessages({
    question,
    extracts,
    history,
    systemPrompt: gen.systemPrompt,
  });
  return invokeChat(ctx, reduceMessages, {
    temperature: gen.temperature,
    maxTokens: gen.maxTokens,
  });
}

async function generateRefine(
  ctx: AnswerContext,
  question: string,
  passages: NumberedPassage[],
  gen: RagGenerationOptions,
): Promise<{ text: string; usage?: unknown }> {
  const groups = groupPassages(passages, gen.groupSize ?? 4);
  let answer = '';
  let lastUsage: unknown;
  for (const group of groups) {
    const messages = buildRefineMessages({
      question,
      passages: group,
      previousAnswer: answer,
      systemPrompt: gen.systemPrompt,
    });
    const res = await invokeChat(ctx, messages, {
      temperature: gen.temperature,
      maxTokens: gen.maxTokens,
    });
    answer = res.text;
    lastUsage = res.usage;
  }
  return { text: answer, usage: lastUsage };
}

/* ── Citations ───────────────────────────────────────────────────────── */

function buildCitations(passages: NumberedPassage[], answer: string): RagCitation[] {
  const referenced = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    referenced.add(Number(m[1]));
  }
  return passages.map((p) => ({
    ref: p.ref,
    documentId: p.match.documentId,
    fileName: p.match.fileName,
    chunkIndex: p.match.chunkIndex,
    score: p.match.score,
    cited: referenced.has(p.ref),
  }));
}

/* ── Public entry point ──────────────────────────────────────────────── */

export async function answerWithRag(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: RagAnswerRequest,
): Promise<RagAnswerResult> {
  const startTime = Date.now();
  const topK = request.topK ?? 5;
  const retrieval = request.retrieval ?? {};
  const gen = request.generation ?? {};
  const history = request.history ?? [];

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) throw new Error(`RAG module "${request.ragModuleKey}" not found`);

  const ctx: AnswerContext = {
    tenantDbName,
    tenantId,
    projectId,
    modelKey: request.answerModelKey,
  };

  // 1. Build the query list (optionally expanded with alternative phrasings).
  const queries = [request.question];
  if (retrieval.multiQuery) {
    const variantCount =
      typeof retrieval.multiQuery === 'object' ? retrieval.multiQuery.variants ?? 3 : 3;
    try {
      const { text } = await invokeChat(
        ctx,
        buildMultiQueryMessages(request.question, variantCount),
        { temperature: 0.3 },
      );
      queries.push(...parseQueryVariants(text, variantCount));
    } catch (err) {
      logger.warn('Multi-query expansion failed, using original question only', { error: err });
    }
  }

  // 2. Retrieve. Oversample when we will post-filter for diversity.
  const wantsDiversity = Boolean(retrieval.diversity?.mmr || retrieval.diversity?.perDocumentLimit);
  const fetchTopK = wantsDiversity || queries.length > 1 ? Math.max(topK, topK * 3) : topK;
  const groups = await Promise.all(
    queries.map((q) =>
      queryRag(tenantDbName, tenantId, projectId, {
        ragModuleKey: request.ragModuleKey,
        query: q,
        topK: fetchTopK,
        filter: retrieval.filter,
      }).then((r) => r.matches),
    ),
  );
  let candidates = mergeMatches(groups);
  const candidateCount = candidates.length;

  // 3. Diversify down to topK.
  if (retrieval.diversity?.perDocumentLimit) {
    candidates = applyPerDocumentLimit(candidates, retrieval.diversity.perDocumentLimit);
  }
  let finalMatches: RagQueryMatch[];
  if (retrieval.diversity?.mmr) {
    finalMatches = await applyMmr(
      ctx,
      ragModule.embeddingModelKey,
      request.question,
      candidates,
      topK,
      retrieval.diversity.lambda ?? 0.5,
    );
  } else {
    finalMatches = candidates.slice(0, topK);
  }

  const passages = numberPassages(finalMatches);

  // 4. Generate. Auto-escalate "stuff" to map_reduce when context is huge.
  let strategy: RagGenerationStrategy = gen.strategy ?? 'stuff';
  const maxContextChars = gen.maxContextChars ?? 16000;
  if (strategy === 'stuff' && maxContextChars > 0 && totalContextChars(passages) > maxContextChars) {
    logger.info('Context exceeds maxContextChars, escalating stuff → map_reduce', {
      chars: totalContextChars(passages),
      maxContextChars,
    });
    strategy = 'map_reduce';
  }

  let generated: { text: string; usage?: unknown };
  if (passages.length === 0) {
    generated = { text: 'I could not find any relevant information in the available documents.' };
  } else if (strategy === 'map_reduce') {
    generated = await generateMapReduce(ctx, request.question, passages, history, gen);
  } else if (strategy === 'refine') {
    generated = await generateRefine(ctx, request.question, passages, gen);
  } else {
    generated = await generateStuff(ctx, request.question, passages, history, gen);
  }

  const citations = buildCitations(passages, generated.text);

  return {
    answer: generated.text,
    citations,
    usedChunks: finalMatches,
    strategy,
    retrieval: {
      queries,
      candidateCount,
      finalCount: finalMatches.length,
    },
    latencyMs: Date.now() - startTime,
    usage: generated.usage,
  };
}

export { DEFAULT_RAG_SYSTEM_PROMPT };
