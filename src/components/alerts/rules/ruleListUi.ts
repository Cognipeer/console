/**
 * Pure presentation rules of the rules list (L3): the query it sends, mute presets, the noise column and the backtest
 * summary. No DOM, no i18n lookups (components translate the keys these return).
 */

import type { AlertRuleDto, BacktestResultDto, RuleDerivedDto, RuleStatsDto } from '../alertTypes';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** A rule that fired this many times in 7 days is "noisy" (mirrors the server KPI). */
export const NOISY_FIRES_7D = 10;
/** The server refuses a mute further ahead than this. */
export const MAX_MUTE_MS = 30 * DAY_MS;

export type RuleStatusFilter = 'all' | 'firing' | 'pending' | 'ok' | 'muted' | 'noData' | 'disabled';
export type RuleSort = 'name' | '-fired7d' | '-lastFiredAt';

export const RULE_STATUS_FILTERS: RuleStatusFilter[] = ['all', 'firing', 'pending', 'ok', 'muted', 'noData', 'disabled'];
export const RULE_SORTS: RuleSort[] = ['-fired7d', '-lastFiredAt', 'name'];

export interface RuleListFilters {
  status: RuleStatusFilter;
  /** `all`, `me` or a user id. */
  owner: string;
  q: string;
  sort: RuleSort;
}

export const DEFAULT_RULE_FILTERS: RuleListFilters = { status: 'all', owner: 'all', q: '', sort: '-fired7d' };

/** Query string of `GET /alerts/rules` for the list: stats always (the noise column), the rest only when set. */
export function buildRulesQuery(filters: RuleListFilters): string {
  const params = new URLSearchParams();
  params.set('include', 'stats');
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.owner !== 'all' && filters.owner) params.set('owner', filters.owner);
  const q = filters.q.trim();
  if (q) params.set('q', q.slice(0, 200));
  params.set('sort', filters.sort);
  return params.toString();
}

export function isRuleStatusFilter(value: string | null | undefined): value is RuleStatusFilter {
  return RULE_STATUS_FILTERS.includes(value as RuleStatusFilter);
}

export function isRuleSort(value: string | null | undefined): value is RuleSort {
  return RULE_SORTS.includes(value as RuleSort);
}

// ── Mute ────────────────────────────────────────────────────────────────────

export type MutePresetId = '1h' | '4h' | '24h' | '7d';

export const MUTE_PRESETS: Array<{ id: MutePresetId; ms: number }> = [
  { id: '1h', ms: HOUR_MS },
  { id: '4h', ms: 4 * HOUR_MS },
  { id: '24h', ms: DAY_MS },
  { id: '7d', ms: 7 * DAY_MS },
];

/** ISO end time of a preset, counted from `now`. */
export function muteUntilForPreset(id: MutePresetId, now: number = Date.now()): string {
  const preset = MUTE_PRESETS.find((entry) => entry.id === id) ?? MUTE_PRESETS[0];
  return new Date(now + preset.ms).toISOString();
}

export type MuteIssue = 'invalid' | 'past' | 'tooFar';

/** Why a custom mute end cannot be used (the server's 400 rule), or null. */
export function validateMuteUntil(value: Date | string | null | undefined, now: number = Date.now()): MuteIssue | null {
  if (value === null || value === undefined || value === '') return 'invalid';
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(time)) return 'invalid';
  if (time <= now) return 'past';
  if (time > now + MAX_MUTE_MS) return 'tooFar';
  return null;
}

/** Whether the rule is muted right now (the server's `derived.muted` wins when present). */
export function isMuted(rule: Pick<AlertRuleDto, 'mutedUntil'>, derived?: RuleDerivedDto | null, now: number = Date.now()): boolean {
  if (derived) return derived.muted;
  if (!rule.mutedUntil) return false;
  const until = new Date(rule.mutedUntil).getTime();
  return Number.isFinite(until) && until > now;
}

// ── Status / noise ──────────────────────────────────────────────────────────

/** i18n key suffix under `alerts.rules.status.` and badge tone of a rule's primary status. */
export function statusBadge(status: RuleDerivedDto['status']): { key: string; tone: 'err' | 'warn' | 'ok' | 'muted' | 'info' } {
  switch (status) {
    case 'firing':
      return { key: 'firing', tone: 'err' };
    case 'pending':
      return { key: 'pending', tone: 'warn' };
    case 'noData':
      return { key: 'noData', tone: 'info' };
    case 'disabled':
      return { key: 'disabled', tone: 'muted' };
    default:
      return { key: 'ok', tone: 'ok' };
  }
}

/** Seven numbers, oldest first; anything missing or malformed counts as zero. */
export function dailySeries(stats: RuleStatsDto | undefined): number[] {
  const source = Array.isArray(stats?.daily7d) ? stats.daily7d : [];
  return Array.from({ length: 7 }, (_, index) => {
    const value = Number(source[index]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
}

export function firedLast7d(stats: RuleStatsDto | undefined): number {
  return stats && Number.isFinite(stats.fired7d) ? Math.max(0, stats.fired7d) : 0;
}

export function isNoisy(stats: RuleStatsDto | undefined): boolean {
  return firedLast7d(stats) >= NOISY_FIRES_7D;
}

// ── Backtest ────────────────────────────────────────────────────────────────

/** Median fire-to-resolve time of the replayed incidents that resolved, in ms; null when none did. */
export function backtestMedianDurationMs(incidents: BacktestResultDto['incidents'] | undefined): number | null {
  const spans = (incidents ?? [])
    .map((incident) => (incident.resolvedAt ? new Date(incident.resolvedAt).getTime() - new Date(incident.firedAt).getTime() : NaN))
    .filter((span) => Number.isFinite(span) && span >= 0)
    .sort((a, b) => a - b);
  if (spans.length === 0) return null;
  const mid = Math.floor(spans.length / 2);
  return spans.length % 2 ? spans[mid] : Math.round((spans[mid - 1] + spans[mid]) / 2);
}

/** Entities that would have fired most, descending (top `limit`). */
export function topBacktestEntities(result: BacktestResultDto, limit = 5): BacktestResultDto['firesPerEntity'] {
  return [...(result.firesPerEntity ?? [])].sort((a, b) => b.fires - a.fires).slice(0, limit);
}
