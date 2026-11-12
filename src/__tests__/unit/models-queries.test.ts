// @vitest-environment jsdom
/**
 * The Models query hooks: their keys, what each mutation does to the cache, and how a failure reads.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  failureText,
  modelsKeys,
  serverErrorText,
  useCreateModel,
  useDeleteModel,
  useModelOptions,
  useModelRecord,
  useModelsDashboard,
  useModelsListCache,
  useModelsPageData,
  useUpdateModel,
} from '@/lib/api/queries/models';
import { ApiError } from '@/lib/api/client';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import { cleanupHooks, newHookClient, renderHook, settle, stubFetch, until } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

const model = (id: string) => ({ _id: id, key: id, name: id, providerKey: 'p', category: 'llm' });

describe('Models hooks', () => {
  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(modelsKeys.page('project:4')).toEqual(['models', 'project:4', 'page']);
    const detail = modelsKeys.detail('project:4', 'm1');
    expect(modelsKeys.routingAnalytics('project:4', 'm1', '7').slice(0, detail.length)).toEqual([...detail]);
  });

  it('a picker reads nothing without a category, and a category\'s models when it has one', async () => {
    const calls = stubFetch({ 'GET /api/models': { models: [{ key: 'e1', name: 'Embed', category: 'embedding', extra: 1 }] } });
    const probe = await renderHook(newHookClient(), () => ({
      none: useModelOptions(''),
      closed: useModelOptions('llm', false),
      embedding: useModelOptions('embedding'),
    }));
    await settle();
    expect(probe.current.none.fetchStatus).toBe('idle');
    expect(probe.current.closed.fetchStatus).toBe('idle');
    expect(probe.current.embedding.data).toEqual([{ key: 'e1', name: 'Embed', category: 'embedding' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toEqual({ category: 'embedding' });
  });

  it('creating a model reads every list of the project again', async () => {
    let models = [model('m1')];
    const calls = stubFetch({
      'GET /api/models': () => ({ models, providers: [], platformProviders: [] }),
      'POST /api/models': () => {
        models = [...models, model('m2')];
        return { status: 201, body: { model: models[1] } };
      },
    });
    const probe = await renderHook(newHookClient(), () => ({ page: useModelsPageData(), create: useCreateModel() }));
    await settle();
    expect(probe.current.page.data?.models).toHaveLength(1);
    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'm2' });
    });
    await settle();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(probe.current.page.data?.models).toHaveLength(2);
  });

  it('a bulk create can ask not to read the lists after every model', async () => {
    const calls = stubFetch({
      'GET /api/models': { models: [], providers: [], platformProviders: [] },
      'POST /api/models': { status: 201, body: { model: model('m2') } },
    });
    const probe = await renderHook(newHookClient(), () => ({ page: useModelsPageData(), create: useCreateModel({ refresh: false }) }));
    await settle();
    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'm2' });
    });
    await settle();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('deleting a model leaves the list at once and reads the usage numbers again', async () => {
    const calls = stubFetch({
      'GET /api/models': { models: [model('m1'), model('m2')], providers: [], platformProviders: [] },
      'GET /api/models/dashboard': { overview: { totalModels: 2 }, topModels: [], daily: [] },
      'DELETE /api/models/m1': { success: true },
    });
    const client = newHookClient();
    const probe = await renderHook(client, () => ({
      page: useModelsPageData(),
      dashboard: useModelsDashboard('period=7d'),
      remove: useDeleteModel(),
    }));
    await settle();
    await act(async () => {
      await probe.current.remove.mutateAsync('m1');
    });
    expect(client.getQueryData<{ models: unknown[] }>(modelsKeys.page(getProjectScope()))?.models).toHaveLength(1);
    await settle();
    expect(calls.filter((c) => c.path === '/api/models/dashboard')).toHaveLength(2);
    // The list itself is not read again: the cache edit is what the page shows.
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/models')).toHaveLength(1);
  });

  it('puts a created model and provider into the list before it is read again', async () => {
    stubFetch({ 'GET /api/models': { models: [model('m1')], providers: [{ key: 'p' }], platformProviders: [] } });
    const probe = await renderHook(newHookClient(), () => ({ page: useModelsPageData(), cache: useModelsListCache() }));
    await until(() => probe.current.page.data, 'the list');
    await act(async () => {
      probe.current.cache.addModel(model('m9') as never);
      probe.current.cache.addModel(model('m1') as never);
      probe.current.cache.addProvider({ key: 'q' } as never);
      probe.current.cache.addProvider({ key: 'p' } as never);
    });
    // Observers hear of a cache edit on the next tick.
    await until(() => probe.current.page.data?.models.length === 2, 'the edited list');
    expect(probe.current.page.data?.models.map((m) => m._id)).toEqual(['m1', 'm9']);
    expect(probe.current.page.data?.providers.map((p) => p.key)).toEqual(['p', 'q']);
  });

  it('a record read and an update carry the server\'s message when they fail', async () => {
    stubFetch({
      'GET /api/models/gone': { status: 404, body: { error: 'Model not found' } },
      'PUT /api/models/m1': { status: 409, body: { error: 'Key already in use' } },
    });
    const probe = await renderHook(newHookClient(), () => ({ record: useModelRecord('gone'), update: useUpdateModel() }));
    await settle();
    expect((probe.current.record.error as Error).message).toBe('Model not found');
    let failure: unknown;
    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'm1', body: { key: 'x' } }).catch((error: unknown) => {
        failure = error;
      });
    });
    expect(serverErrorText(failure)).toBe('Key already in use');
    expect(failureText(failure, 'Could not save')).toBe('Key already in use');
  });

  it('failureText falls back for an answer without a message, and keeps the text of a lost connection', () => {
    expect(failureText(new ApiError('Bad Gateway', 502, undefined), 'Could not save')).toBe('Could not save');
    expect(failureText(new TypeError('Failed to fetch'), 'Could not save')).toBe('Failed to fetch');
    expect(failureText('x', 'Could not save')).toBe('Could not save');
  });
});
