// @vitest-environment jsdom
/**
 * The incidents list (counts, filters, bulk actions, ?highlight deep link), the overview card
 * and the history page, rendered against the real alerts API shapes.
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
const push = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, prefetch: vi.fn() }),
  usePathname: () => '/dashboard/alerts/incidents',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import IncidentsPage from '@/app/dashboard/alerts/incidents/page';
import AlertHistoryPage from '@/app/dashboard/alerts/history/page';
import ActiveIncidentsCard from '@/components/alerts/ActiveIncidentsCard';
import type { AlertEventDto, IncidentDto, IncidentStatus } from '@/components/alerts/alertTypes';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.search = '';
  push.mockClear();
  replace.mockClear();
});

/** The query of the last URL the page navigated to (the inbox keeps its filters in the URL). */
function lastReplacedQuery(): URLSearchParams {
  const url = String(replace.mock.calls.at(-1)?.[0] ?? '');
  return new URLSearchParams(url.split('?')[1] ?? '');
}
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function incident(id: string, status: IncidentStatus, overrides: Partial<IncidentDto> = {}): IncidentDto {
  return {
    _id: id,
    ruleName: `Rule ${id}`,
    ruleId: 'r1',
    alertEventId: `e-${id}`,
    metric: 'agent_error_rate',
    threshold: 5,
    actualValue: 9.5,
    severity: 'warning',
    status,
    notes: [],
    firedAt: '2026-10-15T10:00:00.000Z',
    entityType: 'agent',
    entityKey: `agent-${id}`,
    module: 'agents',
    metadata: { operator: 'gt' },
    ...overrides,
  };
}

const COUNTS = { open: 2, acknowledged: 1, investigating: 0, resolved: 1, closed: 0 };
const ROWS = [incident('i1', 'open'), incident('i2', 'open', { severity: 'critical' }), incident('i3', 'acknowledged'), incident('i4', 'resolved', { autoResolved: true, resolvedAt: '2026-10-15T11:00:00.000Z' })];

function incidentsApi(rows: IncidentDto[] = ROWS) {
  api = installApiMock([
    ['GET', '/api/alerts/incidents', () => ({ incidents: rows, total: rows.length, hasMore: false, openCount: COUNTS.open, counts: COUNTS })],
    ['POST', '/api/alerts/incidents/bulk', (call) => ({ updated: (call.body as { ids: string[] }).ids.length, failed: [] })],
    ['GET', /^\/api\/alerts\/incidents\/[^/]+$/, (call) => {
      const id = call.path.split('/').pop();
      return id === 'i9' ? { incident: incident('i9', 'closed', { ruleName: 'Old rule' }) } : jsonResponse({ error: 'Incident not found' }, 404);
    }],
    ['PATCH', /^\/api\/alerts\/incidents\/[^/]+$/, () => ({ incident: {} })],
  ]);
}

const rowCheckboxes = () => qa<HTMLInputElement>('tbody input[type="checkbox"]');

describe('IncidentsPage', () => {
  it('lists the open incidents with tab counts, entity chips and the value against its limit', async () => {
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    const first = api.to('GET', '/api/alerts/incidents')[0]!;
    expect(first.query).toMatchObject({ status: 'open', limit: '25', skip: '0' });
    expect(text()).toContain('Rule i1');
    expect(text()).toContain('agent-i1');
    expect(text()).toContain('9.5%');
    expect(text()).toContain('limit > 5%');
    expect(text()).toContain('Agent Error Rate');
    // counts per status come from the server, and the header shows the open ones
    const tabs = qa('button, [role="tab"]').map((node) => node.textContent ?? '');
    expect(tabs.some((label) => /^Open\s*2$/.test(label.trim()))).toBe(true);
    expect(tabs.some((label) => /^Acknowledged\s*1$/.test(label.trim()))).toBe(true);
    expect(text()).toContain('2 open');
  });

  it('shows an error with a retry instead of an empty table when the load fails', async () => {
    api = installApiMock([['GET', '/api/alerts/incidents', () => jsonResponse({ message: 'database unavailable' }, 500)]]);
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    expect(text()).toContain('database unavailable');
    await click(buttonByText('Retry'));
    await settle(50);
    expect(api.to('GET', '/api/alerts/incidents').length).toBeGreaterThanOrEqual(2);
  });

  it('sends only the incidents a bulk action applies to and asks before resolving', async () => {
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    // select an open, an acknowledged and a resolved incident
    const boxes = rowCheckboxes();
    expect(boxes).toHaveLength(4);
    for (const index of [0, 2, 3]) await click(boxes[index]);
    // acknowledge: only the open one is eligible; no confirmation for it
    await click(buttonByText('Acknowledge', q('.ds-toolbar') ?? document.body) ?? qa('button').find((button) => button.textContent === 'Acknowledge'));
    await settle(50);
    const bulk = api.to('POST', '/api/alerts/incidents/bulk');
    expect(bulk).toHaveLength(1);
    expect(bulk[0]!.body).toEqual({ ids: ['i1'], action: 'acknowledge' });
  });

  it('confirms a bulk resolve, then sends the eligible ids', async () => {
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    for (const index of [0, 2, 3]) await click(rowCheckboxes()[index]);
    await click(qa('button').find((button) => button.textContent === 'Resolve'));
    await settle(50);
    expect(text()).toContain('Mark 2 incidents as resolved?');
    expect(api.to('POST', '/api/alerts/incidents/bulk')).toHaveLength(0);
    await click(qa<HTMLButtonElement>('button[type="submit"]').find((button) => button.textContent === 'Resolve'));
    await settle(100);
    const bulk = api.to('POST', '/api/alerts/incidents/bulk');
    expect(bulk).toHaveLength(1);
    expect(bulk[0]!.body).toEqual({ ids: ['i1', 'i3'], action: 'resolve' });
    // the list is reloaded and the selection is gone
    expect(api.to('GET', '/api/alerts/incidents').length).toBeGreaterThanOrEqual(2);
    expect(rowCheckboxes().every((box) => !box.checked)).toBe(true);
  });

  it('does not call the API when nothing selected can make the move', async () => {
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    await click(rowCheckboxes()[3]);
    await click(qa('button').find((button) => button.textContent === 'Acknowledge'));
    await settle(50);
    expect(api.to('POST', '/api/alerts/incidents/bulk')).toHaveLength(0);
  });

  it('highlights the row of ?highlight=<id> that is on the page', async () => {
    nav.search = 'highlight=i3';
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    // a deep link opens on "all" so the incident is there whatever its status
    expect(api.to('GET', '/api/alerts/incidents')[0]!.query).not.toHaveProperty('status');
    const row = q('[data-incident-row="i3"]')?.closest('tr');
    expect(row?.getAttribute('data-highlighted')).toBe('true');
    expect(api.to('GET', '/api/alerts/incidents/i3')).toHaveLength(0);
  });

  it('fetches and pins a highlighted incident that is outside the loaded page', async () => {
    nav.search = 'highlight=i9';
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    expect(api.to('GET', '/api/alerts/incidents/i9')).toHaveLength(1);
    const records = qa('[data-incident-row]').map((node) => (node as HTMLElement).dataset.incidentRow);
    expect(records[0]).toBe('i9');
    expect(q('[data-incident-row="i9"]')?.closest('tr')?.getAttribute('data-highlighted')).toBe('true');
  });

  it('ignores a highlight that does not exist', async () => {
    nav.search = 'highlight=gone';
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    expect(qa('[data-highlighted]')).toHaveLength(0);
    expect(text()).toContain('Rule i1');
  });

  it('applies a rule and entity deep-link filter to the request and lets the user remove it', async () => {
    nav.search = 'ruleId=r1&entityKey=agent-i1&severity=critical';
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    expect(api.to('GET', '/api/alerts/incidents')[0]!.query).toMatchObject({ ruleId: 'r1', entityKey: 'agent-i1', severity: 'critical' });
    expect(text()).toContain('Entity: agent-i1');
    await click(q('button[aria-label="Remove the rule filter"]'));
    await settle(50);
    const next = lastReplacedQuery();
    expect(next.has('ruleId')).toBe(false);
    expect(next.get('entityKey')).toBe('agent-i1');
    expect(next.get('severity')).toBe('critical');
  });

  it('sends the search box to the server (through the URL) after a pause', async () => {
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    const input = q<HTMLInputElement>('input[data-inbox-search]')!;
    await setInput(input, 'agent-i2');
    await settle(600);
    expect(lastReplacedQuery().get('q')).toBe('agent-i2');

    // the page reads the filter back from the URL and asks the server for it
    nav.search = 'q=agent-i2';
    await mounted.unmount();
    mounted = await mount(createElement(IncidentsPage));
    await settle(100);
    expect(api.to('GET', '/api/alerts/incidents').at(-1)!.query).toMatchObject({ q: 'agent-i2' });
  });

  it('renders in Turkish without a missing message', async () => {
    incidentsApi();
    mounted = await mount(createElement(IncidentsPage), 'tr');
    await settle(100);
    expect(text()).toContain('Olaylar');
    expect(text()).toContain('Ajan Hata Oranı');
    expect(text()).not.toMatch(/(alerts|incidents)\.[a-zA-Z]/);
  });
});

describe('ActiveIncidentsCard', () => {
  it('lists the open incidents of the project, newest first, with a link to all of them', async () => {
    api = installApiMock([['GET', '/api/alerts/incidents', () => ({ incidents: ROWS.slice(0, 2), total: 2, hasMore: false, openCount: 7, counts: COUNTS })]]);
    mounted = await mount(createElement(ActiveIncidentsCard, { limit: 2 }));
    await settle(100);
    expect(api.to('GET', '/api/alerts/incidents')[0]!.query).toEqual({ status: 'open', limit: '2' });
    expect(text()).toContain('Active incidents');
    expect(text()).toContain('Rule i1');
    expect(text()).toContain('agent-i1');
    expect(text()).toContain('Agent Error Rate');
    expect(text()).toContain('7');
    expect(q<HTMLAnchorElement>('a[href="/dashboard/alerts/incidents"]')).not.toBeNull();
    expect(q<HTMLAnchorElement>('a[href="/dashboard/alerts/incidents/i1"]')).not.toBeNull();
  });

  it('says so when nothing is open and drops the metric line when compact', async () => {
    api = installApiMock([['GET', '/api/alerts/incidents', () => ({ incidents: [], total: 0, hasMore: false, openCount: 0, counts: COUNTS })]]);
    mounted = await mount(createElement(ActiveIncidentsCard));
    await settle(100);
    expect(text()).toContain('No open incidents.');
    await mounted.unmount();

    api = installApiMock([['GET', '/api/alerts/incidents', () => ({ incidents: ROWS.slice(0, 1), total: 1, hasMore: false, openCount: 1, counts: COUNTS })]]);
    mounted = await mount(createElement(ActiveIncidentsCard, { compact: true }));
    await settle(100);
    expect(text()).toContain('Rule i1');
    expect(text()).not.toContain('Agent Error Rate');
  });

  it('renders nothing for a viewer without access to the alerts service', async () => {
    api = installApiMock([['GET', '/api/alerts/incidents', () => jsonResponse({ error: 'forbidden' }, 403)]]);
    mounted = await mount(createElement(ActiveIncidentsCard));
    await settle(100);
    expect(q('[data-testid="active-incidents-card"]')).toBeNull();
    expect(text()).not.toContain('Active incidents');
  });

  it('shows the error and retries', async () => {
    api = installApiMock([['GET', '/api/alerts/incidents', () => jsonResponse({ message: 'boom' }, 500)]]);
    mounted = await mount(createElement(ActiveIncidentsCard));
    await settle(100);
    expect(text()).toContain('boom');
    await click(buttonByText('Retry'));
    await settle(50);
    expect(api.to('GET', '/api/alerts/incidents')).toHaveLength(2);
  });
});

describe('AlertHistoryPage', () => {
  const EVENTS: AlertEventDto[] = [
    {
      _id: 'ev1',
      ruleId: 'r1',
      ruleName: 'Support errors',
      metric: 'agent_error_rate',
      threshold: 5,
      actualValue: 9.5,
      status: 'fired',
      firedAt: '2026-10-15T10:00:00.000Z',
      entityType: 'agent',
      entityKey: 'support',
      baselineValue: 2,
      channels: [
        { type: 'email', target: 'ops@example.com', success: true },
        { type: 'slack', target: 'https://hooks.slack.com/…', success: false, error: 'rejected' },
      ],
    },
    { _id: 'ev2', ruleName: 'Old', metric: 'error_rate', threshold: 5, actualValue: 6, status: 'resolved', firedAt: '2026-10-14T10:00:00.000Z', resolvedAt: '2026-10-14T11:00:00.000Z', channels: [] },
  ];

  it('lists events with their entity, value against the baseline and delivery results', async () => {
    api = installApiMock([
      ['GET', '/api/alerts/history', () => ({ events: EVENTS, activeCount: 1 })],
      ['PATCH', /^\/api\/alerts\/history\/[^/]+\/acknowledge$/, () => ({ event: {} })],
    ]);
    mounted = await mount(createElement(AlertHistoryPage));
    await settle(100);
    expect(api.to('GET', '/api/alerts/history')[0]!.query).toMatchObject({ limit: '26', skip: '0' });
    expect(text()).toContain('Support errors');
    expect(text()).toContain('Agent Error Rate');
    expect(text()).toContain('support');
    expect(text()).toContain('9.5%');
    expect(text()).toContain('normal 2%');
    expect(text()).toContain('1/2 sent');
    expect(text()).toContain('1 active');
    // the legacy event is labelled from the same catalog
    expect(text()).toContain('Error Rate');
  });

  it('acknowledges a fired event and reloads', async () => {
    api = installApiMock([
      ['GET', '/api/alerts/history', () => ({ events: EVENTS, activeCount: 1 })],
      ['PATCH', /^\/api\/alerts\/history\/[^/]+\/acknowledge$/, () => ({ event: {} })],
    ]);
    mounted = await mount(createElement(AlertHistoryPage));
    await settle(100);
    // the row action lives in a menu
    await click(q('button[aria-label]:not([aria-label=""])', q('tbody tr') ?? document.body));
    await settle(50);
    const acknowledge = qa('button, [role="menuitem"]').find((node) => node.textContent?.trim() === 'Acknowledge');
    expect(acknowledge).toBeDefined();
    await click(acknowledge);
    await settle(100);
    expect(api.to('PATCH', '/api/alerts/history/ev1/acknowledge')).toHaveLength(1);
    expect(api.to('GET', '/api/alerts/history').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the empty state', async () => {
    api = installApiMock([['GET', '/api/alerts/history', () => ({ events: [], activeCount: 0 })]]);
    mounted = await mount(createElement(AlertHistoryPage));
    await settle(100);
    expect(text()).toContain('No alerts triggered');
  });
});
