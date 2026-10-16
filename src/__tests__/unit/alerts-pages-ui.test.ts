// @vitest-environment jsdom
/**
 * The rules page (deep-link prefill that is consumed once, edit link, duplicate, toggle) and the
 * incident detail page (context, timeline, actions, notes).
 */
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({ search: '' }));
const replace = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, prefetch: vi.fn() }),
  usePathname: () => '/dashboard/alerts',
  useSearchParams: () => new URLSearchParams(nav.search),
  useParams: () => ({ incidentId: 'i1' }),
}));

import AlertsPage from '@/app/dashboard/alerts/page';
import IncidentDetailPage from '@/app/dashboard/alerts/incidents/[incidentId]/page';
import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';
import type { AlertMeta, AlertRuleDto, IncidentDto } from '@/components/alerts/alertTypes';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.search = '';
  replace.mockClear();
  push.mockClear();
});
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const META: AlertMeta = {
  validModules: ['agents', 'models', 'rag', 'mcp', 'tools', 'guardrails', 'inference'],
  validWindows: [5, 15, 30, 60],
  catalog: ALERT_METRIC_CATALOG,
  modes: { threshold: { available: true }, baseline: { available: true }, absence: { available: true }, slo_burn: { available: true } },
  channelTypes: ['email', 'webhook', 'slack', 'teams', 'pagerduty'],
};

const RULES: AlertRuleDto[] = [
  {
    _id: 'r1',
    name: 'Support errors',
    module: 'agents',
    metric: 'agent_error_rate',
    condition: { operator: 'gt', threshold: 5, mode: 'threshold' },
    windowMinutes: 15,
    cooldownMinutes: 60,
    enabled: true,
    entity: { entityType: 'agent', mode: 'all' },
    severity: 'auto',
    channels: [
      { id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@example.com'] },
      { id: 'ch_bbbbbbbbbbbb', type: 'slack', urlHint: 'https://hooks.slack.com/…abcd' },
    ],
  },
  {
    _id: 'r2',
    name: 'PII guard',
    module: 'guardrails',
    metric: 'guardrail_fail_rate',
    condition: { operator: 'gt', threshold: 10 },
    windowMinutes: 60,
    cooldownMinutes: 60,
    enabled: false,
    scope: { guardrailKey: 'pii' },
    channels: [{ id: 'ch_cccccccccccc', type: 'email', recipients: ['sec@example.com'] }],
  },
];

function rulesApi(rules: AlertRuleDto[] = RULES) {
  api = installApiMock([
    [
      'GET',
      '/api/alerts/rules',
      (call) => {
        // status / owner / q / sort are applied by the server; the mock honours the search so the page can be exercised
        const needle = (call.query.q ?? '').toLowerCase();
        const matching = needle ? rules.filter((rule) => rule.name.toLowerCase().includes(needle)) : rules;
        return {
          rules: matching,
          meta: META,
          states: { r1: { ok: 0, pending: 0, firing: 2 } },
          derived: Object.fromEntries(rules.map((rule) => [rule._id, { status: rule.enabled ? 'ok' : 'disabled', muted: false, noData: false }])),
          stats: { r1: { fired7d: 12, daily7d: [0, 1, 2, 3, 1, 2, 3] } },
          statsCapped: false,
          kpis: { total: rules.length, enabled: rules.filter((rule) => rule.enabled).length, firing: 1, muted: 0, noData: 0, noisy: 1 },
          total: matching.length,
        };
      },
    ],
    ['GET', '/api/alerts/entities', () => ({ entities: [] })],
    ['PATCH', /^\/api\/alerts\/rules\/[^/]+$/, () => ({ rule: {} })],
    ['POST', '/api/alerts/rules', () => jsonResponse({ rule: { _id: 'new' } }, 201)],
  ]);
}

const nameInput = () => q<HTMLInputElement>('input[placeholder="e.g. Pulse Main error rate"]');

describe('AlertsPage', () => {
  it('lists the rules with their module, target, condition, state and the firing count', async () => {
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    expect(text()).toContain('Support errors');
    expect(text()).toContain('PII guard');
    expect(text()).toContain('Agents');
    expect(text()).toContain('All agents');
    expect(text()).toContain('guardrail: pii');
    expect(text()).toContain('> 5% · 15 min');
    expect(text()).toContain('2 firing');
    // each tile says what it counts: entity states that are firing, rules that fired
    expect(text()).toContain('Entities Firing Now');
    expect(text()).toContain('Muted');
    expect(text()).toContain('Noisy · 7d');
    expect(q<HTMLAnchorElement>('a[href="/dashboard/alerts/incidents?ruleId=r1&status=all"]')).not.toBeNull();
  });

  it('shows the empty state and the error state', async () => {
    rulesApi([]);
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    expect(text()).toContain('No alert rules yet');
    await mounted.unmount();

    api = installApiMock([['GET', '/api/alerts/rules', () => jsonResponse({ message: 'down' }, 500)]]);
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    expect(text()).toContain('down');
    expect(buttonByText('Retry')).toBeDefined();
  });

  it('filters by search and keeps the rest out', async () => {
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    await setInput(q<HTMLInputElement>('input[placeholder="Search rules, metrics, targets…"]')!, 'pii');
    await settle(400);
    expect(text()).toContain('PII guard');
    expect(text()).not.toContain('Support errors');
  });

  it('toggles a rule with a PATCH and puts the switch back when it fails', async () => {
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    await click(qa('input[role="switch"]')[1]);
    await settle(50);
    expect(api.to('PATCH', '/api/alerts/rules/r2')[0]!.body).toEqual({ enabled: true });

    api.on('PATCH', /^\/api\/alerts\/rules\/[^/]+$/, () => jsonResponse({ message: 'nope' }, 500));
    await click(qa('input[role="switch"]')[0]);
    await settle(50);
    expect((qa<HTMLInputElement>('input[role="switch"]')[0])?.checked).toBe(true);
  });

  it('opens a prefilled create form from the deep link and consumes the parameters', async () => {
    nav.search = 'create=1&module=agents&metric=agent_error_rate&entityType=agent&entityKey=support';
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(150);
    expect(text()).toContain('Create Alert Rule');
    expect(q('[data-testid="rule-sentence"]')?.textContent).toContain('support');
    expect(replace).toHaveBeenCalledWith('/dashboard/alerts');
    // the form starts blank (name) and a Cancel followed by "New Rule" does not bring the prefill back
    expect(nameInput()?.value).toBe('');
    await click(qa<HTMLButtonElement>('button').find((button) => button.textContent === 'Cancel'));
    await settle(50);
    nav.search = '';
    await click(buttonByText('New Rule'));
    await settle(50);
    expect(q('[data-testid="rule-sentence"]')?.textContent).toContain('All agents');
  });

  it('opens the rule named by the edit link', async () => {
    nav.search = 'edit=r1';
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(150);
    expect(text()).toContain('Edit Alert Rule');
    expect(nameInput()?.value).toBe('Support errors');
    expect(replace).toHaveBeenCalledWith('/dashboard/alerts');
  });

  it('duplicates a rule into the create form and says which channels were left out', async () => {
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    await click(qa('tbody tr button[aria-label]:not([aria-label=""])').find((node) => !/^Mute/.test(node.getAttribute('aria-label') ?? '')));
    await settle(50);
    await click(qa('button, [role="menuitem"]').find((node) => node.textContent?.trim() === 'Duplicate'));
    await settle(100);
    expect(text()).toContain('Create Alert Rule');
    expect(nameInput()?.value).toBe('Copy of Support errors');
    // only the email channel is carried over
    expect(qa('[data-testid="channels-editor"] .ds-card').length).toBe(1);
  });

  it('renders in Turkish without a missing message', async () => {
    rulesApi();
    mounted = await mount(createElement(AlertsPage), 'tr');
    await settle(100);
    expect(text()).toContain('Uyarılar ve Olaylar');
    expect(text()).toContain('Tüm ajanlar');
    expect(text()).not.toMatch(/(alerts|incidents)\.[a-zA-Z]/);
  });
});

// ── incident detail ─────────────────────────────────────────────────────────

const INCIDENT: IncidentDto = {
  _id: 'i1',
  ruleName: 'Support errors',
  ruleId: 'r1',
  alertEventId: 'e1',
  metric: 'agent_error_rate',
  threshold: 5,
  actualValue: 12.5,
  severity: 'critical',
  status: 'open',
  notes: [{ userId: 'u1', userName: 'Ada', content: 'looking into it', createdAt: '2026-10-15T10:10:00.000Z' }],
  firedAt: '2026-10-15T10:00:00.000Z',
  entityType: 'agent',
  entityKey: 'support',
  module: 'agents',
  baselineValue: 2.1,
  peakValue: 15,
  metadata: { operator: 'gt', windowMinutes: 15, sampleCount: 120 },
  context: {
    mode: 'baseline',
    windowMinutes: 15,
    versionChange: { from: 'v3', to: 'v4' },
    errorSignatures: [{ message: 'tool timeout', count: 14 }],
    failingSessions: { count: 6, listPath: '/dashboard/tracing/sessions?agent=support&status=error' },
    correlations: [{ entityType: 'model', entityKey: 'gpt-x', metric: 'model_error_rate', value: 20, baseline: 2, ratio: 10 }],
    notes: ['A new agent version was deployed shortly before.'],
  },
};

function detailApi(incident: IncidentDto = INCIDENT) {
  api = installApiMock([
    ['GET', '/api/alerts/incidents/i1', () => ({ incident })],
    ['PATCH', '/api/alerts/incidents/i1', (call) => ({ incident: { ...incident, ...(call.body as object) } })],
    ['POST', '/api/alerts/incidents/i1/notes', () => ({ incident: { ...incident, notes: [...incident.notes, { userId: 'u2', userName: 'Bob', content: 'fixed', createdAt: '2026-10-15T10:20:00.000Z' }] } })],
  ]);
}

describe('IncidentDetailPage', () => {
  it('shows the detection facts, the context and the activity timeline', async () => {
    detailApi();
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    const content = text();
    expect(content).toContain('Support errors');
    expect(content).toContain('Agent Error Rate');
    expect(content).toContain('12.5%');
    expect(content).toContain('normal 2.1%');
    expect(content).toContain('support');
    expect(content).toContain('v3');
    expect(content).toContain('v4');
    expect(content).toContain('tool timeout');
    expect(content).toContain('gpt-x');
    expect(content).toContain('A new agent version was deployed shortly before.');
    expect(content).toContain('looking into it');
    // the failing-session link is an in-app path
    expect(q<HTMLAnchorElement>('a[href="/dashboard/tracing/sessions?agent=support&status=error"]')).not.toBeNull();
    // the rule opens in the rules page through the edit deep link
    expect(q<HTMLAnchorElement>('a[href="/dashboard/alerts?edit=r1"]')).not.toBeNull();
  });

  it('words a single failing session in the singular', async () => {
    detailApi({
      ...INCIDENT,
      context: { ...INCIDENT.context!, failingSessions: { count: 1, listPath: '/dashboard/tracing/sessions?agent=support&status=error' } },
    });
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    expect(text()).toContain('View 1 failing session');
    expect(text()).not.toContain('1 failing sessions');
  });

  it('states when the new version was first seen and spells out the page labels', async () => {
    detailApi({
      ...INCIDENT,
      context: { ...INCIDENT.context!, versionChange: { from: 'v3', to: 'v4', firstSeenAt: '2026-10-15T09:42:00.000Z' } },
    });
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    expect(text()).toContain('First seen 18 min before this fired');
    // the Detection row names the entity type with a capital, the links card drops the article
    const rowLabels = qa('table.ds-tbl td:first-child').map((cell) => cell.textContent?.trim());
    expect(rowLabels).toContain('Agent');
    expect(rowLabels).not.toContain('agent');
    expect(text()).toContain('Open entity health');
    expect(text()).not.toContain('Open the entity health');
  });

  it('lays the context labels above their content, and keeps the actions out of the title header', async () => {
    detailApi();
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    const failingLabel = qa<HTMLElement>('.ds-eyebrow').find((node) => node.textContent === 'Failing sessions');
    expect(failingLabel?.style.display).toBe('flex');
    expect(q('.detail-header')?.textContent).not.toContain('Acknowledge');
    expect(q<HTMLElement>('.detail-title-row h1')?.style.whiteSpace).not.toBe('nowrap');
  });

  it('puts the meta separators only between the items that are there', async () => {
    const withoutEntity = { ...INCIDENT, entityType: undefined, entityKey: undefined, baselineValue: undefined, metadata: { operator: 'gt', windowMinutes: 15 } };
    for (const incident of [INCIDENT, withoutEntity]) {
      detailApi(incident);
      mounted = await mount(createElement(IncidentDetailPage));
      await settle(150);
      const kids = Array.from(q('.detail-meta-row')!.children);
      const isSeparator = (node: Element) => node.textContent === '·';
      expect(kids.length).toBeGreaterThan(1);
      expect(isSeparator(kids[0]!)).toBe(false);
      expect(isSeparator(kids[kids.length - 1]!)).toBe(false);
      kids.forEach((node, index) => {
        if (index > 0) expect(isSeparator(node) && isSeparator(kids[index - 1]!)).toBe(false);
      });
      expect(kids.filter(isSeparator).length).toBe(kids.filter((node) => !isSeparator(node)).length - 1);
      await mounted.unmount();
    }
  });

  it('offers exactly the transitions the lifecycle allows and sends the chosen one', async () => {
    detailApi();
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    const labels = qa('button').map((button) => button.textContent?.trim());
    for (const label of ['Acknowledge', 'Investigate', 'Resolve', 'Close']) expect(labels).toContain(label);
    expect(labels).not.toContain('Reopen');
    await click(buttonByText('Resolve'));
    await settle(100);
    expect(api.to('PATCH', '/api/alerts/incidents/i1')[0]!.body).toEqual({ status: 'resolved' });
  });

  it('offers only Reopen for a closed incident', async () => {
    detailApi({ ...INCIDENT, status: 'closed', closedAt: '2026-10-15T12:00:00.000Z' });
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    const labels = qa('button').map((button) => button.textContent?.trim());
    expect(labels).toContain('Reopen');
    expect(labels).not.toContain('Resolve');
    expect(labels).not.toContain('Acknowledge');
  });

  it('assigns the incident to the caller', async () => {
    detailApi();
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    await click(buttonByText('Assign to me'));
    await settle(100);
    expect(api.to('PATCH', '/api/alerts/incidents/i1')[0]!.body).toEqual({ assignedTo: 'me' });
  });

  it('adds a note', async () => {
    detailApi();
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    await setInput(q<HTMLTextAreaElement>('textarea')!, 'fixed');
    await click(buttonByText('Add Note'));
    await settle(100);
    expect(api.to('POST', '/api/alerts/incidents/i1/notes')[0]!.body).toEqual({ content: 'fixed' });
    expect(text()).toContain('Bob');
  });

  it('says so when the incident does not exist', async () => {
    api = installApiMock([['GET', '/api/alerts/incidents/i1', () => jsonResponse({ error: 'Incident not found' }, 404)]]);
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    expect(text()).toContain('Incident not found');
  });

  it('renders in Turkish without a missing message', async () => {
    detailApi();
    mounted = await mount(createElement(IncidentDetailPage), 'tr');
    await settle(150);
    expect(text()).toContain('Ajan Hata Oranı');
    expect(text()).not.toMatch(/(alerts|incidents)\.[a-zA-Z]/);
  });
});
