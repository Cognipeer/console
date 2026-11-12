// @vitest-environment jsdom
/**
 * The Settings query hooks (license, audit log): keys, what a license write reloads, how a failure reaches the screen.
 */

import { act, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  settingsKeys,
  useApplyLicense,
  useAuditLogs,
  useAuditServices,
  useLicense,
  useResetLicense,
} from '@/lib/api/queries/settings';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { jsonResponse } from '../helpers/iamCenterUi';
import { cleanupHooks, renderHook, settle, stubApi } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

describe('settings hooks', () => {
  it('keys start with the resource and the project marker, and every read sits under the project prefix', () => {
    const prefix = [...settingsKeys.project('project:2')];
    expect(settingsKeys.license('project:2').slice(0, 2)).toEqual(prefix);
    expect(settingsKeys.auditLogs('project:2', 'limit=26').slice(0, 2)).toEqual(prefix);
    expect(settingsKeys.auditLogs('project:2', 'limit=26')).not.toEqual(settingsKeys.auditLogs('project:2', 'limit=26&skip=25'));
    expect(settingsKeys.auditServices('project:2').slice(0, 2)).toEqual(prefix);
  });

  it('applying a license posts the key as JSON and reads the license again', async () => {
    const calls = stubApi((c) => (c.method === 'POST' ? jsonResponse({ ok: true }) : jsonResponse({ license: { status: 'active' } })));
    const probe = await renderHook(newTestQueryClient(), () => ({ license: useLicense<{ license: { status: string } }>(), apply: useApplyLicense() }));
    await settle();
    expect(probe.current.license.data?.license.status).toBe('active');
    await act(async () => {
      await probe.current.apply.mutateAsync('KEY-123');
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/license', body: { licenseKey: 'KEY-123' } });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('removing the license calls DELETE and reads the license again', async () => {
    const calls = stubApi((c) => (c.method === 'DELETE' ? jsonResponse({ ok: true }) : jsonResponse({ license: { status: 'free' } })));
    const probe = await renderHook(newTestQueryClient(), () => ({ license: useLicense(), reset: useResetLicense() }));
    await settle();
    await act(async () => {
      await probe.current.reset.mutateAsync();
    });
    await settle();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('a refused license carries the status and the server message to the screen', async () => {
    stubApi(() => jsonResponse({ error: 'License key is not valid' }, 400));
    const probe = await renderHook(newTestQueryClient(), () => useApplyLicense());
    await act(async () => {
      await probe.current.mutateAsync('bad').catch(() => undefined);
    });
    await settle();
    expect(probe.current.error).toMatchObject({ status: 400, message: 'License key is not valid' });
  });

  it('reads an audit page with the filters it is given, and the services to filter by', async () => {
    const calls = stubApi((c) =>
      c.path === '/api/audit/services' ? jsonResponse({ services: [{ id: 'models', label: 'Models' }] }) : jsonResponse({ logs: [{ id: 'a' }], total: 1 }),
    );
    const probe = await renderHook(newTestQueryClient(), () => ({
      logs: useAuditLogs<{ logs: unknown[] }>('q=boom&limit=26&skip=0'),
      services: useAuditServices<{ services: unknown[] }>(),
    }));
    await settle();
    expect(probe.current.logs.data?.logs).toHaveLength(1);
    expect(probe.current.services.data?.services).toHaveLength(1);
    expect(calls.find((c) => c.path === '/api/audit/logs')?.search).toBe('?q=boom&limit=26&skip=0');
  });

  it('while another audit page loads, the rows of the one before stay', async () => {
    let gate: Promise<void> | null = null;
    stubApi(async (c) => {
      if (c.path !== '/api/audit/logs') return undefined;
      if (gate) await gate;
      return jsonResponse({ logs: [{ id: c.search }] });
    });
    const probe = await renderHook(newTestQueryClient(), () => {
      const [filters, setFilters] = useState('skip=0');
      return { logs: useAuditLogs<{ logs: Array<{ id: string }> }>(filters), setFilters };
    });
    await settle();
    expect(probe.current.logs.data?.logs[0]?.id).toBe('?skip=0');

    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => probe.current.setFilters('skip=25'));
    expect(probe.current.logs.isFetching).toBe(true);
    expect(probe.current.logs.data?.logs[0]?.id).toBe('?skip=0');
    release();
    await settle();
    expect(probe.current.logs.data?.logs[0]?.id).toBe('?skip=25');
  });

  it('a failed audit read carries the status and the server message', async () => {
    stubApi(() => jsonResponse({ error: 'Slow down' }, 429));
    const probe = await renderHook(newTestQueryClient(), () => useAuditLogs('skip=0'));
    await settle();
    expect(probe.current.error).toMatchObject({ status: 429, message: 'Slow down' });
  });
});
