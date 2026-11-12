// @vitest-environment jsdom
/**
 * `useLimits` over the quota hooks: the rows, the loading / refreshing / forbidden states, a switch shown at once and
 * put back by the reload, and the failures of writes as `LimitsApiError` (status and code).
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimitsApiError, useLimits, useProjectOptions } from '@/components/iam/limits/useLimits';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { jsonResponse } from '../helpers/iamCenterUi';
import { cleanupHooks, renderHook, settle, stubApi, type RecordedCall } from '../helpers/queryHookHarness';

afterEach(async () => {
  await cleanupHooks();
  vi.restoreAllMocks();
});

const ROW = { _id: 'q1', scope: 'tenant', domain: 'llm', enabled: true, projectId: 'p1' };

function api(extra: (c: RecordedCall) => Response | undefined = () => undefined) {
  return stubApi((c) => {
    const answer = extra(c);
    if (answer) return answer;
    if (c.method === 'GET' && c.path === '/api/quota/policies') return jsonResponse({ policies: [ROW] });
    if (c.method === 'GET' && c.path === '/api/projects') return jsonResponse({ projects: [{ _id: 'p1', name: 'Retail', key: 'retail' }, { name: 'no id' }, { _id: 'p2', name: 'Bare' }] });
    if (c.path.startsWith('/api/resources')) return jsonResponse({ items: [] });
    return jsonResponse({ warnings: ['careful', 7] });
  });
}

describe('useLimits', () => {
  it('lists the rows; loading ends with the first answer', async () => {
    const calls = api();
    const probe = await renderHook(newTestQueryClient(), () => useLimits());
    expect(probe.current.loading).toBe(true);
    await settle();
    expect(probe.current.loading).toBe(false);
    expect(probe.current.rows.map((r) => r._id)).toEqual(['q1']);
    expect(probe.current.error).toBeNull();
    expect(probe.current.forbidden).toBe(false);
    expect(calls.find((c) => c.path === '/api/quota/policies')?.search).toBe('?include=targets');
  });

  it('a refused list is forbidden with the message of the server, and has no rows', async () => {
    api((c) => (c.path === '/api/quota/policies' ? jsonResponse({ error: 'No access to limits' }, 403) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useLimits());
    await settle();
    expect(probe.current.forbidden).toBe(true);
    expect(probe.current.error).toBe('No access to limits');
    expect(probe.current.rows).toEqual([]);
    expect(probe.current.loading).toBe(false);
  });

  it('a failed list without a message says the status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api((c) => (c.path === '/api/quota/policies' ? new Response('<html>', { status: 502 }) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useLimits());
    await settle();
    expect(probe.current.error).toBe('Request failed (502)');
    expect(probe.current.forbidden).toBe(false);
  });

  it('saving answers with the warnings (strings only) once the list is read again; a create posts, an edit patches', async () => {
    const calls = api();
    const probe = await renderHook(newTestQueryClient(), () => useLimits());
    await settle();
    let result: { warnings: string[] } | undefined;
    await act(async () => { result = await probe.current.save(null, { name: 'n' } as never); });
    expect(result).toEqual({ warnings: ['careful'] });
    await act(async () => { await probe.current.save('q1', { name: 'm' } as never); });
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/quota/policies', 'PATCH /api/quota/policies/q1']);
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/quota/policies')).toHaveLength(3);
  });

  it('a refused save is a LimitsApiError with the status, the code and the message', async () => {
    api((c) => (c.method === 'POST' ? jsonResponse({ error: 'Overlaps another limit', code: 'overlap' }, 409) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useLimits());
    await settle();
    const error = await act(async () => probe.current.save(null, { name: 'n' } as never).catch((e: unknown) => e));
    expect(error).toBeInstanceOf(LimitsApiError);
    expect(error).toMatchObject({ status: 409, code: 'overlap', message: 'Overlaps another limit' });
  });

  it('a switch shows at once and the reload puts it back when the server refused', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubApi(async (c) => {
      if (c.method === 'PATCH') {
        await gate;
        return jsonResponse({ error: 'Nope', code: 'forbidden' }, 403);
      }
      if (c.path === '/api/quota/policies') return jsonResponse({ policies: [ROW] });
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => useLimits());
    await settle();
    expect(probe.current.rows[0]?.enabled).toBe(true);

    let outcome: Promise<unknown> = Promise.resolve();
    await act(async () => {
      outcome = probe.current.setEnabled(probe.current.rows[0]!, false).catch((e: unknown) => e);
    });
    // The call has not been answered yet: the switch already shows off.
    expect(probe.current.rows[0]?.enabled).toBe(false);
    release();
    const error = await act(async () => outcome);
    await settle();
    expect(error).toBeInstanceOf(LimitsApiError);
    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
    expect(probe.current.rows[0]?.enabled).toBe(true);
  });

  it('a switch that was accepted stays', async () => {
    let enabled = true;
    api((c) => {
      if (c.method === 'PATCH') {
        enabled = (c.body as { enabled: boolean }).enabled;
        return jsonResponse({});
      }
      if (c.path === '/api/quota/policies') return jsonResponse({ policies: [{ ...ROW, enabled }] });
      return undefined;
    });
    const probe = await renderHook(newTestQueryClient(), () => useLimits());
    await settle();
    await act(async () => { await probe.current.setEnabled(probe.current.rows[0]!, false); });
    await settle();
    expect(probe.current.rows[0]?.enabled).toBe(false);
  });

  it('removing names the project of the limit and reads the list again; a refusal is a LimitsApiError', async () => {
    const calls = api();
    const probe = await renderHook(newTestQueryClient(), () => useLimits());
    await settle();
    await act(async () => { await probe.current.remove(probe.current.rows[0]!); });
    expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({ path: '/api/quota/policies/q1', search: '?projectId=p1' });
    await cleanupHooks();

    api((c) => (c.method === 'DELETE' ? jsonResponse({ error: 'Cannot delete', code: 'in_use' }, 409) : undefined));
    const again = await renderHook(newTestQueryClient(), () => useLimits());
    await settle();
    const error = await act(async () => again.current.remove(again.current.rows[0]!).catch((e: unknown) => e));
    expect(error).toMatchObject({ status: 409, code: 'in_use' });
  });

  it('offers the projects as options (the name with the key), skipping what has no id', async () => {
    api();
    const probe = await renderHook(newTestQueryClient(), () => useProjectOptions());
    await settle();
    expect(probe.current).toEqual([
      { value: 'p1', label: 'Retail (retail)' },
      { value: 'p2', label: 'Bare' },
    ]);
  });

  it('offers no projects when the list cannot be read', async () => {
    api((c) => (c.path === '/api/projects' ? jsonResponse({ error: 'no' }, 500) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useProjectOptions());
    await settle();
    expect(probe.current).toEqual([]);
  });
});
