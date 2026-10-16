/**
 * Pure helpers behind the rules list: derived display state (muted / no data),
 * 7-day noise statistics and the server-side filters and sorts. No I/O, so the
 * rules are testable without a database.
 */

import type { IAlertRule } from '@/lib/database';
import { getMetricDef } from './metricCatalog';

export const DAY_MS = 86_400_000;
/** A rule that fired this often within 7 days is "noisy". */
export const NOISY_FIRED_7D = 10;

export type RuleDisplayStatus = 'firing' | 'pending' | 'ok' | 'noData' | 'disabled';
export type RuleStatusFilter = RuleDisplayStatus | 'muted';
export const RULE_STATUS_FILTERS: readonly RuleStatusFilter[] = ['firing', 'pending', 'ok', 'muted', 'noData', 'disabled'];
export const RULE_SORTS = ['name', '-fired7d', '-lastFiredAt'] as const;
export type RuleSort = (typeof RULE_SORTS)[number];

export interface RuleStateCounts {
  ok: number;
  pending: number;
  firing: number;
}

export interface RuleDerived {
  /** One primary state; "muted" is a flag next to it (a muted rule keeps evaluating). */
  status: RuleDisplayStatus;
  muted: boolean;
  noData: boolean;
}

export interface RuleNoiseStats {
  fired7d: number;
  /** Fires per rolling 24 h bucket, oldest first, the last bucket ending now. */
  daily7d: number[];
}

export interface RuleListKpis {
  total: number;
  enabled: number;
  firing: number;
  muted: number;
  noData: number;
  /** Rules that fired at least NOISY_FIRED_7D times in 7 days; null when stats were not computed. */
  noisy: number | null;
}

export function isRuleMuted(rule: Pick<IAlertRule, 'mutedUntil'>, now: Date): boolean {
  if (!rule.mutedUntil) return false;
  const until = new Date(rule.mutedUntil).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

/** "No data": enabled, the last evaluation saw targets and every one of them lacked data (or an entity rule saw no entity at all). */
export function isRuleNoData(rule: IAlertRule): boolean {
  if (rule.enabled === false) return false;
  const last = rule.lastEvaluation;
  if (!last) return false;
  if (last.targets > 0) return last.noDataTargets === last.targets;
  return getMetricDef(rule.metric)?.source === 'entity';
}

export function deriveRule(rule: IAlertRule, counts: RuleStateCounts | undefined, now: Date): RuleDerived {
  const muted = isRuleMuted(rule, now);
  const noData = isRuleNoData(rule);
  let status: RuleDisplayStatus;
  if (rule.enabled === false) status = 'disabled';
  else if ((counts?.firing ?? 0) > 0) status = 'firing';
  else if ((counts?.pending ?? 0) > 0) status = 'pending';
  else if (noData) status = 'noData';
  else status = 'ok';
  return { status, muted, noData };
}

/** Fires per rule over the last 7 days from (ruleId, firedAt) rows. */
export function buildNoiseStats(
  firings: Array<{ ruleId: string; firedAt: Date | string }>,
  now: Date,
): Record<string, RuleNoiseStats> {
  const stats: Record<string, RuleNoiseStats> = {};
  const nowMs = now.getTime();
  for (const firing of firings) {
    const at = new Date(firing.firedAt).getTime();
    if (!Number.isFinite(at)) continue;
    const age = nowMs - at;
    if (age < 0 || age >= 7 * DAY_MS) continue;
    const entry = (stats[firing.ruleId] ??= { fired7d: 0, daily7d: [0, 0, 0, 0, 0, 0, 0] });
    entry.fired7d += 1;
    entry.daily7d[6 - Math.floor(age / DAY_MS)] += 1;
  }
  return stats;
}

export interface RuleListQuery {
  status?: RuleStatusFilter;
  /** User id; the caller resolves "me". */
  owner?: string;
  q?: string;
  sort?: RuleSort;
}

export function applyRuleListQuery<T extends IAlertRule>(
  rules: T[],
  query: RuleListQuery,
  derived: Record<string, RuleDerived>,
  stats: Record<string, RuleNoiseStats> | null,
): T[] {
  const needle = query.q?.trim().toLowerCase();
  let out = rules.filter((rule) => {
    const info = derived[String(rule._id)];
    if (query.status) {
      if (query.status === 'muted' ? !info?.muted : info?.status !== query.status) return false;
    }
    if (query.owner && rule.createdBy !== query.owner) return false;
    if (needle) {
      const haystack = `${rule.name} ${rule.description ?? ''} ${rule.metric}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  if (query.sort === 'name') {
    out = [...out].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } else if (query.sort === '-fired7d') {
    out = [...out].sort((a, b) => (stats?.[String(b._id)]?.fired7d ?? 0) - (stats?.[String(a._id)]?.fired7d ?? 0));
  } else if (query.sort === '-lastFiredAt') {
    const at = (rule: IAlertRule) => (rule.lastTriggeredAt ? new Date(rule.lastTriggeredAt).getTime() : 0);
    out = [...out].sort((a, b) => at(b) - at(a));
  }
  return out;
}

export function buildRuleKpis(
  rules: IAlertRule[],
  derived: Record<string, RuleDerived>,
  stats: Record<string, RuleNoiseStats> | null,
): RuleListKpis {
  const kpis: RuleListKpis = { total: rules.length, enabled: 0, firing: 0, muted: 0, noData: 0, noisy: stats ? 0 : null };
  for (const rule of rules) {
    const id = String(rule._id);
    const info = derived[id];
    if (rule.enabled !== false) kpis.enabled += 1;
    if (info?.status === 'firing') kpis.firing += 1;
    if (info?.muted) kpis.muted += 1;
    if (info?.noData) kpis.noData += 1;
    if (stats && (stats[id]?.fired7d ?? 0) >= NOISY_FIRED_7D && kpis.noisy !== null) kpis.noisy += 1;
  }
  return kpis;
}
