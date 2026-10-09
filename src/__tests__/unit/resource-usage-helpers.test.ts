import { describe, expect, it } from 'vitest';
import {
  edgesBrokenByKeyChange,
  groupByImpact,
  keyChanged,
  needsTypedConfirmation,
  totalUses,
  typedConfirmationText,
  type ResourceUsageEdge,
} from '@/components/common/confirm/resourceUsage';
import { describeUsage } from '@/components/common/confirm/useDeleteResource';
import { isDisplayVisible } from '@/lib/resources/projectDisplay';
import type { ProjectDisplay } from '@/lib/resources/types';

const edge = (type: string, impact: ResourceUsageEdge['impact']): ResourceUsageEdge => ({
  kind: 'agent.model',
  field: 'config.modelKey',
  direction: 'in',
  status: 'ok',
  severity: null,
  impact,
  other: { type, id: `${type}-1`, key: null, name: `${type} 1`, projectId: null, projectName: null, projectDisplay: null, crn: null },
});

const usage = (edges: ResourceUsageEdge[], extra: Partial<{ hidden: number; error: number; warning: number }> = {}) => ({
  resource: { type: 'model', id: 'm1', key: 'gpt', name: 'GPT', projectId: null, projectName: null, projectDisplay: null, crn: null },
  usedBy: edges,
  hiddenUsedByCount: extra.hidden ?? 0,
  hiddenByType: {},
  summary: { error: extra.error ?? edges.filter((e) => e.impact === 'error').length, warning: extra.warning ?? edges.filter((e) => e.impact === 'warning').length },
  usedByTruncated: false,
});

const t = (key: string, values?: Record<string, string | number | undefined | null>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

describe('usage helpers', () => {
  it('groups visible referrers by type for one impact, largest first', () => {
    const u = usage([edge('agent', 'error'), edge('agent', 'error'), edge('guardrail', 'error'), edge('tool', 'warning'), edge('agent', null)]);
    expect(groupByImpact(u, 'error')).toEqual([{ type: 'agent', count: 2 }, { type: 'guardrail', count: 1 }]);
    expect(groupByImpact(u, 'warning')).toEqual([{ type: 'tool', count: 1 }]);
  });

  it('counts hidden referrers in the total', () => {
    expect(totalUses(usage([edge('agent', 'error')], { hidden: 3 }))).toBe(4);
  });

  it('requires typing as soon as one dependent (even a hidden one) would fail', () => {
    expect(needsTypedConfirmation({ summary: { error: 1, warning: 0 } })).toBe(true);
    expect(needsTypedConfirmation({ summary: { error: 0, warning: 4 } })).toBe(false);
  });

  it('types the name, falling back to the key, then the id', () => {
    expect(typedConfirmationText({ name: ' Sales ', key: 'sales' })).toBe('Sales');
    expect(typedConfirmationText({ name: null, key: 'sales' })).toBe('sales');
    expect(typedConfirmationText({ name: '', key: null, id: 'abc' })).toBe('abc');
    expect(typedConfirmationText({ name: null, key: null })).toBeUndefined();
  });

  it('keyChanged ignores whitespace and an empty original', () => {
    expect(keyChanged('gpt', 'gpt ')).toBe(false);
    expect(keyChanged('gpt', 'gpt-4')).toBe(true);
    expect(keyChanged('', 'gpt-4')).toBe(false);
    expect(keyChanged(null, 'gpt-4')).toBe(false);
  });

  it('only references that work today break on a rename', () => {
    const u = usage([edge('agent', 'error'), edge('tool', 'warning'), edge('agent', null)]);
    expect(edgesBrokenByKeyChange(u)).toHaveLength(2);
  });
});

describe('describeUsage (delete dialog content)', () => {
  const ctx = { noun: 'model', fallbackName: 'GPT', t, typeLabel: (x: string) => x };

  it('adds nothing for an unused resource', () => {
    expect(describeUsage(usage([]), ctx)).toEqual({});
  });

  it('warning-only dependents do not force typing', () => {
    const out = describeUsage(usage([edge('tool', 'warning')]), ctx);
    expect(out.details).toBeTruthy();
    expect(out.requireTypedText).toBeUndefined();
  });

  it('an error dependent forces typing the name', () => {
    const out = describeUsage(usage([edge('agent', 'error')]), ctx);
    expect(out.requireTypedText).toBe('GPT');
  });

  it('a hidden failing dependent alone forces typing too', () => {
    const out = describeUsage(usage([], { hidden: 2, error: 2 }), ctx);
    expect(out.requireTypedText).toBe('GPT');
    expect(out.details).toBeTruthy();
  });
});

describe('isDisplayVisible', () => {
  const ids = new Set(['p1']);
  const cases: Array<[ProjectDisplay, boolean]> = [
    [{ kind: 'project', projectId: 'p1', projectName: 'A' }, true],
    [{ kind: 'project', projectId: 'p2', projectName: 'B' }, false],
    [{ kind: 'multi-project', projectIds: ['p2', 'p1'], projectNames: ['B', 'A'] }, true],
    [{ kind: 'multi-project', projectIds: ['p2', 'p3'], projectNames: ['B', 'C'] }, false],
    [{ kind: 'all-projects' }, true],
    [{ kind: 'tenant-level' }, true],
    [{ kind: 'unassigned' }, false],
  ];
  it.each(cases)('%j -> %s for a project member', (display, expected) => {
    expect(isDisplayVisible(display, ids)).toBe(expected);
  });
  it('everything is visible to admins (null)', () => {
    for (const [display] of cases) expect(isDisplayVisible(display, null)).toBe(true);
  });
});
