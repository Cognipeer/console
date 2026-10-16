import { describe, expect, it } from 'vitest';
import { normalizeRunbookUrl, validateRuleInput } from '@/lib/services/alerts/alertService';
import {
  applyRuleListQuery,
  buildNoiseStats,
  buildRuleKpis,
  deriveRule,
  isRuleMuted,
  isRuleNoData,
  NOISY_FIRED_7D,
  type RuleDerived,
} from '@/lib/services/alerts/ruleInsights';
import type { IAlertRule } from '@/lib/database';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const DAY = 86_400_000;

function rule(over: Partial<IAlertRule> & { _id: string }): IAlertRule {
  return {
    tenantId: 't', projectId: 'p', name: over._id, module: 'models', enabled: true, metric: 'error_rate',
    condition: { operator: 'gt', threshold: 5 }, windowMinutes: 15, cooldownMinutes: 15, channels: [], createdBy: 'u1',
    ...over,
  } as IAlertRule;
}

describe('runbookUrl validation', () => {
  it('accepts http(s) links, trims, and clears on empty / null', () => {
    expect(normalizeRunbookUrl(' https://wiki.example.com/runbooks/db?x=1 ')).toBe('https://wiki.example.com/runbooks/db?x=1');
    expect(normalizeRunbookUrl('http://localhost:3000/rb')).toBe('http://localhost:3000/rb');
    expect(normalizeRunbookUrl('')).toBeNull();
    expect(normalizeRunbookUrl('   ')).toBeNull();
    expect(normalizeRunbookUrl(null)).toBeNull();
    expect(normalizeRunbookUrl(undefined)).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/rb',
    'file:///etc/passwd',
    '//example.com/rb',
    'not a url',
    'https://exa mple.com',
    'https://example.com/\u0000',
    'https://example.com/\nX: y',
  ])('rejects %j', (value) => {
    expect(() => normalizeRunbookUrl(value)).toThrow(/runbookUrl/);
  });

  it('rejects non-strings and URLs over 2048 characters', () => {
    expect(() => normalizeRunbookUrl(42)).toThrow(/string/);
    expect(() => normalizeRunbookUrl(`https://example.com/${'a'.repeat(2048)}`)).toThrow(/2048/);
    expect(normalizeRunbookUrl(`https://example.com/${'a'.repeat(2000)}`)).toBeTruthy();
  });

  const body = {
    name: 'r', module: 'models', metric: 'error_rate', condition: { operator: 'gt', threshold: 5 }, windowMinutes: 15,
  };

  it('flows through the rule validator for create, and is kept / cleared on update', () => {
    expect(validateRuleInput({ ...body, runbookUrl: 'https://rb.example.com/x' }, { mode: 'create' }).runbookUrl).toBe('https://rb.example.com/x');
    expect(validateRuleInput(body, { mode: 'create' }).runbookUrl).toBeNull();
    const existing = rule({ _id: 'r1', runbookUrl: 'https://rb.example.com/old' });
    expect(validateRuleInput({ name: 'renamed' }, { mode: 'update', existing }).runbookUrl).toBe('https://rb.example.com/old');
    expect(validateRuleInput({ runbookUrl: '' }, { mode: 'update', existing }).runbookUrl).toBeNull();
    expect(validateRuleInput({ runbookUrl: null }, { mode: 'update', existing }).runbookUrl).toBeNull();
    expect(() => validateRuleInput({ ...body, runbookUrl: 'javascript:1' }, { mode: 'create' })).toThrow();
  });
});

describe('derived rule state', () => {
  it('muted is a flag that expires; no data needs every target without data', () => {
    expect(isRuleMuted({ mutedUntil: new Date(NOW.getTime() + 1000) }, NOW)).toBe(true);
    expect(isRuleMuted({ mutedUntil: new Date(NOW.getTime() - 1000) }, NOW)).toBe(false);
    expect(isRuleMuted({}, NOW)).toBe(false);

    const last = (targets: number, noDataTargets: number) => ({ at: NOW, targets, noDataTargets });
    expect(isRuleNoData(rule({ _id: 'a', lastEvaluation: last(3, 3) }))).toBe(true);
    expect(isRuleNoData(rule({ _id: 'a', lastEvaluation: last(3, 2) }))).toBe(false);
    expect(isRuleNoData(rule({ _id: 'a' }))).toBe(false);
    expect(isRuleNoData(rule({ _id: 'a', enabled: false, lastEvaluation: last(3, 3) }))).toBe(false);
    // an entity rule that sees no entity at all has no data; a legacy rule with zero targets does not
    expect(isRuleNoData(rule({ _id: 'a', metric: 'agent_error_rate', lastEvaluation: last(0, 0) }))).toBe(true);
    expect(isRuleNoData(rule({ _id: 'a', lastEvaluation: last(0, 0) }))).toBe(false);
  });

  it('picks one primary status: disabled > firing > pending > noData > ok', () => {
    const counts = (firing: number, pending: number) => ({ ok: 0, firing, pending });
    const noData = { at: NOW, targets: 1, noDataTargets: 1 };
    expect(deriveRule(rule({ _id: 'a', enabled: false }), counts(1, 0), NOW).status).toBe('disabled');
    expect(deriveRule(rule({ _id: 'a' }), counts(1, 1), NOW).status).toBe('firing');
    expect(deriveRule(rule({ _id: 'a' }), counts(0, 1), NOW).status).toBe('pending');
    expect(deriveRule(rule({ _id: 'a', lastEvaluation: noData }), undefined, NOW)).toMatchObject({ status: 'noData', noData: true });
    expect(deriveRule(rule({ _id: 'a' }), undefined, NOW).status).toBe('ok');
    expect(deriveRule(rule({ _id: 'a', mutedUntil: new Date(NOW.getTime() + 1) }), counts(1, 0), NOW)).toMatchObject({ status: 'firing', muted: true });
  });
});

describe('noise statistics', () => {
  it('counts fires of the last 7 days into 7 rolling day buckets, oldest first', () => {
    const at = (ageMs: number) => ({ ruleId: 'r1', firedAt: new Date(NOW.getTime() - ageMs) });
    const stats = buildNoiseStats([
      at(1000), at(2 * 3600_000), at(DAY + 1), at(6 * DAY + 5), at(7 * DAY), at(8 * DAY),
      { ruleId: 'r2', firedAt: new Date(NOW.getTime() - 3 * DAY) },
      { ruleId: 'r1', firedAt: new Date(NOW.getTime() + 10_000) },
    ], NOW);
    expect(stats.r1).toEqual({ fired7d: 4, daily7d: [1, 0, 0, 0, 0, 1, 2] });
    expect(stats.r2).toEqual({ fired7d: 1, daily7d: [0, 0, 0, 1, 0, 0, 0] });
    expect(stats.r3).toBeUndefined();
  });
});

describe('rules list filters, sort and KPIs', () => {
  const rules = [
    rule({ _id: 'a', name: 'Latency p95', createdBy: 'u1', lastTriggeredAt: new Date('2026-10-10T00:00:00Z') }),
    rule({ _id: 'b', name: 'error budget', description: 'Checkout flow', createdBy: 'u2', mutedUntil: new Date(NOW.getTime() + 60_000), lastTriggeredAt: new Date('2026-10-15T00:00:00Z') }),
    rule({ _id: 'c', name: 'Zeta', enabled: false, createdBy: 'u1' }),
    rule({ _id: 'd', name: 'Idle agent', lastEvaluation: { at: NOW, targets: 2, noDataTargets: 2 } }),
  ];
  const states = { a: { ok: 0, pending: 0, firing: 2 }, b: { ok: 0, pending: 1, firing: 0 } } as Record<string, { ok: number; pending: number; firing: number }>;
  const derived: Record<string, RuleDerived> = {};
  for (const r of rules) derived[String(r._id)] = deriveRule(r, states[String(r._id)], NOW);
  const stats = { a: { fired7d: 3, daily7d: [0, 0, 0, 0, 0, 0, 3] }, b: { fired7d: NOISY_FIRED_7D, daily7d: [0, 0, 0, 0, 0, 0, 10] } };
  const ids = (list: IAlertRule[]) => list.map((r) => String(r._id));

  it('filters by status (muted is a flag), owner and text', () => {
    expect(ids(applyRuleListQuery(rules, { status: 'firing' }, derived, null))).toEqual(['a']);
    expect(ids(applyRuleListQuery(rules, { status: 'pending' }, derived, null))).toEqual(['b']);
    expect(ids(applyRuleListQuery(rules, { status: 'muted' }, derived, null))).toEqual(['b']);
    expect(ids(applyRuleListQuery(rules, { status: 'noData' }, derived, null))).toEqual(['d']);
    expect(ids(applyRuleListQuery(rules, { status: 'disabled' }, derived, null))).toEqual(['c']);
    expect(ids(applyRuleListQuery(rules, { owner: 'u1' }, derived, null))).toEqual(['a', 'c', 'd']);
    expect(ids(applyRuleListQuery(rules, { q: 'CHECKOUT' }, derived, null))).toEqual(['b']);
    expect(ids(applyRuleListQuery(rules, { q: 'zeta', owner: 'u1', status: 'disabled' }, derived, null))).toEqual(['c']);
  });

  it('sorts by name, fired7d and lastFiredAt', () => {
    expect(ids(applyRuleListQuery(rules, { sort: 'name' }, derived, null))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(applyRuleListQuery(rules, { sort: '-fired7d' }, derived, stats)).slice(0, 2)).toEqual(['b', 'a']);
    expect(ids(applyRuleListQuery(rules, { sort: '-lastFiredAt' }, derived, null)).slice(0, 2)).toEqual(['b', 'a']);
  });

  it('computes the KPIs over the whole set; noisy only with stats', () => {
    expect(buildRuleKpis(rules, derived, stats)).toEqual({ total: 4, enabled: 3, firing: 1, muted: 1, noData: 1, noisy: 1 });
    expect(buildRuleKpis(rules, derived, null).noisy).toBeNull();
  });
});
