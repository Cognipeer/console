// @vitest-environment jsdom
/**
 * Configure → Tools of an agent: one list, one row per source. "This agent" holds the agent's own MCP servers, bound
 * or not; "Shared" holds the bound sources of the project. A row's tool count opens the picker on that source alone,
 * and confirming it keeps every other binding. "Add from hub / library" leaves the agent's own servers out.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { createElement as h, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  mount,
  q,
  qa,
  settle,
  type Mounted,
} from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/agents',
  useParams: () => ({}),
}));

import AgentToolsList from '@/components/agents/studio/AgentToolsList';
import { LauncherProvider, type LauncherContextValue } from '@/components/layout/launcher/LauncherContext';
import type { IAgentToolBinding } from '@/lib/database/provider/types.domain';

beforeAll(() => installDomStubs());
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

function shell(child: ReactNode) {
  const value: LauncherContextValue = {
    pinned: new Set(),
    recents: [],
    togglePin: () => {},
    recordVisit: () => {},
    services: [],
    pinnedServices: [],
    recentServices: [],
    isTenantAdmin: false,
    openLauncher: () => {},
    hydrated: true,
    canUseService: () => true,
    canWriteService: () => true,
  };
  return h(LauncherProvider, { value } as ComponentProps<typeof LauncherProvider>, child);
}

const owner = { kind: 'agent', agentId: 'agent-1' };
const tool = (name: string) => ({ name, description: '' });
const SERVERS = [
  { id: 'm1', key: 'jira-own', name: 'Jira helper', status: 'active', owner, tools: [tool('search'), tool('create'), tool('close')], disabledTools: ['close'] },
  { id: 'm2', key: 'weather-own', name: 'Weather API', status: 'disabled', owner, tools: [tool('now')] },
  { id: 'm3', key: 'github', name: 'GitHub', status: 'active', tools: [tool('list_issues'), tool('get_issue'), tool('create_issue')] },
  { id: 'm4', key: 'slack', name: 'Slack hub', status: 'active', tools: [tool('post')] },
];
const TOOLS = [
  { key: 'crm', name: 'CRM lookup', type: 'openapi', status: 'active', actions: [{ key: 'find', name: 'Find', description: '' }] },
];
const BINDINGS: IAgentToolBinding[] = [
  { source: 'mcp', sourceKey: 'jira-own', toolNames: ['search'] },
  { source: 'mcp', sourceKey: 'github', toolNames: ['list_issues'] },
  { source: 'system', sourceKey: 'web_search', toolNames: ['web_search'], config: { providerKey: 'tavily' } },
  { source: 'tool', sourceKey: 'crm', toolNames: ['find'] },
];

async function renderList(props: Partial<ComponentProps<typeof AgentToolsList>> = {}) {
  const api = installApiMock([
    ['GET', '/api/tools', () => ({ tools: TOOLS })],
    ['GET', '/api/mcp', () => ({ servers: SERVERS })],
  ]);
  const onBindingsChange = vi.fn();
  mounted = await mount(
    shell(h(AgentToolsList, { agentId: 'agent-1', bindings: BINDINGS, onBindingsChange, ...props })),
  );
  await settle(50);
  return { api, onBindingsChange };
}

const row = (id: string) => q(`[data-testid="agent-tool-row-${id}"]`);
const dialog = () => q('[role="dialog"]');

describe('the agent Tools list', () => {
  it("lists the agent's own servers (bound or not) under This agent, the bound shared sources under Shared", async () => {
    const { api } = await renderList();
    expect(api.calls.some((c) => c.path === '/api/mcp' && c.query.agentId === 'agent-1')).toBe(true);

    const own = q('[data-testid="agent-tools-own"]')!;
    const shared = q('[data-testid="agent-tools-shared"]')!;
    expect(own.textContent).toContain('Jira helper');
    expect(own.textContent).toContain('Weather API');
    expect(own.textContent).not.toContain('GitHub');
    expect(shared.textContent).toContain('GitHub');
    expect(shared.textContent).toContain('Web Search');
    expect(shared.textContent).toContain('CRM lookup');
    expect(shared.textContent).not.toContain('Jira helper');
    // A hub server the agent does not use is not listed.
    expect(document.body.textContent).not.toContain('Slack hub');

    // Counts are over the server's enabled tools; a switched-off server says so.
    expect(row('mcp::jira-own')!.textContent).toContain('1/2 tools');
    expect(row('mcp::weather-own')!.textContent).toContain('0/1 tools');
    expect(row('mcp::weather-own')!.textContent).toContain('Disabled');
    expect(row('mcp::github')!.textContent).toContain('1/3 tools');
  });

  it('removing a shared row takes only that source off the agent; own rows are managed, not removed', async () => {
    const { onBindingsChange } = await renderList();
    expect(q('[aria-label="Remove from agent: Jira helper"]')).toBeNull();
    expect(buttonByText('Manage', row('mcp::jira-own')!)).toBeTruthy();

    await click(q('[aria-label="Remove from agent: GitHub"]'));
    expect(onBindingsChange).toHaveBeenCalledWith(BINDINGS.filter((b) => b.sourceKey !== 'github'));
  });

  it("a row's tool count opens the picker on that source alone; confirming keeps every other binding", async () => {
    const { onBindingsChange } = await renderList();
    await click(buttonByText('1/3 tools', row('mcp::github')!));
    await settle(50);

    const modal = dialog()!;
    expect(modal.textContent).toContain('Tools of GitHub');
    expect(modal.textContent).not.toContain('Jira helper');
    expect(modal.textContent).not.toContain('CRM lookup');

    const boxes = qa<HTMLInputElement>('input[type="checkbox"]', modal);
    // Select all, list_issues, get_issue, create_issue
    expect(boxes).toHaveLength(4);
    await click(boxes[2]);
    await click(buttonByText('Confirm', modal));

    expect(onBindingsChange).toHaveBeenCalledTimes(1);
    const next = onBindingsChange.mock.calls[0][0] as IAgentToolBinding[];
    expect(next.find((b) => b.sourceKey === 'github')!.toolNames.sort()).toEqual(['get_issue', 'list_issues']);
    expect(next.find((b) => b.sourceKey === 'jira-own')!.toolNames).toEqual(['search']);
    expect(next.find((b) => b.sourceKey === 'crm')!.toolNames).toEqual(['find']);
    expect(next.find((b) => b.sourceKey === 'web_search')!.config).toEqual({ providerKey: 'tavily' });
  });

  it("Add from hub / library lists the project's sources without the agent's own servers", async () => {
    await renderList();
    await click(q('[data-testid="agent-tools-add"]'));
    await click(q('[data-testid="agent-tools-from-library"]'));
    await settle(50);

    const modal = dialog()!;
    expect(modal.textContent).toContain('GitHub');
    expect(modal.textContent).toContain('Slack hub');
    expect(modal.textContent).not.toContain('Jira helper');
    expect(modal.textContent).not.toContain('Weather API');
  });

  it('read-only: no Add, no remove, no delete', async () => {
    await renderList({ readOnly: true });
    expect(q('[data-testid="agent-tools-add"]')).toBeNull();
    expect(q('[aria-label^="Remove from agent"]')).toBeNull();
    expect(q('[aria-label^="Delete server"]')).toBeNull();
    expect(row('mcp::github')!.textContent).toContain('1/3 tools');
  });
});
