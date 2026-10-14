// @vitest-environment jsdom
/**
 * Bulk actions on a page of people and tokens: select, dry run, a small
 * confirmation that says how many will change and why the others are skipped
 * (a typed confirmation above 20), the real run with the same ids, and a result
 * dialog that lists what failed.
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
  type ApiMock,
  type Mounted,
  type RouteHandler,
} from '../helpers/iamCenterUi';
import { CAPS_ADMIN, CAPS_READ_ONLY, directoryRoutes, PEOPLE } from '../helpers/iamDirectoryFixtures';

const nav = vi.hoisted(() => ({ search: '', cache: new Map<string, URLSearchParams>() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

import PrincipalsTab from '@/components/iam/principals/PrincipalsTab';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => window.history.replaceState(null, '', '/dashboard/iam?tab=principals'));
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
});

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

type Route = [string, string | RegExp, RouteHandler];

async function renderTab(search = 'tab=principals', extra: Route[] = [], caps: unknown = CAPS_ADMIN) {
  nav.search = search;
  window.history.replaceState(null, '', `/dashboard/iam?${search}`);
  api = installApiMock([...directoryRoutes(caps), ...extra]);
  mounted = await mount(createElement(PrincipalsTab, { canManage: true }));
  await settle(150);
}

const rowOf = (name: string) => qa<HTMLTableRowElement>('tbody tr').find((r) => r.textContent?.includes(name))!;
const select = async (...names: string[]) => {
  for (const name of names) await click(q('input[type="checkbox"]', rowOf(name)));
};
const bulkButton = (label: string) => qa<HTMLButtonElement>('.ds-toolbar button').find((b) => b.textContent?.trim() === label);
const dialog = () => qa('[role="dialog"]').at(-1)!;
const dialogButton = (label: string) => qa<HTMLButtonElement>('button', dialog()).find((b) => b.textContent?.trim() === label)!;
const bulkCalls = () => api.to('POST', '/api/users/bulk');

/** The server's verdict per person: yourself and the owner are skipped, everyone else changes. */
const verdict = (action: string, ids: string[], dryRun: boolean) => {
  const results = ids.map((id) =>
    id === 'u-admin'
      ? { id, outcome: 'skipped', code: 'self_not_allowed' }
      : id === 'u-owner'
        ? { id, outcome: 'skipped', code: 'owner_immutable' }
        : { id, outcome: 'ok' },
  );
  const count = (o: string) => results.filter((r) => r.outcome === o).length;
  return { action, dryRun, requested: ids.length, ok: count('ok'), skipped: count('skipped'), failed: 0, batchId: 'b1', results };
};
const BULK: Route = ['POST', '/api/users/bulk', (c) => {
  const body = c.body as { action: string; ids: string[]; dryRun?: boolean };
  return verdict(body.action, body.ids, body.dryRun === true);
}];

describe('the bulk bar of the people segment', () => {
  it('appears for a page selection and goes away when the filters change', async () => {
    await renderTab();
    expect(bulkButton('Disable')).toBeUndefined();
    await select('Ann Lee', 'Sam Sso');
    expect(q('.ds-toolbar')?.textContent).toContain('2 selected');
    for (const label of ['Disable', 'Enable', 'Add to group', 'Remove from group', 'Revoke tokens']) {
      expect(bulkButton(label), label).toBeDefined();
    }
    // a refresh (any list change) clears the selection
    await click(qa<HTMLButtonElement>('button[aria-label="Refresh"]')[0]);
    await settle(120);
    expect(q('.ds-toolbar')?.textContent).not.toContain('selected');
  });

  it('is not offered to a read-only viewer', async () => {
    await renderTab('tab=principals', [], CAPS_READ_ONLY);
    expect(qa('input[type="checkbox"]')).toHaveLength(0);
  });

  it('checks first, says what would change and what is skipped, and only then runs with the same ids', async () => {
    await renderTab('tab=principals', [BULK]);
    await select('Ann Lee', 'Ada Admin', 'Olive Owner');
    await click(bulkButton('Disable'));
    await settle(150);

    // the dry run wrote nothing
    expect(bulkCalls()).toHaveLength(1);
    expect(bulkCalls()[0]?.body).toEqual({ action: 'disable', ids: ['u-owner', 'u-admin', 'u-ann'], dryRun: true });
    const text = dialog().textContent!;
    expect(text).toContain('Disable accounts');
    expect(text).toContain('1 will change, 2 skipped (of 3).');
    expect(text).toContain('1 × yourself');
    expect(text).toContain('1 × the workspace owner');

    await setInput(q<HTMLInputElement>('input[placeholder="e.g. Left the company"]', dialog())!, 'Quarterly review');
    await click(dialogButton('Run'));
    await settle(200);
    expect(bulkCalls()).toHaveLength(2);
    expect(bulkCalls()[1]?.body).toEqual({ action: 'disable', ids: ['u-owner', 'u-admin', 'u-ann'], reason: 'Quarterly review' });
  });

  it('says plainly when nothing would change', async () => {
    await renderTab('tab=principals', [
      ['POST', '/api/users/bulk', (c) => {
        const body = c.body as { ids: string[] };
        return { action: 'disable', dryRun: true, requested: body.ids.length, ok: 0, skipped: body.ids.length, failed: 0, batchId: 'b', results: body.ids.map((id) => ({ id, outcome: 'skipped', code: 'already_in_state' })) };
      }],
    ]);
    await select('Ann Lee', 'Sam Sso');
    await click(bulkButton('Disable'));
    await settle(150);
    expect(dialog().textContent).toContain('Nothing would change for these 2 accounts.');
    expect(dialog().textContent).toContain('2 × already in that state');
    await click(dialogButton('Close'));
    await settle(80);
    // nothing was written
    expect(bulkCalls()).toHaveLength(1);
  });

  it('asks to type the number above 20 people, and refuses to run until it is typed', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...PEOPLE[2], id: `u${i}`, label: `Person ${i}`, sublabel: `p${i}@x.co`, email: `p${i}@x.co` }));
    await renderTab('tab=principals', [
      BULK,
      ['GET', '/api/iam/principals', (c) => ({ items: many, nextCursor: null, ...(c.query.count ? { total: many.length } : {}) })],
    ]);
    await click(q('thead input[type="checkbox"]'));
    expect(q('.ds-toolbar')?.textContent).toContain('30 selected');
    await click(bulkButton('Enable'));
    await settle(150);
    const run = () => dialogButton('Run');
    expect(dialog().textContent).toContain('30 will change');
    expect(run().disabled).toBe(true);
    await setInput(q<HTMLInputElement>('input[placeholder="30"]', dialog())!, '30');
    expect(run().disabled).toBe(false);
    await click(run());
    await settle(200);
    expect(bulkCalls()).toHaveLength(2);
    expect((bulkCalls()[1]?.body as { ids: string[] }).ids).toHaveLength(30);
  });

  it('runs nothing when the check itself fails, and says why', async () => {
    await renderTab('tab=principals', [['POST', '/api/users/bulk', () => jsonResponse({ error: 'Database unavailable' }, 500)]]);
    await select('Ann Lee', 'Sam Sso');
    await click(bulkButton('Disable'));
    await settle(150);
    expect(dialog().textContent).toContain('Database unavailable');
    expect(dialog().textContent).not.toContain('will change');
    // the only button that is left closes the dialog
    expect(qa<HTMLButtonElement>('button', dialog()).some((b) => b.textContent?.trim() === 'Run')).toBe(false);
    await click(dialogButton('Close'));
    await settle(100);
    // the check was the only request: the real action never went out
    expect(bulkCalls()).toHaveLength(1);
    expect(bulkCalls()[0]?.body).toMatchObject({ dryRun: true });
  });

  it('words a refusal of the authorization engine and keeps the selection', async () => {
    await renderTab('tab=principals', [['POST', '/api/users/bulk', () => jsonResponse({ error: 'Forbidden', code: 'forbidden' }, 403)]]);
    await select('Ann Lee');
    await click(bulkButton('Enable'));
    await settle(150);
    expect(dialog().textContent).toContain('You do not have permission');
    await click(dialogButton('Close'));
    await settle(100);
    expect(bulkCalls()).toHaveLength(1);
    expect(q('.ds-toolbar')?.textContent).toContain('1 selected');
  });

  it('lists what failed in a result dialog after the run', async () => {
    await renderTab('tab=principals', [
      ['POST', '/api/users/bulk', (c) => {
        const body = c.body as { action: string; ids: string[]; dryRun?: boolean };
        const results = body.ids.map((id) => (!body.dryRun && id === 'u-sso' ? { id, outcome: 'failed', code: 'failed' } : { id, outcome: 'ok' }));
        return { action: body.action, dryRun: body.dryRun === true, requested: body.ids.length, ok: results.filter((r) => r.outcome === 'ok').length, skipped: 0, failed: results.filter((r) => r.outcome === 'failed').length, batchId: 'b', results };
      }],
    ]);
    await select('Ann Lee', 'Sam Sso');
    await click(bulkButton('Enable'));
    await settle(150);
    await click(dialogButton('Run'));
    await settle(250);
    const result = q('[data-testid="bulk-result"]');
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain('1 done, 0 skipped, 1 failed.');
    expect(result!.textContent).toContain('Sam Sso');
  });

  it('adds the selection to a group: pick the group, check, run', async () => {
    await renderTab('tab=principals', [
      BULK,
      ['GET', '/api/iam/principals', (c) =>
        c.query.type === 'group'
          ? { items: [{ type: 'group', id: 'g-eng', label: 'Engineering', sublabel: '', source: 'local', tenantRole: 'user', memberCount: 12, policyCount: 0 }], nextCursor: null }
          : { items: PEOPLE, nextCursor: null, total: PEOPLE.length }],
    ]);
    await select('Ann Lee', 'Sam Sso');
    await click(bulkButton('Add to group'));
    await settle(150);
    expect(q('.form-overlay')?.textContent).toContain('Add 2 people to a group');
    await click(q('input', q('.form-overlay')!));
    await settle(80);
    // (the filter bar's own group select keeps its options in the page too: pick the one that says what joining gives)
    await click(qa('[role="option"]').find((o) => o.textContent?.includes('Gives the User role')));
    await click(buttonByText('Continue'));
    await settle(150);
    expect(bulkCalls()[0]?.body).toMatchObject({ action: 'add-to-group', groupId: 'g-eng', dryRun: true });
    expect(dialog().textContent).toContain('Add to group Engineering');
    await click(dialogButton('Run'));
    await settle(200);
    expect(bulkCalls()[1]?.body).toMatchObject({ action: 'add-to-group', groupId: 'g-eng' });
    expect((bulkCalls()[1]?.body as { dryRun?: boolean }).dryRun).toBeUndefined();
  });
});

describe('the bulk bar of the tokens segment', () => {
  it('revokes the selected tokens after a confirmation, by id', async () => {
    await renderTab('tab=principals&principalType=token', [
      ['POST', '/api/tokens/revoke', () => ({ requested: 2, revoked: 2, skipped: 0, failed: 0, results: [{ id: 't-ci', outcome: 'revoked' }, { id: 't-bot', outcome: 'revoked' }] })],
    ]);
    await click(q('thead input[type="checkbox"]'));
    expect(bulkButton('Revoke')).toBeDefined();
    await click(bulkButton('Revoke'));
    await settle(80);
    expect(dialog().textContent).toContain('Revoke 2 tokens?');
    await click(dialogButton('Revoke'));
    await settle(200);
    expect(api.to('POST', '/api/tokens/revoke')[0]?.body).toEqual({ ids: ['t-ci', 't-bot'] });
  });
});
