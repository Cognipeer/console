/**
 * What deleting a project does to its alerts: `AlertService.removeProjectAlerts` removes every rule of the project
 * (and retires their states) and closes the incidents someone still had to act on; `removeDeletedProjectAlerts`
 * is the best-effort wrapper the project routes call after the delete. Runs the real alert and incident services
 * over an in-memory incident table behind the mock database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const h = vi.hoisted(() => ({
  logLines: [] as Array<{ level: string; message: string; meta: unknown }>,
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));
vi.mock('@/lib/services/alerts/channels', () => ({
  dispatchNotification: vi.fn(),
}));
vi.mock('@/lib/services/alerts/alertEvaluator', () => ({
  evaluateRuleTargets: vi.fn(),
}));
vi.mock('@/lib/services/entityMetrics/entityHealthService', () => ({
  listActiveEntityKeys: vi.fn(),
}));
vi.mock('@/lib/core/logger', () => {
  const write = (level: string) => (message: string, meta?: unknown) => { h.logLines.push({ level, message, meta }); };
  const logger = { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
  return { createLogger: () => logger };
});

import { getDatabase, getTenantDatabase } from '@/lib/database';
import { AlertService, removeDeletedProjectAlerts } from '@/lib/services/alerts/alertService';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const OTHER_PROJECT_ID = 'proj-2';
const NOTE = 'Closed: the project was deleted';

let db: LooseDb;
let listCalls = 0;

function rule(id: string, over: Row = {}): Row {
  return { _id: id, tenantId: TENANT_ID, projectId: PROJECT_ID, name: `Rule ${id}`, enabled: true, ...over };
}

function incident(id: string, status: string, over: Row = {}): Row {
  return { _id: id, tenantId: TENANT_ID, projectId: PROJECT_ID, status, notes: [], ...over };
}

/** Rules in a table the mock db reads and deletes from, like the real store would. */
function useRules(rules: Row[]): Row[] {
  db.listAlertRules.mockImplementation(async (_tenantId: string, filter?: { projectId?: string }) =>
    rules.filter((r) => filter?.projectId === undefined || r.projectId === filter.projectId).map((r) => ({ ...r })));
  db.deleteAlertRule.mockImplementation(async (id: string, projectId?: string) => {
    const index = rules.findIndex((r) => r._id === id && (projectId === undefined || r.projectId === projectId));
    if (index < 0) return false;
    rules.splice(index, 1);
    return true;
  });
  return rules;
}

/** Incidents in a table with the semantics the services rely on: lists by status and project, find/update by id. */
function useIncidents(incidents: Row[]): Row[] {
  const inScope = (row: Row, projectId?: string) => projectId === undefined || row.projectId === projectId;
  db.listIncidents.mockImplementation(async (_tenantId: string, options: { projectId?: string; status?: string; limit?: number } = {}) => {
    listCalls += 1;
    if (listCalls > 200) throw new Error('runaway loop: the incident list is read again and again');
    return incidents
      .filter((row) => inScope(row, options.projectId) && (!options.status || row.status === options.status))
      .slice(0, options.limit ?? 50)
      .map((row) => ({ ...row }));
  });
  db.findIncidentById.mockImplementation(async (id: string, projectId?: string) => {
    const found = incidents.find((row) => row._id === id && inScope(row, projectId));
    return found ? { ...found, notes: [...found.notes] } : null;
  });
  db.updateIncident.mockImplementation(async (id: string, data: Row, projectId?: string) => {
    const found = incidents.find((row) => row._id === id && inScope(row, projectId));
    if (!found) return null;
    Object.assign(found, data);
    return { ...found };
  });
  return incidents;
}

const statusOf = (incidents: Row[], id: string) => incidents.find((row) => row._id === id)?.status;
const notesOf = (incidents: Row[], id: string): string[] =>
  (incidents.find((row) => row._id === id)?.notes ?? []).map((note: { content: string }) => note.content);

beforeEach(() => {
  vi.clearAllMocks();
  h.logLines.length = 0;
  listCalls = 0;
  db = createMockDb() as unknown as LooseDb;
  (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  useRules([]);
  useIncidents([]);
});

describe('AlertService.removeProjectAlerts: the rules', () => {
  it('deletes every rule of the project, scoped to it, and retires their states', async () => {
    const rules = useRules([rule('r1'), rule('r2', { enabled: false }), rule('r3'), rule('r-other', { projectId: OTHER_PROJECT_ID })]);

    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);

    expect(result).toEqual({ rulesDeleted: 3, incidentsClosed: 0 });
    expect(db.listAlertRules).toHaveBeenCalledWith(TENANT_ID, { projectId: PROJECT_ID });
    expect(db.deleteAlertRule.mock.calls).toEqual([['r1', PROJECT_ID], ['r2', PROJECT_ID], ['r3', PROJECT_ID]]);
    expect(db.deleteAlertStates.mock.calls).toEqual([[{ ruleId: 'r1' }], [{ ruleId: 'r2' }], [{ ruleId: 'r3' }]]);
    // a deleted rule is not edited on the way out
    expect(db.updateAlertRule).not.toHaveBeenCalled();
    // the rule of another project stays
    expect(rules.map((r) => r._id)).toEqual(['r-other']);
  });

  it('does nothing to a project without rules or incidents', async () => {
    expect(await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID)).toEqual({ rulesDeleted: 0, incidentsClosed: 0 });
    expect(db.deleteAlertRule).not.toHaveBeenCalled();
    expect(db.deleteAlertStates).not.toHaveBeenCalled();
    expect(db.updateIncident).not.toHaveBeenCalled();
  });

  it('counts only the rules it really deleted and leaves the states of one that was already gone', async () => {
    useRules([rule('r1'), rule('r2')]);
    db.deleteAlertRule.mockImplementation(async (id: string) => id !== 'r1');
    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(result.rulesDeleted).toBe(1);
    expect(db.deleteAlertStates.mock.calls).toEqual([[{ ruleId: 'r2' }]]);
  });

  it('notes the incident a firing state pointed at before the rule goes', async () => {
    useRules([rule('r1')]);
    const incidents = useIncidents([incident('inc-1', 'open')]);
    db.listAlertStates.mockResolvedValue([{ ruleId: 'r1', entityKey: 'a', phase: 'firing', incidentId: 'inc-1' }]);
    await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(db.listAlertStates).toHaveBeenCalledWith({ ruleId: 'r1', phases: ['firing'], limit: 5000 });
    // 'Rule deleted' while the rule is retired, then the closing note
    expect(notesOf(incidents, 'inc-1')).toEqual(['Rule deleted', NOTE]);
  });

  it('deletes the rules before it closes the incidents, so nothing evaluates in between', async () => {
    useRules([rule('r1'), rule('r2')]);
    useIncidents([incident('inc-1', 'open')]);
    await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    const lastDelete = Math.max(...db.deleteAlertRule.mock.invocationCallOrder);
    const firstClose = Math.min(...db.updateIncident.mock.invocationCallOrder);
    expect(lastDelete).toBeLessThan(firstClose);
  });
});

describe('AlertService.removeProjectAlerts: the incidents', () => {
  it('closes the incidents that are open, acknowledged or investigating, with a system note', async () => {
    const incidents = useIncidents([
      incident('open-1', 'open'),
      incident('open-2', 'open', { snoozedUntil: new Date(Date.now() + 3_600_000), snoozedBy: 'user-1' }),
      incident('ack-1', 'acknowledged'),
      incident('inv-1', 'investigating'),
    ]);

    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);

    expect(result).toEqual({ rulesDeleted: 0, incidentsClosed: 4 });
    for (const id of ['open-1', 'open-2', 'ack-1', 'inv-1']) {
      expect(statusOf(incidents, id)).toBe('closed');
      expect(notesOf(incidents, id)).toEqual([NOTE]);
    }
    const closed = incidents.find((row) => row._id === 'open-2')!;
    expect(closed.closedAt).toBeInstanceOf(Date);
    // a closed incident is no longer snoozed
    expect(closed.snoozedUntil).toBeNull();
    expect(closed.snoozedBy).toBeNull();
    // the note is the system's
    expect(closed.notes[0]).toMatchObject({ userId: 'system', userName: 'System', content: NOTE });
  });

  it('reads and closes inside the project only', async () => {
    useIncidents([incident('mine', 'open')]);
    await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(db.listIncidents.mock.calls.every((call) =>
      call[0] === TENANT_ID && call[1].projectId === PROJECT_ID && call[1].limit === 200)).toBe(true);
    expect(db.findIncidentById).toHaveBeenCalledWith('mine', PROJECT_ID);
    expect(db.updateIncident).toHaveBeenCalledWith(
      'mine',
      { status: 'closed', closedAt: expect.any(Date), snoozedUntil: null, snoozedBy: null },
      PROJECT_ID,
    );
  });

  it('leaves resolved and closed incidents, and every incident of another project, alone', async () => {
    const closedAt = new Date('2026-09-01T10:00:00Z');
    const incidents = useIncidents([
      incident('resolved-1', 'resolved', { notes: [{ content: 'fixed' }] }),
      incident('closed-1', 'closed', { closedAt }),
      incident('other-open', 'open', { projectId: OTHER_PROJECT_ID }),
      incident('other-ack', 'acknowledged', { projectId: OTHER_PROJECT_ID }),
      incident('mine', 'open'),
    ]);

    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);

    expect(result.incidentsClosed).toBe(1);
    expect(statusOf(incidents, 'mine')).toBe('closed');
    expect(statusOf(incidents, 'resolved-1')).toBe('resolved');
    expect(notesOf(incidents, 'resolved-1')).toEqual(['fixed']);
    expect(statusOf(incidents, 'closed-1')).toBe('closed');
    expect(incidents.find((row) => row._id === 'closed-1')!.closedAt).toBe(closedAt);
    expect(statusOf(incidents, 'other-open')).toBe('open');
    expect(statusOf(incidents, 'other-ack')).toBe('acknowledged');
    expect(db.updateIncident.mock.calls.map((call) => call[0])).not.toContain('resolved-1');
  });

  it('asks for the three actionable statuses only, never for resolved or closed', async () => {
    useIncidents([incident('a', 'open')]);
    await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    const statuses = db.listIncidents.mock.calls.map((call) => call[1].status);
    expect(new Set(statuses)).toEqual(new Set(['open', 'acknowledged', 'investigating']));
    expect(statuses[0]).toBe('open');
  });

  it('closes more than one page: it reads the first page again until nothing is left', async () => {
    const incidents = useIncidents(Array.from({ length: 450 }, (_, i) => incident(`open-${i}`, 'open')));
    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(result.incidentsClosed).toBe(450);
    expect(incidents.every((row) => row.status === 'closed')).toBe(true);
    // pages of 200, 200 and 50, then the empty one that ends the status
    const openReads = db.listIncidents.mock.calls.filter((call) => call[1].status === 'open');
    expect(openReads).toHaveLength(4);
    expect(openReads.every((call) => call[1].limit === 200)).toBe(true);
  });

  it('closes the incidents of every status of one project, page after page', async () => {
    const incidents = useIncidents([
      ...Array.from({ length: 210 }, (_, i) => incident(`open-${i}`, 'open')),
      ...Array.from({ length: 205 }, (_, i) => incident(`ack-${i}`, 'acknowledged')),
      ...Array.from({ length: 3 }, (_, i) => incident(`inv-${i}`, 'investigating')),
    ]);
    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(result.incidentsClosed).toBe(418);
    expect(incidents.every((row) => row.status === 'closed')).toBe(true);
  });

  it('stops at once when a page makes no progress, instead of reading it forever', async () => {
    // listed, but gone when it is closed (deleted, or moved to another project, in the meantime)
    const incidents = useIncidents([incident('ghost-1', 'open'), incident('ghost-2', 'open')]);
    db.findIncidentById.mockResolvedValue(null);

    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);

    expect(result.incidentsClosed).toBe(0);
    // one read per status, none repeated
    expect(db.listIncidents.mock.calls.map((call) => call[1].status)).toEqual(['open', 'acknowledged', 'investigating']);
    expect(db.updateIncident).not.toHaveBeenCalled();
    expect(statusOf(incidents, 'ghost-1')).toBe('open');
  });

  it('closes what it can, then stops when only incidents it cannot close are left', async () => {
    const incidents = useIncidents([incident('ok', 'open'), incident('stuck', 'open')]);
    const find = db.findIncidentById.getMockImplementation()!;
    db.findIncidentById.mockImplementation(async (id: string, projectId?: string) => (id === 'stuck' ? null : find(id, projectId)));

    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);

    expect(result.incidentsClosed).toBe(1);
    expect(statusOf(incidents, 'ok')).toBe('closed');
    expect(statusOf(incidents, 'stuck')).toBe('open');
    // the first read progressed, the second saw only the stuck one and ended the status
    expect(db.listIncidents.mock.calls.filter((call) => call[1].status === 'open')).toHaveLength(2);
  });

  it('counts an incident as closed even when its note cannot be saved, and goes on', async () => {
    const incidents = useIncidents([incident('a', 'open'), incident('b', 'open')]);
    const update = db.updateIncident.getMockImplementation()!;
    db.updateIncident.mockImplementation(async (id: string, data: Row, projectId?: string) => {
      if (id === 'a' && data.notes) throw new Error('note write failed');
      return update(id, data, projectId);
    });

    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);

    expect(result.incidentsClosed).toBe(2);
    expect(statusOf(incidents, 'a')).toBe('closed');
    expect(statusOf(incidents, 'b')).toBe('closed');
    expect(notesOf(incidents, 'a')).toEqual([]);
    expect(notesOf(incidents, 'b')).toEqual([NOTE]);
  });

  it('never closes more than 5000 incidents of one project in a run', async () => {
    const incidents = useIncidents([
      ...Array.from({ length: 5_200 }, (_, i) => incident(`open-${i}`, 'open')),
      incident('ack-1', 'acknowledged'),
    ]);
    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(result.incidentsClosed).toBe(5_000);
    expect(incidents.filter((row) => row.status === 'open')).toHaveLength(200);
    // the budget is spent: the other statuses are not read
    expect(statusOf(incidents, 'ack-1')).toBe('acknowledged');
    expect(db.listIncidents.mock.calls.every((call) => call[1].status === 'open')).toBe(true);
  });

  // KNOWN GAP (low severity): `IncidentService.updateStatus` throws a 409 for closed -> closed, so an incident that
  // somebody else closed between the list read and the update aborts the whole cleanup; the incidents behind it
  // stay open in a project that no longer exists. The cleanup should skip such an incident and carry on.
  it('skips an incident somebody else closed in the meantime and closes the rest', async () => {
    const incidents = useIncidents([incident('raced', 'open'), incident('later', 'open')]);
    const find = db.findIncidentById.getMockImplementation()!;
    db.findIncidentById.mockImplementation(async (id: string, projectId?: string) => {
      const row = await find(id, projectId);
      // the list page still said "open"; by the time it is read for the update it is closed
      return id === 'raced' && row ? { ...row, status: 'closed' } : row;
    });

    const result = await AlertService.removeProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);

    expect(result.incidentsClosed).toBe(1);
    expect(statusOf(incidents, 'later')).toBe('closed');
  });
});

describe('removeDeletedProjectAlerts', () => {
  it('removes the rules and closes the incidents of the deleted project', async () => {
    const rules = useRules([rule('r1'), rule('r2')]);
    const incidents = useIncidents([incident('open-1', 'open'), incident('ack-1', 'acknowledged')]);

    await expect(removeDeletedProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID)).resolves.toBeUndefined();

    expect(rules).toEqual([]);
    expect(incidents.map((row) => row.status)).toEqual(['closed', 'closed']);
    expect(h.logLines.filter((line) => line.level === 'error')).toEqual([]);
  });

  it.each([
    ['the database cannot be opened', () => (getTenantDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'))],
    ['the rules cannot be read', () => db.listAlertRules.mockRejectedValue(new Error('db down'))],
    ['a rule cannot be deleted', () => { useRules([rule('r1')]); db.deleteAlertRule.mockRejectedValue(new Error('db down')); }],
    ['the incidents cannot be read', () => db.listIncidents.mockRejectedValue(new Error('db down'))],
  ])('does not throw when %s, it logs it with the project and the message', async (_label, breakIt) => {
    breakIt();
    await expect(removeDeletedProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID)).resolves.toBeUndefined();
    expect(h.logLines.filter((line) => line.level === 'error')).toEqual([
      { level: 'error', message: 'Removing the alerts of a deleted project failed', meta: { projectId: PROJECT_ID, error: 'db down' } },
    ]);
  });

  it('logs a failure that is not an Error by its text', async () => {
    db.listAlertRules.mockRejectedValue('plain failure');
    await removeDeletedProjectAlerts(DB_NAME, TENANT_ID, PROJECT_ID);
    expect(h.logLines.find((line) => line.level === 'error')?.meta).toEqual({ projectId: PROJECT_ID, error: 'plain failure' });
  });
});
