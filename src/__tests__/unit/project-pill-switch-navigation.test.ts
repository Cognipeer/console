// @vitest-environment jsdom
/**
 * The project switcher, rendered for real (jsdom + Mantine): switching project from a record's page
 * goes back to that record's list; switching from any other page reloads it in place.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { click, installApiMock, installDomStubs, mount, qa, settle, type Mounted } from '../helpers/iamCenterUi';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('next/navigation', () => ({ useParams: () => route.params }));

import ProjectPill from '@/components/projects/ProjectPill';

beforeAll(() => installDomStubs());

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted;

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

async function switchTo(projectName: string, at: { pathname: string; params: Record<string, string> }) {
  const reload = vi.fn();
  const assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname: at.pathname, reload, assign },
  });
  route.params = at.params;
  const api = installApiMock([
    ['GET', '/api/projects', () => ({
      projects: [{ _id: 'p-a', name: 'Alpha', key: 'alpha' }, { _id: 'p-b', name: 'Beta', key: 'beta' }],
      activeProjectId: 'p-a',
    })],
    ['POST', '/api/projects/active', () => ({ ok: true })],
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mounted = await mount(createElement(QueryClientProvider, { client }, createElement(ProjectPill)));
  await settle(200);
  await click(qa('button').find((b) => b.getAttribute('aria-label') === 'Switch project'));
  await settle(200);
  await click(qa('[role="option"]').find((o) => o.textContent?.startsWith(projectName)));
  await settle(200);
  return { api, reload, assign };
}

describe('switching project', () => {
  it('from an agent\'s page goes back to the agent list', async () => {
    const { api, reload, assign } = await switchTo('Beta', { pathname: '/dashboard/agents/a1', params: { agentId: 'a1' } });
    expect(api.to('POST', '/api/projects/active').map((c) => c.body)).toEqual([{ projectId: 'p-b' }]);
    expect(assign).toHaveBeenCalledWith('/dashboard/agents');
    expect(reload).not.toHaveBeenCalled();
  });

  it('from a list reloads it in place', async () => {
    const { reload, assign } = await switchTo('Beta', { pathname: '/dashboard/agents', params: {} });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });
});
