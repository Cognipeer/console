/**
 * Client side of the credits API on hosted plans (`/api/usage/credits*`). Editions without credits answer
 * 404; callers treat any failure as "no credits data" and hide what depends on it.
 */
import { apiRequest } from '@/lib/api/client';

export type CreditLedgerKind = 'monthly_grant' | 'redeem' | 'grant' | 'revoke' | 'charge' | 'refund' | 'adjust' | 'expire';
export const CREDIT_LEDGER_KINDS: readonly CreditLedgerKind[] = ['charge', 'redeem', 'grant', 'revoke', 'monthly_grant', 'refund', 'adjust', 'expire'];

export type CreditService = 'chat' | 'embedding' | 'search';

/** What a charge paid for. */
export interface CreditUsageDetails {
  service: CreditService;
  /** Chat: the size tier the call was charged at. */
  tier?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Search: billable units (a basic search is 1, an advanced one 2). */
  units?: number;
  /** The counts are an estimate, not the provider's report. */
  estimated?: boolean;
  projectId?: string;
  agentKey?: string;
  source?: string;
}

export interface CreditLedgerEntry {
  id: string;
  at: string;
  kind: CreditLedgerKind;
  credits: number;
  balanceAfter?: number;
  model?: string;
  /** Display name of `model`, when the server knows it. */
  modelLabel?: string;
  note?: string;
  details?: CreditUsageDetails;
  /** Part of `credits` taken from (or returned to) the monthly credits; same sign as `credits`. Absent on old entries. */
  fromMonthly?: number;
  /** Part of `credits` taken from (or returned to) one-time credits; same sign as `credits`. Absent on old entries. */
  fromOneTime?: number;
}

export interface CreditLedgerPage {
  entries: CreditLedgerEntry[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

export interface CreditSpendModel {
  /** Model key; null for charges without a model. `search` for web search. */
  model: string | null;
  label?: string;
  service?: CreditService;
  credits: number;
  /** Settled calls (chat, embedding) or searches. */
  count: number;
  inputTokens: number;
  outputTokens: number;
  units: number;
}

export interface CreditSpend {
  /** Start of the range (ISO); null = since the first entry. */
  from: string | null;
  to: string;
  total: number;
  /** Total split by bucket; fromMonthly + fromOneTime can be below `total` for entries written before the split existed. */
  totals: CreditSpendTotals;
  models: CreditSpendModel[];
}

export interface CreditSpendTotals {
  credits: number;
  count: number;
  fromMonthly: number;
  fromOneTime: number;
}

export type CreditSpendGroup = 'model' | 'service' | 'project' | 'agent' | 'source' | 'day';

/** One row of a grouped spend (all numbers positive). `key` is `unknown` when the entries do not say. */
export interface CreditSpendRow extends CreditSpendTotals {
  key: string;
  credits: number;
  label?: string;
  service?: CreditService;
}

export interface CreditSpendGrouped {
  from: string | null;
  to: string;
  groupBy: CreditSpendGroup;
  total: CreditSpendTotals;
  rows: CreditSpendRow[];
}

/** One month of the history table, newest first from the server. */
export interface CreditMonth {
  period: string;
  monthlyGranted: number;
  monthlyUsed: number;
  monthlyExpired: number;
  oneTimeAdded: number;
  oneTimeUsed: number;
  charged: number;
  refunded: number;
}

export interface CreditLedgerQuery {
  limit: number;
  cursor?: string | null;
  kind?: CreditLedgerKind;
  model?: string;
  /** Calendar month (`YYYY-MM`, UTC) to list. */
  month?: string;
}

export async function fetchCreditLedger(query: CreditLedgerQuery): Promise<CreditLedgerPage> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.kind) params.set('kind', query.kind);
  if (query.model) params.set('model', query.model);
  if (query.month) params.set('month', query.month);
  const data = await apiRequest<{ entries?: CreditLedgerEntry[]; nextCursor?: string | null }>(`/api/usage/credits?${params.toString()}`);
  return { entries: data.entries ?? [], nextCursor: data.nextCursor ?? null };
}

/**
 * Credits spent per model. `range` is either a calendar month (`YYYY-MM`, UTC) or the dashboard date-filter
 * parameters (`period`, `from`, `to`); nothing = the current month.
 */
export async function fetchCreditSpend(range?: { month: string } | URLSearchParams): Promise<CreditSpend> {
  const params = range instanceof URLSearchParams ? range : new URLSearchParams(range ? { month: range.month } : {});
  const qs = params.toString();
  const data = await apiRequest<{ from?: string | null; to?: string; total?: number | Partial<CreditSpendTotals>; models?: CreditSpendModel[] }>(
    `/api/usage/credits/spend${qs ? `?${qs}` : ''}`,
  );
  const totals = normalizeTotals(data.total);
  return {
    from: data.from ?? null,
    to: data.to ?? new Date().toISOString(),
    total: totals.credits,
    totals,
    models: data.models ?? [],
  };
}

/** `total` is a number on older servers and an object with the bucket split on newer ones. */
export function normalizeTotals(total: number | Partial<CreditSpendTotals> | undefined): CreditSpendTotals {
  if (typeof total === 'number') return { credits: total, count: 0, fromMonthly: 0, fromOneTime: 0 };
  return {
    credits: total?.credits ?? 0,
    count: total?.count ?? 0,
    fromMonthly: total?.fromMonthly ?? 0,
    fromOneTime: total?.fromOneTime ?? 0,
  };
}

/** Spend of a month (`YYYY-MM`) grouped by one dimension. Older servers only group by model; their answer is converted and `groupBy` then says 'model' (what the server really did). */
export async function fetchCreditSpendGrouped(month: string, groupBy: CreditSpendGroup): Promise<CreditSpendGrouped> {
  const params = new URLSearchParams({ month, groupBy });
  const data = await apiRequest<{
    from?: string | null;
    to?: string;
    total?: number | Partial<CreditSpendTotals>;
    rows?: CreditSpendRow[];
    models?: CreditSpendModel[];
  }>(`/api/usage/credits/spend?${params.toString()}`);
  const rows: CreditSpendRow[] = data.rows
    ?? (groupBy === 'model'
      ? (data.models ?? []).map((m) => ({
          key: m.model ?? 'unknown',
          credits: m.credits,
          count: m.count,
          fromMonthly: 0,
          fromOneTime: 0,
          ...(m.label ? { label: m.label } : {}),
          ...(m.service ? { service: m.service } : {}),
        }))
      : []);
  return { from: data.from ?? null, to: data.to ?? new Date().toISOString(), groupBy: data.rows ? groupBy : 'model', total: normalizeTotals(data.total), rows };
}

/** The last `count` months with ledger activity, plus the current one. Absent on editions without credits (404). */
export async function fetchCreditMonths(count = 12): Promise<CreditMonth[]> {
  const data = await apiRequest<{ months?: CreditMonth[] }>(`/api/usage/credits/months?count=${count}`);
  return data.months ?? [];
}

/** Where the CSV export of a month's ledger is served. */
export function creditExportUrl(month: string): string {
  return `/api/usage/credits/export.csv?month=${encodeURIComponent(month)}`;
}

/** Every day (`YYYY-MM-DD`, UTC) of `month` with its spend; days without spend are zero. */
export function fillDailySpend(month: string, rows: CreditSpendRow[]): Array<{ day: string; fromMonthly: number; fromOneTime: number; other: number }> {
  const [year, mon] = month.split('-').map(Number);
  if (!year || !mon) return [];
  const byDay = new Map(rows.map((row) => [row.key, row]));
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const out: Array<{ day: string; fromMonthly: number; fromOneTime: number; other: number }> = [];
  for (let d = 1; d <= days; d += 1) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    const row = byDay.get(day);
    const fromMonthly = row?.fromMonthly ?? 0;
    const fromOneTime = row?.fromOneTime ?? 0;
    out.push({ day, fromMonthly, fromOneTime, other: Math.max(0, (row?.credits ?? 0) - fromMonthly - fromOneTime) });
  }
  return out;
}

/** `YYYY-MM` of `date` in UTC, shifted by `monthsBack`. */
export function utcMonth(date: Date, monthsBack = 0): string {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsBack, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** One line saying what a ledger entry was for (the "description" column). */
export function describeCreditEntry(entry: CreditLedgerEntry, t: Translate, formatNumber: (n: number) => string): string {
  const parts: string[] = [];
  const details = entry.details;
  if (entry.kind === 'charge' && details) {
    if (details.service === 'search') {
      parts.push(t('credits.describe.search', { count: formatNumber(details.units ?? 1) }));
    } else {
      parts.push(entry.modelLabel ?? entry.model ?? t(`credits.services.${details.service}`));
      if (details.service === 'chat') {
        if (details.tier) parts.push(t('credits.describe.tier', { tier: details.tier }));
        parts.push(t('credits.describe.tokens', {
          input: formatNumber(details.inputTokens ?? 0),
          output: formatNumber(details.outputTokens ?? 0),
        }));
      } else {
        parts.push(t('credits.describe.embeddingTokens', { input: formatNumber(details.inputTokens ?? 0) }));
      }
      if (details.estimated) parts.push(t('credits.describe.estimated'));
    }
    if (details.agentKey) parts.push(t('credits.describe.agent', { agent: details.agentKey }));
    else if (details.source) parts.push(t('credits.describe.source', { source: details.source }));
    return parts.join(' · ');
  }
  if (entry.kind === 'monthly_grant') return t('credits.describe.monthlyGrant');
  if (entry.kind === 'redeem') return t('credits.describe.redeem');
  if (entry.kind === 'expire') return t('credits.describe.expire');
  if (entry.kind === 'grant') return [t('credits.describe.grant'), entry.note].filter(Boolean).join(' · ');
  if (entry.kind === 'revoke') return [t('credits.describe.revoke'), entry.note].filter(Boolean).join(' · ');
  return [entry.modelLabel ?? entry.model, entry.note].filter(Boolean).join(' · ');
}
