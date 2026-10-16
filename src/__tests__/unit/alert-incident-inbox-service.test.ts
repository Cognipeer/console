import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

type LooseDb = Record<string, import('vitest').Mock>;

vi.mock('@/lib/database', () => ({ getTenantDatabase: vi.fn() }));

import { getTenantDatabase } from '@/lib/database';
import {
  IncidentService,
  MAX_SNOOZE_MS,
  computeIncidentStats,
} from '@/lib/services/alerts/incidentService';
import { bulkEligible, isSnoozed } from '@/components/alerts/incidentUi';
import type { IncidentDto } from '@/components/alerts/alertTypes';

const H = 3_600_000;
const now = new Date('2026-10-10T12:00:00.000Z');
const ago = (h: number) => new Date(now.getTime() - h * H);
const counts = { open: 3, acknowledged: 2 };
const row = (over: Record<string, unknown>) => ({ _id: Math.random().toString(36), status: 'open', firedAt: ago(1), ...over }) as never;

describe('computeIncidentStats', () => {
  const since = ago(24);

  it('uses the MEDIAN (even sample averages the middle pair) and reports sample sizes', () => {
    const stats = computeIncidentStats([
      row({ firedAt: ago(10), acknowledgedAt: ago(9), resolvedAt: ago(8) }),     // mtta 1h, mttr 2h
      row({ firedAt: ago(10), acknowledgedAt: ago(7), resolvedAt: ago(2) }),     // mtta 3h, mttr 8h
      row({ firedAt: ago(10), acknowledgedAt: ago(1) }),                         // mtta 9h
      row({ firedAt: ago(10), resolvedAt: ago(0.5) }),                           // mttr 9.5h, no ack
      row({ firedAt: ago(10), resolvedAt: ago(5) }),                             // mttr 5h
    ], counts, since);
    expect(stats.mttaMs).toBe(3 * H);
    expect(stats.mttrMs).toBe(6.5 * H); // samples 2h, 5h, 8h, 9.5h
    expect(stats).toMatchObject({ open: 3, acknowledged: 2, firedInRange: 5, resolvedInRange: 4, sample: 5, mttaSample: 3, mttrSample: 4, capped: false });
  });

  it('closed-without-resolve has no MTTR; reopened clears resolvedAt', () => {
    const stats = computeIncidentStats([
      row({ status: 'closed', firedAt: ago(5), closedAt: ago(4) }),
      row({ status: 'open', firedAt: ago(8), resolvedAt: null, reopenedAt: ago(2) }),
    ], counts, since);
    expect(stats.mttrMs).toBeNull();
    expect(stats.resolvedInRange).toBe(0);
    expect(stats.firedInRange).toBe(2);
  });

  it('an acknowledgement older than the latest reopen is stale; a fresh one after it counts', () => {
    const stats = computeIncidentStats([
      row({ firedAt: ago(10), acknowledgedAt: ago(9), reopenedAt: ago(5) }),  // stale
      row({ firedAt: ago(10), acknowledgedAt: ago(3), reopenedAt: ago(5) }),  // re-acked after the reopen: 7h
    ], counts, since);
    expect(stats.mttaSample).toBe(1);
    expect(stats.mttaMs).toBe(7 * H);
  });

  it('ignores acknowledgements before the firing or outside the range, and negative resolutions', () => {
    const stats = computeIncidentStats([
      row({ firedAt: ago(10), acknowledgedAt: ago(11) }),                       // before firing
      row({ firedAt: ago(100), acknowledgedAt: ago(99), resolvedAt: ago(98) }), // long ago
      row({ firedAt: ago(5), resolvedAt: ago(6) }),                             // clock skew: counted resolved, no duration
    ], counts, since);
    expect(stats.mttaMs).toBeNull();
    expect(stats.mttrMs).toBeNull();
    expect(stats.resolvedInRange).toBe(1);
    expect(stats.firedInRange).toBe(2);
  });

  it('works with no rows and passes the cap flag through', () => {
    expect(computeIncidentStats([], counts, since, true)).toMatchObject({ mttaMs: null, mttrMs: null, sample: 0, capped: true });
  });
});

describe('IncidentService inbox actions', () => {
  let db: LooseDb;
  const incident = (status: string, extra: Record<string, unknown> = {}) => ({ _id: 'i1', tenantId: 't', projectId: 'p1', status, notes: [], ...extra });

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb() as unknown as LooseDb;
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.updateIncident.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ _id: 'i1', ...data }));
  });

  it('stats reads the status counts and the bounded rows of the range', async () => {
    db.countIncidentsByStatus.mockResolvedValue({ open: 4, acknowledged: 1, investigating: 0, resolved: 0, closed: 0 });
    db.listIncidentStatRows.mockResolvedValue([row({ firedAt: ago(3), acknowledgedAt: ago(2) })]);
    const stats = await IncidentService.stats('d', 'p1', '24h', now);
    expect(db.listIncidentStatRows).toHaveBeenCalledWith('p1', { firedSince: ago(24), resolvedSince: ago(24), limit: 5000 });
    expect(stats).toMatchObject({ open: 4, acknowledged: 1, mttaMs: H, capped: false });
  });

  it('stats flags a read that hit the cap', async () => {
    db.listIncidentStatRows.mockResolvedValue(Array.from({ length: 5000 }, () => row({})));
    expect((await IncidentService.stats('d', 'p1', '7d', now)).capped).toBe(true);
  });

  it('snooze validates the window and the status; null always clears', async () => {
    db.findIncidentById.mockResolvedValue(incident('open'));
    const until = new Date(Date.now() + H);
    await IncidentService.snooze('d', 'i1', until, 'u1', { projectId: 'p1' });
    expect(db.updateIncident).toHaveBeenCalledWith('i1', { snoozedUntil: until, snoozedBy: 'u1' }, 'p1');

    await expect(IncidentService.snooze('d', 'i1', new Date(Date.now() - 1), 'u1')).rejects.toMatchObject({ status: 400, code: 'invalid_snooze' });
    await expect(IncidentService.snooze('d', 'i1', new Date(Date.now() + MAX_SNOOZE_MS + 60_000), 'u1')).rejects.toMatchObject({ code: 'invalid_snooze' });

    db.findIncidentById.mockResolvedValue(incident('resolved'));
    await expect(IncidentService.snooze('d', 'i1', until, 'u1')).rejects.toMatchObject({ status: 409 });
    db.updateIncident.mockClear();
    await IncidentService.snooze('d', 'i1', null, 'u1');
    expect(db.updateIncident).toHaveBeenCalledWith('i1', { snoozedUntil: null, snoozedBy: null }, undefined);

    db.findIncidentById.mockResolvedValue(null);
    expect(await IncidentService.snooze('d', 'gone', until, 'u1')).toBeNull();
  });

  it('resolve and close clear the snooze; autoResolve too', async () => {
    for (const status of ['resolved', 'closed'] as const) {
      db.findIncidentById.mockResolvedValue(incident('open', { snoozedUntil: new Date() }));
      await IncidentService.updateStatus('d', 'i1', status, 'u1');
      expect(db.updateIncident.mock.calls.at(-1)?.[1]).toMatchObject({ snoozedUntil: null, snoozedBy: null });
    }
    db.findIncidentById.mockResolvedValue(incident('open', { snoozedUntil: new Date() }));
    await IncidentService.autoResolve('d', 'i1', 'recovered');
    expect(db.updateIncident.mock.calls.at(-1)?.[1]).toMatchObject({ snoozedUntil: null, snoozedBy: null, status: 'resolved' });
  });

  it('updateStatus open increments reopenCount from the stored value', async () => {
    db.findIncidentById.mockResolvedValue(incident('closed', { reopenCount: 4 }));
    await IncidentService.updateStatus('d', 'i1', 'open', 'u1');
    expect(db.updateIncident.mock.calls[0][1]).toMatchObject({ status: 'open', reopenCount: 5, reopenedAt: expect.any(Date) });
  });

  it.each([['acknowledged', true], ['investigating', true], ['resolved', true], ['closed', true], ['open', false]] as const)(
    'reopen from %s -> allowed %s', async (from, allowed) => {
      db.findIncidentById.mockResolvedValue(incident(from));
      if (allowed) {
        await IncidentService.reopen('d', 'i1');
        expect(db.updateIncident.mock.calls[0][1]).toMatchObject({ status: 'open', resolvedAt: null, closedAt: null, reopenCount: 1 });
      } else {
        await expect(IncidentService.reopen('d', 'i1')).rejects.toMatchObject({ status: 409, code: 'invalid_transition' });
      }
    });

  it('bulk assign validates the user once, supports null, and reports per-row results', async () => {
    db.findUserById.mockResolvedValue({ _id: 'u9' });
    db.findIncidentById.mockImplementation(async (id: string) => (id === 'gone' ? null : incident('open', { _id: id })));
    const res = await IncidentService.bulkUpdate('d', ['a', 'gone'], 'assign', { userId: 'u1' }, {}, { assignedTo: 'u9' });
    expect(db.findUserById).toHaveBeenCalledTimes(1);
    expect(res.updated).toBe(1);
    expect(res.results).toEqual([{ id: 'a', ok: true }, { id: 'gone', ok: false, error: 'Incident not found' }]);
    expect(db.updateIncident).toHaveBeenCalledWith('a', { assignedTo: 'u9' }, undefined);

    db.findUserById.mockClear();
    await IncidentService.bulkUpdate('d', ['a'], 'assign', { userId: 'u1' }, {}, { assignedTo: null });
    expect(db.findUserById).not.toHaveBeenCalled();

    db.findUserById.mockResolvedValue(null);
    await expect(IncidentService.bulkUpdate('d', ['a'], 'assign', { userId: 'u1' }, {}, { assignedTo: 'stranger' })).rejects.toMatchObject({ code: 'invalid_assignee' });
    await expect(IncidentService.bulkUpdate('d', ['a'], 'assign', { userId: 'u1' })).rejects.toMatchObject({ code: 'invalid_assignee' });
  });

  it('bulk snooze needs a valid `until`; a status mismatch lands in failed', async () => {
    await expect(IncidentService.bulkUpdate('d', ['a'], 'snooze', { userId: 'u' })).rejects.toMatchObject({ code: 'invalid_snooze' });
    await expect(IncidentService.bulkUpdate('d', ['a'], 'snooze', { userId: 'u' }, {}, { until: new Date(Date.now() + MAX_SNOOZE_MS + 60_000) })).rejects.toMatchObject({ code: 'invalid_snooze' });
    db.findIncidentById.mockResolvedValue(incident('closed'));
    const res = await IncidentService.bulkUpdate('d', ['a'], 'snooze', { userId: 'u' }, {}, { until: new Date(Date.now() + H) });
    expect(res.updated).toBe(0);
    expect(res.failed[0].id).toBe('a');
  });

  it('similar excludes itself and other entities, counts, takes the median duration and the 5 newest', async () => {
    const mk = (id: string, agoH: number, resolvedAfterH?: number, entityKey = 'E') => ({
      _id: id, status: resolvedAfterH ? 'resolved' : 'open', entityKey,
      firedAt: ago(agoH), ...(resolvedAfterH ? { resolvedAt: new Date(ago(agoH).getTime() + resolvedAfterH * H) } : {}),
    });
    db.listIncidents.mockResolvedValue([
      mk('self', 0.1), mk('a', 1, 2), mk('b', 2, 6), mk('c', 3), mk('d', 4), mk('e', 5), mk('f', 6), mk('x', 7, 1, 'other'),
    ]);
    const res = await IncidentService.similar('d', 't', { _id: 'self', projectId: 'p1', ruleId: 'r1', entityKey: 'E' } as never, now);
    expect(db.listIncidents).toHaveBeenCalledWith('t', expect.objectContaining({ projectId: 'p1', ruleId: 'r1', entityKey: 'E', excludeId: 'self', sort: '-firedAt', firedAfter: ago(24 * 30) }));
    expect(res.count30d).toBe(6);
    expect(res.medianDurationMs).toBe(4 * H);
    expect(res.last.map((l) => l.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(res.last[2].resolvedAt).toBeNull();
  });
});

describe('client eligibility mirror', () => {
  const dto = (status: IncidentDto['status'], extra: Partial<IncidentDto> = {}) => ({ _id: status + (extra.snoozedUntil ?? ''), status, ...extra }) as IncidentDto;
  const future = new Date(Date.now() + H).toISOString();
  const past = new Date(Date.now() - H).toISOString();

  it('mirrors the server rules for assign / snooze / unsnooze / reopen', () => {
    const all = (['open', 'acknowledged', 'investigating', 'resolved', 'closed'] as const).map((s) => dto(s));
    expect(bulkEligible(all, 'assign')).toHaveLength(5);
    expect(bulkEligible(all, 'snooze').map((i) => i.status)).toEqual(['open', 'acknowledged', 'investigating']);
    expect(bulkEligible(all, 'reopen').map((i) => i.status)).toEqual(['acknowledged', 'investigating', 'resolved', 'closed']);
    const snoozed = [dto('open', { snoozedUntil: future }), dto('open', { snoozedUntil: past }), dto('open')];
    expect(bulkEligible(snoozed, 'unsnooze')).toHaveLength(1);
    expect(isSnoozed(dto('open', { snoozedUntil: future }))).toBe(true);
    expect(isSnoozed(dto('open', { snoozedUntil: 'garbage' }))).toBe(false);
  });
});
