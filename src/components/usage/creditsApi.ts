/**
 * Client side of the credits API on hosted plans (`/api/usage/credits*`). Editions without credits answer
 * 404; callers treat any failure as "no credits data" and hide what depends on it.
 */
import { apiRequest } from '@/lib/api/client';

export type CreditLedgerKind = 'monthly_grant' | 'redeem' | 'charge' | 'refund' | 'adjust' | 'expire';
export const CREDIT_LEDGER_KINDS: readonly CreditLedgerKind[] = ['charge', 'redeem', 'monthly_grant', 'refund', 'adjust', 'expire'];

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
  models: CreditSpendModel[];
}

export interface CreditLedgerQuery {
  limit: number;
  cursor?: string | null;
  kind?: CreditLedgerKind;
  model?: string;
}

export async function fetchCreditLedger(query: CreditLedgerQuery): Promise<CreditLedgerPage> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.kind) params.set('kind', query.kind);
  if (query.model) params.set('model', query.model);
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
  const data = await apiRequest<Partial<CreditSpend>>(`/api/usage/credits/spend${qs ? `?${qs}` : ''}`);
  return {
    from: data.from ?? null,
    to: data.to ?? new Date().toISOString(),
    total: data.total ?? 0,
    models: data.models ?? [],
  };
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
  return [entry.modelLabel ?? entry.model, entry.note].filter(Boolean).join(' · ');
}
