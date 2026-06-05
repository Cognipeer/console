/**
 * Unit tests — RAG Answer Service (`answerWithRag`) and prompt builders.
 * Covers the stuff path with citations, multi-query expansion + merge,
 * per-document diversity, and the stuff→map_reduce auto-escalation. The vector
 * retrieval, model runtime, and database are all mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RagQueryMatch } from '@/lib/services/rag/types';

const queryRag = vi.fn();
vi.mock('@/lib/services/rag/ragService', () => ({
  queryRag: (...args: unknown[]) => queryRag(...args),
}));

const handleChatCompletion = vi.fn();
const handleEmbeddingRequest = vi.fn();
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: (...args: unknown[]) => handleChatCompletion(...args),
  handleEmbeddingRequest: (...args: unknown[]) => handleEmbeddingRequest(...args),
}));

const db = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  findRagModuleByKey: vi.fn(),
};
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

import { answerWithRag } from '@/lib/services/rag/ragAnswerService';
import {
  buildStuffMessages,
  numberPassages,
  parseQueryVariants,
} from '@/lib/services/rag/ragPrompt';

function match(over: Partial<RagQueryMatch>): RagQueryMatch {
  return {
    id: over.id ?? 'c1',
    score: over.score ?? 0.9,
    content: over.content ?? 'some content',
    documentId: over.documentId ?? 'doc1',
    fileName: over.fileName ?? 'file.pdf',
    chunkIndex: over.chunkIndex ?? 0,
    ...over,
  };
}

function chatReply(content: string) {
  return { response: { choices: [{ message: { content } }] }, usage: { total_tokens: 10 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.findRagModuleByKey.mockResolvedValue({
    key: 'kb',
    embeddingModelKey: 'embed-1',
    vectorProviderKey: 'vp',
    vectorIndexKey: 'idx',
  });
});

describe('answerWithRag — stuff strategy', () => {
  it('retrieves chunks, generates an answer, and flags cited passages', async () => {
    queryRag.mockResolvedValue({
      matches: [match({ id: 'c1' }), match({ id: 'c2', documentId: 'doc2', fileName: 'b.pdf' })],
    });
    handleChatCompletion.mockResolvedValue(chatReply('The answer is X [1].'));

    const result = await answerWithRag('tenant', 'tid', 'proj', {
      ragModuleKey: 'kb',
      question: 'What is X?',
      answerModelKey: 'gpt',
      topK: 2,
    });

    expect(queryRag).toHaveBeenCalledTimes(1);
    expect(handleChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('The answer is X [1].');
    expect(result.strategy).toBe('stuff');
    expect(result.usedChunks).toHaveLength(2);
    expect(result.citations[0]).toMatchObject({ ref: 1, cited: true });
    expect(result.citations[1]).toMatchObject({ ref: 2, cited: false });
  });

  it('returns a not-found answer without calling the model when no chunks match', async () => {
    queryRag.mockResolvedValue({ matches: [] });

    const result = await answerWithRag('tenant', 'tid', undefined, {
      ragModuleKey: 'kb',
      question: 'unknown?',
      answerModelKey: 'gpt',
    });

    expect(handleChatCompletion).not.toHaveBeenCalled();
    expect(result.usedChunks).toHaveLength(0);
    expect(result.answer).toMatch(/could not find/i);
  });
});

describe('answerWithRag — multi-query', () => {
  it('expands the question and merges results across sub-queries', async () => {
    // First chat call = variant expansion; second = the final answer.
    handleChatCompletion
      .mockResolvedValueOnce(chatReply('What is X exactly?\nDefine X'))
      .mockResolvedValueOnce(chatReply('Final answer [1].'));
    queryRag
      .mockResolvedValueOnce({ matches: [match({ id: 'c1', score: 0.8 })] })
      .mockResolvedValueOnce({ matches: [match({ id: 'c1', score: 0.95 }), match({ id: 'c2' })] })
      .mockResolvedValueOnce({ matches: [match({ id: 'c3' })] });

    const result = await answerWithRag('tenant', 'tid', 'proj', {
      ragModuleKey: 'kb',
      question: 'What is X?',
      answerModelKey: 'gpt',
      topK: 5,
      retrieval: { multiQuery: { variants: 2 } },
    });

    expect(result.retrieval.queries).toEqual(['What is X?', 'What is X exactly?', 'Define X']);
    expect(queryRag).toHaveBeenCalledTimes(3);
    // c1 deduped, best score kept; total unique = c1, c2, c3
    expect(result.usedChunks.map((m) => m.id).sort()).toEqual(['c1', 'c2', 'c3']);
    const c1 = result.usedChunks.find((m) => m.id === 'c1');
    expect(c1?.score).toBe(0.95);
  });
});

describe('answerWithRag — diversity', () => {
  it('caps chunks per document with perDocumentLimit', async () => {
    queryRag.mockResolvedValue({
      matches: [
        match({ id: 'c1', documentId: 'doc1', score: 0.9 }),
        match({ id: 'c2', documentId: 'doc1', score: 0.8 }),
        match({ id: 'c3', documentId: 'doc1', score: 0.7 }),
        match({ id: 'c4', documentId: 'doc2', score: 0.6 }),
      ],
    });
    handleChatCompletion.mockResolvedValue(chatReply('answer'));

    const result = await answerWithRag('tenant', 'tid', 'proj', {
      ragModuleKey: 'kb',
      question: 'q',
      answerModelKey: 'gpt',
      topK: 5,
      retrieval: { diversity: { perDocumentLimit: 1 } },
    });

    expect(result.usedChunks.map((m) => m.id).sort()).toEqual(['c1', 'c4']);
  });
});

describe('answerWithRag — auto escalation', () => {
  it('escalates stuff to map_reduce when context exceeds maxContextChars', async () => {
    const big = 'x'.repeat(200);
    queryRag.mockResolvedValue({
      matches: [match({ id: 'c1', content: big }), match({ id: 'c2', content: big })],
    });
    // map calls + reduce call all return content
    handleChatCompletion.mockResolvedValue(chatReply('reduced answer [1]'));

    const result = await answerWithRag('tenant', 'tid', 'proj', {
      ragModuleKey: 'kb',
      question: 'q',
      answerModelKey: 'gpt',
      topK: 2,
      generation: { strategy: 'stuff', maxContextChars: 100, groupSize: 1 },
    });

    expect(result.strategy).toBe('map_reduce');
    // 2 map calls (groupSize 1) + 1 reduce call
    expect(handleChatCompletion).toHaveBeenCalledTimes(3);
  });
});

describe('ragPrompt helpers', () => {
  it('parseQueryVariants strips bullets/numbering and caps count', () => {
    const out = parseQueryVariants('1. first\n- second\n* third\nfourth', 3);
    expect(out).toEqual(['first', 'second', 'third']);
  });

  it('buildStuffMessages includes system grounding, history, and numbered context', () => {
    const passages = numberPassages([match({ id: 'c1', content: 'hello' })]);
    const messages = buildStuffMessages({
      question: 'Q?',
      passages,
      history: [{ role: 'user', content: 'earlier' }],
    });
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'earlier' });
    expect(messages[2].content).toContain('[1]');
    expect(messages[2].content).toContain('hello');
    expect(messages[2].content).toContain('Question: Q?');
  });
});
