// @vitest-environment jsdom
/**
 * The dataset import hooks: the PII catalog is read per locale, and detection, URL fetch and import send the bodies
 * the wizard always sent and keep the server's message on failure.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  datasetImportKeys,
  useCreateDatasetImport,
  useDetectImportFormat,
  useFetchImportUrl,
  useImportPiiCategories,
} from '@/lib/api/queries/datasetImport';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { cleanupHooks, renderHook, settle, stubFetch } from '../helpers/knowledgeQueryHarness';

afterEach(cleanupHooks);

describe('Dataset import hooks', () => {
  it('keys carry the project marker and the locale', () => {
    expect(datasetImportKeys.piiCategories('project:1', 'tr')).toEqual(['dataset-import', 'project:1', 'pii-categories', 'tr']);
  });

  it('reads the catalog of one locale and sends detect, fetch and import with their bodies', async () => {
    const calls = stubFetch(({ method, path, search }) => {
      if (method === 'GET' && path === '/api/pii/categories' && search === '?locale=tr') {
        return { body: { categories: [{ id: 'email', defaultEnabled: true }] } };
      }
      if (method === 'POST' && path === '/api/dataset-import/detect') return { body: { format: 'jsonl', preview: { items: [], counts: { parsed: 0, skipped: {} } } } };
      if (method === 'POST' && path === '/api/dataset-import/fetch') return { body: { content: 'a,b' } };
      if (method === 'POST' && path === '/api/dataset-import') return { status: 201, body: { datasetId: 'd1', created: 2, skipped: {}, piiFindings: 0 } };
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      catalog: useImportPiiCategories('tr'),
      detect: useDetectImportFormat(),
      fetchUrl: useFetchImportUrl(),
      create: useCreateDatasetImport(),
    }));
    await settle();
    expect(probe.current.catalog.data).toEqual([{ id: 'email', defaultEnabled: true }]);

    let fetched: unknown;
    let created: unknown;
    await act(async () => {
      await probe.current.detect.mutateAsync('{"a":1}');
      fetched = await probe.current.fetchUrl.mutateAsync('https://a.test/data.csv');
      created = await probe.current.create.mutateAsync({
        content: 'a,b',
        format: 'csv' as never,
        name: 'Imported',
        anonymize: { categories: ['email'], strategy: 'mask' },
      });
    });
    expect(fetched).toBe('a,b');
    expect(created).toMatchObject({ datasetId: 'd1' });
    expect(calls.find((c) => c.path === '/api/dataset-import/detect')?.body).toEqual({ content: '{"a":1}' });
    expect(calls.find((c) => c.path === '/api/dataset-import/fetch')?.body).toEqual({ url: 'https://a.test/data.csv' });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/dataset-import')?.body).toMatchObject({ name: 'Imported' });
  });

  it('the message of a refused import reaches the caller', async () => {
    stubFetch(({ method, path }) => (method === 'POST' && path === '/api/dataset-import' ? { status: 413, body: { error: 'too large' } } : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useCreateDatasetImport());
    await act(async () => {
      await expect(
        probe.current.mutateAsync({ content: 'x', format: 'csv' as never, name: 'n', anonymize: { categories: [], strategy: 'mask' } }),
      ).rejects.toThrow('too large');
    });
  });
});
