import { describe, expect, it } from 'vitest';
import {
  diffAssignment,
  effectiveProjectIds,
  filterProjects,
  foundCount,
  formatLatency,
  formatRelativeTime,
  groupAssignCandidates,
  isProviderUnassigned,
  pickModelFlowProject,
  setAll,
  testState,
  toggleId,
  unassignImpact,
  usageSummary,
  type AccessProject,
} from '@/components/providers/providerAccessModel';

const project = (id: string, name: string, byDomain: Record<string, number> = {}): AccessProject => ({
  _id: id,
  key: name.toLowerCase(),
  name,
  stats: { providersByDomain: byDomain },
});

describe('groupAssignCandidates', () => {
  const projects = [project('1', 'Zeta', { model: 1 }), project('2', 'Alpha'), project('3', 'Beta', { vector: 2 })];

  it('puts projects without a provider of the domain first, each group by name', () => {
    const g = groupAssignCandidates(projects, 'model');
    expect(g.recommended.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    expect(g.others.map((p) => p.name)).toEqual(['Zeta']);
  });

  it('applies the query and the exclusions', () => {
    const g = groupAssignCandidates(projects, 'model', { query: 'a', excludeIds: new Set(['2']) });
    expect(g.recommended.map((p) => p.name)).toEqual(['Beta']);
    expect(g.others.map((p) => p.name)).toEqual(['Zeta']);
  });

  it('treats unknown stats as no provider', () => {
    const g = groupAssignCandidates([{ _id: 'x', key: 'x', name: 'X' }], 'model');
    expect(g.recommended).toHaveLength(1);
  });
});

describe('selection helpers', () => {
  it('toggles without mutating', () => {
    const a = new Set(['1']);
    expect([...toggleId(a, '2')]).toEqual(['1', '2']);
    expect([...toggleId(a, '1')]).toEqual([]);
    expect([...a]).toEqual(['1']);
  });
  it('selects or clears only the given ids', () => {
    expect([...setAll(new Set(['9']), ['1', '2'], true)].sort()).toEqual(['1', '2', '9']);
    expect([...setAll(new Set(['1', '9']), ['1', '2'], false)]).toEqual(['9']);
  });
  it('filters by name or key, case-insensitively', () => {
    expect(filterProjects([{ name: 'Alpha', key: 'a-1' }, { name: 'B', key: 'zz' }], 'ALP')).toHaveLength(1);
    expect(filterProjects([{ name: 'Alpha', key: 'a-1' }], '  ')).toHaveLength(1);
  });
});

describe('assignment', () => {
  it('folds the legacy projectId in and detects unassigned providers', () => {
    expect(effectiveProjectIds({ projectId: 'a', projectIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(isProviderUnassigned({ projectIds: [] })).toBe(true);
    expect(isProviderUnassigned({ projectId: 'a' })).toBe(false);
  });
  it('diffs two assignments', () => {
    expect(diffAssignment(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'], next: ['b', 'c'] });
  });
  it('summarises usage and impact', () => {
    expect(usageSummary([{ assigned: true }, { assigned: false }, { assigned: true }])).toEqual({ assigned: 2, total: 3 });
    expect(unassignImpact({ models: [], agents: [] }).hasImpact).toBe(false);
    expect(unassignImpact({ models: [{ id: '1', name: 'm' }], agents: [], requests7d: 4 })).toMatchObject({
      hasImpact: true,
      requests7d: 4,
    });
  });
  it('picks the project of the add-models flow', () => {
    expect(pickModelFlowProject([], 'x')).toBeNull();
    expect(pickModelFlowProject(['a', 'b'], 'b')).toEqual({ projectId: 'b', needsSwitch: false });
    expect(pickModelFlowProject(['a', 'b'], 'z')).toEqual({ projectId: 'a', needsSwitch: true });
  });
});

describe('test results', () => {
  it('maps ok to a state', () => {
    expect(testState({ ok: true })).toBe('ok');
    expect(testState({ ok: false })).toBe('failed');
    expect(testState({ ok: null })).toBe('unsupported');
  });
  it('counts found deployments before models', () => {
    expect(foundCount(undefined)).toBeUndefined();
    expect(foundCount({ deployments: ['a', 'b'], models: ['x'] })).toBe(2);
    expect(foundCount({ models: ['x'] })).toBe(1);
  });
  it('formats latency and relative time', () => {
    expect(formatLatency(412)).toBe('412 ms');
    expect(formatLatency(1234)).toBe('1.2 s');
    expect(formatLatency(-1)).toBe('—');
    const now = new Date('2026-10-16T12:00:00Z');
    expect(formatRelativeTime('2026-10-16T11:58:00Z', 'en', now)).toBe('2 minutes ago');
    expect(formatRelativeTime('nope', 'en', now)).toBe('');
  });
});
