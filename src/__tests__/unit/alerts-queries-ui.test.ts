// @vitest-environment jsdom
/**
 * The alert query hooks: their keys, what each mutation does to the cache, and what a failed request hands the screen.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiErrorMessage } from '@/components/alerts/apiError';
import { ApiError } from '@/lib/api/client';
import {
  alertsKeys,
  useAlertRules,
  useAlertTemplates,
  useApplyAlertTemplates,
  useDeleteAlertRule,
  useDeleteLibraryChannel,
  useEntityLinkLookup,
  useChannelLibraryQuery,
  useMuteAlertRule,
  useSaveLibraryChannel,
  useToggleAlertRule,
  useUserDirectoryQuery,
} from '@/lib/api/queries/alerts';
import {
  alertIncidentKeys,
  useBulkIncidents,
  useIncident,
  useIncidentList,
  useIncidentProbe,
  useIncidentStats,
  useUpdateIncident,
} from '@/lib/api/queries/alertIncidents';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { jsonResponse } from '../helpers/iamCenterUi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

async function renderHook<T>(client: QueryClient, hook: () => T): Promise<{ current: T }> {
  const result = { current: undefined as T };
  function Probe() {
    useReducer((n: number) => n + 1, 0);
    result.current = hook();
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(QueryClientProvider, { client }, h(Probe)));
  });
  return result;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

type Call = { method: string; path: string; search: string; body: unknown };

describe('alert hooks', () => {
  let calls: Call[];
  let rules: Array<Record<string, unknown>>;
  let incident: Record<string, unknown>;
  let failures: Set<string>;

  const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;

  beforeEach(() => {
    calls = [];
    failures = new Set();
    rules = [{ _id: 'r1', name: 'One', enabled: true }, { _id: 'r2', name: 'Two', enabled: false }];
    incident = { _id: 'i1', status: 'open', ruleName: 'One' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const url = new URL(input, 'http://localhost');
        const path = url.pathname;
        calls.push({ method, path, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (failures.has(`${method} ${path}`)) return jsonResponse({ message: 'refused by server', error: 'other' }, 409);
        if (method === 'GET' && path === '/api/alerts/rules') return jsonResponse({ rules, meta: { catalog: [] }, total: rules.length });
        if (method === 'PATCH' && path === '/api/alerts/rules/r1') return jsonResponse({ rule: rules[0] });
        if (method === 'DELETE' && path === '/api/alerts/rules/r1') return jsonResponse({ success: true });
        if (method === 'POST' && path === '/api/alerts/rules/r1/mute') return jsonResponse({ rule: { _id: 'r1', mutedUntil: '2099-01-01T00:00:00.000Z' } });
        if (method === 'GET' && path === '/api/alerts/templates') return jsonResponse({ projectId: 'p', items: [], projectAdminRecipients: 2 });
        if (method === 'POST' && path === '/api/alerts/templates') return jsonResponse({ created: ['a'] }, 201);
        if (method === 'GET' && path === '/api/alerts/incidents') return jsonResponse({ incidents: [incident], total: 1, serverTime: 't0' });
        if (method === 'GET' && path === '/api/alerts/incidents/stats') return jsonResponse({ range: '24h', open: 1 });
        if (method === 'GET' && path === '/api/alerts/incidents/i1') return jsonResponse({ incident });
        if (method === 'PATCH' && path === '/api/alerts/incidents/i1') {
          incident = { ...incident, ...(JSON.parse(String(init?.body)) as object) };
          return jsonResponse({ incident });
        }
        if (method === 'POST' && path === '/api/alerts/incidents/bulk') return jsonResponse({ updated: 1, failed: [] });
        if (method === 'GET' && path === '/api/alerts/channels/library') return jsonResponse({ channels: [{ id: 'c1', name: 'Ops' }] });
        if (method === 'POST' && path === '/api/alerts/channels/library') return jsonResponse({ channel: { id: 'c2' } }, 201);
        if (method === 'DELETE' && path === '/api/alerts/channels/library/c1') return jsonResponse({ success: true });
        if (method === 'POST' && path === '/api/alerts/entities/links') {
          const body = JSON.parse(String(init?.body)) as { entities: Array<{ type: string; key: string }> };
          return jsonResponse({ links: Object.fromEntries(body.entities.map((e) => [`${e.type}:${e.key}`, `/dashboard/${e.type}/${e.key}`])) });
        }
        if (method === 'GET' && path === '/api/auth/me') return jsonResponse({ userId: 'u1', name: 'Me', role: 'admin' });
        if (method === 'GET' && path === '/api/users') return jsonResponse({ users: [{ _id: 'u2', name: 'Other' }] });
        return jsonResponse({ error: `no mock for ${method} ${path}` }, 404);
      }),
    );
  });

  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(alertsKeys.rulesList('project:3', 'q=1')).toEqual(['alerts', 'project:3', 'rules', 'list', 'q=1']);
    expect(alertsKeys.rule('project:3', 'r1').slice(0, 3)).toEqual([...alertsKeys.rules('project:3')]);
    expect(alertIncidentKeys.list('project:3', 'a=1')).toEqual(['alerts', 'project:3', 'incidents', 'list', 'a=1']);
    const detail = alertIncidentKeys.detail('project:3', 'i1');
    expect(alertIncidentKeys.deliveries('project:3', 'i1', 'k').slice(0, detail.length)).toEqual([...detail]);
    expect(alertIncidentKeys.similar('project:3', 'i1').slice(0, detail.length)).toEqual([...detail]);
  });

  it('a failed read hands the screen the status and the server message, not the HTTP status text', async () => {
    failures.add('GET /api/alerts/rules');
    const probe = await renderHook(newTestQueryClient(), () => useAlertRules('limit=5'));
    await settle();
    expect(probe.current.isError).toBe(true);
    expect(probe.current.error).toMatchObject({ status: 409 });
    expect(apiErrorMessage(probe.current.error, 'fallback')).toBe('refused by server');
    // an answer without a usable body leaves the screen its own text
    expect(apiErrorMessage(new ApiError('Internal Server Error', 500), 'fallback')).toBe('fallback');
    expect(apiErrorMessage(new TypeError('Failed to fetch'), 'fallback')).toBe('Failed to fetch');
  });

  it('switching a rule shows at once and is undone when the server refuses', async () => {
    const client = newTestQueryClient();
    client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, gcTime: 60_000 } });
    const probe = await renderHook(client, () => ({ list: useAlertRules('q=1'), toggle: useToggleAlertRule() }));
    await settle();
    expect(probe.current.list.data?.rules?.map((r) => r.enabled)).toEqual([true, false]);

    await act(async () => {
      await probe.current.toggle.mutateAsync({ id: 'r1', enabled: false });
    });
    await settle();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false });
    expect(probe.current.list.data?.rules?.[0]?.enabled).toBe(false);
    // the answer is not reread: the optimistic row is what the server now holds
    expect(count('GET', '/api/alerts/rules')).toBe(1);

    failures.add('PATCH /api/alerts/rules/r1');
    await act(async () => {
      await expect(probe.current.toggle.mutateAsync({ id: 'r1', enabled: true })).rejects.toMatchObject({ status: 409 });
    });
    await settle();
    expect(probe.current.list.data?.rules?.[0]?.enabled).toBe(false);
  });

  it('deleting a rule drops it from every cached list without rereading them', async () => {
    const probe = await renderHook(newTestQueryClient(), () => ({ list: useAlertRules('q=1'), remove: useDeleteAlertRule() }));
    await settle();
    await act(async () => {
      await probe.current.remove.mutateAsync('r1');
    });
    await settle();
    expect(probe.current.list.data?.rules?.map((r) => r._id)).toEqual(['r2']);
    expect(count('GET', '/api/alerts/rules')).toBe(1);
  });

  it('muting stores the server rule and reloads the rule lists', async () => {
    const client = newTestQueryClient();
    client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, gcTime: 60_000 } });
    const probe = await renderHook(client, () => ({ list: useAlertRules('q=1'), mute: useMuteAlertRule() }));
    await settle();
    await act(async () => {
      await probe.current.mute.mutateAsync({ id: 'r1', until: '2099-01-01T00:00:00.000Z', reason: ' away ' });
    });
    await settle();
    expect(calls.find((c) => c.path === '/api/alerts/rules/r1/mute')?.body).toEqual({ until: '2099-01-01T00:00:00.000Z', reason: 'away' });
    expect(client.getQueryData(alertsKeys.rule(getProjectScope(), 'r1'))).toMatchObject({ mutedUntil: '2099-01-01T00:00:00.000Z' });
    expect(count('GET', '/api/alerts/rules')).toBe(2);
  });

  it('applying templates reloads the template list and the rules', async () => {
    const probe = await renderHook(newTestQueryClient(), () => ({
      templates: useAlertTemplates(),
      rules: useAlertRules('q=1'),
      apply: useApplyAlertTemplates(),
    }));
    await settle();
    expect(probe.current.templates.data?.projectAdminRecipients).toBe(2);
    await act(async () => {
      await probe.current.apply.mutateAsync(['a']);
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/alerts/templates')?.body).toEqual({ keys: ['a'] });
    expect(count('GET', '/api/alerts/templates')).toBe(2);
    expect(count('GET', '/api/alerts/rules')).toBe(2);
  });

  it('an incident change replaces the cached incident and reloads the list and the stats', async () => {
    const client = newTestQueryClient();
    client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, gcTime: 60_000 } });
    const probe = await renderHook(client, () => ({
      list: useIncidentList('limit=25'),
      stats: useIncidentStats('24h'),
      one: useIncident('i1'),
      update: useUpdateIncident(),
    }));
    await settle();
    expect(count('GET', '/api/alerts/incidents')).toBe(1);
    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'i1', body: { status: 'resolved' } });
    });
    await settle();
    expect(probe.current.one.data).toMatchObject({ status: 'resolved' });
    expect(count('GET', '/api/alerts/incidents')).toBe(2);
    expect(count('GET', '/api/alerts/incidents/stats')).toBe(2);
    expect(probe.current.list.data?.incidents?.[0]).toMatchObject({ status: 'resolved' });
  });

  it('a bulk action reloads the list and the stats, and a 404 incident is a final answer', async () => {
    const probe = await renderHook(newTestQueryClient(), () => ({
      list: useIncidentList('limit=25'),
      stats: useIncidentStats('24h'),
      bulk: useBulkIncidents(),
      missing: useIncident('nope'),
    }));
    await settle();
    expect(probe.current.missing.error).toMatchObject({ status: 404 });
    expect(count('GET', '/api/alerts/incidents/nope')).toBe(1);
    await act(async () => {
      await probe.current.bulk.mutateAsync({ ids: ['i1'], action: 'resolve' });
    });
    await settle();
    expect(calls.find((c) => c.path === '/api/alerts/incidents/bulk')?.body).toEqual({ ids: ['i1'], action: 'resolve' });
    expect(count('GET', '/api/alerts/incidents')).toBe(2);
    expect(count('GET', '/api/alerts/incidents/stats')).toBe(2);
  });

  it('the live probe asks nothing until one interval has passed, and only once the list has loaded', async () => {
    const probe = await renderHook(newTestQueryClient(), () => useIncidentProbe({ live: true, ready: true, getSince: () => 't0' }));
    await settle();
    expect(count('GET', '/api/alerts/incidents')).toBe(0);
    expect(probe.current.data).toEqual({});
    const idle = await renderHook(newTestQueryClient(), () => useIncidentProbe({ live: false, ready: true, getSince: () => 't0' }));
    await settle();
    expect(idle.current.fetchStatus).toBe('idle');
  });

  it('saving and deleting a library channel reload the library', async () => {
    const probe = await renderHook(newTestQueryClient(), () => ({
      library: useChannelLibraryQuery(true),
      save: useSaveLibraryChannel(),
      remove: useDeleteLibraryChannel(),
    }));
    await settle();
    expect(probe.current.library.data).toEqual([{ id: 'c1', name: 'Ops' }]);
    await act(async () => {
      await probe.current.save.mutateAsync({ body: { name: 'New' } });
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/alerts/channels/library')?.body).toEqual({ name: 'New' });
    expect(count('GET', '/api/alerts/channels/library')).toBe(2);
    await act(async () => {
      await probe.current.remove.mutateAsync('c1');
    });
    await settle();
    expect(count('GET', '/api/alerts/channels/library')).toBe(3);
  });

  it('entity links ask only for the entities not answered yet, and keep the answers for the next screen', async () => {
    const key = (type: string, k: string) => `${type}:${k}`;
    const client = newTestQueryClient();
    let entities = [{ type: 'model', key: 'gpt' }, { type: 'crawler', key: 'x' }];
    const probe = await renderHook(client, () => useEntityLinkLookup(entities, 'p1', key));
    await settle();
    expect(probe.current).toEqual({ 'model:gpt': '/dashboard/model/gpt' });
    expect(calls.filter((c) => c.path === '/api/alerts/entities/links')).toHaveLength(1);
    expect(calls.find((c) => c.path === '/api/alerts/entities/links')?.body).toEqual({ projectId: 'p1', entities: [{ type: 'model', key: 'gpt' }] });

    entities = [{ type: 'model', key: 'gpt' }, { type: 'tool', key: 'search' }];
    await act(async () => root!.render(h(QueryClientProvider, { client }, h(function Again() { useReducer((n: number) => n + 1, 0); probe.current = useEntityLinkLookup(entities, 'p1', key); return null; }))));
    await settle();
    expect(calls.filter((c) => c.path === '/api/alerts/entities/links').at(-1)?.body).toEqual({ projectId: 'p1', entities: [{ type: 'tool', key: 'search' }] });
    expect(probe.current).toEqual({ 'model:gpt': '/dashboard/model/gpt', 'tool:search': '/dashboard/tool/search' });
  });

  it('the user directory names the viewer and the others, and a lookup without the viewer is a failure', async () => {
    const ok = await renderHook(newTestQueryClient(), () => useUserDirectoryQuery());
    await settle();
    expect(ok.current.data).toEqual({ meId: 'u1', meName: 'Me', names: { u2: 'Other' } });

    failures.add('GET /api/auth/me');
    const broken = await renderHook(newTestQueryClient(), () => useUserDirectoryQuery());
    await settle();
    expect(broken.current.isError).toBe(true);
    expect(broken.current.data).toBeUndefined();
  });
});
