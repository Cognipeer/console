/**
 * The rule's project reaches the email channel: from a rule that fires, resolves or is tested, through the real
 * evaluator, `dispatchNotification` and `EmailAlertChannel`, to the mailboxes of the project's admins. Only the edges
 * are replaced (database, mailer, metric collection, webhooks); the unit tests of the channel itself cannot catch a
 * context that arrives without `projectId`, which would silently send every `project_admins` notification to the
 * owner/admin fallback instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const h = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: h.sendEmail }));
vi.mock('@/lib/services/alerts/metrics', () => ({
  collectMetric: vi.fn(),
}));
vi.mock('@/lib/services/webhooks/webhookService', () => ({
  publishWebhookEvent: vi.fn().mockResolvedValue({ eventId: null, deliveries: 0 }),
}));
vi.mock('@/lib/license/tenantLicense', () => ({
  isTenantEnterpriseLicensed: vi.fn().mockResolvedValue(false),
}));

import { getDatabase, getTenantDatabase } from '@/lib/database';
import { __resetEvaluatorCachesForTests, evaluateTenantAlerts } from '@/lib/services/alerts/alertEvaluator';
import { AlertService } from '@/lib/services/alerts/alertService';
import { resetAlertEmailUserCache } from '@/lib/services/alerts/channels/emailChannel';
import { collectMetric } from '@/lib/services/alerts/metrics';
import type { IAlertChannel, IAlertRule } from '@/lib/database';

const ctx = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', tenantSlug: 'acme', companyName: 'Acme Corp' };
const T0 = Date.UTC(2026, 9, 15, 12, 2, 30);
const MIN = 60_000;

const email = (id: string) => `${id}@acme.test`;
const person = (id: string, over: Row = {}): Row => ({ _id: id, email: email(id), role: 'user', ...over });
const admin = (userId: string, projectId: string): Row => ({ userId, projectId, role: 'project_admin' });

const USERS = [
  person('owner', { role: 'owner' }),
  person('admin', { role: 'admin' }),
  person('pat'), // administers proj-1
  person('quinn'), // administers proj-2
  person('plain'),
];
const MEMBERSHIPS = [admin('pat', 'proj-1'), admin('quinn', 'proj-2'), { userId: 'plain', projectId: 'proj-1', role: 'member' }];

const projectAdminChannel: Extract<IAlertChannel, { type: 'email' }> = {
  id: 'ch_000000000001',
  type: 'email',
  recipients: [],
  audience: 'project_admins',
};

function ruleOf(projectId: string, over: Partial<IAlertRule> = {}): IAlertRule {
  return {
    _id: `rule-${projectId}`,
    tenantId: 'tenant-1',
    projectId,
    name: `Errors in ${projectId}`,
    module: 'models',
    metric: 'error_rate',
    condition: { operator: 'gt', threshold: 5 },
    windowMinutes: 15,
    cooldownMinutes: 0,
    enabled: true,
    channels: [projectAdminChannel],
    createdBy: 'user-1',
    ...over,
  };
}

let db: LooseDb;
let rules: IAlertRule[];

/** A db with the evaluator's writes kept in memory, the users and memberships of this file, and the rules above. */
function arrange(): void {
  db = createMockDb() as unknown as LooseDb;
  (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);

  const states = new Map<string, Row>();
  const events: Row[] = [];
  const incidents = new Map<string, Row>();
  db.listUsers.mockResolvedValue(USERS);
  db.listUserProjectsByProject.mockImplementation(async (projectId: string) => MEMBERSHIPS.filter((row) => row.projectId === projectId));
  db.listAlertRules.mockImplementation(async () => rules);
  db.findAlertRuleById.mockImplementation(async (id: string) => rules.find((rule) => String(rule._id) === id) ?? null);
  db.findProjectById.mockImplementation(async (id: string) => ({ _id: id, name: `Project ${id}`, key: id, tenantId: 'tenant-1', createdBy: 'user-1' }));
  db.findTenantById.mockResolvedValue({ companyName: 'Acme Corp' });
  db.listAlertStates.mockImplementation(async (filter: { ruleId?: string }) =>
    [...states.values()].filter((state) => !filter.ruleId || state.ruleId === filter.ruleId));
  db.upsertAlertState.mockImplementation(async (state: Row) => {
    const stored = { ...state, _id: `${state.ruleId}|${state.entityKey}` };
    states.set(String(stored._id), stored);
    return stored;
  });
  db.deleteAlertStates.mockResolvedValue(0);
  db.createAlertEvent.mockImplementation(async (event: Row) => {
    const stored = { ...event, _id: `event-${events.length + 1}` };
    events.push(stored);
    return stored;
  });
  db.updateAlertEvent.mockImplementation(async (id: string, data: Row) => {
    const event = events.find((e) => e._id === id);
    return event ? Object.assign(event, data) : null;
  });
  db.createIncident.mockImplementation(async (incident: Row) => {
    const stored = { ...incident, _id: `incident-${incidents.size + 1}` };
    incidents.set(String(stored._id), stored);
    return stored;
  });
  db.findIncidentById.mockImplementation(async (id: string) => incidents.get(id) ?? null);
  db.updateIncident.mockImplementation(async (id: string, data: Row) => {
    const incident = incidents.get(id);
    return incident ? Object.assign(incident, data) : null;
  });
  db.updateAlertRule.mockResolvedValue(null);
}

/** Who was mailed, by template: [template, address] pairs in the order they were sent. */
const mailed = () => h.sendEmail.mock.calls.map((call) => [call[1], call[0]] as [string, string]);
const addresses = (template: string) => mailed().filter(([name]) => name === template).map(([, to]) => to).sort();

async function tick(minutesLater = 0): Promise<number> {
  vi.setSystemTime(T0 + minutesLater * MIN);
  return evaluateTenantAlerts(ctx);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  __resetEvaluatorCachesForTests();
  resetAlertEmailUserCache();
  h.sendEmail.mockResolvedValue(true);
  (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 10, sampleCount: 5 });
  rules = [ruleOf('proj-1')];
  arrange();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a rule that fires', () => {
  it('mails the admins of its project, and not the workspace owners and admins', async () => {
    expect(await tick()).toBe(1);

    expect(mailed()).toEqual([['alert-fired', email('pat')]]);
    expect(h.sendEmail.mock.calls[0][2]).toMatchObject({ projectName: 'Project proj-1', companyName: 'Acme Corp' });
  });

  it('mails each rule\'s own project admins when rules of several projects fire together', async () => {
    rules = [ruleOf('proj-1'), ruleOf('proj-2')];
    expect(await tick()).toBe(2);

    const sent = mailed();
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(expect.arrayContaining([['alert-fired', email('pat')], ['alert-fired', email('quinn')]]));
    // the project name of each mail is its own project's
    const byAddress = Object.fromEntries(h.sendEmail.mock.calls.map((call) => [call[0], call[2].projectName]));
    expect(byAddress).toEqual({ [email('pat')]: 'Project proj-1', [email('quinn')]: 'Project proj-2' });
  });

  it('falls back to the workspace owners and admins when its project has no admin', async () => {
    rules = [ruleOf('proj-3')];
    expect(await tick()).toBe(1);
    expect(addresses('alert-fired')).toEqual([email('admin'), email('owner')]);
  });

  it('adds the listed recipients to the project admins', async () => {
    rules = [ruleOf('proj-1', { channels: [{ ...projectAdminChannel, recipients: ['oncall@acme.test', 'PAT@acme.test'] }] })];
    await tick();
    // a listed address that is also an admin is mailed once, whatever its case
    expect(addresses('alert-fired')).toEqual(['PAT@acme.test', 'oncall@acme.test'].sort());
  });

  it('keeps mailing only the listed recipients for a channel without the audience', async () => {
    rules = [ruleOf('proj-1', { channels: [{ id: 'ch_000000000002', type: 'email', recipients: ['oncall@acme.test'] }] })];
    await tick();
    expect(mailed()).toEqual([['alert-fired', 'oncall@acme.test']]);
  });

  it('records the delivery against the admins it reached', async () => {
    await tick();
    const event = db.createAlertEvent.mock.results[0];
    expect(event).toBeDefined();
    const updates = db.updateAlertEvent.mock.calls.map((call) => call[1]);
    const channels = updates.flatMap((data) => (data.channels ?? []) as Row[]);
    expect(channels).toEqual([expect.objectContaining({ type: 'email', target: email('pat'), success: true })]);
  });
});

describe('a rule that resolves', () => {
  it('mails the same project admins with the recovery', async () => {
    await tick();
    h.sendEmail.mockClear();

    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 1, sampleCount: 5 });
    await tick(15);
    await tick(30);

    expect(addresses('alert-resolved')).toEqual([email('pat')]);
    expect(addresses('alert-fired')).toEqual([]);
  });
});

describe('a test notification', () => {
  const session = { tenantId: 'tenant-1', tenantSlug: 'acme' };
  const scope = { projectId: 'proj-1', projectName: 'Project proj-1' };

  it('on an unsaved project_admins channel goes to the admins of the project it is sent from', async () => {
    const result = await AlertService.testChannel('tenant_acme', session, scope, { channel: { type: 'email', recipients: [], audience: 'project_admins' } });

    // the person who tests sees how many were mailed, not their addresses
    expect(result).toMatchObject({ type: 'email', target: '1 recipient', success: true });
    expect(mailed()).toEqual([['alert-fired', email('pat')]]);
  });

  it('is sent from another project to that project\'s admins', async () => {
    await AlertService.testChannel('tenant_acme', session, { projectId: 'proj-2', projectName: 'Project proj-2' }, { channel: { type: 'email', recipients: [], audience: 'project_admins' } });
    expect(mailed()).toEqual([['alert-fired', email('quinn')]]);
  });

  it('on a stored channel of a rule reaches the admins of the rule\'s project', async () => {
    rules = [ruleOf('proj-1')];
    await AlertService.testChannel('tenant_acme', session, { ...scope, ruleScopeProjectId: 'proj-1' }, { ruleId: 'rule-proj-1', channelId: 'ch_000000000001' });
    expect(mailed()).toEqual([['alert-fired', email('pat')]]);
  });

  it('on a stored channel of a rule of another project reaches that project\'s admins, not the caller\'s, and names that project', async () => {
    // a workspace owner testing from proj-1 a rule that lives in proj-2 (no project scope on the rule lookup)
    rules = [ruleOf('proj-2')];
    const result = await AlertService.testChannel('tenant_acme', session, scope, { ruleId: 'rule-proj-2', channelId: 'ch_000000000001' });
    expect(result).toMatchObject({ success: true, target: '1 recipient' });
    expect(mailed()).toEqual([['alert-fired', email('quinn')]]);
    expect(h.sendEmail.mock.calls[0][2]).toMatchObject({ projectName: 'Project proj-2' });
  });

  it('falls back to the caller\'s project name when the rule\'s project cannot be read', async () => {
    rules = [ruleOf('proj-2')];
    db.findProjectById.mockRejectedValue(new Error('db down'));
    await AlertService.testChannel('tenant_acme', session, scope, { ruleId: 'rule-proj-2', channelId: 'ch_000000000001' });
    expect(mailed()).toEqual([['alert-fired', email('quinn')]]);
    expect(h.sendEmail.mock.calls[0][2]).toMatchObject({ projectName: 'Project proj-1' });
  });

  it('only the stored-channel branch follows the rule: a typed channel keeps the caller\'s project', async () => {
    rules = [ruleOf('proj-2')];
    await AlertService.testChannel('tenant_acme', session, scope, { channel: { type: 'email', recipients: [], audience: 'project_admins' } });
    expect(mailed()).toEqual([['alert-fired', email('pat')]]);
  });

  it('falls back to the owners and admins in a project without admins', async () => {
    await AlertService.testChannel('tenant_acme', session, { projectId: 'proj-3', projectName: 'Project proj-3' }, { channel: { type: 'email', recipients: [], audience: 'project_admins' } });
    expect(addresses('alert-fired')).toEqual([email('admin'), email('owner')]);
  });
});
