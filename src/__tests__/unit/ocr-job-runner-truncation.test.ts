/**
 * Unit tests — OCR item runner, summary / structured steps and the output limit.
 * Covers the explicit `max_tokens` the two LLM steps are sent with (the model maximum, never above the non-streaming
 * default cap, left to the model's own setting when unknown or already as large), and what a reply cut off at the
 * limit does to the item: it still succeeds, `result.truncated` names the step, a cut-off structured reply is kept raw
 * and never stored as a parsed result. DB + inference mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/ocrJobs/ocrJobWebhook', () => ({
  sendOcrJobWebhook: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleOcrRequest: vi.fn(),
  handleChatCompletion: vi.fn(),
}));
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: h.getModelByKey,
}));
vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn().mockReturnValue({ totalCost: 0, currency: 'USD' }),
}));
vi.mock('@/lib/services/files/fileService', () => ({
  downloadFile: vi.fn(),
}));

const db = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  findOcrJobItemById: vi.fn(),
  findOcrJobById: vi.fn(),
  updateOcrJobItem: vi.fn(),
  incrementOcrJobAggregates: vi.fn(),
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

import { processOcrItem } from '@/lib/services/ocrJobs/ocrJobRunner';
import { handleChatCompletion, handleOcrRequest } from '@/lib/services/models/inferenceService';
import { NON_STREAM_DEFAULT_CAP } from '@/lib/services/models/outputLimits';
import { UpstreamFinishError } from '@/lib/services/models/openaiErrors';

const handleChat = handleChatCompletion as unknown as ReturnType<typeof vi.fn>;
const handleOcr = handleOcrRequest as unknown as ReturnType<typeof vi.fn>;

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'user-1' };
const SCHEMA = { type: 'object', properties: { name: { type: 'string' } } };

function makeItem() {
  return {
    _id: 'item-1',
    tenantId: 'tenant-1',
    jobId: 'job-1',
    index: 0,
    status: 'pending',
    source: { kind: 'inline', data: Buffer.from('file-bytes').toString('base64'), fileName: 'a.pdf' },
    fileName: 'a.pdf',
  };
}

function makeJob(outputs: string[]) {
  return {
    _id: 'job-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    status: 'active',
    bucketKey: 'bucket',
    ocrModelKey: 'ocr-model',
    llmModelKey: 'llm-model',
    structuredSchema: SCHEMA,
    outputs,
    itemsTotal: 2,
    itemsProcessed: 0,
    itemsFailed: 0,
    createdBy: 'user-1',
  };
}

function llmModel(modelId: string, settings: Record<string, unknown> = {}, metadata?: Record<string, unknown>) {
  return { key: 'llm-model', modelId, settings, pricing: undefined, ...(metadata ? { metadata } : {}) };
}

/** One chat reply of the (mocked) LLM step. */
function chatReply(content: string, finishReason?: string) {
  return {
    response: { choices: [{ ...(finishReason ? { finish_reason: finishReason } : {}), message: { content } }] },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

/** The body the n-th LLM step was called with. */
function bodyOfCall(n: number): Record<string, unknown> {
  return handleChat.mock.calls[n][0].body;
}

/** The result the item succeeded with. */
function storedResult(): Record<string, unknown> {
  const call = db.updateOcrJobItem.mock.calls.find((c) => c[1].status === 'succeeded');
  return call?.[1].result;
}

async function run(outputs: string[]) {
  db.findOcrJobItemById.mockResolvedValue(makeItem());
  db.findOcrJobById.mockResolvedValue(makeJob(outputs));
  await processOcrItem(CTX, 'item-1');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getModelByKey.mockResolvedValue(llmModel('gpt-4o'));
  handleOcr.mockResolvedValue({
    response: { text: 'extracted text', usage: { inputTokens: 10, outputTokens: 0, pages: 1 } },
    model: { pricing: undefined },
  });
  handleChat.mockResolvedValue(chatReply('{"name":"Acme"}', 'stop'));
  db.updateOcrJobItem.mockImplementation(async (id: string, data: Record<string, unknown>) => ({
    ...makeItem(),
    ...data,
    _id: id,
  }));
  db.incrementOcrJobAggregates.mockResolvedValue({ ...makeJob(['summary']), itemsProcessed: 1, itemsTotal: 2 });
});

describe('processOcrItem — output limit of the summary / structured steps', () => {
  it('asks a model with a known maximum for it, up to the non-streaming default cap', async () => {
    h.getModelByKey.mockResolvedValue(llmModel('claude-sonnet-5-5')); // 128000 in the built-in table
    await run(['summary', 'structured']);

    expect(handleChat).toHaveBeenCalledTimes(2);
    expect(bodyOfCall(0).max_tokens).toBe(NON_STREAM_DEFAULT_CAP);
    expect(bodyOfCall(1).max_tokens).toBe(NON_STREAM_DEFAULT_CAP);
    // The structured step keeps its schema.
    expect(bodyOfCall(1).response_format).toMatchObject({ type: 'json_schema' });
  });

  it('a declared maximum below the cap is the limit', async () => {
    h.getModelByKey.mockResolvedValue(llmModel('some-model', {}, { capabilities: { maxOutputTokens: 8000 } }));
    await run(['summary']);
    expect(bodyOfCall(0).max_tokens).toBe(8000);
  });

  it('sends nothing for a model whose maximum is unknown: its own setting applies', async () => {
    await run(['summary', 'structured']);
    expect(bodyOfCall(0)).not.toHaveProperty('max_tokens');
    expect(bodyOfCall(1)).not.toHaveProperty('max_tokens');
  });

  it('leaves a limit the operator configured alone when it is already as large', async () => {
    h.getModelByKey.mockResolvedValue(llmModel('claude-sonnet-5-5', { maxTokens: 30000 }));
    await run(['summary']);
    expect(bodyOfCall(0)).not.toHaveProperty('max_tokens');
  });

  it('raises a configured limit that is smaller', async () => {
    h.getModelByKey.mockResolvedValue(llmModel('claude-sonnet-5-5', { maxTokens: 4096 }));
    await run(['summary']);
    expect(bodyOfCall(0).max_tokens).toBe(NON_STREAM_DEFAULT_CAP);
  });
});

describe('processOcrItem — a reply cut off at the output limit', () => {
  it('keeps a cut-off summary and names the step', async () => {
    handleChat.mockResolvedValue(chatReply('The document describes', 'length'));
    await run(['summary']);

    const result = storedResult();
    expect(result.summary).toBe('The document describes');
    expect(result.truncated).toEqual(['summary']);
    expect(db.updateOcrJobItem).toHaveBeenCalledWith('item-1', expect.objectContaining({ status: 'succeeded' }));
  });

  it('keeps a cut-off structured reply raw: it is never stored as a parsed result', async () => {
    handleChat.mockResolvedValue(chatReply('{"name": "Ac', 'length'));
    await run(['structured']);

    const result = storedResult();
    expect(result.structured).toEqual({ _raw: '{"name": "Ac', _truncated: true });
    expect(result.structured).not.toHaveProperty('_parseError');
    expect(result.truncated).toEqual(['structured']);
  });

  it('does not parse a cut-off reply even when what was written happens to be valid JSON', async () => {
    handleChat.mockResolvedValue(chatReply('{"name":"Acme"}', 'length'));
    await run(['structured']);

    expect(storedResult().structured).toEqual({ _raw: '{"name":"Acme"}', _truncated: true });
  });

  it('lists every step that was cut off, in order', async () => {
    handleChat
      .mockResolvedValueOnce(chatReply('A summary that', 'length'))
      .mockResolvedValueOnce(chatReply('{"na', 'max_tokens'));
    await run(['summary', 'structured']);

    expect(storedResult().truncated).toEqual(['summary', 'structured']);
  });

  it('marks only the step that was cut off', async () => {
    handleChat
      .mockResolvedValueOnce(chatReply('A whole summary.', 'stop'))
      .mockResolvedValueOnce(chatReply('{"name": "Ac', 'length'));
    await run(['summary', 'structured']);

    const result = storedResult();
    expect(result.summary).toBe('A whole summary.');
    expect(result.truncated).toEqual(['structured']);
  });

  it('a finished reply is parsed as before and carries no truncated key', async () => {
    handleChat.mockResolvedValue(chatReply('```json\n{"name":"Acme"}\n```', 'stop'));
    await run(['summary', 'structured']);

    const result = storedResult();
    expect(result.structured).toEqual({ name: 'Acme' });
    expect(result).not.toHaveProperty('truncated');
  });

  it('a finished reply that is not JSON is still a parse error, not a truncation', async () => {
    handleChat.mockResolvedValue(chatReply('no json here', 'stop'));
    await run(['structured']);

    expect(storedResult().structured).toEqual({ _raw: 'no json here', _parseError: true });
    expect(storedResult()).not.toHaveProperty('truncated');
  });
});

describe('processOcrItem — a VLM page cut off at the output limit', () => {
  const ocrReply = (pages: Array<{ truncated?: boolean }>) => ({
    response: { text: 'extracted text', pages, usage: { inputTokens: 10, outputTokens: 0, pages: pages.length } },
    model: { pricing: undefined },
  });

  it("names 'ocr' when a page was truncated, ahead of the later steps", async () => {
    handleOcr.mockResolvedValue(ocrReply([{ truncated: false }, { truncated: true }]));
    handleChat.mockResolvedValue(chatReply('A summary that', 'length'));
    await run(['full_text', 'summary']);

    expect(storedResult().truncated).toEqual(['ocr', 'summary']);
  });

  it("names 'ocr' even when no LLM step runs", async () => {
    handleOcr.mockResolvedValue(ocrReply([{ truncated: true }]));
    await run(['full_text']);

    expect(storedResult().truncated).toEqual(['ocr']);
  });

  it('carries no truncated key when no page was cut off', async () => {
    handleOcr.mockResolvedValue(ocrReply([{}, { truncated: false }]));
    await run(['full_text']);

    expect(storedResult()).not.toHaveProperty('truncated');
  });
});

describe('processOcrItem — an error finish of the LLM step', () => {
  it('books the usage the UpstreamFinishError carries on the failed item', async () => {
    handleChat.mockRejectedValue(
      new UpstreamFinishError('MALFORMED_FUNCTION_CALL', {
        usage: { inputTokens: 40, outputTokens: 7, totalTokens: 47 },
        usageBooked: true,
      }),
    );
    await run(['summary']);

    const failed = db.updateOcrJobItem.mock.calls.find((c) => c[1].status === 'failed');
    expect(failed?.[1].usage).toMatchObject({ inputTokens: 50, outputTokens: 7, totalTokens: 57 });
  });
});
