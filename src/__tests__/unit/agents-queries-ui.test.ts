// @vitest-environment jsdom
/**
 * The agents query hooks (src/lib/api/queries/agents.ts, skills.ts, tools.ts): project-scoped keys, what each mutation
 * does to the cache, and how a failed request reaches the screen.
 */

import { act, createElement as h, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import {
  agentsKeys,
  httpErrorOr,
  serverErrorOr,
  useAgentList,
  useAgentReminders,
  useAgentRuns,
  useAgentTemplates,
  useAttachmentBucketsQuery,
  useDeleteAgent,
  useSaveAgent,
} from '@/lib/api/queries/agents';
import { skillsKeys, useDeleteSkill, useSetSkillStatus, useSkillList } from '@/lib/api/queries/skills';
import { toolsKeys, useDeleteTool, useSetToolStatus, useToolList } from '@/lib/api/queries/tools';
import { getProjectScope } from '@/lib/api/queries/projectScope';
import { newTestQueryClient } from '../helpers/renderWithQuery';
import { installApiMock, jsonResponse, type ApiMock } from '../helpers/iamCenterUi';

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

const agentRow = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: id, key: id, name: id, config: {}, status: 'active', createdAt: '2026-01-01', ...extra,
});

describe('agents keys', () => {
  it('start with the resource and the project marker, each a prefix of the ones below', () => {
    expect(agentsKeys.list('project:3')).toEqual(['agents', 'project:3', 'list']);
    const agent = agentsKeys.agent('project:3', 'a1');
    expect(agentsKeys.reminders('project:3', 'a1', 'active').slice(0, agent.length)).toEqual([...agent]);
    expect(agentsKeys.runs('project:3', 'a1', 'limit=200').slice(0, agent.length)).toEqual([...agent]);
    expect(skillsKeys.list('project:3')).toEqual(['skills', 'project:3', 'list']);
    expect(toolsKeys.list('project:3')).toEqual(['tools', 'project:3', 'list']);
  });
});

describe('error text of refused requests', () => {
  it('uses the server text, else the fallback; a lost connection keeps its own message', () => {
    const refused = new ApiError('Bad', 400, { error: 'Key is taken' });
    const bare = new ApiError('Bad', 500, {});
    expect(serverErrorOr(refused, 'Failed')).toBe('Key is taken');
    expect(serverErrorOr(bare, 'Failed')).toBe('Failed');
    expect(serverErrorOr(new Error('offline'), 'Failed')).toBe('offline');
    expect(httpErrorOr(refused)).toBe('Key is taken');
    expect(httpErrorOr(bare)).toBe('HTTP 500');
  });
});

describe('agent list hooks', () => {
  let api: ApiMock;
  let agents: Array<Record<string, unknown>>;

  beforeEach(() => {
    agents = [agentRow('a1'), agentRow('flow-owned', { config: { ownerFlowId: 'f1' } })];
    api = installApiMock([
      ['GET', '/api/agents', () => ({ agents })],
      ['POST', '/api/agents', () => {
        agents.push(agentRow('a2'));
        return jsonResponse({ agent: { _id: 'a2' } }, 201);
      }],
      ['PATCH', '/api/agents/a1', () => ({ agent: { _id: 'a1' } })],
      ['DELETE', '/api/agents/a1', () => {
        agents.splice(0, 1);
        return jsonResponse({ success: true });
      }],
    ]);
  });

  it('creating or updating refreshes the list; deleting drops what the agent owned', async () => {
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({ list: useAgentList(), save: useSaveAgent(), remove: useDeleteAgent() }));
    await settle();
    expect(probe.current.list.data?.map((a) => a._id)).toContain('a1');

    await act(async () => {
      await probe.current.save.mutateAsync({ body: { name: 'Two' } });
    });
    await settle();
    expect(api.to('GET', '/api/agents')).toHaveLength(2);
    expect(probe.current.list.data?.map((a) => a._id)).toContain('a2');

    await act(async () => {
      await probe.current.save.mutateAsync({ id: 'a1', body: { name: 'One' } });
    });
    expect(api.to('PATCH', '/api/agents/a1')[0].body).toEqual({ name: 'One' });

    client.setQueryData(agentsKeys.runs(getProjectScope(), 'a1', 'limit=200'), [{ id: 'r1' }]);
    await act(async () => {
      await probe.current.remove.mutateAsync('a1');
    });
    await settle();
    expect(client.getQueryData(agentsKeys.runs(getProjectScope(), 'a1', 'limit=200'))).toBeUndefined();
    expect(probe.current.list.data?.map((a) => a._id)).not.toContain('a1');
  });

  it('a failed list read reaches the screen as the error', async () => {
    api.on('GET', '/api/agents', () => jsonResponse({ error: 'Nope' }, 403));
    const probe = await renderHook(newTestQueryClient(), () => useAgentList());
    await settle();
    expect(probe.current.isError).toBe(true);
    expect((probe.current.error as Error).message).toBe('Nope');
  });

  it('a refused create keeps the server text for the form', async () => {
    api.on('POST', '/api/agents', () => jsonResponse({ error: 'Key is taken' }, 409));
    const probe = await renderHook(newTestQueryClient(), () => useSaveAgent());
    let failure: unknown;
    await act(async () => {
      await probe.current.mutateAsync({ body: {} }).catch((error) => { failure = error; });
    });
    expect(serverErrorOr(failure, 'Failed to create')).toBe('Key is taken');
  });
});

describe('templates, buckets, reminders and runs', () => {
  it('templates default the catalog version; a 403 on buckets is a result, any other failure an error', async () => {
    const api = installApiMock([
      ['GET', '/api/agents/templates', () => ({ templates: [{ key: 'x' }] })],
      ['GET', '/api/agents/attachments/buckets', () => jsonResponse({ error: 'No access to the Document Store' }, 403)],
    ]);
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      templates: useAgentTemplates(),
      buckets: useAttachmentBucketsQuery(true),
    }));
    await settle();
    expect(probe.current.templates.data).toEqual({ templates: [{ key: 'x' }], catalogVersion: 0 });
    expect(probe.current.buckets.data).toEqual({ status: 'forbidden', message: 'No access to the Document Store' });

    api.on('GET', '/api/agents/attachments/buckets', () => jsonResponse({ error: 'boom' }, 500));
    await act(async () => { await probe.current.buckets.refetch(); });
    await settle();
    expect(client.getQueryState(agentsKeys.attachmentBuckets(getProjectScope()))?.status).toBe('error');
  });

  it('reminders and runs poll while something can still change, and stop once nothing can', async () => {
    const api = installApiMock([
      ['GET', '/api/agents/a1/reminders', () => ({ reminders: [{ id: 'r1', status: 'scheduled' }], summary: { active: 1 } })],
      ['GET', '/api/agents/a1/runs', () => ({ runs: [{ id: 'run1', status: 'succeeded' }] })],
    ]);
    const client = newTestQueryClient();
    const probe = await renderHook(client, () => ({
      reminders: useAgentReminders('a1', 'active'),
      runs: useAgentRuns('a1', 'limit=200'),
    }));
    await settle();
    expect(probe.current.reminders.data?.reminders).toHaveLength(1);
    expect(api.to('GET', '/api/agents/a1/reminders')[0].query).toEqual({ status: 'active', limit: '200' });
    expect(api.to('GET', '/api/agents/a1/runs')[0].query).toEqual({ limit: '200' });

    const interval = (key: readonly unknown[], data: unknown) => {
      const option = (client.getQueryCache().find({ queryKey: key })!.options as { refetchInterval?: (q: unknown) => number | false }).refetchInterval!;
      return option({ state: { data, error: null } });
    };
    const project = getProjectScope();
    const running = { runs: [{ id: 'run1', status: 'running' }] };
    expect(interval(agentsKeys.runs(project, 'a1', 'limit=200'), [{ status: 'running' }])).toBe(5_000);
    expect(interval(agentsKeys.runs(project, 'a1', 'limit=200'), running.runs.map((r) => ({ ...r, status: 'failed' })))).toBe(false);
    expect(interval(agentsKeys.reminders(project, 'a1', 'active'), { reminders: [{ status: 'scheduled' }] })).toBe(15_000);
    expect(interval(agentsKeys.reminders(project, 'a1', 'active'), { reminders: [{ status: 'canceled' }] })).toBe(false);
  });
});

describe('skills and tools lists', () => {
  it('toggling and deleting refresh the list; the failure of a toggle reaches the screen', async () => {
    let skills = [{ _id: 's1', key: 's1', title: 'One', header: 'h', status: 'active' }];
    let tools = [{ id: 't1', key: 't1', name: 'One', type: 'openapi', status: 'active' }];
    const api = installApiMock([
      ['GET', '/api/skills', () => ({ skills })],
      ['PATCH', '/api/skills/s1', () => ({ skill: {} })],
      ['DELETE', '/api/skills/s1', () => { skills = []; return { success: true }; }],
      ['GET', '/api/tools', () => ({ tools })],
      ['PUT', '/api/tools/t1', () => jsonResponse({ error: 'Managed by a connector' }, 409)],
      ['DELETE', '/api/tools/t1', () => { tools = []; return { success: true }; }],
    ]);
    const probe = await renderHook(newTestQueryClient(), () => ({
      skills: useSkillList(),
      setSkill: useSetSkillStatus(),
      deleteSkill: useDeleteSkill(),
      tools: useToolList(),
      setTool: useSetToolStatus(),
      deleteTool: useDeleteTool(),
    }));
    await settle();
    expect(probe.current.skills.data).toHaveLength(1);
    expect(probe.current.tools.data).toHaveLength(1);

    await act(async () => { await probe.current.setSkill.mutateAsync({ id: 's1', status: 'inactive' }); });
    expect(api.to('PATCH', '/api/skills/s1')[0].body).toEqual({ status: 'inactive' });
    await settle();
    expect(api.to('GET', '/api/skills')).toHaveLength(2);

    let failure: unknown;
    await act(async () => { await probe.current.setTool.mutateAsync({ id: 't1', status: 'disabled' }).catch((e) => { failure = e; }); });
    expect(api.to('PUT', '/api/tools/t1')[0].body).toEqual({ status: 'disabled' });
    expect((failure as Error).message).toBe('Managed by a connector');

    await act(async () => { await probe.current.deleteSkill.mutateAsync('s1'); });
    await act(async () => { await probe.current.deleteTool.mutateAsync('t1'); });
    await settle();
    expect(probe.current.skills.data).toEqual([]);
    expect(probe.current.tools.data).toEqual([]);
  });
});
