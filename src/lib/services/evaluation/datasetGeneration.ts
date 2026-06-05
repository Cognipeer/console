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

import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IEvaluationDatasetItem } from '@/lib/database';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';

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

  const documents = await db.listRagDocuments(source.ragModuleKey, {
    projectId: params.projectId,
  });
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
  choices?: Array<{ message?: { content?: unknown } }>;
}

function extractAssistantText(response: unknown): string {
  const content = (response as ChatLikeResponse | null | undefined)?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

/** Tolerantly parse a JSON array out of a model reply (handles code fences). */
function parseQaPairs(text: string): Array<{ question: string; answer: string }> {
  let raw = text.trim();
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
  const count = params.count ?? 10;
  const blocks = await gatherBlocks(params);

  // Use enough blocks to reach the target, asking for a few questions per block.
  const perBlock = Math.max(1, Math.min(5, Math.ceil(count / Math.max(1, Math.min(blocks.length, count)))));
  const selected = sample(blocks, Math.min(blocks.length, count));

  const items: IEvaluationDatasetItem[] = [];
  let usedBlocks = 0;

  for (const block of selected) {
    if (items.length >= count) break;
    usedBlocks += 1;
    let text: string;
    try {
      const result = (await handleChatCompletion({
        tenantDbName: params.tenantDbName,
        tenantId: params.tenantId,
        modelKey: params.generationModelKey,
        projectId: params.projectId ?? '',
        body: { messages: buildGenerationMessages(block, perBlock, params.language) },
      })) as { response?: unknown };
      text = extractAssistantText(result.response);
    } catch (err) {
      logger.warn('Generation call failed for a block, skipping', { error: err });
      continue;
    }
    for (const pair of parseQaPairs(text)) {
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
    throw new Error('No question-answer pairs could be generated from the source content');
  }
  return { items, usedBlocks };
}
