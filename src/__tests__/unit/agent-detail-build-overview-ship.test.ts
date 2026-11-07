// @vitest-environment jsdom
/**
 * The agent page, read as a whole: Build lists its sections in a fixed order with an index beside them, folds the
 * ones the agent does not use into one line, and says what is not saved yet (with a way back); Overview gathers what
 * needs attention and shows where the agent runs and what it uses; Ship opens with what is live and what publishing
 * would change; the header carries a "Draft" badge and the less frequent actions in one menu.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buttonByText, click, installApiMock, installDomStubs, mount, q, qa, settle, text, type Mounted } from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/agents',
}));

import ConfigSection, { ConfigBlock } from '@/components/agents/studio/ConfigSection';
import BuildSectionIndex, { type BuildIndexGroup } from '@/components/agents/studio/BuildSectionIndex';
import AgentOverviewAside, { splitAgentUsedBy } from '@/components/agents/studio/AgentOverviewAside';
import AgentOverviewPanel from '@/components/agents/studio/AgentOverviewPanel';
import { toolNameBreaks } from '@/components/agents/studio/AgentHumanInTheLoopPanel';
import type { ResourceEdgeView } from '@/components/resources/ResourceUsagePanel';
import type { ResourceUsageResponse } from '@/components/common/confirm';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

beforeAll(() => installDomStubs());
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  mounted = await mount(node);
  await settle(50);
}

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (acc, [key, inner]) => ({ ...acc, ...flatten(inner, prefix ? `${prefix}.${key}` : key) }),
    {},
  );
}
const placeholders = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const edge = (type: string, name: string, status: ResourceEdgeView['status'] = 'ok', direction: 'in' | 'out' = 'in'): ResourceEdgeView => ({
  kind: 'ref',
  field: `${type}Key`,
  direction,
  status,
  severity: status === 'missing' ? 'error' : status === 'ok' ? null : 'warning',
  other: { type, id: `${type}-1`, key: `${type}-key`, name, projectId: 'p1', projectName: 'Default', projectDisplay: null, crn: null },
});

describe('messages', () => {
  it('English and Turkish carry the same keys and placeholders for the new agent-page texts', () => {
    const agentsEn = en.agents as unknown as Record<string, unknown>;
    const agentsTr = tr.agents as unknown as Record<string, unknown>;
    for (const block of ['build', 'header', 'overview', 'ship', 'versions']) {
      const a = flatten(agentsEn[block]);
      const b = flatten(agentsTr[block]);
      expect(Object.keys(b).sort(), block).toEqual(Object.keys(a).sort());
      for (const key of Object.keys(a)) expect(placeholders(b[key]), `${block}.${key}`).toEqual(placeholders(a[key]));
    }
  });
});

describe('Build sections', () => {
  it('a section the agent does not use is one line with "Set up", which opens it', async () => {
    const onSetUp = vi.fn();
    await render(h(ConfigSection, {
      id: 'skills',
      title: 'Skills',
      description: 'Capabilities on demand.',
      unset: true,
      onSetUp,
      children: h('div', { 'data-testid': 'skills-form' }, 'form'),
    }));
    expect(q('[data-unset="true"]')?.id).toBe('config-skills');
    expect(text()).toContain('Not set · Capabilities on demand.');
    expect(q('[data-testid="skills-form"]')).toBeNull();
    await click(q('[data-testid="config-setup-skills"]'));
    expect(onSetUp).toHaveBeenCalledTimes(1);
  });

  it('read-only: no "Set up" button; a section in use renders its fields', async () => {
    await render(h('div', null,
      h(ConfigSection, { id: 'memory', title: 'Memory', unset: true, children: h('span', null, 'x') }),
      h(ConfigSection, { id: 'files', title: 'Files', changed: true, children: h('span', { 'data-testid': 'files-form' }, 'y') }),
    ));
    expect(q('[data-testid="config-setup-memory"]')).toBeNull();
    expect(q('[data-testid="files-form"]')).not.toBeNull();
    expect(q('#config-files')?.getAttribute('data-unset')).toBeNull();
    expect(text()).toContain('Changed');
  });

  it('a block inside a long section can carry its own anchor', async () => {
    await render(h(ConfigBlock, { id: 'tools', title: 'Tools', children: h('span', null, 'z') }));
    expect(q('#config-tools')).not.toBeNull();
  });
});

describe('Build index', () => {
  const groups: BuildIndexGroup[] = [
    {
      id: 'essentials',
      title: 'Essentials',
      items: [
        { id: 'basic', title: 'General', parts: [{ id: 'tools', title: 'Tools' }] },
        { id: 'prompt', title: 'Prompt', state: 'changed' },
      ],
    },
    { id: 'capabilities', title: 'Capabilities', items: [{ id: 'skills', title: 'Skills', state: 'unset' }] },
    { id: 'behavior', title: 'Behavior', items: [] },
  ];

  it('lists the groups that have sections, marks changed ● and not set ○, and jumps on click', async () => {
    const onJump = vi.fn();
    await render(h(BuildSectionIndex, { groups, onJump }));
    const nav = q('[data-testid="build-section-index"]')!;
    expect(nav.textContent).toContain('Essentials');
    expect(nav.textContent).toContain('Capabilities');
    expect(nav.textContent).not.toContain('Behavior');
    expect(q('[data-section="prompt"] [data-state="changed"]')?.textContent).toBe('●');
    expect(q('[data-section="skills"] [data-state="unset"]')?.textContent).toBe('○');
    expect(q('[data-section="basic"] [data-state]')).toBeNull();
    await click(q('[data-section="skills"]'));
    expect(onJump).toHaveBeenLastCalledWith('skills');
    expect(q('[data-section="skills"]')?.getAttribute('aria-current')).toBe('location');
    await click(q('[data-section="tools"]'));
    expect(onJump).toHaveBeenLastCalledWith('tools');
  });
});

describe('Overview: where it runs and what it uses', () => {
  const usage = (usedBy: ResourceEdgeView[], uses: ResourceEdgeView[] = []): ResourceUsageResponse => ({
    resource: { type: 'agent', id: 'a1', key: 'a', name: 'A', projectId: 'p1', projectName: 'Default', projectDisplay: null, crn: null },
    uses,
    usedBy,
    hiddenUsedByCount: 0,
    hiddenByType: {},
    summary: { error: 0, warning: 0 },
    usedByTruncated: false,
  });

  it('separates the places the agent answers in from what is built on it', () => {
    const { surfaces, others } = splitAgentUsedBy([
      edge('portal', 'Support portal'),
      edge('channel-deployment', 'Slack'),
      edge('realtime-model', 'Voice'),
      edge('evaluation-target', 'Nightly eval'),
      edge('agent', 'Router'),
    ]);
    expect(surfaces.map((e) => e.other.name)).toEqual(['Support portal', 'Slack', 'Voice']);
    expect(others.map((e) => e.other.name)).toEqual(['Nightly eval', 'Router']);
  });

  it('lists API, A2A, triggers and each surface; the rest goes under "Uses and used by"', async () => {
    const onManage = vi.fn();
    await render(h(AgentOverviewAside, {
      usage: usage([edge('portal', 'Support portal'), edge('evaluation-target', 'Nightly eval')], [edge('model', 'GPT', 'ok', 'out')]),
      usageFailed: false,
      isConnected: false,
      publishedVersion: 3,
      a2aEnabled: true,
      triggerCount: 2,
      onManage,
    }));
    const where = q('[data-testid="agent-where-it-runs"]')!.textContent ?? '';
    expect(where).toContain('API · runs v3');
    expect(where).toContain('A2A · on');
    expect(where).toContain('2 triggers');
    expect(where).toContain('Support portal');
    expect(where).not.toContain('Nightly eval');
    const uses = q('[data-testid="agent-uses"]')!.textContent ?? '';
    expect(uses).toContain('GPT');
    expect(uses).toContain('Nightly eval');
    expect(uses).not.toContain('Support portal');
    await click(buttonByText('Manage in Ship'));
    expect(onManage).toHaveBeenCalled();
  });

  it('before the first publish, and when the usage check fails', async () => {
    await render(h(AgentOverviewAside, {
      usage: null,
      usageFailed: true,
      isConnected: false,
      publishedVersion: null,
      a2aEnabled: false,
      triggerCount: 0,
      onManage: () => {},
    }));
    expect(text()).toContain('API · after the first publish');
    expect(text()).toContain('A2A · off');
    expect(text()).toContain('No triggers');
    expect(text()).toContain('Could not load what this agent uses.');
  });

  it('a connected agent has no API, A2A or trigger lines of its own', async () => {
    await render(h(AgentOverviewAside, {
      usage: usage([]),
      usageFailed: false,
      isConnected: true,
      publishedVersion: null,
      a2aEnabled: false,
      triggerCount: null,
      onManage: () => {},
    }));
    expect(text()).not.toContain('API ·');
    expect(text()).not.toContain('A2A ·');
  });
});

describe('Overview: needs attention', () => {
  const agent = {
    key: 'support',
    name: 'Support',
    status: 'active',
    publishedVersion: 4,
    config: { kind: 'native' as const, toolBindings: [{ toolNames: ['get_order'] }] },
  };
  const overview = (tools: Array<{ toolName: string; totalCalls: number; errorCalls: number }>, failed: number) => ({
    analytics: {
      totals: { sessionsCount: 40, totalInputTokens: 1000, totalOutputTokens: 500, averageDurationMs: 1200 },
      tools: { items: tools },
      statuses: [{ status: 'completed', count: 40 - failed }, ...(failed ? [{ status: 'error', count: failed }] : [])],
      models: [],
      daily: [],
    },
    agent: { latestSessionAt: null },
  });

  it('gathers unpublished changes, failing tools, failed runs and broken references, each with where to go', async () => {
    installApiMock([['GET', /\/api\/tracing\/agents\/.+\/overview$/, () => overview([
      { toolName: 'get_order', totalCalls: 20, errorCalls: 12 },
      { toolName: 'web_search', totalCalls: 8, errorCalls: 0 },
    ], 5)]]);
    const onGoToTab = vi.fn();
    await render(h(AgentOverviewPanel, {
      agent,
      isConnected: false,
      sessionCount: 0,
      onStartSession: () => {},
      onGoToTab,
      unpublishedSections: ['Prompt', 'General'],
      brokenReferences: [edge('guardrail', 'Prompt shield', 'inactive', 'out')],
    }));
    await settle(100);
    const card = q('[data-testid="agent-attention"]')!;
    expect(card).not.toBeNull();
    const content = card.textContent ?? '';
    expect(content).toContain('2 changes are not published');
    expect(content).toContain('Prompt, General');
    expect(content).toContain('get_order failed 12 times');
    expect(content).not.toContain('web_search failed');
    expect(content).toContain('5 runs ended with an error');
    expect(content).toContain('“Prompt shield”: Inactive');

    const buttons = qa('button', card);
    await click(buttons.find((b) => b.textContent === 'Review in Ship'));
    expect(onGoToTab).toHaveBeenLastCalledWith('versions');
    await click(buttons.find((b) => b.textContent === 'Open tools'));
    expect(onGoToTab).toHaveBeenLastCalledWith('tools');
    await click(buttons.find((b) => b.textContent === 'Open Sessions'));
    expect(onGoToTab).toHaveBeenLastCalledWith('sessions');
    await click(buttons.find((b) => b.textContent === 'Open in Build'));
    expect(onGoToTab).toHaveBeenLastCalledWith('guardrails');
  });

  it('nothing to report, no card; never published says so', async () => {
    installApiMock([['GET', /\/api\/tracing\/agents\/.+\/overview$/, () => overview([], 0)]]);
    await render(h(AgentOverviewPanel, {
      agent,
      isConnected: false,
      sessionCount: 0,
      onStartSession: () => {},
      onGoToTab: () => {},
    }));
    await settle(100);
    expect(q('[data-testid="agent-attention"]')).toBeNull();
    await mounted?.unmount();

    installApiMock([['GET', /\/api\/tracing\/agents\/.+\/overview$/, () => overview([], 0)]]);
    await render(h(AgentOverviewPanel, {
      agent: { ...agent, publishedVersion: null },
      isConnected: false,
      sessionCount: 0,
      onStartSession: () => {},
      onGoToTab: () => {},
    }));
    await settle(100);
    expect(q('[data-testid="agent-attention"]')?.textContent).toContain('Not published yet');
  });
});

describe('agent page wiring', () => {
  const page = readFileSync(join(process.cwd(), 'src/components/agents/AgentDetailPage.tsx'), 'utf8');

  it('renders Build in the order of the index, with the index beside it', () => {
    expect(page).toContain('BUILD_SECTION_ORDER.map((id) => <Fragment key={id}>{buildSectionElements[id]}</Fragment>)');
    expect(page).toContain('<BuildSectionIndex groups={buildIndexGroups} onJump={jumpToSection} />');
  });

  it('counts unsaved edits against what was last loaded or saved, and can throw them away', () => {
    // The baseline is built by the same function Save uses, and replaced by what a save sent.
    expect(page).toContain('changedConfigSections(buildConfigPayload(), savedPayload)');
    expect(page).toContain('setSavedPayload(payload);');
    expect(page).toContain("tone: 'danger'");
    expect(page).toMatch(/discardUnsaved = async \(\) => \{[\s\S]*?await loadAgent\(\);/);
    expect(page).toContain('data-testid="build-discard"');
  });

  it('a link to a section the agent does not use opens it', () => {
    expect(page).toMatch(/if \(activeTab === 'configure'\) \{\s*setExpandedUnset/);
  });

  it('moves Compare, Update from file and Export into the header menu and shows the draft badge', () => {
    expect(page).toContain('data-testid="agent-header-more"');
    expect(page).toContain('data-testid="agent-draft-badge"');
    expect(page).not.toMatch(/>\s*Update from file\s*</);
  });

  it('Ship opens with what is live and what publishing would change', () => {
    expect(page).toContain('data-testid="ship-summary"');
  });

  it('lists the versions five at a time; the two picked for Compare stay picked across pages', () => {
    expect(page).toContain('const VERSIONS_PAGE_SIZE = 5;');
    expect(page).toContain('records={versions.slice((shownVersionsPage - 1) * VERSIONS_PAGE_SIZE, shownVersionsPage * VERSIONS_PAGE_SIZE)}');
    expect(page).toContain('hasMore: shownVersionsPage < versionPageCount');
    // The selection is shown above the list, as one of the two can be on another page.
    expect(page).toContain('data-testid="versions-compare-selection"');
    // A reload (after a publish) starts on the page with the newest version.
    expect(page).toMatch(/setVersionsTotal\(data\.total \?\? 0\);[\s\S]{0,120}setVersionsPage\(1\);/);
  });
});

describe('fitting the section', () => {
  it('a section stacks its heading above its fields by the width it gets, not the window', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/agents/studio/ConfigSection.module.css'), 'utf8');
    expect(css).toMatch(/\.frame \{\s*container-type: inline-size;/);
    expect(css).toContain('@container (max-width: 60rem)');
    expect(css).not.toContain('@media (max-width: 62em)');
  });

  it('the per-tool approvals table scrolls inside its section and wraps tool names between words', () => {
    const panel = readFileSync(join(process.cwd(), 'src/components/agents/studio/AgentHumanInTheLoopPanel.tsx'), 'utf8');
    expect(panel).toContain('<Table.ScrollContainer minWidth={600} type="native">');
    expect(panel).not.toContain('<Table.Th w={300}>');
    expect(toolNameBreaks('get_resource_labels')).toEqual(['get_', 'resource_', 'labels']);
    expect(toolNameBreaks('mcp__crm__search.v2')).toEqual(['mcp__', 'crm__', 'search.', 'v2']);
    expect(toolNameBreaks('search')).toEqual(['search']);
    expect(toolNameBreaks('a-b')).toEqual(['a-', 'b']);
  });
});
