import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  creditExportUrl,
  describeCreditEntry,
  fetchCreditMonths,
  fetchCreditSpend,
  fetchCreditSpendGrouped,
  fetchCreditLedger,
  fillDailySpend,
  normalizeTotals,
} from '@/components/usage/creditsApi';

function mockFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('credits client', () => {
  it('reads a numeric (older) and an object (newer) spend total', async () => {
    mockFetch({ total: 12, models: [] });
    expect((await fetchCreditSpend({ month: '2026-11' })).total).toBe(12);
    mockFetch({ total: { credits: 9, count: 3, fromMonthly: 6, fromOneTime: 3 }, models: [] });
    const spend = await fetchCreditSpend({ month: '2026-11' });
    expect(spend.total).toBe(9);
    // A server that reports no USD priced nothing: every credit is unpriced.
    expect(spend.totals).toEqual({ credits: 9, count: 3, fromMonthly: 6, fromOneTime: 3, usd: 0, unpricedCredits: 9 });
  });

  it('normalizes missing totals to zero', () => {
    expect(normalizeTotals(undefined)).toEqual({ credits: 0, count: 0, fromMonthly: 0, fromOneTime: 0, usd: 0, unpricedCredits: 0 });
  });

  it('reads the USD of a total and of grouped rows', async () => {
    mockFetch({
      total: { credits: 10, count: 2, fromMonthly: 10, fromOneTime: 0, usd: 0.05, unpricedCredits: 2 },
      rows: [
        { key: 'agent-a', credits: 8, count: 1, fromMonthly: 8, fromOneTime: 0, usd: 0.05, unpricedCredits: 0 },
        { key: 'agent-b', credits: 2, count: 1, fromMonthly: 2, fromOneTime: 0 },
      ],
    });
    const result = await fetchCreditSpendGrouped('2026-11', 'agent');
    expect(result.total).toMatchObject({ usd: 0.05, unpricedCredits: 2 });
    expect(result.rows[0]).toMatchObject({ key: 'agent-a', usd: 0.05, unpricedCredits: 0 });
    // A row without USD fields counts as unpriced.
    expect(result.rows[1]).toMatchObject({ key: 'agent-b', usd: 0, unpricedCredits: 2 });
  });

  it('asks for a grouped spend and passes rows through', async () => {
    const fn = mockFetch({ total: { credits: 5, count: 1, fromMonthly: 5, fromOneTime: 0 }, rows: [{ key: 'a', credits: 5, count: 1, fromMonthly: 5, fromOneTime: 0 }] });
    const result = await fetchCreditSpendGrouped('2026-11', 'project');
    expect((fn.mock.calls[0] as unknown[])[0]).toBe('/api/usage/credits/spend?month=2026-11&groupBy=project');
    expect(result.rows[0]!.key).toBe('a');
  });

  it('converts an older by-model answer into rows and gives no rows for other groups', async () => {
    const legacy = { total: 4, models: [{ model: 'm1', label: 'M1', credits: 4, count: 2, inputTokens: 1, outputTokens: 1, units: 0 }] };
    mockFetch(legacy);
    const model = await fetchCreditSpendGrouped('2026-11', 'model');
    expect(model.rows).toEqual([{ key: 'm1', credits: 4, count: 2, fromMonthly: 0, fromOneTime: 0, usd: 0, unpricedCredits: 4, label: 'M1' }]);
    mockFetch(legacy);
    expect((await fetchCreditSpendGrouped('2026-11', 'agent')).rows).toEqual([]);
    mockFetch(legacy);
    // The server did not group by day or agent: the result must not claim it did.
    expect((await fetchCreditSpendGrouped('2026-11', 'day')).groupBy).toBe('model');
    expect((await fetchCreditSpendGrouped('2026-11', 'agent')).groupBy).toBe('model');
  });

  it('loads months, the ledger with a month, and builds the export url', async () => {
    mockFetch({ months: [{ period: '2026-11' }] });
    expect(await fetchCreditMonths(12)).toHaveLength(1);
    const fn = mockFetch({ entries: [], nextCursor: null });
    await fetchCreditLedger({ limit: 25, month: '2026-10', kind: 'grant' });
    const url = String((fn.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('month=2026-10');
    expect(url).toContain('kind=grant');
    expect(creditExportUrl('2026-10')).toBe('/api/usage/credits/export.csv?month=2026-10');
  });

  it('rejects when an endpoint is absent so callers can hide the section', async () => {
    mockFetch({ error: 'Not Found' }, false, 404);
    await expect(fetchCreditMonths()).rejects.toBeDefined();
  });
});

describe('fillDailySpend', () => {
  it('lists every day of the month and zero-fills days without spend', () => {
    const days = fillDailySpend('2026-02', [{ key: '2026-02-03', credits: 10, count: 2, fromMonthly: 6, fromOneTime: 3, usd: 0, unpricedCredits: 10 }]);
    expect(days).toHaveLength(28);
    expect(days[0]).toEqual({ day: '2026-02-01', fromMonthly: 0, fromOneTime: 0, other: 0 });
    expect(days[2]).toEqual({ day: '2026-02-03', fromMonthly: 6, fromOneTime: 3, other: 1 });
  });

  it('returns nothing for a malformed month', () => {
    expect(fillDailySpend('nope', [])).toEqual([]);
  });
});

describe('describeCreditEntry for grants', () => {
  const t = (key: string) => key;
  it('describes grant and revoke entries with their note', () => {
    const base = { id: 'g', at: '2026-11-01T00:00:00Z', credits: 5 };
    expect(describeCreditEntry({ ...base, kind: 'grant', note: 'launch' }, t, String)).toBe('credits.describe.grant · launch');
    expect(describeCreditEntry({ ...base, kind: 'revoke', credits: -5 }, t, String)).toBe('credits.describe.revoke');
  });
});
