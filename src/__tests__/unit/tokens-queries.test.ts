// @vitest-environment jsdom
/**
 * The token query hooks: their keys, what a write does to the cached lists, how a refusal reaches the screen.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  tokenRoutes,
  tokensKeys,
  useCreateToken,
  useDeleteToken,
  useTokenPolicyQuery,
  useTokens,
  useUpdateToken,
} from '@/lib/api/queries/tokens';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { jsonResponse } from '../helpers/iamCenterUi';
import { cleanupHooks, renderHook, settle, stubApi } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

const ROWS = [
  { _id: 't1', label: 'One', createdAt: '2026-01-01' },
  { _id: 't2', label: 'Two', createdAt: '2026-01-02' },
];

describe('token hooks', () => {
  it('keys start with the resource and the project marker; the workspace and a project are two lists', () => {
    const prefix = [...tokensKeys.project('project:1')];
    expect(tokensKeys.list('project:1').slice(0, 2)).toEqual(prefix);
    expect(tokensKeys.policy('project:1').slice(0, 2)).toEqual(prefix);
    expect(tokensKeys.list('project:1')).not.toEqual(tokensKeys.list('project:1', 'p1'));
    expect(tokensKeys.list('project:1', 'p1').slice(0, 3)).toEqual([...tokensKeys.lists('project:1')]);
  });

  it('reads the tokens of the workspace or of one project from their own routes', async () => {
    const calls = stubApi(() => jsonResponse({ tokens: ROWS }));
    const probe = await renderHook(newTestQueryClient(), () => ({ all: useTokens(), project: useTokens('p 1') }));
    await settle();
    expect(probe.current.all.data).toEqual({ tokens: ROWS, forbidden: false });
    expect(probe.current.project.data?.tokens).toHaveLength(2);
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/projects/p%201/tokens', '/api/tokens']);
    expect(tokenRoutes('p 1').item('t/1')).toBe('/api/projects/p%201/tokens/t%2F1');
    expect(tokenRoutes().item('t1')).toBe('/api/tokens/t1');
  });

  it('a 403 is an answer (forbidden), any other failure is an error with the status', async () => {
    stubApi(() => jsonResponse({ error: 'Forbidden' }, 403));
    let probe = await renderHook(newTestQueryClient(), () => useTokens());
    await settle();
    expect(probe.current.data).toEqual({ tokens: [], forbidden: true });
    await cleanupHooks();

    stubApi(() => jsonResponse({ error: 'Boom' }, 500));
    probe = await renderHook(newTestQueryClient(), () => useTokens());
    await settle();
    expect(probe.current.isError).toBe(true);
    expect(probe.current.error).toMatchObject({ status: 500, message: 'Boom' });
  });

  it('minting a token posts to the given route and reads the lists again', async () => {
    const calls = stubApi((c) => (c.method === 'POST' ? jsonResponse({ token: 'secret', label: 'New' }) : jsonResponse({ tokens: ROWS })));
    const probe = await renderHook(newTestQueryClient(), () => ({ list: useTokens(), create: useCreateToken('/api/tokens') }));
    await settle();
    let created: Record<string, unknown> | undefined;
    await act(async () => {
      created = await probe.current.create.mutateAsync({ label: 'New' });
    });
    await settle();
    expect(created?.token).toBe('secret');
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/tokens', body: { label: 'New' } });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('a refused create carries the server body, so the form can name the problem', async () => {
    stubApi(() => jsonResponse({ error: 'Too long', code: 'token_expiry_too_long', details: { maxLifetimeDays: 30 } }, 400));
    const probe = await renderHook(newTestQueryClient(), () => useCreateToken('/api/tokens'));
    await act(async () => {
      await probe.current.mutateAsync({ label: 'x' }).catch(() => undefined);
    });
    await settle();
    expect(probe.current.error).toMatchObject({ status: 400, payload: { code: 'token_expiry_too_long', details: { maxLifetimeDays: 30 } } });
  });

  it('saving a token merges what the server saved into the cached list, without reading it again', async () => {
    const calls = stubApi((c) =>
      c.method === 'PUT' ? jsonResponse({ _id: 't1', label: 'Renamed' }) : jsonResponse({ tokens: ROWS }),
    );
    const probe = await renderHook(newTestQueryClient(), () => ({
      list: useTokens(),
      update: useUpdateToken(tokenRoutes().item),
    }));
    await settle();
    await act(async () => {
      await probe.current.update.mutateAsync({ id: 't1', body: { label: 'Renamed' } });
    });
    await settle();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/api/tokens/t1', body: { label: 'Renamed' } });
    expect(probe.current.list.data?.tokens.map((t) => t.label)).toEqual(['Renamed', 'Two']);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('deleting a token calls its own route and reads the lists again', async () => {
    const calls = stubApi((c) => (c.method === 'DELETE' ? jsonResponse({ success: true }) : jsonResponse({ tokens: ROWS })));
    const probe = await renderHook(newTestQueryClient(), () => ({ list: useTokens('p1'), remove: useDeleteToken('p1') }));
    await settle();
    await act(async () => {
      await probe.current.remove.mutateAsync('t1');
    });
    await settle();
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/projects/p1/tokens/t1');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('reads the token rules normalized, only while enabled, and a failure leaves no data', async () => {
    const calls = stubApi(() => jsonResponse({ maxLifetimeDays: 30, requireExpiry: false }));
    const client = newTestQueryClient();
    await renderHook(client, () => useTokenPolicyQuery(false));
    await settle();
    expect(calls).toHaveLength(0);
    await cleanupHooks();

    const calls2 = stubApi(() => jsonResponse({ maxLifetimeDays: 30, requireExpiry: false }));
    const probe = await renderHook(client, () => useTokenPolicyQuery(true));
    await settle();
    expect(calls2.map((c) => c.path)).toEqual(['/api/tokens/policy']);
    expect(probe.current.data).toMatchObject({ maxLifetimeDays: 30, expiryRequired: true });
    await cleanupHooks();

    stubApi(() => jsonResponse({ error: 'Nope' }, 500));
    const failed = await renderHook(newTestQueryClient(), () => useTokenPolicyQuery(true));
    await settle();
    expect(failed.current.data).toBeUndefined();
    expect(failed.current.isError).toBe(true);
  });
});
