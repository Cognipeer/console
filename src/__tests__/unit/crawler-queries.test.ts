// @vitest-environment jsdom
/**
 * The Crawler query hooks: project-scoped keys, the runs list (narrowed to one crawler and polled while one runs)
 * and what each mutation rereads.
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import {
  crawlerKeys,
  useCancelCrawlJob,
  useCrawlJobResults,
  useCrawlJobs,
  useCrawler,
  useCrawlers,
  useCreateCrawler,
  useDeleteCrawler,
  useRemoveCrawlerUrls,
  useRunCrawler,
  useUpdateCrawler,
} from '@/lib/api/queries/crawler';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { cleanupHooks, renderHook, settle, stubFetch } from '../helpers/knowledgeQueryHarness';

afterEach(cleanupHooks);

describe('Crawler hooks', () => {
  it('keys start with the resource and the project marker; jobs is a prefix of the lists and results below it', () => {
    expect(crawlerKeys.list('project:5')).toEqual(['crawler', 'project:5', 'list']);
    const jobs = crawlerKeys.jobs('project:5');
    expect(crawlerKeys.jobList('project:5', 'c').slice(0, jobs.length)).toEqual([...jobs]);
    expect(crawlerKeys.jobResults('project:5', 'j', 'limit=50', 0).slice(0, jobs.length)).toEqual([...jobs]);
  });

  it('create refreshes the list; an update refreshes the crawler and the list; a delete drops the crawler', async () => {
    const crawlers = [{ id: 'c1', key: 'one' }];
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/crawler/crawlers') return { body: { crawlers } };
      if (method === 'GET' && path === '/api/crawler/crawlers/c1') return { body: { crawler: { id: 'c1', key: 'one' } } };
      if (method === 'POST' && path === '/api/crawler/crawlers') {
        crawlers.push({ id: 'c2', key: 'two' });
        return { status: 201, body: { crawler: { id: 'c2' } } };
      }
      if (method === 'PATCH' && path === '/api/crawler/crawlers/c1') return { body: { crawler: { id: 'c1' } } };
      if (method === 'DELETE' && path === '/api/crawler/crawlers/c1/urls') return { body: {} };
      if (method === 'DELETE' && path === '/api/crawler/crawlers/c1') return { body: { success: true } };
      return undefined;
    });
    const client = newTestQueryClient();
    const removed = vi.spyOn(client, 'removeQueries');
    const probe = await renderHook(client, () => ({
      list: useCrawlers(),
      one: useCrawler('c1'),
      create: useCreateCrawler(),
      update: useUpdateCrawler('c1'),
      removeUrls: useRemoveCrawlerUrls('c1'),
      remove: useDeleteCrawler(),
    }));
    await settle();
    const reads = (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;
    expect(probe.current.list.data).toHaveLength(1);

    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'Two', engine: 'auto', autoCrawl: false, maxDepth: 0, maxPages: 50 });
    });
    await settle();
    expect(probe.current.list.data).toHaveLength(2);

    await act(async () => {
      await probe.current.update.mutateAsync({ name: 'Renamed' });
    });
    await settle();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed' });
    expect(reads('/api/crawler/crawlers/c1')).toBe(2);

    await act(async () => {
      await probe.current.removeUrls.mutateAsync(['https://a.test']);
    });
    expect(calls.find((c) => c.path === '/api/crawler/crawlers/c1/urls')?.body).toEqual({ urls: ['https://a.test'] });

    await act(async () => {
      await probe.current.remove.mutateAsync('c1');
    });
    // The screen is gone by then; a still-mounted observer would only fetch the removed key again.
    expect(removed).toHaveBeenCalledWith({ queryKey: crawlerKeys.detail(getProjectScope(), 'c1') });
  });

  it('narrows the runs to one crawler, polls while one is running and stops after; the error of a run reaches the caller', async () => {
    let status = 'running';
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/crawler/jobs') {
        return { body: { jobs: [{ id: 'j1', crawlerKey: 'one', status }, { id: 'j2', crawlerKey: 'other', status: 'running' }] } };
      }
      if (method === 'POST' && path === '/api/crawler/crawlers/c1/run') return { status: 409, body: { error: 'already running' } };
      if (method === 'POST' && path === '/api/crawler/jobs/j1/cancel') return { body: {} };
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      jobs: useCrawlJobs('one', 15),
      run: useRunCrawler('c1'),
      cancel: useCancelCrawlJob(),
    }));
    await settle();
    expect(probe.current.jobs.data?.map((j) => j.id)).toEqual(['j1']);
    const reads = () => calls.filter((c) => c.method === 'GET').length;
    expect(reads()).toBeGreaterThan(1);

    status = 'succeeded';
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const settled = reads();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(reads()).toBe(settled);

    await act(async () => {
      await expect(probe.current.run.mutateAsync()).rejects.toThrow('already running');
      await probe.current.cancel.mutateAsync('j1');
    });
    expect(calls.find((c) => c.path === '/api/crawler/jobs/j1/cancel')?.body).toEqual({});
  });

  it('reads one page of a job’s results with its filters in the query string', async () => {
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/crawler/jobs/j1/results') {
        return { body: { results: [], total: 0, counts: { html: 0, file: 0, error: 0 } } };
      }
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () =>
      useCrawlJobResults('j1', { limit: 50, skip: 50, type: 'html', ragStatus: 'failed', search: 'faq' }, 0),
    );
    await settle();
    expect(probe.current.data?.total).toBe(0);
    const params = new URLSearchParams(calls[0]?.search);
    expect(Object.fromEntries(params)).toEqual({ limit: '50', skip: '50', type: 'html', ragStatus: 'failed', search: 'faq' });
  });
});
