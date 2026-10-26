// @vitest-environment jsdom
/**
 * The Evaluations and Red-team screens where an agent shows up: the version beside its name, and the run /
 * scan controls that need Write access to Agents.
 *
 * - A configuration shows its default (`published`, `v3`, `draft`); a run shows what answered (`v4`, `draft`),
 *   and a run that predates the record shows no tag at all.
 * - While the level for Agents is known and below write, the controls that run an agent are switched off
 *   (marked disabled, so the hint can show on hover); a model target or campaign never is.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import { createElement as h } from 'react';
import { notifications } from '@mantine/notifications';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
const nav = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => nav.params,
  usePathname: () => '/dashboard/evaluations',
  useSearchParams: () => new URLSearchParams(),
}));

import EvaluationSuiteDetailPage from '@/app/dashboard/evaluations/suites/[id]/page';
import EvaluationTargetDetailPage from '@/app/dashboard/evaluations/targets/[id]/page';
import EvaluationRunDetailPage from '@/app/dashboard/evaluations/runs/[id]/page';
import RedTeamCampaignDetailPage from '@/app/dashboard/redteam/campaigns/[id]/page';
import RedTeamRunDetailPage from '@/app/dashboard/redteam/runs/[id]/page';
import EvaluationsWorkspace, { type EvaluationSection } from '@/components/evaluations/EvaluationsWorkspace';
import RedTeamWorkspace, { type RedTeamSection } from '@/components/redteam/RedTeamWorkspace';
import type { EvalRunView, EvalSuiteView, EvalTargetView } from '@/components/evaluations/types';
import type { RedTeamCampaignView, RedTeamRunView } from '@/components/redteam/types';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  text,
  wait,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';

// These render whole pages (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

beforeAll(() => {
  installDomStubs();
});

const mounted: Mounted[] = [];
beforeEach(() => {
  nav.params = {};
  router.push.mockClear();
});
afterEach(async () => {
  for (const item of mounted.splice(0)) await item.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Route = Parameters<typeof installApiMock>[0][number];

/** The API with the session answering `level` for Agents (`null`: the engine gave no answer). */
function installApi(level: string | null, ...routes: Route[]): ApiMock {
  return installApiMock([
    ['GET', '/api/auth/session', () => ({ effectivePermissions: level ? { agents: level } : null })],
    ...routes,
  ]);
}

async function show(element: Parameters<typeof mount>[0]): Promise<void> {
  mounted.push(await mount(element));
  await wait(60);
}

/** The text of every version tag inside `scope` (the only Mantine badges these screens draw). */
const tagsIn = (scope: ParentNode = document.body): string[] =>
  qa('.mantine-Badge-root', scope).map((badge) => badge.textContent ?? '');

/** The table row that holds `needle`. */
function rowWith(needle: string): HTMLElement {
  const row = qa('tr').find((tr) => tr.textContent?.includes(needle));
  if (!row) throw new Error(`no row with "${needle}"`);
  return row;
}

/** Opens the row menu of the row holding `needle` and returns the item named `label`. */
async function rowAction(needle: string, label: string): Promise<HTMLElement> {
  await click(q('[aria-label="Actions"]', rowWith(needle)));
  await wait(30);
  const item = qa('[role="menuitem"]').find((el) => el.textContent?.trim() === label);
  if (!item) throw new Error(`no row action "${label}"`);
  return item;
}

function expectSwitchedOff(el: HTMLElement | undefined | null): void {
  expect(el).toBeTruthy();
  expect(el!.getAttribute('data-disabled')).toBe('true');
  expect(el!.getAttribute('aria-disabled')).toBe('true');
  expect(el!.hasAttribute('disabled')).toBe(false);
}

function expectSwitchedOn(el: HTMLElement | undefined | null): void {
  expect(el).toBeTruthy();
  expect(el!.hasAttribute('data-disabled')).toBe(false);
  expect(el!.hasAttribute('disabled')).toBe(false);
}

const FORBIDDEN = 'Forbidden: agents requires write permission';

// ── Evaluations ─────────────────────────────────────────────────────────

const evalTargets: EvalTargetView[] = [
  { id: 't1', key: 'support-pinned', name: 'Support pinned', kind: 'agent', agentKey: 'bot', agentVersion: 3 },
  { id: 't2', key: 'support-draft', name: 'Support draft', kind: 'agent', agentKey: 'bot', agentVersion: 'draft' },
  { id: 't3', key: 'support-live', name: 'Support live', kind: 'agent', agentKey: 'bot' },
  { id: 't4', key: 'gpt', name: 'GPT four', kind: 'model', modelKey: 'model-one' },
];

const evalSuites: EvalSuiteView[] = [
  { id: 's1', key: 'agent-suite', name: 'Agent suite', targetKey: 'support-pinned', datasetKey: 'dk', scorers: [{ type: 'assertion' }] },
  { id: 's2', key: 'model-suite', name: 'Model suite', targetKey: 'gpt', datasetKey: 'dk', scorers: [{ type: 'assertion' }] },
];

const evalRun = (patch: Partial<EvalRunView>): EvalRunView => ({
  id: 'r1',
  suiteKey: 'agent-suite',
  targetKey: 'support-pinned',
  datasetKey: 'dk',
  status: 'completed',
  mode: 'async',
  progress: { total: 1, completed: 1, failed: 0 },
  items: [],
  ...patch,
});

const evalRoutes = (runs: EvalRunView[]): Route[] => [
  ['GET', '/api/evaluation/targets', () => ({ targets: evalTargets })],
  ['GET', '/api/evaluation/datasets', () => ({ datasets: [{ id: 'd1', key: 'dk', name: 'Dataset', source: 'manual', itemCount: 1 }] })],
  ['GET', '/api/evaluation/suites', () => ({ suites: evalSuites })],
  ['GET', '/api/evaluation/runs', () => ({ runs })],
  ['GET', '/api/models', () => ({ models: [] })],
];

async function showEvaluations(section: EvaluationSection): Promise<void> {
  await show(h(EvaluationsWorkspace, { section }));
}

describe('Evaluations, the lists', () => {
  it('shows the version each agent target follows beside the agent, and nothing beside a model', async () => {
    installApi('write', ...evalRoutes([]));
    await showEvaluations('targets');
    expect(tagsIn(rowWith('Support pinned'))).toEqual(['v3']);
    expect(tagsIn(rowWith('Support draft'))).toEqual(['draft']);
    expect(tagsIn(rowWith('Support live'))).toEqual(['published']);
    expect(tagsIn(rowWith('GPT four'))).toEqual([]);
    expect(rowWith('GPT four').textContent).toContain('model-one');
    expect(rowWith('Support pinned').textContent).toContain('bot');
  });

  it('shows the version an agent suite follows beside its target', async () => {
    installApi('write', ...evalRoutes([]));
    await showEvaluations('suites');
    expect(tagsIn(rowWith('Agent suite'))).toEqual(['v3']);
    expect(tagsIn(rowWith('Model suite'))).toEqual([]);
  });

  it('shows what each run tested, and nothing extra for a run made before it was recorded', async () => {
    installApi('write', ...evalRoutes([
      evalRun({ id: 'r1', suiteKey: 'run-pinned', targetKey: 'support-pinned', agentRevision: { requested: 3, version: 3 } }),
      evalRun({ id: 'r2', suiteKey: 'run-live', targetKey: 'support-live', agentRevision: { requested: 'published', version: 4 } }),
      evalRun({
        id: 'r3',
        suiteKey: 'run-draft',
        targetKey: 'support-draft',
        agentRevision: { requested: 'draft', version: null, draftFingerprint: 'ab12', draftChanged: true },
      }),
      evalRun({ id: 'r4', suiteKey: 'run-old', targetKey: 'support-live' }),
      evalRun({ id: 'r5', suiteKey: 'run-model', targetKey: 'gpt' }),
    ]));
    await showEvaluations('runs');
    expect(tagsIn(rowWith('run-pinned'))).toEqual(['v3']);
    expect(tagsIn(rowWith('run-live'))).toEqual(['v4']);
    expect(tagsIn(rowWith('run-draft'))).toEqual(['draft']);
    // The draft changed under the run: the tag carries a warning icon, so it is not colour alone.
    expect(q('.mantine-Badge-root svg', rowWith('run-draft'))).not.toBeNull();
    expect(q('.mantine-Badge-root svg', rowWith('run-pinned'))).toBeNull();
    // An agent run from before the revision was recorded: the agent's name, no tag. A model run: no agent.
    expect(tagsIn(rowWith('run-old'))).toEqual([]);
    expect(rowWith('run-old').textContent).toContain('bot');
    expect(tagsIn(rowWith('run-model'))).toEqual([]);
    expect(rowWith('run-model').textContent).not.toContain('bot');
  });
});

describe('Evaluations, the agent a run tested', () => {
  it('names the agent the run recorded, not the one its target points at now', async () => {
    installApi('write', ...evalRoutes([
      evalRun({ id: 'r1', suiteKey: 'run-moved', targetKey: 'support-live', agentRevision: { requested: 'published', agentKey: 'old-bot', version: 2 } }),
    ]));
    await showEvaluations('runs');
    expect(rowWith('run-moved').textContent).toContain('old-bot');
    expect(tagsIn(rowWith('run-moved'))).toEqual(['v2']);
  });
});

describe('Evaluations, running a suite from the list', () => {
  const runRoute: Route = ['POST', '/api/evaluation/suites/agent-suite/run', () => ({ run: { id: 'r9' } })];

  it('switches Run off for an agent suite while Agents is read-only', async () => {
    const api = installApi('read', ...evalRoutes([]), runRoute);
    await showEvaluations('suites');
    const agentRun = await rowAction('Agent suite', 'Run');
    expectSwitchedOff(agentRun);
    await click(agentRun);
    await wait(30);
    expect(api.to('POST', '/api/evaluation/suites/agent-suite/run')).toHaveLength(0);
  });

  it('leaves Run on for a model suite, whatever the level for Agents', async () => {
    const api = installApi('read', ...evalRoutes([]), ['POST', '/api/evaluation/suites/model-suite/run', () => ({ run: { id: 'r8' } })]);
    await showEvaluations('suites');
    const modelRun = await rowAction('Model suite', 'Run');
    expectSwitchedOn(modelRun);
    await click(modelRun);
    await wait(30);
    expect(api.to('POST', '/api/evaluation/suites/model-suite/run')).toHaveLength(1);
  });

  it('shows the refusal the server answers, word for word', async () => {
    const shown = vi.spyOn(notifications, 'show').mockReturnValue('id');
    installApi('write', ...evalRoutes([]), ['POST', '/api/evaluation/suites/agent-suite/run', () => jsonResponse({ error: FORBIDDEN, code: 'forbidden' }, 403)]);
    await showEvaluations('suites');
    await click(await rowAction('Agent suite', 'Run'));
    await wait(30);
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({ color: 'red', message: FORBIDDEN }));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('runs an agent suite for a person with write access to Agents', async () => {
    const api = installApi('write', ...evalRoutes([]), runRoute);
    await showEvaluations('suites');
    const agentRun = await rowAction('Agent suite', 'Run');
    expectSwitchedOn(agentRun);
    await click(agentRun);
    await wait(30);
    expect(api.to('POST', '/api/evaluation/suites/agent-suite/run')).toHaveLength(1);
    expect(router.push).toHaveBeenCalledWith('/dashboard/evaluations/runs/r9');
  });
});

describe('Evaluations, the suite page', () => {
  const suiteRoutes = (targetsList: EvalTargetView[], runs: EvalRunView[] = []): Route[] => [
    ['GET', '/api/evaluation/suites/s1', () => ({ suite: evalSuites[0] })],
    ['GET', '/api/evaluation/runs', () => ({ runs })],
    ['GET', '/api/evaluation/targets', () => ({ targets: targetsList })],
    ['GET', '/api/evaluation/datasets', () => ({ datasets: [] })],
    ['GET', '/api/models', () => ({ models: [] })],
    ['GET', '/api/agents', () => ({ agents: [{ _id: 'a1', key: 'bot', name: 'Bot' }] })],
    ['GET', '/api/agents/a1/versions', () => ({ versions: [{ version: 4 }, { version: 3 }], publishedVersion: 4 })],
    ['POST', '/api/evaluation/suites/agent-suite/run', () => ({ run: { id: 'r9' } })],
  ];

  async function showSuitePage(): Promise<void> {
    nav.params = { id: 's1' };
    await show(h(EvaluationSuiteDetailPage));
  }

  it('names the agent with the version the target follows', async () => {
    installApi('write', ...suiteRoutes(evalTargets));
    await showSuitePage();
    expect(text()).toContain('Agent');
    expect(tagsIn()).toContain('v3');
  });

  it('offers to run on another version, beside Run now, to a person with write access to Agents', async () => {
    const api = installApi('write', ...suiteRoutes(evalTargets));
    await showSuitePage();
    expect(q('[aria-label="Run on another agent version"]')).not.toBeNull();
    const runNow = buttonByText('Run now');
    expectSwitchedOn(runNow);
    await click(runNow);
    await wait(30);
    expect(api.to('POST', '/api/evaluation/suites/agent-suite/run')).toHaveLength(1);
    expect(api.to('POST', '/api/evaluation/suites/agent-suite/run')[0]!.body).toBeUndefined();
  });

  it('switches Run now off, with no version menu, while Agents is read-only', async () => {
    const api = installApi('read', ...suiteRoutes(evalTargets));
    await showSuitePage();
    const runNow = buttonByText('Run now');
    expectSwitchedOff(runNow);
    expect(q('[aria-label="Run on another agent version"]')).toBeNull();
    await click(runNow);
    await wait(30);
    expect(api.to('POST', '/api/evaluation/suites/agent-suite/run')).toHaveLength(0);
  });

  it('leaves Run now on for a suite whose target is a model, whatever the level for Agents', async () => {
    const api = installApi('read', ...suiteRoutes(evalTargets.map((t) => (t.key === 'support-pinned' ? { ...t, kind: 'model' as const, modelKey: 'm', agentKey: undefined } : t))));
    await showSuitePage();
    const runNow = buttonByText('Run now');
    expectSwitchedOn(runNow);
    expect(q('[aria-label="Run on another agent version"]')).toBeNull();
    await click(runNow);
    await wait(30);
    expect(api.to('POST', '/api/evaluation/suites/agent-suite/run')).toHaveLength(1);
  });

  it('shows the refusal the server answers, word for word', async () => {
    const shown = vi.spyOn(notifications, 'show').mockReturnValue('id');
    installApi('write', ...suiteRoutes(evalTargets), ['POST', '/api/evaluation/suites/agent-suite/run', () => jsonResponse({ error: FORBIDDEN, code: 'forbidden' }, 403)]);
    await showSuitePage();
    await click(buttonByText('Run now'));
    await wait(30);
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({ color: 'red', message: FORBIDDEN }));
  });

  it('shows what each run of the suite tested', async () => {
    installApi('write', ...suiteRoutes(evalTargets, [
      evalRun({ id: 'r1', suiteKey: 'agent-suite', createdAt: '2026-10-20T10:00:00.000Z', agentRevision: { requested: 'published', version: 4 } }),
      evalRun({ id: 'r2', suiteKey: 'agent-suite', createdAt: '2026-10-21T10:00:00.000Z', agentRevision: { requested: 'draft', version: null, draftFingerprint: 'ab12' } }),
    ]));
    await showSuitePage();
    // One tag beside the agent in the details, plus one per run.
    const tags = tagsIn();
    expect(tags).toEqual(expect.arrayContaining(['v3', 'v4', 'draft']));
  });
});

describe('Evaluations, the target page', () => {
  async function showTargetPage(found: EvalTargetView): Promise<void> {
    nav.params = { id: found.id };
    installApi('write', ['GET', `/api/evaluation/targets/${found.id}`, () => ({ target: found })], ['GET', '/api/models', () => ({ models: [] })]);
    await show(h(EvaluationTargetDetailPage));
  }

  it.each([
    ['a pinned version', evalTargets[0]!, 'v3'],
    ['the draft', evalTargets[1]!, 'draft'],
    ['the published version', evalTargets[2]!, 'published'],
  ] as const)('names the agent with the version it follows: %s', async (_name, found, tag) => {
    await showTargetPage(found);
    expect(tagsIn()).toEqual([tag]);
    expect(text()).toContain('bot');
  });

  it('shows the model of a model target as it was, with no tag', async () => {
    await showTargetPage(evalTargets[3]!);
    expect(tagsIn()).toEqual([]);
    expect(text()).toContain('model-one');
  });
});

describe('Evaluations, the run page', () => {
  it('shows the run page header with the version that answered, and the warning when the draft changed', async () => {
    nav.params = { id: 'r1' };
    installApi('write', [
      'GET',
      '/api/evaluation/runs/r1',
      () => ({
        run: evalRun({
          id: 'r1',
          targetKey: 'support-draft',
          agentRevision: { requested: 'draft', version: null, draftFingerprint: 'ab12', draftChanged: true },
        }),
      }),
    ], ['GET', '/api/evaluation/runs', () => ({ runs: [] })]);
    await show(h(EvaluationRunDetailPage));
    expect(tagsIn()).toEqual(['draft']);
    expect(text()).toContain('The draft changed during this run');
  });

  it('shows no warning, and a plain tag, when the draft stayed as it was', async () => {
    nav.params = { id: 'r1' };
    installApi('write', [
      'GET',
      '/api/evaluation/runs/r1',
      () => ({ run: evalRun({ id: 'r1', agentRevision: { requested: 'published', version: 4 } }) }),
    ], ['GET', '/api/evaluation/runs', () => ({ runs: [] })]);
    await show(h(EvaluationRunDetailPage));
    expect(tagsIn()).toEqual(['v4']);
    expect(text()).not.toContain('The draft changed during this run');
  });

  it('names the agent the run tested beside the version that answered', async () => {
    nav.params = { id: 'r1' };
    installApi('write', [
      'GET',
      '/api/evaluation/runs/r1',
      () => ({ run: evalRun({ id: 'r1', agentRevision: { requested: 'published', agentKey: 'old-bot', version: 4 } }) }),
    ], ['GET', '/api/evaluation/runs', () => ({ runs: [] })]);
    await show(h(EvaluationRunDetailPage));
    expect(text()).toContain('Agent old-bot');
    expect(tagsIn()).toEqual(['v4']);
  });

  it('shows a run from before the revision was recorded without any tag or warning', async () => {
    nav.params = { id: 'r1' };
    installApi('write', ['GET', '/api/evaluation/runs/r1', () => ({ run: evalRun({ id: 'r1' }) })], ['GET', '/api/evaluation/runs', () => ({ runs: [] })]);
    await show(h(EvaluationRunDetailPage));
    expect(tagsIn()).toEqual([]);
    expect(text()).not.toContain('The draft changed during this run');
  });
});

// ── Red team ────────────────────────────────────────────────────────────

const campaigns: RedTeamCampaignView[] = [
  { id: 'c1', key: 'agent-pinned', name: 'Agent pinned', targetKind: 'agent', agentKey: 'bot', agentVersion: 3, probeKeys: [] },
  { id: 'c2', key: 'agent-live', name: 'Agent live', targetKind: 'agent', agentKey: 'bot', probeKeys: [] },
  { id: 'c3', key: 'model-one', name: 'Model one', targetKind: 'model', modelKey: 'model-x', probeKeys: [] },
];

const scanRun = (patch: Partial<RedTeamRunView>): RedTeamRunView => ({
  id: 'x1',
  campaignKey: 'agent-pinned',
  targetKind: 'agent',
  targetRef: 'bot',
  status: 'completed',
  mode: 'async',
  progress: { total: 1, completed: 1, failed: 0 },
  attempts: [],
  ...patch,
});

const redTeamRoutes = (runs: RedTeamRunView[]): Route[] => [
  ['GET', '/api/redteam/campaigns', () => ({ campaigns })],
  ['GET', '/api/redteam/runs', () => ({ runs })],
  ['GET', '/api/redteam/probes', () => ({ probes: [] })],
  ['GET', '/api/redteam/custom-probes', () => ({ probes: [] })],
  ['GET', '/api/agents', () => ({ agents: [{ _id: 'a1', key: 'bot', name: 'Bot' }] })],
  ['GET', '/api/models', () => ({ models: [] })],
];

async function showRedTeam(section: RedTeamSection): Promise<void> {
  await show(h(RedTeamWorkspace, { section }));
}

describe('Red team, the lists', () => {
  it('shows the version each agent campaign attacks beside the agent, and nothing beside a model', async () => {
    installApi('write', ...redTeamRoutes([]));
    await showRedTeam('campaigns');
    expect(tagsIn(rowWith('Agent pinned'))).toEqual(['v3']);
    expect(tagsIn(rowWith('Agent live'))).toEqual(['published']);
    expect(tagsIn(rowWith('Model one'))).toEqual([]);
    expect(rowWith('Model one').textContent).toContain('model-x');
  });

  it('shows what each scan attacked, and nothing extra for a scan made before it was recorded', async () => {
    installApi('write', ...redTeamRoutes([
      scanRun({ id: 'x1', campaignKey: 'scan-pinned', agentRevision: { requested: 3, version: 3 } }),
      scanRun({ id: 'x2', campaignKey: 'scan-draft', agentRevision: { requested: 'draft', version: null, draftChanged: true } }),
      scanRun({ id: 'x3', campaignKey: 'scan-old' }),
      scanRun({ id: 'x4', campaignKey: 'scan-model', targetKind: 'model', targetRef: 'model-x' }),
    ]));
    await showRedTeam('runs');
    expect(tagsIn(rowWith('scan-pinned'))).toEqual(['v3']);
    expect(tagsIn(rowWith('scan-draft'))).toEqual(['draft']);
    expect(q('.mantine-Badge-root svg', rowWith('scan-draft'))).not.toBeNull();
    expect(tagsIn(rowWith('scan-old'))).toEqual([]);
    expect(rowWith('scan-old').textContent).toContain('bot');
    expect(tagsIn(rowWith('scan-model'))).toEqual([]);
  });
});

describe('Red team, scanning from the list', () => {
  it('switches Run scan off for an agent campaign while Agents is read-only', async () => {
    installApi('read', ...redTeamRoutes([]));
    await showRedTeam('campaigns');
    const agentScan = await rowAction('Agent pinned', 'Run scan');
    expectSwitchedOff(agentScan);
    await click(agentScan);
    await wait(60);
    // The scan dialog did not open.
    expect(text()).not.toContain('Scan settings');
  });

  it('leaves Run scan on for a model campaign, whatever the level for Agents', async () => {
    installApi('read', ...redTeamRoutes([]));
    await showRedTeam('campaigns');
    const modelScan = await rowAction('Model one', 'Run scan');
    expectSwitchedOn(modelScan);
    await click(modelScan);
    await wait(60);
    expect(text()).toContain('Scan settings');
  });

  it('opens the scan dialog for an agent campaign for a person with write access to Agents', async () => {
    installApi('write', ...redTeamRoutes([]));
    await showRedTeam('campaigns');
    const agentScan = await rowAction('Agent pinned', 'Run scan');
    expectSwitchedOn(agentScan);
    await click(agentScan);
    await wait(60);
    expect(text()).toContain('Scan settings');
  });
});

describe('Red team, the campaign page', () => {
  const campaignRoutes = (found: RedTeamCampaignView, runs: RedTeamRunView[] = []): Route[] => [
    ['GET', `/api/redteam/campaigns/${found.id}`, () => ({ campaign: found })],
    ['GET', '/api/redteam/runs', () => ({ runs })],
    ['GET', '/api/redteam/probes', () => ({ probes: [] })],
    ['GET', '/api/agents', () => ({ agents: [] })],
    ['GET', '/api/models', () => ({ models: [] })],
  ];

  async function showCampaignPage(found: RedTeamCampaignView): Promise<void> {
    nav.params = { id: found.id };
    await show(h(RedTeamCampaignDetailPage));
  }

  it('names the agent with the version the campaign attacks', async () => {
    installApi('write', ...campaignRoutes(campaigns[0]!));
    await showCampaignPage(campaigns[0]!);
    expect(tagsIn()).toEqual(['v3']);
  });

  it('switches Run scan off while Agents is read-only, and opens the dialog otherwise', async () => {
    installApi('read', ...campaignRoutes(campaigns[0]!));
    await showCampaignPage(campaigns[0]!);
    const runScan = qa<HTMLButtonElement>('button').find((b) => b.textContent?.trim() === 'Run scan');
    expectSwitchedOff(runScan);
    await click(runScan);
    await wait(60);
    expect(text()).not.toContain('Scan settings');
    await mounted.pop()!.unmount();

    installApi('write', ...campaignRoutes(campaigns[0]!));
    await showCampaignPage(campaigns[0]!);
    const enabled = qa<HTMLButtonElement>('button').find((b) => b.textContent?.trim() === 'Run scan');
    expectSwitchedOn(enabled);
    await click(enabled);
    await wait(60);
    expect(text()).toContain('Scan settings');
  });

  it('leaves Run scan on for a model campaign whatever the level for Agents', async () => {
    installApi('read', ...campaignRoutes(campaigns[2]!));
    await showCampaignPage(campaigns[2]!);
    const runScan = qa<HTMLButtonElement>('button').find((b) => b.textContent?.trim() === 'Run scan');
    expectSwitchedOn(runScan);
    expect(tagsIn()).toEqual([]);
  });

  it('offers no empty-state Run scan while it is switched off', async () => {
    installApi('read', ...campaignRoutes(campaigns[0]!));
    await showCampaignPage(campaigns[0]!);
    const buttons = qa<HTMLButtonElement>('button').filter((b) => b.textContent?.trim() === 'Run scan');
    expect(buttons).toHaveLength(1);
    await mounted.pop()!.unmount();

    installApi('write', ...campaignRoutes(campaigns[0]!));
    await showCampaignPage(campaigns[0]!);
    expect(qa<HTMLButtonElement>('button').filter((b) => b.textContent?.trim() === 'Run scan')).toHaveLength(2);
  });
});

describe('Red team, the scan page', () => {
  it('shows the version that was attacked, and the warning when the draft changed', async () => {
    nav.params = { id: 'x1' };
    installApi('write', [
      'GET',
      '/api/redteam/runs/x1',
      () => ({ run: scanRun({ id: 'x1', agentRevision: { requested: 'draft', version: null, draftFingerprint: 'ab12', draftChanged: true } }) }),
    ], ['GET', '/api/redteam/runs', () => ({ runs: [] })]);
    await show(h(RedTeamRunDetailPage));
    expect(tagsIn()).toEqual(['draft']);
    expect(text()).toContain('The draft changed during this scan');
  });

  it('shows a plain tag when the draft did not change, and none for a scan from before the record', async () => {
    nav.params = { id: 'x1' };
    installApi('write', [
      'GET',
      '/api/redteam/runs/x1',
      () => ({ run: scanRun({ id: 'x1', agentRevision: { requested: 'published', version: 4 } }) }),
    ], ['GET', '/api/redteam/runs', () => ({ runs: [] })]);
    await show(h(RedTeamRunDetailPage));
    expect(tagsIn()).toEqual(['v4']);
    expect(text()).not.toContain('The draft changed during this scan');
    await mounted.pop()!.unmount();

    installApi('write', ['GET', '/api/redteam/runs/x1', () => ({ run: scanRun({ id: 'x1' }) })], ['GET', '/api/redteam/runs', () => ({ runs: [] })]);
    await show(h(RedTeamRunDetailPage));
    expect(tagsIn()).toEqual([]);
  });
});
