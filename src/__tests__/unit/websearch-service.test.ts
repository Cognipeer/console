/**
 * Unit tests — webSearchService run logging.
 * Every runWebSearch call must persist an IWebSearchRunLog (success or error)
 * keyed by the instance key so per-instance logs show up in the dashboard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createWebSearchRunLog, listWebSearchRunLogsDb } = vi.hoisted(() => ({
  createWebSearchRunLog: vi.fn(),
  listWebSearchRunLogsDb: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue({
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    createWebSearchRunLog,
    listWebSearchRunLogs: listWebSearchRunLogsDb,
  }),
}));

vi.mock('@/lib/core/asyncTask', () => ({
  // Run inline so assertions see the write synchronously.
  fireAndForget: vi.fn((_name: string, fn: () => Promise<void>) => fn()),
}));

vi.mock('@/lib/services/providers/providerService', () => ({
  listProviderConfigs: vi.fn(),
  loadProviderRuntimeData: vi.fn(),
}));

vi.mock('@/lib/services/webSearch/webSearchAdapter', () => ({
  callWebSearchProvider: vi.fn(),
}));

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
}));

import { runWebSearch, listWebSearchRunLogs } from '@/lib/services/webSearch/webSearchService';
import {
  listProviderConfigs,
  loadProviderRuntimeData,
} from '@/lib/services/providers/providerService';
import { callWebSearchProvider } from '@/lib/services/webSearch/webSearchAdapter';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';

const RECORD = {
  tenantId: 'tenant-1',
  key: 'brave-main',
  type: 'websearch',
  driver: 'brave-search',
  label: 'Brave',
  status: 'active',
  settings: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
    record: RECORD,
    credentials: { apiKey: 'k' },
  });
});

describe('runWebSearch logging', () => {
  it('writes a success log with result count and latency', async () => {
    (callWebSearchProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        { title: 'A', url: 'https://a', snippet: '', position: 1 },
        { title: 'B', url: 'https://b', snippet: '', position: 2 },
      ],
    });

    const result = await runWebSearch('tenant_acme', 'tenant-1', 'proj-1', {
      query: 'hello',
      providerKey: 'brave-main',
      source: 'dashboard',
    });

    expect(result.results).toHaveLength(2);
    await vi.waitFor(() => expect(createWebSearchRunLog).toHaveBeenCalledTimes(1));
    expect(createWebSearchRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        searchKey: 'brave-main',
        driver: 'brave-search',
        query: 'hello',
        resultCount: 2,
        status: 'success',
        source: 'dashboard',
      }),
    );
  });

  it('writes an error log and rethrows when the adapter fails', async () => {
    (callWebSearchProvider as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Brave search failed (429): quota'),
    );

    await expect(
      runWebSearch('tenant_acme', 'tenant-1', 'proj-1', {
        query: 'hello',
        providerKey: 'brave-main',
      }),
    ).rejects.toThrow(/429/);

    await vi.waitFor(() => expect(createWebSearchRunLog).toHaveBeenCalledTimes(1));
    expect(createWebSearchRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        searchKey: 'brave-main',
        resultCount: 0,
        status: 'error',
        errorMessage: expect.stringContaining('429'),
        source: 'api',
      }),
    );
  });

  it('rejects non-websearch provider records without logging', async () => {
    (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: { ...RECORD, type: 'model' },
      credentials: {},
    });
    await expect(
      runWebSearch('tenant_acme', 'tenant-1', undefined, {
        query: 'q',
        providerKey: 'openai-main',
      }),
    ).rejects.toThrow(/not a web search provider/i);
    expect(createWebSearchRunLog).not.toHaveBeenCalled();
  });
});

describe('instance resolution without an explicit key', () => {
  beforeEach(() => {
    (callWebSearchProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
  });

  it('uses the single active instance', async () => {
    (listProviderConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { key: 'only-one', status: 'active', settings: {} },
      { key: 'disabled-one', status: 'disabled', settings: {} },
    ]);
    const result = await runWebSearch('tenant_acme', 'tenant-1', 'proj-1', { query: 'q' });
    expect(result.providerKey).toBe('only-one');
    expect(loadProviderRuntimeData).toHaveBeenCalledWith('tenant_acme', {
      tenantId: 'tenant-1',
      key: 'only-one',
      projectId: 'proj-1',
    });
  });

  it('errors when multiple active instances exist', async () => {
    (listProviderConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { key: 'a', status: 'active', settings: {} },
      { key: 'b', status: 'active', settings: {} },
    ]);
    await expect(
      runWebSearch('tenant_acme', 'tenant-1', 'proj-1', { query: 'q' }),
    ).rejects.toThrow(/multiple web search instances/i);
  });

  it('errors when no active instance exists', async () => {
    (listProviderConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await expect(
      runWebSearch('tenant_acme', 'tenant-1', 'proj-1', { query: 'q' }),
    ).rejects.toThrow(/no active web search instance/i);
  });
});

describe('AI answer (includeAnswer)', () => {
  it('errors when AI answers are not enabled on the instance', async () => {
    await expect(
      runWebSearch('tenant_acme', 'tenant-1', 'proj-1', {
        query: 'q',
        providerKey: 'brave-main',
        includeAnswer: true,
      }),
    ).rejects.toThrow(/AI answers are not enabled/i);
    expect(callWebSearchProvider).not.toHaveBeenCalled();
    expect(createWebSearchRunLog).not.toHaveBeenCalled();
  });

  it('errors when enabled but no model is selected', async () => {
    (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: { ...RECORD, settings: { aiAnswer: { enabled: true } } },
      credentials: { apiKey: 'k' },
    });
    await expect(
      runWebSearch('tenant_acme', 'tenant-1', 'proj-1', {
        query: 'q',
        providerKey: 'brave-main',
        includeAnswer: true,
      }),
    ).rejects.toThrow(/no model selected/i);
  });

  it('interprets results with the configured model and logs the answer', async () => {
    (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: {
        ...RECORD,
        settings: { aiAnswer: { enabled: true, modelKey: 'gpt-4', instructions: 'Be brief.' } },
      },
      credentials: { apiKey: 'k' },
    });
    (callWebSearchProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ title: 'A', url: 'https://a', snippet: 'context', position: 1 }],
    });
    (handleChatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { choices: [{ message: { content: 'Synthesized answer [1].' } }] },
    });

    const result = await runWebSearch('tenant_acme', 'tenant-1', 'proj-1', {
      query: 'what is A?',
      providerKey: 'brave-main',
      includeAnswer: true,
    });

    expect(result.answer).toBe('Synthesized answer [1].');
    expect(result.answerModel).toBe('gpt-4');
    expect(handleChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantDbName: 'tenant_acme',
        modelKey: 'gpt-4',
        projectId: 'proj-1',
        body: expect.objectContaining({
          messages: [
            expect.objectContaining({
              content: expect.stringContaining('Be brief.'),
            }),
          ],
        }),
      }),
    );

    await vi.waitFor(() => expect(createWebSearchRunLog).toHaveBeenCalledTimes(1));
    expect(createWebSearchRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: 'Synthesized answer [1].',
        results: [
          { title: 'A', url: 'https://a', snippet: 'context', position: 1 },
        ],
        metadata: { answerModel: 'gpt-4' },
      }),
    );
  });

  it('does not call the model when includeAnswer is not set', async () => {
    (callWebSearchProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    await runWebSearch('tenant_acme', 'tenant-1', 'proj-1', {
      query: 'q',
      providerKey: 'brave-main',
    });
    expect(handleChatCompletion).not.toHaveBeenCalled();
  });
});

describe('listWebSearchRunLogs', () => {
  it('delegates to the tenant db', async () => {
    listWebSearchRunLogsDb.mockResolvedValue([]);
    await listWebSearchRunLogs('tenant_acme', 'brave-main', { limit: 20 });
    expect(listWebSearchRunLogsDb).toHaveBeenCalledWith('brave-main', { limit: 20 });
  });
});
