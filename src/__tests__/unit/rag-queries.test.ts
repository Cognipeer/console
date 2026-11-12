// @vitest-environment jsdom
/**
 * The Knowledge Engine query hooks: project-scoped keys, the lookups pickers read, the re-index polling and what
 * each mutation rereads.
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ragKeys,
  useCancelRagReindex,
  useCreateRagModule,
  useDeleteRagModule,
  useModelsByCategory,
  useRagModules,
  useRagReindexRuns,
  useStartRagReindex,
  useUpdateRagModule,
} from '@/lib/api/queries/rag';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { cleanupHooks, renderHook, settle, stubFetch } from '../helpers/knowledgeQueryHarness';

afterEach(cleanupHooks);

describe('Knowledge Engine hooks', () => {
  it('keys start with the resource and the project marker; the module key is a prefix of its runs', () => {
    expect(ragKeys.list('project:1')).toEqual(['rag', 'project:1', 'list']);
    const moduleKey = ragKeys.module('project:1', 'kb');
    expect(ragKeys.reindexRuns('project:1', 'kb').slice(0, moduleKey.length)).toEqual([...moduleKey]);
    expect(ragKeys.detail('project:1', 'kb').slice(0, moduleKey.length)).toEqual([...moduleKey]);
  });

  it('a create refreshes the list; an update refreshes the list; a delete drops the module queries', async () => {
    const modules = [{ key: 'kb', name: 'KB' }];
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/rag/modules') return { body: { modules } };
      if (method === 'POST' && path === '/api/rag/modules') {
        modules.push({ key: 'kb2', name: 'KB2' });
        return { status: 201, body: { module: { key: 'kb2' } } };
      }
      if (method === 'PATCH' && path === '/api/rag/modules/kb') return { body: { module: { key: 'kb', name: 'Renamed' } } };
      if (method === 'DELETE' && path === '/api/rag/modules/kb') return { body: { success: true } };
      return undefined;
    });
    const client = newTestQueryClient();
    const removed = vi.spyOn(client, 'removeQueries');
    const probe = await renderHook(client, () => ({
      list: useRagModules(),
      create: useCreateRagModule(),
      update: useUpdateRagModule('kb'),
      remove: useDeleteRagModule(),
    }));
    await settle();
    expect(probe.current.list.data).toHaveLength(1);

    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'KB2' });
    });
    await settle();
    expect(probe.current.list.data).toHaveLength(2);

    let updated: unknown;
    await act(async () => {
      updated = await probe.current.update.mutateAsync({ name: 'Renamed' });
    });
    expect(updated).toEqual({ key: 'kb', name: 'Renamed' });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Renamed' });

    client.setQueryData(ragKeys.detail(getProjectScope(), 'kb'), { key: 'kb' });
    await act(async () => {
      await probe.current.remove.mutateAsync('kb');
    });
    // The screen is gone by then; a still-mounted observer would only fetch the removed key again.
    expect(removed).toHaveBeenCalledWith({ queryKey: ragKeys.module(getProjectScope(), 'kb') });
  });

  it('reads the models of one category, and the failure message of a request reaches the screen', async () => {
    stubFetch(({ method, path, search }) => {
      if (method === 'GET' && path === '/api/models' && search === '?category=embedding') {
        return { body: { models: [{ key: 'e1', name: 'Embed' }] } };
      }
      if (method === 'GET' && path === '/api/rag/modules') return { status: 403, body: { error: 'no access' } };
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      models: useModelsByCategory('embedding'),
      list: useRagModules(),
    }));
    await settle();
    expect(probe.current.models.data).toEqual([{ key: 'e1', name: 'Embed' }]);
    expect(probe.current.list.error).toMatchObject({ message: 'no access', status: 403 });
  });

  it('rereads the re-index runs while one is not finished and stops once it is; start sends the reason', async () => {
    let status = 'running';
    const calls = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/rag/modules/kb/reindex') return { body: { runs: [{ key: 'r1', status }] } };
      if (method === 'POST' && path === '/api/rag/modules/kb/reindex') return { status: 202, body: {} };
      if (method === 'POST' && path === '/api/rag/modules/kb/reindex/r1/cancel') return { body: {} };
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      runs: useRagReindexRuns('kb', 15),
      start: useStartRagReindex('kb'),
      cancel: useCancelRagReindex('kb'),
    }));
    await settle();
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/rag/modules/kb/reindex').length;
    expect(reads()).toBeGreaterThan(1);

    status = 'completed';
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const settled = reads();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(reads()).toBe(settled);

    await act(async () => {
      await probe.current.start.mutateAsync('manual');
      await probe.current.cancel.mutateAsync('r1');
    });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/rag/modules/kb/reindex')?.body).toEqual({ reason: 'manual' });
    expect(calls.some((c) => c.path === '/api/rag/modules/kb/reindex/r1/cancel')).toBe(true);
  });
});
