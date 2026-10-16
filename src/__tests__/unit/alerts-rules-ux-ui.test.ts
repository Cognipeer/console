// @vitest-environment jsdom
/** Rules list (noise, mute, server-side query), the rule form's library channels and backtest, and the channel library page. */
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
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/alerts',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import AlertsPage from '@/app/dashboard/alerts/page';
import ChannelsLibraryView from '@/components/alerts/channels/ChannelsLibraryView';
import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';
import type { AlertMeta, AlertRuleDto, LibraryChannelDto } from '@/components/alerts/alertTypes';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.search = '';
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

const baseRule = {
  module: 'agents',
  metric: 'agent_error_rate',
  condition: { operator: 'gt', threshold: 5, mode: 'threshold' },
  windowMinutes: 15,
  cooldownMinutes: 60,
  enabled: true,
  entity: { entityType: 'agent', mode: 'all' },
} as const;

const RULES = [
  { ...baseRule, _id: 'r1', name: 'Noisy rule', channels: [{ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['a@b.co'] }] },
  {
    ...baseRule,
    _id: 'r2',
    name: 'Muted rule',
    mutedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    channels: [{ id: 'ch_bbbbbbbbbbbb', type: 'library', libraryId: 'lib1' }],
  },
] as unknown as AlertRuleDto[];

const LIBRARY: LibraryChannelDto[] = [
  { id: 'lib1', name: 'On-call Slack', kind: 'slack', config: { type: 'slack', urlHint: 'https://hooks.slack.com/…abcd' }, usedBy: [{ ruleId: 'r2', ruleName: 'Muted rule' }] },
  { id: 'lib2', name: 'Ops mail', kind: 'email', config: { type: 'email', recipients: ['ops@example.com'] }, usedBy: [] },
];

function rulesApi() {
  api = installApiMock([
    [
      'GET',
      '/api/alerts/rules',
      () => ({
        rules: RULES,
        meta: META,
        states: {},
        derived: {
          r1: { status: 'ok', muted: false, noData: false },
          r2: { status: 'ok', muted: true, noData: false },
        },
        stats: { r1: { fired7d: 14, daily7d: [1, 2, 3, 2, 3, 2, 1] } },
        statsCapped: false,
        kpis: { total: 2, enabled: 2, firing: 0, muted: 1, noData: 0, noisy: 1 },
        total: 2,
      }),
    ],
    ['GET', '/api/alerts/entities', () => ({ entities: [] })],
    ['GET', '/api/alerts/channels/library', () => ({ channels: LIBRARY })],
    ['POST', /^\/api\/alerts\/rules\/[^/]+\/mute$/, () => ({ rule: {} })],
    [
      'POST',
      '/api/alerts/rules/backtest',
      () => ({
        supported: true,
        days: 7,
        stepMinutes: 5,
        evaluations: 2000,
        fires: 6,
        firesPerEntity: [{ entityKey: 'support', fires: 6 }],
        incidents: [],
        suggestion: { threshold: 9, firesAtThreshold: 2 },
      }),
    ],
  ]);
}

describe('rules list', () => {
  it('asks the server for stats and the noisiest-first order, and shows the noise column and KPIs', async () => {
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    expect(api.to('GET', '/api/alerts/rules')[0]!.query).toEqual({ include: 'stats', sort: '-fired7d' });
    expect(text()).toContain('Noisy · 7d');
    expect(text()).toContain('Fired · 7d');
    expect(text()).toContain('14');
    expect(text()).toContain('noisy');
  });

  it('marks a muted rule, offers Unmute and sends the unmute', async () => {
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    expect(text()).toContain('Muted ·');
    await click(buttonByText('Unmute'));
    await settle(50);
    expect(api.to('POST', '/api/alerts/rules/r2/mute')[0]!.body).toEqual({ until: null });
  });

  it('mutes with a preset', async () => {
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(100);
    const before = Date.now();
    await click(q('button[aria-label="Mute rule Noisy rule"]'));
    await settle(50);
    await click(qa('[role="menuitem"]').find((node) => node.textContent?.trim() === '4 hours'));
    await settle(50);
    const body = api.to('POST', '/api/alerts/rules/r1/mute')[0]!.body as { until: string };
    expect(Date.parse(body.until) - before).toBeGreaterThan(4 * 3_600_000 - 5_000);
    expect(Date.parse(body.until) - before).toBeLessThan(4 * 3_600_000 + 5_000);
  });
});

describe('rule form', () => {
  it('shows the library channel a rule references and runs the backtest with the preview shape', async () => {
    nav.search = 'edit=r2';
    rulesApi();
    mounted = await mount(createElement(AlertsPage));
    await settle(200);
    expect(text()).toContain('Edit Alert Rule');
    expect(q('[data-testid="library-channel-picker"]')?.textContent).toContain('On-call Slack');

    await click(buttonByText('Run backtest'));
    await settle(50);
    const call = api.to('POST', '/api/alerts/rules/backtest')[0]!;
    expect((call.body as { days: number }).days).toBe(7);
    expect('channels' in ((call.body as { rule: object }).rule)).toBe(false);
    expect(text()).toContain('Would have fired 6 times in the last 7 days');
    expect(text()).toContain('A threshold of 9 would have fired 2 times.');
  });
});

describe('channel library page', () => {
  function libraryApi(role: string) {
    api = installApiMock([
      ['GET', '/api/auth/me', () => ({ userId: 'u1', role })],
      ['GET', '/api/alerts/channels/library', () => ({ channels: LIBRARY })],
      ['POST', '/api/alerts/channels/library', () => jsonResponse({ channel: LIBRARY[1] }, 201)],
      ['DELETE', /^\/api\/alerts\/channels\/library\/[^/]+$/, () => ({ success: true })],
    ]);
  }

  it('lists the entries with what they are used by, and lets an admin create one', async () => {
    libraryApi('admin');
    mounted = await mount(createElement(ChannelsLibraryView));
    await settle(150);
    expect(text()).toContain('On-call Slack');
    expect(text()).toContain('Ops mail');
    expect(text()).toContain('1 rules');
    expect(text()).toContain('Not used');
    expect(buttonByText('New channel')).toBeDefined();
    await click(buttonByText('New channel'));
    await settle(50);
    expect(text()).toContain('New shared channel');
  });

  it('is read-only for a member', async () => {
    libraryApi('member');
    mounted = await mount(createElement(ChannelsLibraryView));
    await settle(150);
    expect(text()).toContain('On-call Slack');
    expect(buttonByText('New channel')).toBeUndefined();
    expect(text()).toContain('Only owners and admins can change shared channels.');
  });

  it('renders in Turkish without a missing message', async () => {
    libraryApi('admin');
    mounted = await mount(createElement(ChannelsLibraryView), 'tr');
    await settle(150);
    expect(text()).toContain('Bildirim kanalları');
    expect(text()).not.toMatch(/(alerts|incidents)\.[a-zA-Z]/);
  });
});
