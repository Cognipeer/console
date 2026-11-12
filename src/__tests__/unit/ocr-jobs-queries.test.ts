// @vitest-environment jsdom
/**
 * The OCR Jobs query hooks: project-scoped keys, the detail polling, and what each mutation changes in the cache.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  ocrJobsKeys,
  useCreateOcrJob,
  useDeleteOcrJob,
  useOcrJob,
  useOcrJobs,
  useSendOcrJobFiles,
  useSetOcrJobPaused,
} from '@/lib/api/queries/ocrJobs';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { cleanupHooks, renderHook, settle, stubFetch } from '../helpers/knowledgeQueryHarness';

afterEach(cleanupHooks);

describe('OCR Jobs hooks', () => {
  it('keys start with the resource and the project marker', () => {
    expect(ocrJobsKeys.list('project:1')).toEqual(['ocr-jobs', 'project:1', 'list']);
    expect(ocrJobsKeys.detail('project:1', 'j1')).toEqual(['ocr-jobs', 'project:1', 'detail', 'j1']);
  });

  it('a job’s detail holds the job and its documents and is reread while one is pending; sending files rereads it', async () => {
    let itemStatus = 'pending';
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/ocr-jobs/j1') return { body: { job: { id: 'j1', status: 'active' } } };
      if (method === 'GET' && path === '/api/ocr-jobs/j1/items') return { body: { items: [{ id: 'i1', status: itemStatus }] } };
      if (method === 'GET' && path === '/api/ocr-jobs') return { body: { jobs: [{ id: 'j1', itemsTotal: 1, itemsProcessed: 0, itemsFailed: 0 }] } };
      if (method === 'POST' && path === '/api/ocr-jobs/j1/files') return { status: 202, body: { items: [{ id: 'i2' }] } };
      if (method === 'POST' && path === '/api/ocr-jobs/j1/pause') return { body: { job: { id: 'j1', status: 'paused' } } };
      return undefined;
    });
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      detail: useOcrJob('j1', 15),
      send: useSendOcrJobFiles('j1'),
      pause: useSetOcrJobPaused('j1'),
    }));
    await settle();
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/ocr-jobs/j1/items').length;
    expect(probe.current.detail.data?.items).toEqual([{ id: 'i1', status: 'pending' }]);
    expect(reads()).toBeGreaterThan(1);

    itemStatus = 'succeeded';
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const settled = reads();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(reads()).toBe(settled);

    await act(async () => {
      await probe.current.send.mutateAsync({ items: [{ source: { kind: 'url', url: 'https://a.test/x.pdf' } }] });
    });
    expect(calls.find((c) => c.path === '/api/ocr-jobs/j1/files')?.body).toMatchObject({ mode: 'async' });
    expect(reads()).toBe(settled + 1);

    await act(async () => {
      await probe.current.pause.mutateAsync(true);
    });
    expect(client.getQueryData<{ job: { status: string } }>(ocrJobsKeys.detail(getProjectScope(), 'j1'))?.job.status).toBe('paused');
  });

  it('create and delete reread the list; the message of a failed list reaches the caller', async () => {
    const jobs = [{ id: 'j1', itemsTotal: 0, itemsProcessed: 0, itemsFailed: 0 }];
    stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/ocr-jobs') return { body: { jobs } };
      if (method === 'POST' && path === '/api/ocr-jobs') {
        jobs.push({ id: 'j2', itemsTotal: 0, itemsProcessed: 0, itemsFailed: 0 });
        return { status: 201, body: { job: { id: 'j2' } } };
      }
      if (method === 'DELETE' && path === '/api/ocr-jobs/j1') {
        jobs.splice(0, 1);
        return { body: { ok: true } };
      }
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      list: useOcrJobs(5000),
      create: useCreateOcrJob(),
      remove: useDeleteOcrJob(),
    }));
    await settle();
    await act(async () => {
      await probe.current.create.mutateAsync({ bucketKey: 'b', ocrModelKey: 'm', outputs: ['full_text'] });
    });
    await settle();
    expect(probe.current.list.data?.map((j) => j.id)).toEqual(['j1', 'j2']);
    await act(async () => {
      await probe.current.remove.mutateAsync('j1');
    });
    await settle();
    expect(probe.current.list.data?.map((j) => j.id)).toEqual(['j2']);
  });

  it('a failed read keeps the server’s message', async () => {
    stubFetch(({ path }) => (path === '/api/ocr-jobs/j9' ? { status: 404, body: { error: 'job not found' } } : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useOcrJob('j9', 15));
    await settle();
    expect(probe.current.error).toMatchObject({ message: 'job not found', status: 404 });
  });
});
