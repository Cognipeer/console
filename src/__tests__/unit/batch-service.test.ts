import { describe, expect, it, vi } from 'vitest';

// batchService transitively imports the file service (input/output JSONL in
// buckets); stub it so the pure helpers under test load without the
// markdown-conversion ESM chain.
vi.mock('@/lib/services/files/fileService', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
}));

import type { IBatchJobItem } from '@/lib/database';
import {
  BatchValidationError,
  buildResultsJsonl,
  isSupportedBatchEndpoint,
  parseBatchJsonl,
  toOutputLine,
} from '@/lib/services/batch/batchService';

describe('isSupportedBatchEndpoint', () => {
  it('accepts the two supported endpoints', () => {
    expect(isSupportedBatchEndpoint('/v1/chat/completions')).toBe(true);
    expect(isSupportedBatchEndpoint('/v1/embeddings')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isSupportedBatchEndpoint('/v1/responses')).toBe(false);
    expect(isSupportedBatchEndpoint(undefined)).toBe(false);
    expect(isSupportedBatchEndpoint(42)).toBe(false);
  });
});

describe('parseBatchJsonl', () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it('parses OpenAI batch input lines', () => {
    const content = [
      line({ custom_id: 'a', method: 'POST', url: '/v1/chat/completions', body: { model: 'm', messages: [] } }),
      line({ custom_id: 'b', body: { model: 'm', messages: [] } }),
    ].join('\n');
    const parsed = parseBatchJsonl(content, '/v1/chat/completions');
    expect(parsed).toHaveLength(2);
    expect(parsed[0].customId).toBe('a');
    expect(parsed[1].customId).toBe('b');
    expect(parsed[0].body.model).toBe('m');
  });

  it('skips blank lines and tolerates CRLF', () => {
    const content = `${line({ body: { model: 'm' } })}\r\n\r\n${line({ body: { model: 'n' } })}\n`;
    expect(parseBatchJsonl(content, '/v1/embeddings')).toHaveLength(2);
  });

  it('rejects invalid JSON with the line number', () => {
    const content = `${line({ body: {} })}\nnot-json`;
    expect(() => parseBatchJsonl(content, '/v1/embeddings')).toThrowError(/line 2/);
  });

  it('rejects a url that does not match the batch endpoint', () => {
    const content = line({ url: '/v1/embeddings', body: { model: 'm' } });
    expect(() => parseBatchJsonl(content, '/v1/chat/completions')).toThrowError(BatchValidationError);
  });

  it('rejects non-POST methods', () => {
    const content = line({ method: 'GET', body: { model: 'm' } });
    expect(() => parseBatchJsonl(content, '/v1/chat/completions')).toThrowError(/POST/);
  });
});

describe('toOutputLine / buildResultsJsonl', () => {
  const baseItem: IBatchJobItem = {
    _id: 'item-1',
    tenantId: 't1',
    batchId: 'b1',
    index: 0,
    customId: 'q1',
    requestBody: { model: 'm' },
    status: 'succeeded',
    responseStatusCode: 200,
    responseBody: { id: 'chatcmpl-1' },
  };

  it('shapes a succeeded item like an OpenAI output line', () => {
    const out = toOutputLine(baseItem);
    expect(out).toMatchObject({
      id: 'batch_req_item-1',
      custom_id: 'q1',
      response: { status_code: 200, body: { id: 'chatcmpl-1' } },
      error: null,
    });
  });

  it('shapes a failed item with the error envelope and no body', () => {
    const out = toOutputLine({
      ...baseItem,
      status: 'failed',
      responseStatusCode: 429,
      responseBody: undefined,
      errorMessage: 'Budget exceeded',
    });
    expect(out).toMatchObject({
      response: { status_code: 429, body: null },
      error: { code: 'failed', message: 'Budget exceeded' },
    });
  });

  it('excludes pending/running/cancelled items from the JSONL', () => {
    const jsonl = buildResultsJsonl([
      baseItem,
      { ...baseItem, _id: 'item-2', status: 'pending' },
      { ...baseItem, _id: 'item-3', status: 'cancelled' },
      { ...baseItem, _id: 'item-4', status: 'failed', errorMessage: 'boom' },
    ]);
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('batch_req_item-1');
    expect(JSON.parse(lines[1]).id).toBe('batch_req_item-4');
  });
});
