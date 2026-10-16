// @vitest-environment jsdom
/**
 * Review fixes of the alerts UI: condition-mode aware values (absence / SLO rows), translated server
 * notes, mode availability in the rules list, user names instead of ids, the shared catalog hook,
 * filter re-seeding from the URL, a stored rule without channels, and in-app link hardening.
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
import { messages } from '@/lib/i18n/messages';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/alerts',
  useSearchParams: () => new URLSearchParams(nav.search),
  useParams: () => ({ incidentId: 'i1' }),
}));

import AlertsPage from '@/app/dashboard/alerts/page';
import IncidentsPage from '@/app/dashboard/alerts/incidents/page';
import IncidentDetailPage from '@/app/dashboard/alerts/incidents/[incidentId]/page';
import AlertHistoryPage from '@/app/dashboard/alerts/history/page';
import AlertRuleForm from '@/components/alerts/AlertRuleForm';
import ChannelsEditor from '@/components/alerts/ChannelsEditor';
import { DEFAULT_ALERT_CATALOG, ruleStateView, type TFn } from '@/components/alerts/alertCatalog';
import { channelsFromStored, newChannelItem } from '@/components/alerts/channelItems';
import { buildRulePayload, channelsSignature, checkRule, valuesFromRule } from '@/components/alerts/ruleForm';
import { describeRowValue, internalPath, rowMode, translateServerNote, translateServerNotes } from '@/components/alerts/incidentUi';
import { resetAlertMetaCache } from '@/components/alerts/useAlertMeta';
import { resetUserDirectoryCache, userLabel } from '@/components/alerts/useUserDirectory';
import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';
import type { AlertEventDto, AlertMeta, AlertRuleDto, IncidentDto } from '@/components/alerts/alertTypes';

type Tree = { [key: string]: string | Tree };
function makeT(locale: 'en' | 'tr', namespace = 'alerts'): TFn {
  const root = (messages[locale] as unknown as Record<string, Tree>)[namespace];
  return (key, values) => {
    let node: string | Tree | undefined = root;
    for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
    if (typeof node !== 'string') return `${namespace}.${key}`;
    return node.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
  };
}
const tEn = makeT('en');
const tTr = makeT('tr');

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.search = '';
  resetAlertMetaCache();
  resetUserDirectoryCache();
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

function incident(id: string, overrides: Partial<IncidentDto> = {}): IncidentDto {
  return {
    _id: id,
    ruleName: `Rule ${id}`,
    ruleId: 'r1',
    alertEventId: `e-${id}`,
    metric: 'agent_error_rate',
    threshold: 0,
    actualValue: 0,
    severity: 'warning',
    status: 'open',
    notes: [],
    firedAt: '2026-10-15T10:00:00.000Z',
    entityType: 'agent',
    entityKey: 'support',
    module: 'agents',
    metadata: { operator: 'gt' },
    ...overrides,
  };
}

// ── pure ────────────────────────────────────────────────────────────────────

describe('rowMode and describeRowValue', () => {
  it('reads the mode from the context, then the metadata, then defaults to threshold', () => {
    expect(rowMode({ context: { mode: 'absence' } })).toBe('absence');
    expect(rowMode({ metadata: { mode: 'slo_burn' } })).toBe('slo_burn');
    expect(rowMode({ context: { mode: 'absence' }, metadata: { mode: 'baseline' } })).toBe('absence');
    expect(rowMode({ metadata: { mode: 'nonsense' } })).toBe('threshold');
    expect(rowMode({})).toBe('threshold');
  });

  it('shows an absence row as a request count, never as a metric value or a limit', () => {
    const row = { metric: 'agent_error_rate', actualValue: 0, threshold: 0, metadata: { mode: 'absence' } };
    expect(describeRowValue(row, DEFAULT_ALERT_CATALOG, tEn, 'en')).toEqual({ value: '0 requests', compare: 'normally active, now silent' });
    expect(describeRowValue({ ...row, actualValue: 12 }, DEFAULT_ALERT_CATALOG, tEn, 'en').value).toBe('12 requests');
    expect(describeRowValue(row, DEFAULT_ALERT_CATALOG, tTr, 'tr').value).toBe('0 istek');
  });

  it('shows an SLO row with the value and the burn text, not "limit > 0"', () => {
    const row = { metric: 'agent_error_rate', actualValue: 7.5, threshold: 0, context: { mode: 'slo_burn' } };
    expect(describeRowValue(row, DEFAULT_ALERT_CATALOG, tEn, 'en')).toEqual({ value: '7.5%', compare: 'error budget burning too fast' });
  });

  it('keeps the limit for a threshold row and the normal value for a baseline row', () => {
    const base = { metric: 'agent_error_rate', actualValue: 9.5, threshold: 5, metadata: { operator: 'gt' } };
    expect(describeRowValue(base, DEFAULT_ALERT_CATALOG, tEn, 'en')).toEqual({ value: '9.5%', compare: 'limit > 5%' });
    expect(describeRowValue({ ...base, baselineValue: 2, metadata: { mode: 'baseline' } }, DEFAULT_ALERT_CATALOG, tEn, 'en').compare).toBe('normal 2%');
    expect(describeRowValue({ ...base, metadata: { mode: 'baseline' } }, DEFAULT_ALERT_CATALOG, tEn, 'en').compare).toBeNull();
  });
});

describe('server notes', () => {
  it('translates the notes the server is known to write', () => {
    expect(translateServerNote('Showing 50 of 120 entities', tTr)).toBe('120 varlığın 50 tanesi gösteriliyor');
    expect(translateServerNote('Only the 200 busiest entities are evaluated', tTr)).toBe('Yalnızca en yoğun 200 varlık değerlendiriliyor');
    expect(translateServerNote('No entity has data in the evaluation window yet', tEn)).toBe('No entity has data in the evaluation window yet');
    expect(translateServerNote('The baseline mode needs an enterprise licence', tTr)).toContain('Taban çizgisi');
    expect(translateServerNote('The slo_burn mode is not available in this edition', tEn)).toBe('The SLO burn condition type is not available in this edition');
    expect(translateServerNote('Unknown metric "foo_bar"', tTr)).toBe('Bilinmeyen metrik "foo_bar"');
  });

  it('drops text it cannot translate, unless asked to keep it (English UI)', () => {
    expect(translateServerNote('Something new', tTr)).toBeNull();
    expect(translateServerNote('Something new', tEn, true)).toBe('Something new');
    expect(translateServerNotes(['Something new', 'Showing 1 of 2 entities', 'Showing 1 of 2 entities'], tTr)).toEqual(['2 varlığın 1 tanesi gösteriliyor']);
  });
});

describe('internalPath', () => {
  it('accepts dashboard paths only', () => {
    expect(internalPath('/dashboard/tracing/sessions?status=error&agent=x')).toBe('/dashboard/tracing/sessions?status=error&agent=x');
    for (const bad of ['/\\evil.example', '//evil.example', 'https://evil.example', '/dashboard/\\x', '/dashboard/a\nb', '/other', '', null, undefined]) {
      expect(internalPath(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
});

describe('ruleStateView', () => {
  const modes = { baseline: { available: false, reason: 'license_required' }, slo_burn: { available: true } };
  it('marks an enabled rule of an unavailable mode instead of calling it OK', () => {
    const rule = { enabled: true, condition: { operator: 'gt' as const, threshold: 0, mode: 'baseline' as const } };
    expect(ruleStateView(rule, { ok: 3, pending: 0, firing: 0 }, modes)).toEqual({ kind: 'blocked', reason: 'license_required' });
    expect(ruleStateView({ ...rule, enabled: false }, undefined, modes)).toEqual({ kind: 'paused' });
    expect(ruleStateView({ ...rule, condition: { ...rule.condition, mode: 'slo_burn' } }, { ok: 1, pending: 1, firing: 2 }, modes)).toEqual({
      kind: 'counts',
      firing: 2,
      pending: 1,
      ok: 1,
    });
    expect(ruleStateView({ ...rule, condition: { operator: 'gt', threshold: 1 } }, undefined, modes)).toEqual({ kind: 'counts', firing: 0, pending: 0, ok: 0 });
  });
});

describe('userLabel', () => {
  const directory = { meId: 'u1', meName: 'Ada', names: { u2: 'Grace' } };
  const labels = { you: 'You', system: 'system' };
  it('names the viewer, the system and known users; shortens the rest', () => {
    expect(userLabel('u1', directory, labels)).toBe('You');
    expect(userLabel('system', directory, labels)).toBe('system');
    expect(userLabel('u2', directory, labels)).toBe('Grace');
    expect(userLabel('6650ab12cd34ef567890abcd', directory, labels)).toBe('6650ab12…');
    expect(userLabel(null, directory, labels)).toBe('—');
  });
  it('prefers the name the server resolved, so viewers who cannot list users see names', () => {
    expect(userLabel('6650ab12cd34ef567890abcd', directory, labels, 'Linus')).toBe('Linus');
    expect(userLabel('u2', directory, labels, 'Grace H.')).toBe('Grace H.');
    expect(userLabel('6650ab12cd34ef567890abcd', directory, labels, null)).toBe('6650ab12…');
    expect(userLabel('u1', directory, labels, 'Ada L.')).toBe('You');
    expect(userLabel('system', directory, labels, 'x')).toBe('system');
  });
});

describe('a stored rule without channels', () => {
  const legacy = { _id: 'r1', name: 'Legacy', metric: 'agent_error_rate', module: 'agents', condition: { operator: 'gt', threshold: 5 }, windowMinutes: 15, cooldownMinutes: 0, enabled: true, channels: [] } as unknown as AlertRuleDto;
  it('can be saved untouched, without sending a channel list, but not once channels were edited into an invalid state', () => {
    const values = valuesFromRule(legacy, DEFAULT_ALERT_CATALOG);
    const sig = channelsSignature(values.channels);
    expect(checkRule(values, DEFAULT_ALERT_CATALOG).channels).toBe(false);
    expect(checkRule(values, DEFAULT_ALERT_CATALOG, { channelsUnchanged: true }).channels).toBe(true);
    expect('channels' in buildRulePayload(values, { catalog: DEFAULT_ALERT_CATALOG, isEdit: true, channelsUnchanged: true })).toBe(false);
    expect('channels' in buildRulePayload(values, { catalog: DEFAULT_ALERT_CATALOG, isEdit: true })).toBe(true);
    const edited = { ...values, channels: [newChannelItem('slack')] };
    expect(channelsSignature(edited.channels)).not.toBe(sig);
  });
});

// ── pages ───────────────────────────────────────────────────────────────────

describe('incident rows by condition type', () => {
  it('lists an absence incident as a request count and an SLO incident without a fake limit', async () => {
    const rows = [
      incident('i1', { context: { mode: 'absence', windowMinutes: 15 } }),
      incident('i2', { actualValue: 7.5, metadata: { mode: 'slo_burn' } }),
    ];
    api = installApiMock([['GET', '/api/alerts/incidents', () => ({ incidents: rows, total: 2, hasMore: false, openCount: 2, counts: { open: 2, acknowledged: 0, investigating: 0, resolved: 0, closed: 0 } })]]);
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    expect(text()).toContain('0 requests');
    expect(text()).toContain('normally active, now silent');
    expect(text()).toContain('error budget burning too fast');
    expect(text()).not.toContain('limit > 0');
    expect(text()).not.toContain('0%');
  });

  it('shows the same on the incident detail page, with the viewer as "You" and the stored names resolved', async () => {
    const detail = incident('i1', {
      actualValue: 0,
      peakValue: 0,
      context: { mode: 'absence', windowMinutes: 15, notes: ['Only the 200 busiest entities are evaluated'] },
      acknowledgedAt: '2026-10-15T10:05:00.000Z',
      acknowledgedBy: 'u1',
      assignedTo: 'u2',
    });
    api = installApiMock([
      ['GET', '/api/alerts/incidents/i1', () => ({ incident: detail })],
      ['GET', '/api/auth/me', () => ({ userId: 'u1', name: 'Ada' })],
      ['GET', '/api/users', () => ({ users: [{ _id: 'u2', name: 'Grace', email: 'g@example.com' }] })],
    ]);
    mounted = await mount(createElement(IncidentDetailPage), 'tr');
    await settle(150);
    expect(text()).toContain('0 istek');
    expect(text()).not.toContain('sınır');
    expect(text()).toContain('Siz');
    expect(text()).toContain('Grace');
    expect(text()).toContain('Yalnızca en yoğun 200 varlık değerlendiriliyor');
    expect(text()).not.toContain('busiest entities');
  });

  it('uses the server catalog for a metric the bundle does not know', async () => {
    const custom = { ...ALERT_METRIC_CATALOG[0]!, id: 'agent_new_metric', label: 'Brand new metric', module: 'agents' } as unknown as (typeof ALERT_METRIC_CATALOG)[number];
    api = installApiMock([
      ['GET', '/api/alerts/incidents/i1', () => ({ incident: incident('i1', { metric: 'agent_new_metric', actualValue: 3, metadata: {} }) })],
      ['GET', '/api/alerts/rules', () => ({ rules: [], meta: { ...META, catalog: [...ALERT_METRIC_CATALOG, custom] } })],
    ]);
    mounted = await mount(createElement(IncidentDetailPage));
    await settle(150);
    expect(text()).toContain('Brand new metric');
  });
});

describe('IncidentsPage filters follow the URL', () => {
  it('re-seeds the rule filter when the URL changes and does not refetch a missing highlight', async () => {
    nav.search = 'ruleId=r7&status=all';
    api = installApiMock([
      ['GET', '/api/alerts/incidents', () => ({ incidents: [incident('i1')], total: 1, hasMore: false, openCount: 1, counts: { open: 1, acknowledged: 0, investigating: 0, resolved: 0, closed: 0 } })],
      ['GET', /^\/api\/alerts\/incidents\/[^/]+$/, () => jsonResponse({ error: 'Incident not found' }, 404)],
    ]);
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    expect(api.to('GET', '/api/alerts/incidents')[0]!.query).toMatchObject({ ruleId: 'r7' });
    expect(text()).toContain('One rule');
    // the sub-navigation link: same page, no parameters
    nav.search = '';
    await mounted.unmount();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    const last = api.to('GET', '/api/alerts/incidents').at(-1)!;
    expect(last.query).not.toHaveProperty('ruleId');
    expect(last.query).toMatchObject({ status: 'open' });
  });

  it('looks a highlight up once, even if the list is refreshed afterwards', async () => {
    nav.search = 'highlight=i404';
    api = installApiMock([
      ['GET', '/api/alerts/incidents', () => ({ incidents: [incident('i1')], total: 1, hasMore: false, openCount: 1, counts: { open: 1, acknowledged: 0, investigating: 0, resolved: 0, closed: 0 } })],
      ['GET', /^\/api\/alerts\/incidents\/[^/]+$/, () => jsonResponse({ error: 'Incident not found' }, 404)],
    ]);
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    await click(qa<HTMLButtonElement>('button').find((button) => /refresh/i.test(button.getAttribute('aria-label') ?? button.textContent ?? '')));
    await settle(100);
    expect(api.to('GET', '/api/alerts/incidents/i404')).toHaveLength(1);
  });
});

describe('AlertHistoryPage', () => {
  it('names the user who acknowledged an event and shows an absence event as a count', async () => {
    const events: AlertEventDto[] = [
      {
        _id: 'ev1',
        ruleName: 'Silent agent',
        metric: 'agent_error_rate',
        threshold: 0,
        actualValue: 0,
        status: 'acknowledged',
        firedAt: '2026-10-15T10:00:00.000Z',
        acknowledgedAt: '2026-10-15T10:05:00.000Z',
        acknowledgedBy: 'u1',
        entityType: 'agent',
        entityKey: 'support',
        metadata: { mode: 'absence' },
        channels: [],
      },
    ];
    api = installApiMock([
      ['GET', '/api/alerts/history', () => ({ events, activeCount: 0 })],
      ['GET', '/api/auth/me', () => ({ userId: 'u1', name: 'Ada' })],
    ]);
    mounted = await mount(createElement(AlertHistoryPage));
    await settle(150);
    expect(text()).toContain('You');
    expect(text()).toContain('0 requests');
    // Leaf texts, not the page text: "You" next to a relative time like "10 hours ago" reads "You10…".
    const leaves = qa<HTMLElement>('*').filter((el) => el.childElementCount === 0).map((el) => el.textContent?.trim() ?? '');
    expect(leaves.some((leaf) => /\bu1\b/.test(leaf))).toBe(false);
  });
});

describe('AlertsPage', () => {
  const RULES: AlertRuleDto[] = [
    {
      _id: 'r1',
      name: 'Needs EE',
      module: 'agents',
      metric: 'agent_error_rate',
      condition: { operator: 'gt', threshold: 0, mode: 'baseline', baseline: { direction: 'up', minRatio: 2, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily' } },
      windowMinutes: 15,
      cooldownMinutes: 0,
      enabled: true,
      entity: { entityType: 'agent', mode: 'all' },
      channels: [],
    },
    {
      _id: 'r2',
      name: 'Plain threshold',
      module: 'agents',
      metric: 'agent_error_rate',
      condition: { operator: 'gt', threshold: 5, mode: 'threshold' },
      windowMinutes: 15,
      cooldownMinutes: 0,
      enabled: true,
      entity: { entityType: 'agent', mode: 'all' },
      channels: [],
    },
  ];

  it('flags a rule of an unavailable mode and shows firing, pending and ok counts', async () => {
    api = installApiMock([
      [
        'GET',
        '/api/alerts/rules',
        () => ({
          rules: RULES,
          meta: { ...META, modes: { ...META.modes, baseline: { available: false, reason: 'license_required' } } },
          states: { r1: { ok: 3, pending: 0, firing: 0 }, r2: { ok: 4, pending: 1, firing: 2 } },
        }),
      ],
    ]);
    mounted = await mount(createElement(AlertsPage));
    await settle(150);
    expect(text()).toContain('Not evaluated');
    expect(text()).not.toContain('3 OK');
    expect(text()).toContain('2 firing');
    expect(text()).toContain('1 pending');
    expect(text()).toContain('4 OK');
  });

  it('opens the create deep link only after the rules request settled, with the server meta', async () => {
    nav.search = 'create=1&module=agents&metric=agent_error_rate&entityType=agent&entityKey=support';
    api = installApiMock([['GET', '/api/alerts/rules', () => ({ rules: [], meta: { ...META, modes: { ...META.modes, absence: { available: false, reason: 'not_enterprise_build' } } }, states: {} })]]);
    mounted = await mount(createElement(AlertsPage));
    await settle(150);
    // one request: the form reuses the page's meta instead of fetching the rules a second time
    expect(api.to('GET', '/api/alerts/rules')).toHaveLength(1);
    expect(text()).toContain('Create Alert Rule');
    expect(q('[data-testid="mode-upsell"]')).not.toBeNull();
  });
});

describe('AlertRuleForm', () => {
  async function renderForm(extra: Record<string, unknown> = {}, previewBody: unknown = { targets: [], notes: [] }, locale = 'en') {
    api = installApiMock([
      ['GET', '/api/alerts/entities', () => ({ entities: [] })],
      ['POST', '/api/alerts/rules/preview', () => previewBody],
      ...(extra.rules ? ([['GET', '/api/alerts/rules', extra.rules as () => unknown]] as Array<[string, string, () => unknown]>) : []),
    ]);
    mounted = await mount(
      createElement(AlertRuleForm, {
        opened: true,
        onClose: vi.fn(),
        onSuccess: vi.fn(),
        initialData: { module: 'agents', metric: 'agent_error_rate', condition: { operator: 'gt', threshold: 0, mode: 'absence', absence: { lookbackHours: 24, minExpectedPerWindow: 1 } }, windowMinutes: 15, entity: { entityType: 'agent', mode: 'all' } },
        ...(extra.props as object),
      } as never),
      locale,
    );
    await settle(100);
  }

  it('previews an absence rule as request counts and translates the server notes', async () => {
    await renderForm(
      { props: { meta: META } },
      { targets: [{ entityKey: 'support', value: 0, sampleCount: 0, breached: true }], notes: ['Showing 1 of 2 entities'] },
      'tr',
    );
    await click(qa<HTMLButtonElement>('button').find((button) => button.textContent?.trim() === 'Şimdi önizle'));
    await settle(100);
    const preview = q('[data-testid="rule-preview"]')!;
    expect(preview.textContent).toContain('İstek');
    expect(preview.textContent).toContain('0');
    expect(preview.textContent).not.toContain('0%');
    expect(preview.textContent).toContain('2 varlığın 1 tanesi gösteriliyor');
    expect(preview.textContent).not.toContain('Showing');
  });

  it('explains that an SLO preview is decided by the burn rate', async () => {
    await renderForm(
      { props: { meta: META, initialData: { module: 'agents', metric: 'agent_error_rate', condition: { operator: 'gt', threshold: 0, mode: 'slo_burn', slo: { objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 } }, windowMinutes: 15, entity: { entityType: 'agent', mode: 'all' } } } },
      { targets: [{ entityKey: 'support', value: 4, sampleCount: 10, breached: false }], notes: [] },
    );
    await click(qa<HTMLButtonElement>('button').find((button) => button.textContent?.trim() === 'Preview now'));
    await settle(100);
    expect(q('[data-testid="preview-slo-hint"]')?.textContent).toContain('burn rate');
  });

  it('tells the user when the mode availability could not be loaded', async () => {
    await renderForm({ props: { meta: null }, rules: () => jsonResponse({ error: 'down' }, 500) });
    expect(q('[data-testid="mode-unknown"]')).not.toBeNull();
    expect(api.to('GET', '/api/alerts/rules').length).toBeGreaterThanOrEqual(1);
  });

  it('saves a legacy rule that has no channels without sending a channel list', async () => {
    api = installApiMock([
      ['GET', '/api/alerts/entities', () => ({ entities: [] })],
      ['PUT', /^\/api\/alerts\/rules\/[^/]+$/, () => ({ rule: { _id: 'r1' } })],
    ]);
    const onSuccess = vi.fn();
    mounted = await mount(
      createElement(AlertRuleForm, {
        opened: true,
        onClose: vi.fn(),
        onSuccess,
        mode: 'edit',
        ruleId: 'r1',
        meta: META,
        initialData: { _id: 'r1', name: 'Legacy', module: 'agents', metric: 'agent_error_rate', condition: { operator: 'gt', threshold: 5, mode: 'threshold' }, windowMinutes: 15, cooldownMinutes: 0, enabled: true, entity: { entityType: 'agent', mode: 'all' }, channels: [] },
      }),
    );
    await settle(100);
    const input = q<HTMLInputElement>('input[placeholder="e.g. Pulse Main error rate"]')!;
    await setInput(input, 'Legacy renamed');
    await click(qa<HTMLButtonElement>('button').find((button) => button.textContent?.trim() === 'Save'));
    await settle(100);
    const puts = api.to('PUT', '/api/alerts/rules/r1');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ name: 'Legacy renamed' });
    expect(puts[0]!.body as object).not.toHaveProperty('channels');
    expect(onSuccess).toHaveBeenCalled();
  });
});

describe('ChannelsEditor webhook replace', () => {
  it('warns that the stored signing secret follows the new URL', async () => {
    const [stored] = channelsFromStored([{ id: 'ch_cccccccccccc', type: 'webhook', urlHint: 'https://example.com/…', hasSecret: true }]);
    let value = [stored!];
    const render = () => createElement(ChannelsEditor, { value, onChange: (next: typeof value) => { value = next; } });
    mounted = await mount(render());
    await settle(50);
    await click(buttonByText('Replace'));
    await settle(50);
    expect(q('[data-testid="webhook-secret-kept"]')).toBeNull();
    await mounted.unmount();
    value = [{ ...value[0]!, replace: true, url: 'https://new.example.com/hook' }];
    mounted = await mount(render());
    await settle(50);
    expect(q('[data-testid="webhook-secret-kept"]')?.textContent).toContain('signing secret');
  });
});
