// @vitest-environment jsdom
/**
 * The IAM center's Overview, rendered for real (jsdom) against contract-shaped
 * answers of the endpoints that still exist: the engine's health and counters,
 * the policies, the directory and the latest denials. It is a summary - what is
 * enabled, who is affected, what needs attention - with no mode switch and no
 * shadow report.
 */

import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  type RouteHandler,
} from '../helpers/iamCenterUi';
import { defaultRoutes, MANAGED } from '../helpers/iamCenterFixtures';
import { messages } from '@/lib/i18n/messages';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

import OverviewTab from '@/components/iam/overview/OverviewTab';

let api: ApiMock;
let mounted: Mounted;

beforeAll(() => installDomStubs());

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TENANT_STATS = {
  statsScope: 'tenant',
  generatedAt: '2026-10-10T10:00:00.000Z',
  health: { status: 'ok' },
  policySet: { version: 3, custom: 3, skipped: [] },
  undeclaredRoutes: { count: 0, sample: [] },
  engine: { decisions: 1234, p50Us: null, p99Us: null, principalCache: { hitRate: null } },
  enforce: {
    engineDecisions: 1234,
    engineAllows: 1200,
    engineDenies: 34,
    unavailable: 0,
    undeclaredDenies: 0,
    ownerSafety: 2,
    lastUnavailableAt: null,
    lastUnavailableReason: null,
  },
};

const DENIAL = {
  id: 'a1',
  at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  kind: 'denials',
  principal: { type: 'user', id: 'u-bob', label: 'Bob Ray' },
  service: 'models',
  action: 'models.write',
  route: '/api/models/m1',
  method: 'PUT',
  code: 'forbidden',
  decisionId: 'dec-0001-aaaa',
  summary: 'Denied PUT /api/models/m1: models needs write because no rule allows it',
  text: { key: 'denied.noRule', params: { route: 'PUT /api/models/m1', service: 'models', required: 'write', policies: '' } },
};
const UNAVAILABLE = {
  id: 'a2',
  at: new Date(Date.now() - 60_000).toISOString(),
  kind: 'denials',
  principal: { type: 'token', id: 't-ci', label: 'ci-pipeline' },
  service: 'agents',
  action: 'agents.read',
  route: '/api/agents',
  method: 'GET',
  code: 'authorization_unavailable',
  decisionId: 'dec-0002-bbbb',
  summary: 'Refused GET /api/agents: authorization was temporarily unavailable',
  text: { key: 'unavailable', params: { route: 'GET /api/agents' } },
};

const GONE_ID = 'p-gone-77aa11bb';
/** A refusal by a policy that has been deleted since: the server could only write the raw id into the sentence. */
const GONE_DENIAL = {
  id: 'a3',
  at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  kind: 'denials',
  principal: { type: 'user', id: 'u-bob', label: 'Bob Ray' },
  service: 'agents',
  action: 'agents.write',
  route: '/api/agents/a1',
  method: 'DELETE',
  code: 'forbidden',
  decisionId: 'dec-0003-cccc',
  policyId: GONE_ID,
  summary: `Denied DELETE /api/agents/a1: agents needs write by policy "${GONE_ID}"`,
  text: { key: 'denied.policy', params: { route: 'DELETE /api/agents/a1', service: 'agents', required: 'write', policies: GONE_ID } },
};
/** A refusal by a policy that still exists: the server wrote its name. */
const LIVE_DENIAL = {
  ...GONE_DENIAL,
  id: 'a4',
  policyId: 'p-contractors',
  decisionId: 'dec-0004-dddd',
  summary: 'Denied DELETE /api/agents/a1: agents needs write by policy "Contractors cannot write"',
  text: { key: 'denied.policy', params: { route: 'DELETE /api/agents/a1', service: 'agents', required: 'write', policies: 'Contractors cannot write' } },
};
/** The policy-change trail, newest first: the deletion of the gone policy and its creation under another name. */
const change = (id: string, action: string, key: string, name: string, policyId = GONE_ID) => ({
  id, at: new Date(Date.now() - 86_400_000).toISOString(), kind: 'changes', principal: null, actor: 'Ada Admin', service: 'iam', action, route: null, method: null,
  code: null, decisionId: null, policyId, summary: `${key} "${name}"`, text: { key, params: { name, effect: 'forbid', enabled: 1 } },
});
const CHANGES = [
  change('c2', 'iam.policy.delete', 'policy.deleted', 'Block agent deletes'),
  change('c1', 'iam.policy.update', 'policy.updated', 'Block agent deletes (draft)'),
  change('c0', 'iam.policy.create', 'policy.created', 'Old name'),
  change('cx', 'iam.policy.delete', 'policy.deleted', 'Someone else\'s policy', 'p-other'),
];

/** Answers the denials and, for `kind=changes`, the policy-change trail. */
const trail = (denials: unknown[], changes: unknown[] = CHANGES): [string, string, RouteHandler] => [
  'GET',
  '/api/iam/audit',
  (c) => ({ items: c.query.kind === 'changes' ? changes : denials, nextCursor: null }),
];

async function render(options: {
  canManage?: boolean;
  stats?: unknown;
  denials?: unknown[];
  extra?: Array<[string, string | RegExp, RouteHandler]>;
  locale?: string;
} = {}) {
  api = installApiMock([
    ...defaultRoutes(),
    ['GET', '/api/iam/engine/stats', () => options.stats ?? TENANT_STATS],
    ['GET', '/api/iam/audit', () => ({ items: options.denials ?? [DENIAL], nextCursor: null })],
    ...(options.extra ?? []),
  ]);
  mounted = await mount(createElement(OverviewTab, { canManage: options.canManage ?? true }), options.locale ?? 'en');
  await settle(200);
}

describe('OverviewTab', () => {
  it('summarizes the engine, the policies, the people and the latest denials', async () => {
    await render();
    const t = text();
    // engine: running, with this workspace's counters
    expect(q('[data-testid="overview-engine-status"]')!.textContent).toBe('Running');
    expect(q('[data-testid="overview-decisions"]')!.textContent).toBe('1,234');
    expect(t).toContain('Counters for this workspace since this server process started');
    // policies: the fixtures hold two enabled and one disabled custom policy, and the built-in ones
    expect(q('[data-testid="overview-policies-enabled"]')!.textContent).toBe('2');
    expect(q('[data-testid="overview-policies-disabled"]')!.textContent).toBe('1');
    expect(t).toContain('1 allow');
    expect(t).toContain('1 deny');
    // people: users / groups / API tokens of the directory
    expect(q('[data-testid="overview-users"]')!.textContent).toBe('2');
    expect(q('[data-testid="overview-groups"]')!.textContent).toBe('3');
    expect(q('[data-testid="overview-tokens"]')!.textContent).toBe('1');
    // the latest denial, worded in the reader's language, with its decision id leading to the Access check
    expect(t).toContain('Denied PUT /api/models/m1: models needs write because no rule allows it');
    expect(t).toContain('Bob Ray');
    const hrefs = qa<HTMLAnchorElement>('a').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/dashboard/iam?tab=check&decisionId=dec-0001-aaaa');
    // quick links
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/dashboard/iam?tab=policies',
        '/dashboard/iam?tab=audit',
        '/dashboard/iam?tab=limits',
        '/dashboard/iam?tab=settings',
        '/dashboard/iam?tab=check',
        '/dashboard/projects',
      ]),
    );
    expect(MANAGED.length).toBeGreaterThan(0);
  });

  it('asks only for endpoints that exist', async () => {
    await render();
    const paths = api.calls.map((c) => c.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/api/iam/policies', '/api/iam/engine/stats', '/api/iam/audit', '/api/iam/principals']),
    );
    expect(paths.some((p) => p === '/api/iam/mode' || p.startsWith('/api/iam/shadow'))).toBe(false);
    // the latest denials only (a handful), not the whole trail
    expect(api.to('GET', '/api/iam/audit')[0].query).toMatchObject({ kind: 'denials', limit: '5' });
    // one small page of each directory just to count it
    expect(api.to('GET', '/api/iam/principals').map((c) => c.query.type).sort()).toEqual(['group', 'token', 'user']);
  });

  it('has no mode, shadow or legacy wording anywhere', async () => {
    await render();
    expect(text()).not.toMatch(/Shadow|Legacy|Monitor|Enforce mode|Evaluation mode|kill switch|would be blocked/i);
    expect(buttonByText(/Enforce/)).toBeUndefined();
  });

  it('offers "Create policy" to admins only', async () => {
    await render();
    expect(buttonByText('Create policy')).toBeDefined();
    expect(qa<HTMLAnchorElement>('a').map((a) => a.getAttribute('href'))).toContain('/dashboard/iam?tab=policies&new=1');
    await mounted.unmount();
    await render({ canManage: false });
    expect(buttonByText('Create policy')).toBeUndefined();
    expect(buttonByText('Manage policies')).toBeDefined();
  });

  it('says there are no denials when the trail is empty', async () => {
    await render({ denials: [] });
    expect(q('[data-testid="overview-no-denials"]')!.textContent).toBe('No denials in the last 30 days.');
  });

  it('flags a request the engine could not decide differently from a denial', async () => {
    await render({ denials: [UNAVAILABLE, DENIAL] });
    const list = q('[data-testid="overview-denials"]')!.textContent ?? '';
    expect(list).toContain('Refused GET /api/agents: authorization was temporarily unavailable');
    expect(list).toContain('Engine unavailable');
    expect(list).toContain('Denied PUT /api/models/m1');
  });

  it('shows "N+" for a directory bigger than the page it counts from', async () => {
    const users = Array.from({ length: 100 }, (_, i) => ({ type: 'user', id: `u${i}`, label: `User ${i}`, sublabel: '', policyCount: 0 }));
    await render({
      extra: [
        [
          'GET',
          '/api/iam/principals',
          (c) => (c.query.type === 'user' ? { items: users, nextCursor: 'more' } : { items: [], nextCursor: null }),
        ],
      ],
    });
    expect(q('[data-testid="overview-users"]')!.textContent).toBe('100+');
    expect(q('[data-testid="overview-groups"]')!.textContent).toBe('0');
  });

  it('on a single-organisation server also shows latency and the cache figures', async () => {
    await render({
      stats: {
        ...TENANT_STATS,
        statsScope: 'process',
        engine: { decisions: 9000, p50Us: 180, p99Us: 2400, principalCache: { hitRate: 0.93 } },
        enforce: { ...TENANT_STATS.enforce, engineDecisions: 9000 },
        tenantEnforce: { ...TENANT_STATS.enforce, engineDecisions: 1234 },
      },
    });
    const t = text();
    expect(t).toContain('Median latency');
    expect(t).toContain('180 µs');
    expect(t).toContain('2.40 ms');
    expect(t).toContain('93%');
    // this workspace's own counters, not the whole server's
    expect(q('[data-testid="overview-decisions"]')!.textContent).toBe('1,234');
    expect(t).toContain('Counters since this server process started (this node).');
  });

  it('does not show latency on a shared platform', async () => {
    await render();
    expect(text()).not.toContain('Median latency');
  });
});

describe('OverviewTab (the people card)', () => {
  it('opens the directory tab under that tab\'s own name, whatever it is called', async () => {
    await render();
    const open = buttonByText(/^Open /, q('[data-testid="overview-users"]')!.closest('.mantine-Paper-root')!)!;
    expect(open.textContent).toBe(`Open ${messages.en.iamCenter.tabs.principals}`);
    expect(open.getAttribute('href')).toBe('/dashboard/iam?tab=principals&principalType=user');
  });

  it('says so in Turkish', async () => {
    await render({ locale: 'tr' });
    const open = buttonByText(/sekmesini aç$/, q('[data-testid="overview-users"]')!.closest('.mantine-Paper-root')!)!;
    expect(open.textContent).toBe(`${messages.tr.iamCenter.tabs.principals} sekmesini aç`);
  });
});

describe('OverviewTab (header of a card)', () => {
  it('keeps the engine status and the "view all" link at their full width; the text beside them gives way', async () => {
    await render();
    const asides = qa('[data-testid="overview-card-aside"]');
    // The engine's status badge and the denials' link: the two cards that have something at their right.
    expect(asides.map((a) => a.textContent)).toEqual(['Running', 'View all denials']);
    for (const aside of asides) {
      // A flex item that may shrink is what turned "RUNNING" into "RUNNI…" and clipped the link.
      expect(aside.style.flexShrink).toBe('0');
      expect(aside.style.whiteSpace).toBe('nowrap');
      // ...while the title and its hint stay free to wrap.
      const text = aside.previousElementSibling as HTMLElement;
      expect(text.style.flex).toBe('1 1 0%');
      expect(['0', '0px']).toContain(text.style.minWidth);
    }
  });

  it('lets the third card of the first row take the whole row where the grid has only two columns', async () => {
    await render();
    const first = q('.mantine-SimpleGrid-root')!;
    const cards = [...first.children] as HTMLElement[];
    expect(cards).toHaveLength(3);
    // The two before it keep their own cell; the third carries the class that spans the row between the md and xl breakpoints
    // (overview.module.css; Chromium lays it out, see the stylesheet's comment).
    expect(cards.map((card) => /wide/.test(card.className))).toEqual([false, false, true]);
    expect(cards[2].textContent).toContain('People and tokens');
  });

  it('does the same in Turkish, where the words are longer', async () => {
    await render({ locale: 'tr' });
    expect(qa('[data-testid="overview-card-aside"]').map((a) => a.textContent)).toEqual(['Çalışıyor', 'Tüm reddedilenleri gör']);
  });
});

describe('OverviewTab (denials by a policy that has since been deleted)', () => {
  const denialText = () => q('[data-testid="overview-denials"]')!.textContent ?? '';

  it('leaves a denial by an existing policy as the server wrote it, and reads no policy-change trail for it', async () => {
    await render({ extra: [trail([LIVE_DENIAL])] });
    expect(denialText()).toContain('by policy "Contractors cannot write"');
    expect(denialText()).not.toContain('deleted');
    expect(q('[data-testid="overview-denial-policy-id"]')).toBeNull();
    expect(api.to('GET', '/api/iam/audit').map((c) => c.query.kind)).toEqual(['denials']);
  });

  it('shows the name the policy had, taken from the policy-change trail, and says it is deleted', async () => {
    await render({ extra: [trail([GONE_DENIAL])] });
    // The newest name the trail recorded for that policy, not the raw id and not another policy's name.
    expect(denialText()).toContain('Denied DELETE /api/agents/a1: agents needs write by policy "Block agent deletes" (deleted)');
    expect(denialText()).not.toContain(GONE_ID);
    expect(q('[data-testid="overview-denial-policy-id"]')).toBeNull();
    expect(api.to('GET', '/api/iam/audit').map((c) => c.query.kind).sort()).toEqual(['changes', 'denials']);
    expect(api.to('GET', '/api/iam/audit').find((c) => c.query.kind === 'changes')!.query.limit).toBe('100');
  });

  it('shows a short, dimmed id when the trail no longer says what the policy was called', async () => {
    await render({ extra: [trail([GONE_DENIAL], [change('cx', 'iam.policy.delete', 'policy.deleted', 'Someone else\'s policy', 'p-other')])] });
    const id = q('[data-testid="overview-denial-policy-id"]')!;
    expect(id.textContent).toBe('p-gone-7');
    expect(id.getAttribute('title')).toBe(GONE_ID);
    // dimmed and monospace, like the decision id beside it
    expect(id.className).toMatch(/Text-root/);
    expect(id.getAttribute('style') ?? '').toMatch(/dimmed/);
    expect(id.getAttribute('style') ?? '').toMatch(/monospace/);
    expect(denialText()).toContain('by policy "p-gone-7" (deleted)');
    expect(denialText()).not.toContain(GONE_ID);
  });

  it('shows the short id too when the trail cannot be read', async () => {
    await render({
      extra: [['GET', '/api/iam/audit', (c) => (c.query.kind === 'changes' ? jsonResponse({ error: 'x' }, 500) : { items: [GONE_DENIAL], nextCursor: null })]],
    });
    expect(q('[data-testid="overview-denial-policy-id"]')!.textContent).toBe('p-gone-7');
    expect(denialText()).toContain('(deleted)');
  });

  it('says nothing about a policy when the list of policies could not be read', async () => {
    await render({
      extra: [trail([GONE_DENIAL]), ['GET', '/api/iam/policies', () => jsonResponse({ error: 'x' }, 500)]],
    });
    // Without the list there is no telling a deleted policy from an existing one: the server's sentence stands.
    expect(denialText()).toContain(`by policy "${GONE_ID}"`);
    expect(denialText()).not.toContain('(deleted)');
    expect(api.to('GET', '/api/iam/audit').map((c) => c.query.kind)).toEqual(['denials']);
  });

  it('keeps the link to the Access check of the denial', async () => {
    await render({ extra: [trail([GONE_DENIAL])] });
    expect(qa<HTMLAnchorElement>('a').map((a) => a.getAttribute('href'))).toContain('/dashboard/iam?tab=check&decisionId=dec-0003-cccc');
  });

  it('is worded in Turkish too', async () => {
    await render({
      locale: 'tr',
      extra: [
        ['GET', '/api/iam/audit', (c) => ({
          items: c.query.kind === 'changes' ? CHANGES : [{ ...GONE_DENIAL, text: GONE_DENIAL.text }],
          nextCursor: null,
        })],
      ],
    });
    expect(denialText()).toContain('"Block agent deletes" (silindi)');
    expect(denialText()).not.toMatch(/iamOverview\.|iamAudit\./);
  });
});

describe('OverviewTab (what needs attention)', () => {
  it('says when the engine is degraded or down', async () => {
    await render({ stats: { ...TENANT_STATS, health: { status: 'degraded', message: 'one policy statement could not be loaded' } } });
    expect(q('[data-testid="overview-engine-status"]')!.textContent).toBe('Degraded');
    const alert = q('[data-testid="overview-health-alert"]')!;
    expect(alert.textContent).toContain('The policy engine is degraded');
    expect(alert.textContent).toContain('one policy statement could not be loaded');
    await mounted.unmount();

    await render({ stats: { ...TENANT_STATS, health: { status: 'down' } } });
    expect(q('[data-testid="overview-engine-status"]')!.textContent).toBe('Not running');
    expect(q('[data-testid="overview-health-alert"]')!.textContent).toContain('refused with HTTP 503 until it recovers');
  });

  it('names the policies whose statements the engine could not load, and links to them', async () => {
    await render({
      stats: {
        ...TENANT_STATS,
        health: { status: 'degraded' },
        policySet: { version: 4, custom: 2, skipped: ['custom:p-contractors#0', 'custom:p-contractors#1', 'custom:p-gone#0'] },
      },
    });
    const alert = q('[data-testid="overview-skipped-alert"]')!;
    expect(alert.textContent).toContain('3 policy statement(s) are not applied');
    // by the policy's name when it still exists, by id otherwise; each policy once
    const links = qa<HTMLAnchorElement>('a', alert);
    expect(links.map((a) => a.textContent)).toEqual(['Contractors cannot write', 'p-gone']);
    expect(links[0]!.getAttribute('href')).toBe('/dashboard/iam?tab=policies&policyId=p-contractors');
  });

  it('lists the routes that have no authorization declaration', async () => {
    await render({
      stats: { ...TENANT_STATS, undeclaredRoutes: { count: 2, sample: [{ method: 'GET', url: '/api/x' }, { method: 'POST', url: '/api/y' }] } },
    });
    const alert = q('[data-testid="overview-undeclared-alert"]')!;
    expect(alert.textContent).toContain('2 API route(s) have no authorization declaration');
    expect(alert.textContent).toContain('GET /api/x');
    expect(alert.textContent).toContain('POST /api/y');
  });

  it('counts the requests refused because the engine could not decide, with when and why, and leads to the trail', async () => {
    await render({
      stats: {
        ...TENANT_STATS,
        enforce: { ...TENANT_STATS.enforce, unavailable: 3, lastUnavailableAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), lastUnavailableReason: 'engine_unavailable' },
      },
    });
    const alert = q('[data-testid="overview-unavailable-alert"]')!;
    expect(alert.textContent).toContain('Authorization was unavailable 3 time(s)');
    expect(alert.textContent).toContain('refused with HTTP 503');
    expect(alert.textContent).toContain('the engine was not available');
    expect(qa<HTMLAnchorElement>('a', alert).map((a) => a.getAttribute('href'))).toContain('/dashboard/iam?tab=audit');
  });

  it('shows no alert for a healthy engine', async () => {
    await render();
    expect(q('[data-testid="overview-health-alert"]')).toBeNull();
    expect(q('[data-testid="overview-skipped-alert"]')).toBeNull();
    expect(q('[data-testid="overview-undeclared-alert"]')).toBeNull();
    expect(q('[data-testid="overview-unavailable-alert"]')).toBeNull();
  });
});

describe('OverviewTab (when something cannot be loaded)', () => {
  it('keeps the other cards when the engine statistics are not available', async () => {
    await render({ extra: [['GET', '/api/iam/engine/stats', () => jsonResponse({ error: 'x', code: 'authorization_unavailable' }, 503)]] });
    expect(text()).toContain('Engine statistics are not available.');
    expect(q('[data-testid="overview-policies-enabled"]')!.textContent).toBe('2');
    expect(q('[data-testid="overview-users"]')!.textContent).toBe('2');
  });

  it('explains a missing read permission and offers a retry when nothing loads at all', async () => {
    api = installApiMock([
      ['GET', /^\/api\/iam\//, () => jsonResponse({ error: 'Forbidden', code: 'forbidden' }, 403)],
    ]);
    mounted = await mount(createElement(OverviewTab, { canManage: false }));
    await settle(200);
    expect(text()).toContain('Could not load the overview');
    expect(text()).toContain('You need read access to the IAM service to see this.');
    expect(buttonByText('Try again')).toBeDefined();
  });

  it('refreshes on request', async () => {
    await render();
    const before = api.to('GET', '/api/iam/engine/stats').length;
    await click(buttonByText('Refresh'));
    await settle(200);
    expect(api.to('GET', '/api/iam/engine/stats').length).toBe(before + 1);
  });
});

describe('OverviewTab (Turkish)', () => {
  it('renders in Turkish with no raw translation keys', async () => {
    await render({ locale: 'tr', denials: [UNAVAILABLE, DENIAL], stats: { ...TENANT_STATS, health: { status: 'degraded' }, enforce: { ...TENANT_STATS.enforce, unavailable: 1, lastUnavailableAt: new Date().toISOString(), lastUnavailableReason: 'evaluation_error' } } });
    const t = text();
    expect(t).toContain('Genel bakış');
    expect(t).toContain('Politika motoru');
    expect(t).toContain('Kısmen çalışıyor');
    expect(t).toContain('Son reddedilenler');
    expect(t).toContain('Yetkilendirme 1 kez kullanılamadı');
    expect(t).toContain('bir politika değerlendirilemedi');
    expect(t).toContain('GET /api/agents reddedildi: yetkilendirme geçici olarak kullanılamıyordu');
    expect(t).not.toMatch(/iamOverview\.|iamCenter\.|iamAudit\./);
  });

  it('marks the tab as Turkish text, so the upper-cased badges keep their dots ("İZİN", not "IZIN")', async () => {
    await render({ locale: 'tr' });
    // The page's own language is "en" and CSS upper-casing goes by it unless the text says otherwise.
    for (const testId of ['overview-engine-status', 'overview-policies-enabled']) {
      expect(q(`[data-testid="${testId}"]`)!.closest('[lang]')!.getAttribute('lang'), testId).toBe('tr');
    }
    expect(text()).toContain('1 izin');
    await mounted.unmount();
    await render({ locale: 'en' });
    expect(q('[data-testid="overview-engine-status"]')!.closest('[lang]')!.getAttribute('lang')).toBe('en');
  });
});
