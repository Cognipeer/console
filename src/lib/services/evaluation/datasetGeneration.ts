/**
 * Dataset generation — synthesize evaluation Q&A datasets from source content.
 *
 * Produces `IEvaluationDatasetItem`s (a user question + an `expected.reference`
 * gold answer) grounded in either an existing RAG module's ingested documents
 * or ad-hoc supplied text. The generated dataset can then be scored against any
 * target (model / agent / rag) via the normal evaluation suite flow.
 *
 * Additive: this module only reads RAG chunks and calls the inference service;
 * it does not modify the RAG or evaluation engines.
 */

import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IEvaluationDatasetItem, IModel } from '@/lib/database';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { computeOutputTokenLimit, modelMaxOutputTokens } from '@/lib/services/models/outputLimits';
import { hasExplicitThinking } from '@/lib/services/models/reasoning';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';

const logger = createLogger('eval-dataset-gen');

/* ── Public types ────────────────────────────────────────────────────── */

export type DatasetGenerationSource =
  | { type: 'rag'; ragModuleKey: string; maxChunks?: number }
  | { type: 'text'; text: string; chunkSize?: number };

export interface GenerateDatasetItemsParams {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  /** LLM used to write the questions and reference answers. */
  generationModelKey: string;
  source: DatasetGenerationSource;
  /** Target number of Q&A pairs. Default 10. */
  count?: number;
  /** Optional natural-language hint, e.g. "Turkish" or "English". */
  language?: string;
  /** Who asked for the dataset (recorded only: it does not widen what a knowledge base hands over). */
  createdBy?: string;
}

export interface GenerateDatasetItemsResult {
  items: IEvaluationDatasetItem[];
  usedBlocks: number;
}

/* ── Content gathering ───────────────────────────────────────────────── */

/** Evenly sample up to `max` items from a list (keeps spread, not just head). */
function sample<T>(items: T[], max: number): T[] {
  if (max <= 0 || items.length <= max) return items;
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

/** Split free text into reasonably sized blocks on paragraph boundaries. */
function splitText(text: string, chunkSize: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const blocks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current.length + p.length > chunkSize && current.length > 0) {
      blocks.push(current.trim());
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) blocks.push(current.trim());
  return blocks.length > 0 ? blocks : [text.trim()].filter(Boolean);
}

async function gatherBlocks(params: GenerateDatasetItemsParams): Promise<string[]> {
  const { source } = params;
  if (source.type === 'text') {
    return splitText(source.text, source.chunkSize ?? 1500);
  }
  // RAG module: collect chunk contents across its indexed documents.
  const db = await getDatabase();
  await db.switchToTenant(params.tenantDbName);
  const ragModule = await db.findRagModuleByKey(source.ragModuleKey, params.projectId);
  if (!ragModule) throw new Error(`RAG module "${source.ragModuleKey}" not found`);

  let documents = await db.listRagDocuments(source.ragModuleKey, {
    projectId: params.projectId,
  });
  if (ragModule.access?.enabled === true) {
    // A knowledge base with access control: a dataset is read by everyone who may read the project's
    // evaluations, so only the documents open to everyone are used, whoever asked for it.
    // Imported here so the access engine loads only when a knowledge base needs it.
    const { anonymousKbCaller, resolveRagAccess } = await import('@/lib/services/rag/access');
    const scope = await resolveRagAccess({
      tenantDbName: params.tenantDbName,
      tenantId: params.tenantId,
      module: ragModule,
      caller: anonymousKbCaller('public'),
    });
    if (scope.enforced) documents = documents.filter((doc) => scope.canReadDocument(doc));
  }
  const blocks: string[] = [];
  for (const doc of documents) {
    const docId = String(doc._id);
    if (!docId) continue;
    const chunks = await db.findRagChunksByDocumentId(docId);
    for (const c of chunks) {
      const content = (c.content ?? '').trim();
      if (content) blocks.push(content);
    }
  }
  if (blocks.length === 0) {
    throw new Error(
      `RAG module "${source.ragModuleKey}" has no indexed content to generate questions from`,
    );
  }
  return sample(blocks, source.maxChunks ?? 40);
}

/* ── Generation ──────────────────────────────────────────────────────── */

interface ChatLikeResponse {
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
}

function extractAssistantText(response: unknown): string {
  const content = (response as ChatLikeResponse | null | undefined)?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

/** Whether the reply was cut off at the output limit (its finish reason says so). */
function wasCutOff(response: unknown): boolean {
  return isTruncatedFinishReason(
    normalizeFinishReason((response as ChatLikeResponse | null | undefined)?.choices?.[0]?.finish_reason),
  );
}

/**
 * Output budget of ONE generation call. The reply is a JSON array of question/answer pairs, so it needs room in
 * proportion to the pairs asked for - and a reply cut off at the limit is unparseable JSON (the block's pairs are
 * all lost), not a shorter list. About 600 tokens a pair (a question and a reference answer, JSON syntax included,
 * in any language), with a floor of 2048 for the small asks and for a model that spends part of the budget thinking.
 */
const TOKENS_PER_PAIR = 600;
const MIN_BLOCK_OUTPUT_TOKENS = 2048;

function positiveNumber(...values: unknown[]): number | undefined {
  return values.find((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

/**
 * The `max_tokens` a generation call is sent with, or undefined to leave the limit to the model's own setting.
 *
 * Sent ONLY to raise a limit the operator configured on the model ("Default max tokens") that is BELOW the need -
 * exactly what loses the pairs. With no configured limit nothing is sent: the driver default applies (for Anthropic
 * the model maximum capped at 21333 for a non-streaming call), and an explicit value would be the caller's hard
 * cap, which a thinking model (Claude 5.x thinks by default) would share with its answer. A configured limit that
 * already covers the need is left alone too. Never above the model maximum (when it is known).
 */
export function blockOutputLimit(perBlock: number, model: IModel | undefined): number | undefined {
  const needed = Math.max(MIN_BLOCK_OUTPUT_TOKENS, perBlock * TOKENS_PER_PAIR);
  const settings = (model?.settings ?? {}) as Record<string, unknown>;
  const configured = positiveNumber(settings.maxCompletionTokens, settings.maxTokens);
  if (configured === undefined || configured >= needed) return undefined;
  const max = modelMaxOutputTokens(model);
  const raised = max !== undefined ? Math.min(needed, max) : needed;
  // A value sent is the caller's hard cap, with no thinking headroom on top: it must beat the limit the call would
  // otherwise get (the configured one, raised for thinking where that applies), or it would lower it.
  const effective = computeOutputTokenLimit({
    driver: model?.providerDriver,
    modelId: model?.modelId,
    modelMax: max,
    configured,
    stream: false,
    reasoning: settings.reasoning,
    explicitThinking: hasExplicitThinking(settings.extraBody),
  });
  return raised > (effective ?? configured) ? raised : undefined;
}

/** The generation model's record, best effort: a failed lookup only costs the limit tuning above. */
async function findGenerationModel(params: GenerateDatasetItemsParams): Promise<IModel | undefined> {
  try {
    const db = await getDatabase();
    await db.switchToTenant(params.tenantDbName);
    return (await db.findModelByKey(params.generationModelKey, params.projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Tolerantly parse a JSON array out of a model reply (handles code fences). */
function parseQaPairs(text: string): Array<{ question: string; answer: string }> {
  let raw = stripInlineReasoning(text).trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) raw = raw.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const pairs: Array<{ question: string; answer: string }> = [];
  for (const entry of parsed) {
    const q = (entry as Record<string, unknown>)?.question;
    const a = (entry as Record<string, unknown>)?.answer;
    if (typeof q === 'string' && q.trim() && typeof a === 'string' && a.trim()) {
      pairs.push({ question: q.trim(), answer: a.trim() });
    }
  }
  return pairs;
}

function buildGenerationMessages(block: string, perBlock: number, language?: string) {
  const langLine = language ? `Write the questions and answers in ${language}.` : '';
  return [
    {
      role: 'system',
      content: [
        'You generate question-answer pairs for evaluating a retrieval system.',
        'Given a source passage, write factual questions that can be answered using ONLY that passage,',
        'along with a concise, correct reference answer for each.',
        langLine,
        'Return ONLY a JSON array of objects: [{"question": "...", "answer": "..."}]. No prose, no code fences.',
      ].filter(Boolean).join(' '),
    },
    {
      role: 'user',
      content: `Generate up to ${perBlock} question-answer pairs from this passage:\n\n${block}`,
    },
  ];
}

export async function generateDatasetItems(
  params: GenerateDatasetItemsParams,
): Promise<GenerateDatasetItemsResult> {
  await assertServiceEnabled({ tenantDbName: params.tenantDbName, tenantId: params.tenantId }, 'evaluations');
  const count = params.count ?? 10;
  const blocks = await gatherBlocks(params);

  // Use enough blocks to reach the target, asking for a few questions per block.
  const perBlock = Math.max(1, Math.min(5, Math.ceil(count / Math.max(1, Math.min(blocks.length, count)))));
  const selected = sample(blocks, Math.min(blocks.length, count));

  const items: IEvaluationDatasetItem[] = [];
  let usedBlocks = 0;
  const maxTokens = blockOutputLimit(perBlock, await findGenerationModel(params));
  // Why blocks yielded nothing, in the order met: when NO block yields anything the first one is the answer to
  // "why", and the job's error is the only place the operator sees it.
  const failures = new Set<string>();

  for (const block of selected) {
    if (items.length >= count) break;
    usedBlocks += 1;
    let text: string;
    let cutOff = false;
    try {
      const result = (await handleChatCompletion({
        tenantDbName: params.tenantDbName,
        tenantId: params.tenantId,
        modelKey: params.generationModelKey,
        projectId: params.projectId ?? '',
        // Its own route: generation is not production traffic (the gateway keeps such routes out of the
        // semantic cache - a cached reply would hand every run the same questions).
        route: 'evaluation.dataset',
        body: {
          messages: buildGenerationMessages(block, perBlock, params.language),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        },
      })) as { response?: unknown };
      text = extractAssistantText(result.response);
      cutOff = wasCutOff(result.response);
    } catch (err) {
      logger.warn('Generation call failed for a block, skipping', { error: err });
      failures.add(err instanceof Error ? err.message : String(err));
      continue;
    }
    const pairs = parseQaPairs(text);
    if (pairs.length === 0 && cutOff) {
      logger.warn('Generation reply was cut off at the output limit, skipping the block', { maxTokens });
      failures.add(
        maxTokens !== undefined
          ? `The model's reply was cut off at the output limit (${maxTokens} tokens). `
            + `Raise the model's "Default max tokens" setting, or use a model with a larger output limit.`
          : `The model's reply was cut off at the model's own output limit (a thinking model spends part of it `
            + `thinking). Lower the model's reasoning effort or use a model with a larger output limit.`,
      );
    }
    for (const pair of pairs) {
      if (items.length >= count) break;
      items.push({
        id: `gen-${items.length + 1}`,
        input: [{ role: 'user', content: pair.question }],
        expected: { reference: pair.answer },
        tags: ['generated'],
      });
    }
  }

  if (items.length === 0) {
    const reason = failures.values().next().value;
    throw new Error(
      reason
        ? `No question-answer pairs could be generated from the source content: ${reason}`
        : 'No question-answer pairs could be generated from the source content',
    );
  }
  return { items, usedBlocks };
}
