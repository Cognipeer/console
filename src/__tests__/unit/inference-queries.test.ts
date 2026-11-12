// @vitest-environment jsdom
/**
 * The Inference Monitoring query hooks: their keys and what each mutation does to the cache.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inferenceKeys,
  useCreateInferenceServer,
  useDeleteInferenceServer,
  useInferenceDashboard,
  useInferenceServer,
  useInferenceServers,
  usePollInferenceServer,
} from '@/lib/api/queries/inference';
import { cleanupHooks, newHookClient, renderHook, settle, stubFetch, until } from '../helpers/queryHookHarness';

afterEach(cleanupHooks);

const server = { _id: 's1', key: 's1', name: 'One', type: 'vllm', baseUrl: 'http://x', status: 'active', pollIntervalSeconds: 60, createdAt: '' };

describe('Inference Monitoring hooks', () => {
  it('keys start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(inferenceKeys.list('project:2')).toEqual(['inference', 'project:2', 'list']);
    const detail = inferenceKeys.detail('project:2', 's1');
    expect(inferenceKeys.metrics('project:2', 's1', 'limit=5').slice(0, detail.length)).toEqual([...detail]);
  });

  it('creating a server reads the list and the dashboard again', async () => {
    let servers = [server];
    const calls = stubFetch({
      'GET /api/inference-monitoring/servers': () => ({ servers }),
      'GET /api/inference-monitoring/dashboard': { overview: { totalServers: 1 }, typeBreakdown: [], servers: [] },
      'POST /api/inference-monitoring/servers': () => {
        servers = [...servers, { ...server, _id: 's2', key: 's2' }];
        return { status: 201, body: { server: servers[1] } };
      },
    });
    const probe = await renderHook(newHookClient(), () => ({
      list: useInferenceServers(),
      dashboard: useInferenceDashboard('period=7d'),
      create: useCreateInferenceServer(),
    }));
    await settle();
    expect(probe.current.list.data).toHaveLength(1);
    expect(calls.find((c) => c.path.endsWith('/dashboard'))?.query).toEqual({ period: '7d' });

    await act(async () => {
      await probe.current.create.mutateAsync({ name: 'Two', type: 'vllm', baseUrl: 'http://y', apiKey: '', pollIntervalSeconds: 60 });
    });
    await settle();
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith('/servers'))).toHaveLength(2);
    expect(calls.filter((c) => c.path.endsWith('/dashboard'))).toHaveLength(2);
    expect(probe.current.list.data).toHaveLength(2);
  });

  it('a poll that failed still reads the server again, and a delete drops it', async () => {
    const calls = stubFetch({
      'GET /api/inference-monitoring/servers/s1': { server },
      'GET /api/inference-monitoring/servers': { servers: [server] },
      'POST /api/inference-monitoring/servers/s1/poll': { status: 502, body: { error: 'unreachable' } },
      'DELETE /api/inference-monitoring/servers/s1': { success: true },
    });
    const probe = await renderHook(newHookClient(), () => ({
      detail: useInferenceServer('s1'),
      list: useInferenceServers(),
      poll: usePollInferenceServer('s1'),
      remove: useDeleteInferenceServer('s1'),
    }));
    await until(() => probe.current.detail.data && probe.current.list.data, 'the server and the list');

    let failure: unknown;
    await act(async () => {
      await probe.current.poll.mutateAsync().catch((error: unknown) => {
        failure = error;
      });
    });
    const reads = (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;
    await until(() => reads('/api/inference-monitoring/servers/s1') === 2, 'the server read again');
    expect((failure as Error).message).toBe('unreachable');

    await act(async () => {
      await probe.current.remove.mutateAsync();
    });
    // The list the server was on is read again.
    await until(() => reads('/api/inference-monitoring/servers') >= 3, 'the list read again');
  });
});
