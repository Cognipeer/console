// @vitest-environment jsdom
/**
 * The Webhooks query hooks: keys, the list and the catalog read together, the page-by-page deliveries, and what a
 * write reloads.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELIVERY_PAGE,
  useDeleteWebhook,
  useRedeliverWebhook,
  useRestartWebhookDeliveries,
  useRotateWebhookSecret,
  useSaveWebhook,
  useSendWebhookTest,
  useSetWebhookStatus,
  useWebhookDeliveries,
  useWebhooks,
  webhooksKeys,
} from '@/lib/api/queries/webhooks';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { jsonResponse } from '../helpers/iamCenterUi';
import { cleanupHooks, renderHook, settle, stubApi, type RecordedCall } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

const ENDPOINT = { id: 'w1', url: 'https://example.com/hook', events: ['alert.fired'], status: 'active' };

function api(extra: (c: RecordedCall) => Response | undefined = () => undefined) {
  return stubApi((c) => {
    const answer = extra(c);
    if (answer) return answer;
    if (c.method === 'GET' && c.path === '/api/webhooks') return jsonResponse({ endpoints: [ENDPOINT], capabilities: { manage: true, workspaceScope: false } });
    if (c.method === 'GET' && c.path === '/api/webhooks/events') return jsonResponse({ events: [{ type: 'alert.fired', group: 'alert' }] });
    return jsonResponse({ ok: true });
  });
}

describe('webhook hooks', () => {
  it('keys start with the resource and the project marker', () => {
    const prefix = [...webhooksKeys.project('project:1')];
    expect(webhooksKeys.list('project:1').slice(0, 2)).toEqual(prefix);
    expect(webhooksKeys.deliveries('project:1', 'w1').slice(0, 2)).toEqual(prefix);
    expect(webhooksKeys.deliveries('project:1', 'w1')).not.toEqual(webhooksKeys.deliveries('project:1', 'w2'));
  });

  it('reads the endpoints and the event catalog together', async () => {
    const calls = api();
    const probe = await renderHook(newTestQueryClient(), () => useWebhooks());
    await settle();
    expect(probe.current.data?.forbidden).toBe(false);
    expect(probe.current.data?.list?.endpoints).toHaveLength(1);
    expect(probe.current.data?.catalog).toEqual([{ type: 'alert.fired', group: 'alert' }]);
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/webhooks', '/api/webhooks/events']);
  });

  it('a catalog that cannot be read leaves the list; a 403 on the list is an answer; any other failure is an error', async () => {
    api((c) => (c.path === '/api/webhooks/events' ? jsonResponse({ error: 'no' }, 500) : undefined));
    let probe = await renderHook(newTestQueryClient(), () => useWebhooks());
    await settle();
    expect(probe.current.data?.catalog).toEqual([]);
    expect(probe.current.data?.list?.endpoints).toHaveLength(1);
    await cleanupHooks();

    api((c) => (c.path === '/api/webhooks' ? jsonResponse({ error: 'Forbidden' }, 403) : undefined));
    probe = await renderHook(newTestQueryClient(), () => useWebhooks());
    await settle();
    expect(probe.current.data).toMatchObject({ forbidden: true, list: null });
    await cleanupHooks();

    api((c) => (c.path === '/api/webhooks' ? jsonResponse({ error: 'Boom' }, 500) : undefined));
    probe = await renderHook(newTestQueryClient(), () => useWebhooks());
    await settle();
    expect(probe.current.error).toMatchObject({ status: 500, message: 'Boom' });
  });

  it('creating posts the body and answers with the endpoint (and its secret); editing patches it; both reload the list', async () => {
    const calls = api((c) =>
      c.method === 'POST' && c.path === '/api/webhooks' ? jsonResponse({ endpoint: { ...ENDPOINT, secret: 's3cret' } }, 201) : undefined,
    );
    const probe = await renderHook(newTestQueryClient(), () => ({ list: useWebhooks(), save: useSaveWebhook() }));
    await settle();
    let created: Awaited<ReturnType<typeof probe.current.save.mutateAsync>> | undefined;
    await act(async () => {
      created = await probe.current.save.mutateAsync({ body: { url: 'https://example.com/hook', events: ['alert.fired'] } });
    });
    await settle();
    expect((created as { endpoint: { secret?: string } }).endpoint.secret).toBe('s3cret');
    await act(async () => {
      await probe.current.save.mutateAsync({ id: 'w1', body: { description: 'd' } });
    });
    await settle();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/webhooks', body: { events: ['alert.fired'] } });
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/webhooks/w1', body: { description: 'd' } });
    expect(calls.filter((c) => c.path === '/api/webhooks' && c.method === 'GET')).toHaveLength(3);
  });

  it('status, rotate and delete reload the list; a test event does not', async () => {
    const calls = api((c) => (c.path.endsWith('/test') ? jsonResponse({ delivery: { id: 'd1', status: 'delivered' } }) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => ({
      list: useWebhooks(),
      status: useSetWebhookStatus(),
      test: useSendWebhookTest(),
      rotate: useRotateWebhookSecret(),
      remove: useDeleteWebhook(),
    }));
    await settle();
    const listReads = () => calls.filter((c) => c.path === '/api/webhooks' && c.method === 'GET').length;
    expect(listReads()).toBe(1);

    await act(async () => { await probe.current.test.mutateAsync('w1'); });
    await settle();
    expect(calls.find((c) => c.path === '/api/webhooks/w1/test')?.method).toBe('POST');
    expect(listReads()).toBe(1);

    await act(async () => { await probe.current.status.mutateAsync({ id: 'w1', status: 'disabled' }); });
    await settle();
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/webhooks/w1', body: { status: 'disabled' } });
    expect(listReads()).toBe(2);

    await act(async () => { await probe.current.rotate.mutateAsync('w1'); });
    await settle();
    expect(calls.find((c) => c.path === '/api/webhooks/w1/rotate-secret')?.method).toBe('POST');
    expect(listReads()).toBe(3);

    await act(async () => { await probe.current.remove.mutateAsync('w1'); });
    await settle();
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/webhooks/w1');
    expect(listReads()).toBe(4);
  });

  it('a refused write carries the status and the server message', async () => {
    api((c) => (c.method === 'PATCH' ? jsonResponse({ error: 'URL is not allowed' }, 400) : undefined));
    const probe = await renderHook(newTestQueryClient(), () => useSaveWebhook());
    await act(async () => {
      await probe.current.mutateAsync({ id: 'w1', body: {} }).catch(() => undefined);
    });
    await settle();
    expect(probe.current.error).toMatchObject({ status: 400, message: 'URL is not allowed' });
  });

  it('deliveries load a page at a time, the next one after the rows already shown, and a restart goes back to the first', async () => {
    const delivery = (n: number) => ({ id: `d${n}`, eventType: 'alert.fired', eventId: `e${n}`, status: 'delivered', attempts: 1, createdAt: '2026-01-01' });
    const calls = api((c) => {
      if (!c.path.endsWith('/deliveries')) return undefined;
      const skip = Number(new URLSearchParams(c.search).get('skip'));
      return jsonResponse({ deliveries: skip === 0 ? [delivery(1), delivery(2)] : [delivery(3)], hasMore: skip === 0 });
    });
    const probe = await renderHook(newTestQueryClient(), () => ({
      deliveries: useWebhookDeliveries('w1'),
      restart: useRestartWebhookDeliveries('w1'),
      redeliver: useRedeliverWebhook(),
    }));
    await settle();
    const rows = () => probe.current.deliveries.data?.pages.flatMap((page) => page.deliveries.map((d) => d.id));
    expect(rows()).toEqual(['d1', 'd2']);
    expect(probe.current.deliveries.hasNextPage).toBe(true);
    expect(calls[calls.length - 1]?.search).toBe(`?limit=${DELIVERY_PAGE}&skip=0`);

    await act(async () => { await probe.current.deliveries.fetchNextPage(); });
    await settle();
    expect(rows()).toEqual(['d1', 'd2', 'd3']);
    expect(probe.current.deliveries.hasNextPage).toBe(false);
    expect(calls[calls.length - 1]?.search).toBe(`?limit=${DELIVERY_PAGE}&skip=2`);

    await act(async () => { await probe.current.restart(); });
    await settle();
    expect(rows()).toEqual(['d1', 'd2']);

    await act(async () => { await probe.current.redeliver.mutateAsync('d1'); });
    expect(calls.find((c) => c.path === '/api/webhooks/deliveries/d1/redeliver')?.method).toBe('POST');
  });
});
