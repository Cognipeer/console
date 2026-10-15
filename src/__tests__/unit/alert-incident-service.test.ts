import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;

vi.mock('@/lib/database', () => ({ getTenantDatabase: vi.fn() }));

import { getTenantDatabase } from '@/lib/database';
import {
  IncidentService,
  MAX_BULK_INCIDENTS,
  deriveRuleSeverity,
  deriveSeverity,
} from '@/lib/services/alerts/incidentService';
import { AlertApiError } from '@/lib/services/alerts/alertApiError';
import type { IAlertCondition } from '@/lib/database';

describe('deriveSeverity (operator-aware)', () => {
  it.each([
    // gt/gte: actual / threshold
    ['gt', 20, 10, 'critical'],
    ['gt', 12.5, 10, 'warning'],
    ['gte', 10, 10, 'info'],
    ['gt', 11, 10, 'info'],
    // lt/lte: threshold / actual
    ['lt', 2, 10, 'critical'],
    ['lt', 8, 10, 'warning'],
    ['lte', 9.5, 10, 'info'],
    ['lt', 0, 10, 'critical'],
    // eq/neq or a non-positive threshold have no ratio
    ['eq', 5, 10, 'warning'],
    ['gt', 5, 0, 'warning'],
    ['lt', 5, -1, 'warning'],
  ] as const)('%s actual=%s threshold=%s -> %s', (operator, actual, threshold, expected) => {
    expect(deriveSeverity('error_rate', actual, threshold, operator)).toBe(expected);
  });

  it('keeps the legacy heuristic when no operator is known', () => {
    expect(deriveSeverity('error_rate', 20, 10)).toBe('critical');
    expect(deriveSeverity('error_rate', 12, 10)).toBe('warning');
    expect(deriveSeverity('avg_latency_ms', 30, 10)).toBe('critical');
    expect(deriveSeverity('avg_latency_ms', 15, 10)).toBe('warning');
    expect(deriveSeverity('avg_latency_ms', 11, 10)).toBe('info');
  });
});

describe('deriveRuleSeverity', () => {
  const threshold: IAlertCondition = { operator: 'gt', threshold: 10 };
  const rule = (condition: IAlertCondition, severity?: 'auto' | 'info' | 'warning' | 'critical' | null) =>
    ({ metric: 'agent_error_rate' as const, severity, condition });

  it('a configured severity always wins', () => {
    expect(deriveRuleSeverity({ rule: rule(threshold, 'info'), value: 1000 })).toBe('info');
    expect(deriveRuleSeverity({ rule: rule({ mode: 'absence' } as IAlertCondition, 'warning'), value: 0 })).toBe('warning');
  });

  it.each([undefined, null, 'auto'] as const)('%s derives from the breach', (severity) => {
    expect(deriveRuleSeverity({ rule: rule(threshold, severity), value: 25 })).toBe('critical');
    expect(deriveRuleSeverity({ rule: rule(threshold, severity), value: 13 })).toBe('warning');
    expect(deriveRuleSeverity({ rule: rule(threshold, severity), value: 10.5 })).toBe('info');
    expect(deriveRuleSeverity({ rule: rule(threshold, severity), value: null })).toBe('warning');
  });

  it('an lt threshold rule uses the inverse ratio', () => {
    expect(deriveRuleSeverity({ rule: rule({ operator: 'lt', threshold: 10 }), value: 3 })).toBe('critical');
  });

  it('absence is critical', () => {
    expect(deriveRuleSeverity({ rule: rule({ operator: 'lt', threshold: 1, mode: 'absence' }), value: 0 })).toBe('critical');
  });

  describe('baseline', () => {
    const condition = {
      operator: 'gt', threshold: 0, mode: 'baseline',
      baseline: { direction: 'up', minRatio: 2, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily' },
    } as IAlertCondition;
    it.each([
      [{ ratio: 4, z: 1 }, 'critical'],
      [{ ratio: 1, z: 6 }, 'critical'],
      [{ ratio: 3.9, z: 5.9 }, 'warning'],
      [{ ratio: null, z: null }, 'warning'],
    ] as const)('%j -> %s', (baseline, expected) => {
      expect(deriveRuleSeverity({ rule: rule(condition), value: 1, baseline })).toBe(expected);
    });
    it('is a warning without baseline data', () => {
      expect(deriveRuleSeverity({ rule: rule(condition), value: 1 })).toBe('warning');
    });
  });

  describe('slo_burn', () => {
    const condition = {
      operator: 'gt', threshold: 0, mode: 'slo_burn',
      slo: { objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 },
    } as IAlertCondition;
    it('critical from twice the configured burn rate', () => {
      expect(deriveRuleSeverity({ rule: rule(condition), value: 1, slo: { burnShort: 28.8 } })).toBe('critical');
      expect(deriveRuleSeverity({ rule: rule(condition), value: 1, slo: { burnShort: 20 } })).toBe('warning');
      expect(deriveRuleSeverity({ rule: rule(condition), value: 1, slo: { burnShort: null } })).toBe('warning');
    });
  });
});

describe('IncidentService', () => {
  let db: LooseDb;
  const incident = (status: string, extra: Record<string, unknown> = {}) => ({
    _id: 'i1', tenantId: 't', projectId: 'p1', status, notes: [], ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb() as unknown as LooseDb;
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.updateIncident.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ _id: 'i1', ...data }));
    db.createIncident.mockImplementation(async (data: Record<string, unknown>) => ({ _id: 'i1', ...data }));
  });

  describe('createIncident', () => {
    const base = {
      tenantId: 't', projectId: 'p1', alertEventId: 'e1', ruleId: 'r1', ruleName: 'Rule',
      metric: 'agent_error_rate' as const, threshold: 10, actualValue: 25, firedAt: new Date(),
    };

    it('stores the entity fields, peak and last values, and derives the severity from the operator', async () => {
      await IncidentService.createIncident('d', {
        ...base, module: 'agents', entityType: 'agent', entityKey: 'Pulse Main', baselineValue: 2, context: { mode: 'threshold', windowMinutes: 15 },
        metadata: { operator: 'gt' },
      });
      expect(db.createIncident).toHaveBeenCalledWith(expect.objectContaining({
        status: 'open', notes: [], severity: 'critical', module: 'agents', entityType: 'agent', entityKey: 'Pulse Main',
        baselineValue: 2, lastValue: 25, peakValue: 25, context: { mode: 'threshold', windowMinutes: 15 },
      }));
    });

    it('an explicit severity wins, and legacy callers add no entity fields', async () => {
      await IncidentService.createIncident('d', { ...base, severity: 'info' });
      const stored = db.createIncident.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(stored.severity).toBe('info');
      for (const key of ['module', 'entityType', 'entityKey', 'baselineValue', 'context']) expect(stored).not.toHaveProperty(key);
    });
  });

  describe('updateStatus', () => {
    it('returns null for a missing incident and scopes the lookup', async () => {
      db.findIncidentById.mockResolvedValue(null);
      expect(await IncidentService.updateStatus('d', 'x', 'resolved', 'u1', { projectId: 'p1' })).toBeNull();
      expect(db.findIncidentById).toHaveBeenCalledWith('x', 'p1');
    });

    it.each([
      ['open', 'acknowledged', 'acknowledgedBy'],
      ['open', 'resolved', 'resolvedBy'],
      ['acknowledged', 'investigating', null],
      ['investigating', 'closed', null],
      ['resolved', 'closed', null],
      ['resolved', 'open', null],
      ['closed', 'open', null],
    ] as const)('allows %s -> %s', async (from, to, actorField) => {
      db.findIncidentById.mockResolvedValue(incident(from));
      await IncidentService.updateStatus('d', 'i1', to, 'u1', { projectId: 'p1' });
      const [, data, projectId] = db.updateIncident.mock.calls[0];
      expect(data).toMatchObject({ status: to });
      if (actorField) expect(data).toMatchObject({ [actorField]: 'u1' });
      expect(projectId).toBe('p1');
    });

    it.each([
      ['resolved', 'acknowledged'],
      ['resolved', 'investigating'],
      ['closed', 'resolved'],
      ['investigating', 'acknowledged'],
      ['acknowledged', 'open'],
    ] as const)('refuses %s -> %s with 409', async (from, to) => {
      db.findIncidentById.mockResolvedValue(incident(from));
      await expect(IncidentService.updateStatus('d', 'i1', to, 'u1')).rejects.toMatchObject({ status: 409, code: 'invalid_transition' });
      expect(db.updateIncident).not.toHaveBeenCalled();
    });

    it.each(['resolved', 'closed'] as const)('reopening a %s incident clears the resolution fields', async (from) => {
      db.findIncidentById.mockResolvedValue({ ...incident(from), resolvedAt: new Date(), resolvedBy: 'system', closedAt: new Date(), autoResolved: true });
      await IncidentService.updateStatus('d', 'i1', 'open', 'u1');
      expect(db.updateIncident.mock.calls[0][1]).toEqual({
        status: 'open', resolvedAt: null, resolvedBy: null, closedAt: null, autoResolved: false,
      });
    });

    it('refuses an unknown status with 400', async () => {
      db.findIncidentById.mockResolvedValue(incident('open'));
      await expect(IncidentService.updateStatus('d', 'i1', 'weird' as never, 'u1')).rejects.toMatchObject({ status: 400, code: 'invalid_status' });
    });

    it('stamps the time of acknowledge, resolve and close', async () => {
      db.findIncidentById.mockResolvedValue(incident('open'));
      await IncidentService.updateStatus('d', 'i1', 'acknowledged', 'u1');
      expect((db.updateIncident.mock.calls[0][1] as { acknowledgedAt?: Date }).acknowledgedAt).toBeInstanceOf(Date);
      db.findIncidentById.mockResolvedValue(incident('acknowledged'));
      await IncidentService.updateStatus('d', 'i1', 'resolved', 'u1');
      expect((db.updateIncident.mock.calls[1][1] as { resolvedAt?: Date }).resolvedAt).toBeInstanceOf(Date);
      await IncidentService.updateStatus('d', 'i1', 'closed', 'u1');
      expect((db.updateIncident.mock.calls[2][1] as { closedAt?: Date }).closedAt).toBeInstanceOf(Date);
    });
  });

  describe('autoResolve', () => {
    it.each(['open', 'acknowledged', 'investigating'])('resolves a %s incident as the system, with a note and the values', async (status) => {
      db.findIncidentById.mockResolvedValue(incident(status, { notes: [{ content: 'earlier' }] }));
      await IncidentService.autoResolve('d', 'i1', 'Automatically resolved: x back to 1', { lastValue: 1, peakValue: 30 });
      const [, data] = db.updateIncident.mock.calls[0];
      expect(data).toMatchObject({
        status: 'resolved', resolvedBy: 'system', autoResolved: true, lastValue: 1, peakValue: 30,
      });
      const notes = (data as { notes: Array<{ content: string; userId: string }> }).notes;
      expect(notes).toHaveLength(2);
      expect(notes[1]).toMatchObject({ userId: 'system', content: 'Automatically resolved: x back to 1' });
    });

    it.each(['resolved', 'closed'])('leaves a %s incident alone (a person got there first)', async (status) => {
      db.findIncidentById.mockResolvedValue(incident(status));
      expect(await IncidentService.autoResolve('d', 'i1', 'note')).toBeNull();
      expect(db.updateIncident).not.toHaveBeenCalled();
    });

    it('returns null for a missing incident', async () => {
      db.findIncidentById.mockResolvedValue(null);
      expect(await IncidentService.autoResolve('d', 'nope', 'note')).toBeNull();
    });
  });

  describe('notes', () => {
    it('adds a trimmed note and keeps the earlier ones', async () => {
      db.findIncidentById.mockResolvedValue(incident('open', { notes: [{ content: 'first' }] }));
      await IncidentService.addNote('d', 'i1', 'u1', 'Ada', '  hello  ', { projectId: 'p1' });
      const [, data, projectId] = db.updateIncident.mock.calls[0];
      expect((data as { notes: Array<{ content: string; userName: string }> }).notes).toEqual([
        { content: 'first' },
        expect.objectContaining({ content: 'hello', userId: 'u1', userName: 'Ada' }),
      ]);
      expect(projectId).toBe('p1');
    });

    it('addSystemNote is a note by the system without a status change', async () => {
      db.findIncidentById.mockResolvedValue(incident('open'));
      await IncidentService.addSystemNote('d', 'i1', 'Rule disabled');
      const data = db.updateIncident.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(data)).toEqual(['notes']);
      expect((data.notes as Array<{ userId: string }>)[0].userId).toBe('system');
    });

    it('returns null for a missing or foreign incident', async () => {
      db.findIncidentById.mockResolvedValue(null);
      expect(await IncidentService.addNote('d', 'x', 'u', 'U', 'hi', { projectId: 'other' })).toBeNull();
    });
  });

  describe('assign', () => {
    it('assigns, trims and clears with null or blank', async () => {
      db.findIncidentById.mockResolvedValue(incident('open'));
      await IncidentService.assign('d', 'i1', ' user-2 ');
      expect(db.updateIncident.mock.calls[0][1]).toEqual({ assignedTo: 'user-2' });
      await IncidentService.assign('d', 'i1', null);
      expect(db.updateIncident.mock.calls[1][1]).toEqual({ assignedTo: null });
      await IncidentService.assign('d', 'i1', '   ');
      expect(db.updateIncident.mock.calls[2][1]).toEqual({ assignedTo: null });
    });

    it('returns null for a missing incident', async () => {
      db.findIncidentById.mockResolvedValue(null);
      expect(await IncidentService.assign('d', 'x', 'u')).toBeNull();
    });
  });

  describe('bulkUpdate', () => {
    it('applies the action to each id on its own and reports the failures', async () => {
      db.findIncidentById.mockImplementation(async (id: string) => {
        if (id === 'gone') return null;
        if (id === 'closed') return incident('closed');
        return incident('open', { _id: id });
      });
      const result = await IncidentService.bulkUpdate('d', ['a', 'gone', 'closed', 'b', 'a'], 'resolve', { userId: 'u1' }, { projectId: 'p1' });
      expect(result.updated).toBe(2);
      expect(result.failed.map((f) => f.id)).toEqual(['gone', 'closed']);
      expect(result.failed[0].error).toBe('Incident not found');
      expect(result.failed[1].error).toMatch(/Cannot transition/);
      expect(db.updateIncident).toHaveBeenCalledTimes(2);
      expect(db.findIncidentById).toHaveBeenCalledWith('a', 'p1');
    });

    it.each([
      ['acknowledge', 'acknowledged'],
      ['resolve', 'resolved'],
      ['close', 'closed'],
    ] as const)('maps %s to %s', async (action, status) => {
      db.findIncidentById.mockResolvedValue(incident('open'));
      await IncidentService.bulkUpdate('d', ['a'], action, { userId: 'u1' });
      expect(db.updateIncident.mock.calls[0][1]).toMatchObject({ status });
    });

    it('rejects an empty list, more than the maximum, and an unknown action', async () => {
      await expect(IncidentService.bulkUpdate('d', [], 'resolve', { userId: 'u' })).rejects.toMatchObject({ status: 400 });
      const many = Array.from({ length: MAX_BULK_INCIDENTS + 1 }, (_, i) => `i${i}`);
      await expect(IncidentService.bulkUpdate('d', many, 'resolve', { userId: 'u' })).rejects.toBeInstanceOf(AlertApiError);
      await expect(IncidentService.bulkUpdate('d', ['a'], 'explode' as never, { userId: 'u' })).rejects.toMatchObject({ code: 'invalid_action' });
      expect(MAX_BULK_INCIDENTS).toBe(100);
    });

    it('accepts exactly the maximum', async () => {
      db.findIncidentById.mockResolvedValue(null);
      const ids = Array.from({ length: MAX_BULK_INCIDENTS }, (_, i) => `i${i}`);
      const result = await IncidentService.bulkUpdate('d', ids, 'close', { userId: 'u' });
      expect(result.failed).toHaveLength(MAX_BULK_INCIDENTS);
    });
  });

  describe('reads', () => {
    it('delegates listing and counting', async () => {
      db.listIncidents.mockResolvedValue([incident('open')]);
      db.countIncidents.mockResolvedValue(4);
      db.countIncidentsByStatus.mockResolvedValue({ open: 1, acknowledged: 0, investigating: 0, resolved: 0, closed: 0 });
      expect(await IncidentService.listIncidents('d', 't', { projectId: 'p1', entityKey: 'a' })).toHaveLength(1);
      expect(db.listIncidents).toHaveBeenCalledWith('t', { projectId: 'p1', entityKey: 'a' });
      expect(await IncidentService.countIncidents('d', 't', { status: 'open' })).toBe(4);
      expect((await IncidentService.countByStatus('d', 'p1')).open).toBe(1);
      db.findIncidentById.mockResolvedValue(incident('open'));
      await IncidentService.getIncident('d', 'i1', { projectId: 'p1' });
      expect(db.findIncidentById).toHaveBeenCalledWith('i1', 'p1');
    });
  });
});
