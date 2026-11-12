// @vitest-environment jsdom
/**
 * The provider query hooks: their keys, what a save does to the cache, and the assignment to the active project.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  providersKeys,
  useAssignProviderToActiveProject,
  useDeleteProvider,
  useProvider,
  useProviderUsageQuery,
  useTestProvider,
  useUpdateProvider,
} from '@/lib/api/queries/providers';
import { cleanupHooks, newHookClient, renderHook, settle, stubFetch } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

const record = { _id: 'p1', key: 'main', label: 'Main', projectIds: ['a'] };

describe('provider hooks', () => {
  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(providersKeys.detail('project:5', 'p1')).toEqual(['providers', 'project:5', 'detail', 'p1']);
    const detail = providersKeys.detail('project:5', 'p1');
    expect(providersKeys.usage('project:5', 'p1').slice(0, detail.length)).toEqual([...detail]);
  });

  it('saving a provider reads the record and its usage again; a refusal keeps its payload', async () => {
    let status = 200;
    const calls = stubFetch({
      'GET /api/providers/p1': { provider: record },
      'GET /api/providers/p1/usage': { projects: [{ projectId: 'a', name: 'A', assigned: true }] },
      'PATCH /api/providers/p1': () => (status === 200 ? { provider: record } : { status, body: { error: 'Enter the token.', field: 'sasToken' } }),
    });
    const probe = await renderHook(newHookClient(), () => ({
      detail: useProvider<typeof record>('p1'),
      usage: useProviderUsageQuery('p1'),
      update: useUpdateProvider(),
    }));
    await settle();
    expect(probe.current.detail.data?.key).toBe('main');
    expect(calls.find((c) => c.path === '/api/providers/p1')?.query).toEqual({ scope: 'tenant' });

    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'p1', body: { label: 'New' } });
    });
    await settle();
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/providers/p1')).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/api/providers/p1/usage')).toHaveLength(2);

    status = 400;
    let failure: { payload?: unknown } | undefined;
    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'p1', body: { label: 'Bad' } }).catch((error: { payload?: unknown }) => {
        failure = error;
      });
    });
    expect(failure?.payload).toEqual({ error: 'Enter the token.', field: 'sasToken' });
  });

  it('a test of a saved provider goes through its route, a draft through the generic one', async () => {
    const calls = stubFetch({
      'POST /api/providers/p1/test': { ok: true },
      'POST /api/providers/test': { ok: false },
    });
    const probe = await renderHook(newHookClient(), () => useTestProvider<{ ok: boolean }>());
    await act(async () => {
      await probe.current.mutateAsync({ id: 'p1', body: { credentials: {}, settings: {} } });
      await probe.current.mutateAsync({ body: { type: 'model', driver: 'openai' } });
    });
    expect(calls.map((c) => c.path)).toEqual(['/api/providers/p1/test', '/api/providers/test']);
    expect(calls[1]!.body).toEqual({ type: 'model', driver: 'openai' });
  });

  it('deleting a provider is a DELETE on the tenant scope', async () => {
    const calls = stubFetch({ 'DELETE /api/providers/p1': { success: true } });
    const probe = await renderHook(newHookClient(), () => useDeleteProvider());
    await act(async () => {
      await probe.current.mutateAsync('p1');
    });
    expect(calls[0]).toMatchObject({ method: 'DELETE', query: { scope: 'tenant' } });
  });

  it('assigning to the active project merges it into the projects read just now', async () => {
    const calls = stubFetch({
      'GET /api/projects': { activeProjectId: 'active' },
      'GET /api/providers': { providers: [{ _id: 'p1', projectIds: ['a', 'b'] }] },
      'PATCH /api/providers/p1': { provider: record },
    });
    const probe = await renderHook(newHookClient(), () => useAssignProviderToActiveProject());
    await act(async () => {
      await probe.current.mutateAsync({ provider: { _id: 'p1', projectIds: ['a'] }, failedMessage: 'Could not assign' });
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ projectIds: ['a', 'b', 'active'] });
  });

  it('assigning says why it could not when no project is active, and falls back to the record at hand when the list fails', async () => {
    stubFetch({ 'GET /api/projects': {} });
    const probe = await renderHook(newHookClient(), () => useAssignProviderToActiveProject());
    let failure: unknown;
    await act(async () => {
      await probe.current.mutateAsync({ provider: { _id: 'p1' }, failedMessage: 'Could not assign' }).catch((error: unknown) => {
        failure = error;
      });
    });
    expect((failure as Error).message).toBe('Could not assign');

    const calls = stubFetch({
      'GET /api/projects': { activeProjectId: 'active' },
      'GET /api/providers': { status: 500, body: { error: 'down' } },
      'PATCH /api/providers/p1': { provider: record },
    });
    await act(async () => {
      await probe.current.mutateAsync({ provider: { _id: 'p1', projectId: 'legacy' }, failedMessage: 'x' });
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ projectIds: ['legacy', 'active'] });
  });
});
