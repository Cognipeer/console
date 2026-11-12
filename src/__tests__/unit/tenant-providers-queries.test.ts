// @vitest-environment jsdom
/**
 * The tenant-provider hooks (list, a project's tab, drivers, writes) and the hooks of the create-project form.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  tenantProvidersKeys,
  useAddTenantProviderToList,
  useCreateTenantProvider,
  useLoadTenantProvider,
  usePreloadProviderDrivers,
  useProjectProviders,
  useProviderDrivers,
  useTenantProviders,
  useUpdateTenantProvider,
} from '@/lib/api/queries/tenantProviders';
import { projectCreateKeys, useDefaultAlertRulesChoice, useProjectPeople } from '@/lib/api/queries/projectCreate';
import { useCreateProject } from '@/lib/api/queries/projects';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { jsonResponse } from '../helpers/iamCenterUi';
import { cleanupHooks, renderHook, settle, stubApi, type RecordedCall } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

const P1 = { _id: 'prov-1', key: 'one', label: 'One', type: 'model', driver: 'openai', status: 'active' };

function api(extra: (c: RecordedCall) => Response | undefined = () => undefined) {
  return stubApi((c) => {
    const answer = extra(c);
    if (answer) return answer;
    if (c.method === 'GET' && c.path === '/api/providers') return jsonResponse({ providers: [P1] });
    if (c.method === 'GET' && c.path === '/api/providers/drivers') return jsonResponse({ drivers: [{ id: 'openai' }] });
    if (c.method === 'GET' && c.path === '/api/providers/prov-1') return jsonResponse({ provider: { ...P1, settings: {} } });
    return jsonResponse({ ok: true });
  });
}

describe('tenant provider hooks', () => {
  it('keys start with the resource and the project marker', () => {
    const prefix = [...tenantProvidersKeys.project('project:1')];
    expect(tenantProvidersKeys.list('project:1').slice(0, 2)).toEqual(prefix);
    expect(tenantProvidersKeys.projectView('project:1', 'p1').slice(0, 2)).toEqual(prefix);
    expect(tenantProvidersKeys.drivers('project:1', 'model').slice(0, 2)).toEqual(prefix);
    expect(tenantProvidersKeys.drivers('project:1', 'model')).not.toEqual(tenantProvidersKeys.drivers('project:1', 'file'));
    expect(tenantProvidersKeys.detail('project:1', 'x').slice(0, 2)).toEqual(prefix);
  });

  it('reads the tenant list with the tenant scope, and nothing while disabled', async () => {
    const calls = api();
    await renderHook(newTestQueryClient(), () => useTenantProviders({ enabled: false }));
    await settle();
    expect(calls).toHaveLength(0);
    await cleanupHooks();

    const calls2 = api();
    const probe = await renderHook(newTestQueryClient(), () => useTenantProviders<typeof P1>());
    await settle();
    expect(probe.current.data).toEqual({ providers: [P1], forbidden: false });
    expect(calls2[0]).toMatchObject({ path: '/api/providers', search: '?scope=tenant' });
  });

  it('a 403 is an answer (forbidden); any other failure is an error with the status and message', async () => {
    api(() => jsonResponse({ error: 'Forbidden' }, 403));
    let probe = await renderHook(newTestQueryClient(), () => useTenantProviders());
    await settle();
    expect(probe.current.data).toEqual({ providers: [], forbidden: true });
    await cleanupHooks();

    api(() => jsonResponse({ error: 'Boom' }, 500));
    probe = await renderHook(newTestQueryClient(), () => useTenantProviders());
    await settle();
    expect(probe.current.error).toMatchObject({ status: 500, message: 'Boom' });
  });

  it("a project's tab shows the tenant's providers when they can be read, else the project's own, else forbidden", async () => {
    api();
    let probe = await renderHook(newTestQueryClient(), () => useProjectProviders<typeof P1>('p1'));
    await settle();
    expect(probe.current.data).toMatchObject({ tenantScope: true, forbidden: false });
    await cleanupHooks();

    const calls = api((c) => (c.search === '?scope=tenant' ? jsonResponse({ error: 'Forbidden' }, 403) : undefined));
    probe = await renderHook(newTestQueryClient(), () => useProjectProviders<typeof P1>('p1'));
    await settle();
    expect(probe.current.data).toMatchObject({ tenantScope: false, forbidden: false });
    expect(probe.current.data?.providers).toHaveLength(1);
    expect(calls.map((c) => c.search)).toEqual(['?scope=tenant', '']);
    await cleanupHooks();

    api(() => jsonResponse({ error: 'Forbidden' }, 403));
    probe = await renderHook(newTestQueryClient(), () => useProjectProviders<typeof P1>('p1'));
    await settle();
    expect(probe.current.data).toEqual({ providers: [], tenantScope: false, forbidden: true });
  });

  it('reads the drivers of a domain only once a domain is given, and one preload fills the cache for it', async () => {
    const calls = api();
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ none: useProviderDrivers(null), model: useProviderDrivers('model'), preload: usePreloadProviderDrivers() }));
    await settle();
    expect(probe.current.none.data).toBeUndefined();
    expect(probe.current.model.data).toEqual([{ id: 'openai' }]);
    expect(calls.filter((c) => c.path === '/api/providers/drivers').map((c) => c.search)).toEqual(['?domain=model']);
    await act(async () => { await probe.current.preload('file'); });
    expect(calls.filter((c) => c.path === '/api/providers/drivers').map((c) => c.search)).toEqual(['?domain=model', '?domain=file']);
  });

  it('a preload that fails still resolves (the failure is reported by the cache), and a failed drivers read has the status', async () => {
    api((c) => (c.path === '/api/providers/drivers' ? jsonResponse({ error: 'No drivers' }, 500) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => ({ model: useProviderDrivers('model', false), preload: usePreloadProviderDrivers(false) }));
    await settle();
    expect(probe.current.model.error).toMatchObject({ status: 500, message: 'No drivers' });
    await act(async () => { await expect(probe.current.preload('file')).resolves.toBeUndefined(); });
  });

  it('loads one provider fresh each time and rejects with the server answer', async () => {
    const calls = api((c) => (c.path === '/api/providers/missing' ? jsonResponse({ error: 'Provider not found' }, 404) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useLoadTenantProvider());
    let first: unknown;
    await act(async () => { first = await probe.current('prov-1'); });
    await act(async () => { await probe.current('prov-1'); });
    expect(first).toMatchObject({ _id: 'prov-1' });
    expect(calls.filter((c) => c.path === '/api/providers/prov-1')).toHaveLength(2);
    expect(calls[0]?.search).toBe('?scope=tenant');
    await act(async () => {
      await expect(probe.current('missing')).rejects.toMatchObject({ status: 404, message: 'Provider not found' });
    });
  });

  it('creating and editing go to the tenant scope and reload the lists', async () => {
    const calls = api((c) => (c.method === 'POST' ? jsonResponse({ provider: { _id: 'prov-2', label: 'Two', key: 'two', type: 'model' } }, 201) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => ({
      list: useTenantProviders(),
      create: useCreateTenantProvider(),
      update: useUpdateTenantProvider(),
    }));
    await settle();
    let created: Awaited<ReturnType<typeof probe.current.create.mutateAsync>> | undefined;
    await act(async () => { created = await probe.current.create.mutateAsync({ key: 'two', type: 'model' }); });
    await act(async () => { await probe.current.update.mutateAsync({ id: 'prov 1', body: { projectIds: ['p1'] } }); });
    await settle();
    expect(created?.provider?._id).toBe('prov-2');
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/providers', search: '?scope=tenant', body: { key: 'two' } });
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/providers/prov%201', search: '?scope=tenant', body: { projectIds: ['p1'] } });
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/providers')).toHaveLength(3);
  });

  it('a refused create carries the body, so the form can mark the field', async () => {
    api((c) => (c.method === 'POST' ? jsonResponse({ error: 'Key taken', field: 'key' }, 409) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useCreateTenantProvider());
    await act(async () => { await probe.current.mutateAsync({ key: 'one' }).catch(() => undefined); });
    await settle();
    expect(probe.current.error).toMatchObject({ status: 409, message: 'Key taken', payload: { field: 'key' } });
  });

  it('puts a provider that was just created into the cached list at once, once', async () => {
    api();
    const probe = await renderHook(newTestQueryClient(), () => ({ list: useTenantProviders<typeof P1>(), add: useAddTenantProviderToList<typeof P1>() }));
    await settle();
    const extra = { ...P1, _id: 'prov-2', key: 'two' };
    await act(async () => { probe.current.add(extra); probe.current.add(extra); probe.current.add(P1); });
    await settle();
    expect(probe.current.list.data?.providers.map((p) => p._id)).toEqual(['prov-1', 'prov-2']);
  });
});

describe('create-project hooks', () => {
  it('keys start with the resource and the project marker', () => {
    const prefix = [...projectCreateKeys.project('project:1')];
    expect(projectCreateKeys.people('project:1').slice(0, 2)).toEqual(prefix);
    expect(projectCreateKeys.alertDefault('project:1').slice(0, 2)).toEqual(prefix);
  });

  it('reads people and groups together, only while the form is open', async () => {
    const calls = stubApi((c) => (c.path === '/api/users' ? jsonResponse({ users: [{ _id: 'u1' }] }) : jsonResponse({ groups: [{ _id: 'g1' }] })));
    await renderHook(newTestQueryClient(), () => useProjectPeople(false));
    await settle();
    expect(calls).toHaveLength(0);
    await cleanupHooks();

    stubApi((c) => (c.path === '/api/users' ? jsonResponse({ users: [{ _id: 'u1' }] }) : jsonResponse({ groups: [{ _id: 'g1' }] })));
    const probe = await renderHook(newTestQueryClient(), () => useProjectPeople(true));
    await settle();
    expect(probe.current.data).toEqual({ users: [{ _id: 'u1' }], groups: [{ _id: 'g1' }] });
  });

  it('is an error when either read fails, with the status', async () => {
    stubApi((c) => (c.path === '/api/groups' ? jsonResponse({ error: 'Forbidden' }, 403) : jsonResponse({ users: [] })));
    const probe = await renderHook(newTestQueryClient(), () => useProjectPeople(true));
    await settle();
    expect(probe.current.isError).toBe(true);
    expect(probe.current.error).toMatchObject({ status: 403 });
  });

  it('reads the default for alert rules as a yes or no, or nothing when the workspace did not say', async () => {
    stubApi(() => jsonResponse({ defaultRulesOnNewProjects: false }));
    let probe = await renderHook(newTestQueryClient(), () => useDefaultAlertRulesChoice(true));
    await settle();
    expect(probe.current.data).toBe(false);
    await cleanupHooks();

    stubApi(() => jsonResponse({ templates: [] }));
    probe = await renderHook(newTestQueryClient(), () => useDefaultAlertRulesChoice(true));
    await settle();
    expect(probe.current.data).toBeUndefined();
    await cleanupHooks();

    stubApi(() => jsonResponse({ error: 'no' }, 500));
    probe = await renderHook(newTestQueryClient(), () => useDefaultAlertRulesChoice(true));
    await settle();
    expect(probe.current.data).toBeUndefined();
  });

  it('creating a project posts the body, answers with the project and the warnings, and reads the list again', async () => {
    const calls = stubApi((c) =>
      c.method === 'POST' ? jsonResponse({ project: { _id: 'p9' }, warnings: ['w'] }, 201) : jsonResponse({ projects: [] }),
    );
    const { useProjects } = await import('@/lib/api/queries/projects');
    const probe = await renderHook(newTestQueryClient(), () => ({ list: useProjects(), create: useCreateProject() }));
    await settle();
    let body: Awaited<ReturnType<typeof probe.current.create.mutateAsync>> | undefined;
    await act(async () => { body = await probe.current.create.mutateAsync({ name: 'New', providerIds: [] }); });
    await settle();
    expect(body).toEqual({ project: { _id: 'p9' }, warnings: ['w'] });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/projects', body: { name: 'New', providerIds: [] } });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('a refused create carries the status and the server message', async () => {
    stubApi(() => jsonResponse({ error: 'Project key already exists' }, 409));
    const probe = await renderHook(newTestQueryClient(), () => useCreateProject());
    await act(async () => { await probe.current.mutateAsync({ name: 'Dup' }).catch(() => undefined); });
    await settle();
    expect(probe.current.error).toMatchObject({ status: 409, message: 'Project key already exists' });
  });
});
