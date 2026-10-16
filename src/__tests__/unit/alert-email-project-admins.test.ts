/**
 * The `project_admins` audience of an email alert channel, resolved when the mail is sent: who counts as a
 * project admin (direct membership, an admin group grant, a legacy project admin), who never does, how it is
 * combined with the listed recipients and the owner/admin fallback, and the short-lived cache that keeps a
 * burst of notifications from re-reading the memberships.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const db = {
    listUsers: vi.fn(),
    listUserProjectsByProject: vi.fn(),
    listGroupProjectsByProject: vi.fn(),
    listGroupMembers: vi.fn(),
  };
  return {
    db,
    /** The instant from which a workspace's project levels are enforced (see `iam/projectLevels`). */
    since: vi.fn(async () => 1_000_000),
    getTenantDatabase: vi.fn(async () => db),
    sendEmail: vi.fn(),
    logLines: [] as Array<{ level: string; message: string; meta: unknown }>,
  };
});

vi.mock('@/lib/email/mailer', () => ({ sendEmail: h.sendEmail }));
vi.mock('@/lib/database', () => ({ getTenantDatabase: h.getTenantDatabase }));
vi.mock('@/lib/iam/projectLevels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/iam/projectLevels')>()),
  getProjectLevelsSince: h.since,
}));
vi.mock('@/lib/core/logger', () => {
  const write = (level: string) => (message: string, meta?: unknown) => { h.logLines.push({ level, message, meta }); };
  const logger = { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
  return { createLogger: () => logger };
});

import {
  EmailAlertChannel,
  MAX_TEST_EMAIL_RECIPIENTS,
  resetAlertEmailUserCache,
  resolveAlertEmailRecipients,
  resolveProjectAdminRecipients,
} from '@/lib/services/alerts/channels/emailChannel';
import type { AlertEmailAudienceOptions } from '@/lib/services/alerts/channels/emailChannel';

const DB = 'tenant_acme';
const PROJECT = 'proj-1';
const OTHER_PROJECT = 'proj-2';

type Row = Record<string, unknown>;

const email = (id: string) => `${id}@acme.test`;
const person = (id: string, over: Row = {}): Row => ({ _id: id, email: email(id), role: 'user', ...over });
const membership = (userId: string, over: Row = {}): Row => ({ userId, projectId: PROJECT, role: 'project_admin', ...over });
const grant = (groupId: string, over: Row = {}): Row => ({ groupId, projectId: PROJECT, role: 'project_admin', ...over });

interface World {
  users?: Row[];
  /** `IUserProject` rows, of any project: the store answers per project like the real one. */
  rows?: Row[];
  /** `IGroupProject` rows. */
  grants?: Row[];
  /** Group id to its `IGroupMember` rows. */
  members?: Record<string, Row[]>;
}

function seed(world: World): void {
  h.db.listUsers.mockResolvedValue(world.users ?? []);
  h.db.listUserProjectsByProject.mockImplementation(async (projectId: string) =>
    (world.rows ?? []).filter((row) => row.projectId === projectId));
  h.db.listGroupProjectsByProject.mockImplementation(async (projectId: string) =>
    (world.grants ?? []).filter((row) => row.projectId === projectId));
  h.db.listGroupMembers.mockImplementation(async (groupId: string) => world.members?.[groupId] ?? []);
}

const OWNERS = [person('owner', { role: 'owner' }), person('admin', { role: 'admin' })];

const audienceOf = (projectId: string = PROJECT): AlertEmailAudienceOptions => ({ audience: 'project_admins', projectId });

const sorted = (values: string[]) => [...values].sort();

/** A membership row saved before / after the project levels were enforced (`since` is 1,000,000 ms). */
const BEFORE_ENFORCEMENT = new Date(500_000);
const AFTER_ENFORCEMENT = new Date(2_000_000);

beforeEach(() => {
  vi.clearAllMocks();
  h.logLines.length = 0;
  resetAlertEmailUserCache();
  h.since.mockResolvedValue(1_000_000);
  h.sendEmail.mockResolvedValue(true);
  h.getTenantDatabase.mockImplementation(async () => h.db);
  seed({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the project_admins audience: who is reached', () => {
  it('mails the users with a direct project_admin membership of the project', async () => {
    seed({
      users: [...OWNERS, person('ada'), person('bob'), person('cy')],
      rows: [membership('ada'), membership('bob'), membership('cy', { role: 'member' })],
    });
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('ada'), email('bob')]);
  });

  it('mails the members of a group granted project_admin, and only of those groups', async () => {
    seed({
      users: [...OWNERS, person('gina'), person('gus'), person('plain')],
      grants: [grant('g-admins'), grant('g-members', { role: 'member' })],
      members: { 'g-admins': [{ userId: 'gina' }, { userId: 'gus' }], 'g-members': [{ userId: 'plain' }] },
    });
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('gina'), email('gus')]);
    expect(h.db.listGroupMembers).toHaveBeenCalledTimes(1);
    expect(h.db.listGroupMembers).toHaveBeenCalledWith('g-admins');
  });

  it('mails a legacy project admin: tenant role project_admin with the project in projectIds', async () => {
    seed({
      users: [...OWNERS, person('legacy', { role: 'project_admin', projectIds: [PROJECT, OTHER_PROJECT] })],
    });
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('legacy')]);
  });

  it('reaches all three kinds together and mails a person who is several of them once', async () => {
    seed({
      users: [
        ...OWNERS,
        person('direct'),
        person('grouped'),
        person('legacy', { role: 'project_admin', projectIds: [PROJECT] }),
        person('both', { role: 'project_admin', projectIds: [PROJECT] }),
      ],
      rows: [membership('direct'), membership('both')],
      grants: [grant('g-admins')],
      members: { 'g-admins': [{ userId: 'grouped' }, { userId: 'both' }, { userId: 'direct' }] },
    });
    const recipients = await resolveAlertEmailRecipients(DB, [], audienceOf());
    expect(sorted(recipients)).toEqual(sorted([email('direct'), email('grouped'), email('legacy'), email('both')]));
    expect(recipients).toHaveLength(4);
  });

  it('matches ids by their string form (ObjectId-like ids)', async () => {
    const objectId = (value: string) => ({ toString: () => value });
    seed({
      users: [...OWNERS, person('ada', { _id: objectId('ada') }), person('legacy', { _id: objectId('legacy'), role: 'project_admin', projectIds: [objectId(PROJECT)] })],
      rows: [membership(objectId('ada') as unknown as string)],
    });
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('ada'), email('legacy')]);
  });

  it('ignores the memberships and grants of another project', async () => {
    seed({
      users: [...OWNERS, person('here'), person('there'), person('legacy-there', { role: 'project_admin', projectIds: [OTHER_PROJECT] })],
      rows: [membership('here'), membership('there', { projectId: OTHER_PROJECT })],
      grants: [grant('g-other', { projectId: OTHER_PROJECT })],
      members: { 'g-other': [{ userId: 'there' }] },
    });
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('here')]);
    expect(h.db.listUserProjectsByProject).toHaveBeenCalledWith(PROJECT);
    expect(h.db.listGroupProjectsByProject).toHaveBeenCalledWith(PROJECT);
    expect(h.db.listGroupMembers).not.toHaveBeenCalled();
  });

  describe('who is never mailed', () => {
    // `ok` is always an admin, so a wrongly included person shows up next to it instead of hiding behind the owner/admin fallback.
    const OK = person('ok');
    const cases: Array<[string, World]> = [
      ['a plain member', { users: [person('x')], rows: [membership('x', { role: 'member' })] }],
      ['a member through a group granted member', { users: [person('x')], grants: [grant('g', { role: 'member' })], members: { g: [{ userId: 'x' }] } }],
      ['a portal user with a project_admin membership', { users: [person('x', { role: 'portal_user' })], rows: [membership('x')] }],
      ['a portal user who is a legacy project admin', { users: [person('x', { role: 'portal_user', projectIds: [PROJECT] })] }],
      ['a disabled account', { users: [person('x', { status: 'disabled' })], rows: [membership('x')] }],
      ['a disabled account in an admin group', { users: [person('x', { status: 'disabled' })], grants: [grant('g')], members: { g: [{ userId: 'x' }] } }],
      ['a disabled legacy project admin', { users: [person('x', { status: 'disabled', role: 'project_admin', projectIds: [PROJECT] })] }],
      ['an account that cannot sign in (canLogin false)', { users: [person('x', { canLogin: false })], rows: [membership('x')] }],
      ['an external account', { users: [person('x', { kind: 'external' })], rows: [membership('x')] }],
      ['an admin membership whose alerts access is none', { users: [person('x')], rows: [membership('x', { servicePermissions: { alerts: 'none' }, updatedAt: AFTER_ENFORCEMENT })] }],
      ['an admin group grant whose alerts access is none', { users: [person('x')], grants: [grant('g', { servicePermissions: { alerts: 'none' }, updatedAt: AFTER_ENFORCEMENT })], members: { g: [{ userId: 'x' }] } }],
      ['a project admin whose workspace-level alerts access is none', { users: [person('x', { servicePermissions: { alerts: 'none' } })], rows: [membership('x')] }],
      ['a legacy project admin of another project', { users: [person('x', { role: 'project_admin', projectIds: [OTHER_PROJECT] })] }],
      ['a legacy project admin without any project', { users: [person('x', { role: 'project_admin' })] }],
      ['a plain user who merely lists the project in projectIds', { users: [person('x', { projectIds: [PROJECT] })] }],
      ['a membership of a user who is gone from the workspace', { users: [], rows: [membership('ghost')] }],
    ];

    it.each(cases)('%s', async (_label, world) => {
      seed({
        users: [...OWNERS, OK, ...(world.users ?? [])],
        rows: [membership('ok'), ...(world.rows ?? [])],
        grants: world.grants,
        members: world.members,
      });
      expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('ok')]);
    });

    it.each([['read'], ['write'], ['admin']])('does mail an admin whose alerts access is %s', async (level) => {
      seed({
        users: [...OWNERS, person('x')],
        rows: [membership('x', { servicePermissions: { alerts: level } })],
      });
      expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('x')]);
    });

    it('does mail an admin whose permissions restrict another service only', async () => {
      seed({
        users: [...OWNERS, person('x')],
        rows: [membership('x', { servicePermissions: { models: 'none' } })],
      });
      expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('x')]);
    });

    it('skips an admin without an email address instead of mailing an empty one', async () => {
      seed({
        users: [...OWNERS, person('robot', { email: '' }), person('ada')],
        rows: [membership('robot'), membership('ada')],
      });
      expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('ada')]);
    });
  });
});

describe('the project_admins audience: with the listed recipients and the fallback', () => {
  it('adds the listed recipients to the project admins, de-duplicated case-insensitively, listed ones first', async () => {
    seed({ users: [...OWNERS, person('ada'), person('bob')], rows: [membership('ada'), membership('bob')] });
    const recipients = await resolveAlertEmailRecipients(
      DB,
      [' ADA@acme.test ', 'extra@else.test', 'Extra@Else.test'],
      audienceOf(),
    );
    expect(recipients).toEqual(['ADA@acme.test', 'extra@else.test', email('bob')]);
  });

  it('removes a listed recipient that belongs to a disabled account, as without an audience', async () => {
    seed({
      users: [...OWNERS, person('ada'), person('gone', { status: 'disabled' })],
      rows: [membership('ada')],
    });
    expect(await resolveAlertEmailRecipients(DB, [email('gone').toUpperCase(), 'ext@else.test'], audienceOf()))
      .toEqual(['ext@else.test', email('ada')]);
  });

  it('keeps only the listed recipients when the project has no admin, without falling back', async () => {
    seed({ users: [...OWNERS, person('plain')], rows: [membership('plain', { role: 'member' })] });
    expect(await resolveAlertEmailRecipients(DB, ['ops@else.test'], audienceOf())).toEqual(['ops@else.test']);
  });

  it('falls back to the workspace owners and admins when there are no listed recipients and no project admin', async () => {
    seed({
      users: [
        ...OWNERS,
        person('gone-admin', { role: 'admin', status: 'disabled' }),
        person('plain'),
      ],
      rows: [membership('plain', { role: 'member' })],
    });
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('admin'), email('owner')]);
  });

  it('falls back when every project admin is blocked', async () => {
    seed({
      users: [...OWNERS, person('off', { status: 'disabled' }), person('portal', { role: 'portal_user' })],
      rows: [membership('off'), membership('portal')],
    });
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('admin'), email('owner')]);
  });

  it('does NOT add the owners and admins when the project has admins', async () => {
    seed({ users: [...OWNERS, person('ada')], rows: [membership('ada')] });
    const recipients = await resolveAlertEmailRecipients(DB, [], audienceOf());
    expect(recipients).toEqual([email('ada')]);
    expect(recipients).not.toContain(email('owner'));
    expect(recipients).not.toContain(email('admin'));
  });

  it('does mail an owner or admin who is also a project admin', async () => {
    seed({
      users: [...OWNERS, person('ada')],
      rows: [membership('admin'), membership('ada')],
    });
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('ada'), email('admin')]);
  });
});

describe('without the audience nothing changes', () => {
  beforeEach(() => {
    seed({ users: [...OWNERS, person('ada')], rows: [membership('ada')] });
  });

  it('mails the listed recipients only', async () => {
    expect(await resolveAlertEmailRecipients(DB, ['ops@else.test'])).toEqual(['ops@else.test']);
    expect(await resolveAlertEmailRecipients(DB, ['ops@else.test'], { projectId: PROJECT })).toEqual(['ops@else.test']);
  });

  it('falls back to the owners and admins with nobody listed, project admins or not', async () => {
    expect(sorted(await resolveAlertEmailRecipients(DB, []))).toEqual([email('admin'), email('owner')]);
    expect(sorted(await resolveAlertEmailRecipients(DB, null, { projectId: PROJECT }))).toEqual([email('admin'), email('owner')]);
    expect(sorted(await resolveAlertEmailRecipients(DB, undefined))).toEqual([email('admin'), email('owner')]);
  });

  it('reads no membership at all', async () => {
    await resolveAlertEmailRecipients(DB, []);
    await resolveAlertEmailRecipients(DB, ['a@else.test'], { projectId: PROJECT });
    expect(h.db.listUserProjectsByProject).not.toHaveBeenCalled();
    expect(h.db.listGroupProjectsByProject).not.toHaveBeenCalled();
  });

  it('ignores an audience it does not know', async () => {
    const options = { audience: 'everyone', projectId: PROJECT } as unknown as AlertEmailAudienceOptions;
    expect(sorted(await resolveAlertEmailRecipients(DB, [], options))).toEqual([email('admin'), email('owner')]);
    expect(h.db.listUserProjectsByProject).not.toHaveBeenCalled();
  });

  it('treats the audience as absent when the project is not known (nothing to resolve it against)', async () => {
    expect(sorted(await resolveAlertEmailRecipients(DB, [], { audience: 'project_admins' }))).toEqual([email('admin'), email('owner')]);
    expect(await resolveAlertEmailRecipients(DB, ['a@else.test'], { audience: 'project_admins', projectId: '' })).toEqual(['a@else.test']);
    expect(h.db.listUserProjectsByProject).not.toHaveBeenCalled();
  });
});

describe('when the memberships cannot be read', () => {
  it('falls back like a project without admins, and does not throw', async () => {
    seed({ users: [...OWNERS, person('ada')], rows: [membership('ada')] });
    h.db.listUserProjectsByProject.mockRejectedValue(new Error('db down'));
    await expect(resolveAlertEmailRecipients(DB, [], audienceOf())).resolves.toEqual(expect.arrayContaining([email('owner'), email('admin')]));
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('admin'), email('owner')]);
  });

  it('keeps the listed recipients and still reaches the legacy project admins', async () => {
    seed({
      users: [...OWNERS, person('legacy', { role: 'project_admin', projectIds: [PROJECT] }), person('ada')],
      rows: [membership('ada')],
    });
    h.db.listUserProjectsByProject.mockRejectedValue(new Error('db down'));
    expect(await resolveAlertEmailRecipients(DB, ['ops@else.test'], audienceOf())).toEqual(['ops@else.test', email('legacy')]);
  });

  it('falls back the same way when a group read fails', async () => {
    seed({ users: [...OWNERS, person('ada')], grants: [grant('g')], members: { g: [{ userId: 'ada' }] } });
    h.db.listGroupMembers.mockRejectedValue(new Error('db down'));
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('admin'), email('owner')]);
    h.db.listGroupMembers.mockRejectedValue(new Error('db down'));
    h.db.listGroupProjectsByProject.mockRejectedValue(new Error('db down'));
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('admin'), email('owner')]);
  });

  it('does not cache the failure: the next resolution reads again and finds the admins', async () => {
    seed({ users: [...OWNERS, person('ada')], rows: [membership('ada')] });
    h.db.listUserProjectsByProject.mockRejectedValueOnce(new Error('db down'));
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('admin'), email('owner')]);
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('ada')]);
    expect(h.db.listUserProjectsByProject).toHaveBeenCalledTimes(2);
  });

  it('logs the error name only, never its message', async () => {
    seed({ users: [...OWNERS], rows: [] });
    h.db.listUserProjectsByProject.mockRejectedValue(new Error('connect mongodb://svc:s3cr3t@db.internal:27017 refused'));
    await resolveAlertEmailRecipients(DB, [], audienceOf());
    const warnings = h.logLines.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].meta).toEqual({ error: 'Error' });
    expect(JSON.stringify(h.logLines)).not.toContain('s3cr3t');
  });

  it('keeps the listed recipients, resolves no audience and reads no membership when the user list is unreadable', async () => {
    h.db.listUsers.mockRejectedValue(new Error('db down'));
    expect(await resolveAlertEmailRecipients(DB, ['ops@else.test'], audienceOf())).toEqual(['ops@else.test']);
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([]);
    expect(h.db.listUserProjectsByProject).not.toHaveBeenCalled();
  });
});

describe('the alerts level of a membership is read the way the access engine reads it', () => {
  const noneOf = (updatedAt: Date | undefined): Row => membership('x', { servicePermissions: { alerts: 'none' }, ...(updatedAt ? { updatedAt } : {}) });

  it('honours a none saved after the levels were enforced', async () => {
    seed({ users: [...OWNERS, person('x')], rows: [noneOf(AFTER_ENFORCEMENT)] });
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('admin'), email('owner')]);
  });

  it('reads a none saved before that as not set: the admin is mailed', async () => {
    seed({ users: [...OWNERS, person('x')], rows: [noneOf(BEFORE_ENFORCEMENT)] });
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('x')]);
  });

  it('reads a none of a row without a date as not set', async () => {
    seed({ users: [...OWNERS, person('x')], rows: [noneOf(undefined)] });
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('x')]);
  });

  it('does the same for an admin group grant', async () => {
    const grantOf = (updatedAt: Date) => grant('g', { servicePermissions: { alerts: 'none' }, updatedAt });
    seed({ users: [...OWNERS, person('x')], grants: [grantOf(BEFORE_ENFORCEMENT)], members: { g: [{ userId: 'x' }] } });
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('x')]);

    resetAlertEmailUserCache();
    seed({ users: [...OWNERS, person('x')], grants: [grantOf(AFTER_ENFORCEMENT)], members: { g: [{ userId: 'x' }] } });
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('admin'), email('owner')]);
  });

  it('asks for the activation instant of the workspace once per lookup', async () => {
    seed({ users: [...OWNERS, person('x')], rows: [noneOf(AFTER_ENFORCEMENT)] });
    await resolveAlertEmailRecipients(DB, [], audienceOf());
    await resolveAlertEmailRecipients(DB, [], audienceOf());
    expect(h.since).toHaveBeenCalledTimes(1);
    expect(h.since).toHaveBeenCalledWith(DB);
  });

  it('falls back to the stored levels, and logs the error name only, when the instant cannot be read', async () => {
    h.since.mockRejectedValue(new Error('connect mongodb://svc:s3cr3t@db.internal:27017 refused'));
    seed({ users: [...OWNERS, person('x'), person('y')], rows: [noneOf(BEFORE_ENFORCEMENT), membership('y')] });
    // the stored none still counts, and the notification is not failed
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('y')]);
    const warnings = h.logLines.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].meta).toEqual({ error: 'Error' });
    expect(JSON.stringify(h.logLines)).not.toContain('s3cr3t');
  });

  it('does not keep a list read without the instant: the next send reads it again', async () => {
    h.since.mockRejectedValueOnce(new Error('unavailable'));
    seed({ users: [...OWNERS, person('x'), person('y')], rows: [noneOf(BEFORE_ENFORCEMENT), membership('y')] });
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('y')]);
    // the instant is back: the old none no longer counts
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('x'), email('y')]);
    expect(h.since).toHaveBeenCalledTimes(2);
  });
});

describe('resolveProjectAdminRecipients', () => {
  it('lists the admins of the project, de-duplicated by address and trimmed', async () => {
    seed({
      users: [
        ...OWNERS,
        person('ada', { email: ' Ada@acme.test ' }),
        person('ada-2', { email: 'ada@ACME.test' }),
        person('bob'),
      ],
      rows: [membership('ada'), membership('ada-2'), membership('bob')],
    });
    expect(await resolveProjectAdminRecipients(DB, PROJECT)).toEqual(['Ada@acme.test', email('bob')]);
  });

  it('is empty, not the owners and admins, for a project without admins', async () => {
    seed({ users: [...OWNERS, person('plain')], rows: [membership('plain', { role: 'member' })] });
    expect(await resolveProjectAdminRecipients(DB, PROJECT)).toEqual([]);
  });

  it('is empty, and does not throw, when the user list cannot be read', async () => {
    h.db.listUsers.mockRejectedValue(new Error('db down'));
    expect(await resolveProjectAdminRecipients(DB, PROJECT)).toEqual([]);
  });

  it('counts the same people the send resolves', async () => {
    seed({
      users: [...OWNERS, person('direct'), person('grouped'), person('off', { status: 'disabled' }), person('legacy', { role: 'project_admin', projectIds: [PROJECT] })],
      rows: [membership('direct'), membership('off')],
      grants: [grant('g')],
      members: { g: [{ userId: 'grouped' }] },
    });
    const listed = await resolveProjectAdminRecipients(DB, PROJECT);
    const sent = await resolveAlertEmailRecipients(DB, [], audienceOf());
    expect(sorted(listed)).toEqual(sorted(sent));
    expect(listed).toHaveLength(3);
  });
});

describe('the membership cache', () => {
  beforeEach(() => {
    seed({
      users: [...OWNERS, person('direct'), person('grouped')],
      rows: [membership('direct')],
      grants: [grant('g')],
      members: { g: [{ userId: 'grouped' }] },
    });
  });

  it('reads the memberships once across a burst, for the users and the memberships alike', async () => {
    for (let i = 0; i < 5; i += 1) await resolveAlertEmailRecipients(DB, [], audienceOf());
    await resolveProjectAdminRecipients(DB, PROJECT);
    expect(h.db.listUsers).toHaveBeenCalledTimes(1);
    expect(h.db.listUserProjectsByProject).toHaveBeenCalledTimes(1);
    expect(h.db.listGroupProjectsByProject).toHaveBeenCalledTimes(1);
    expect(h.db.listGroupMembers).toHaveBeenCalledTimes(1);
  });

  it('shares one read between resolutions that run at the same time', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveAlertEmailRecipients(DB, [], audienceOf())));
    for (const recipients of results) expect(sorted(recipients)).toEqual([email('direct'), email('grouped')]);
    expect(h.db.listUserProjectsByProject).toHaveBeenCalledTimes(1);
    expect(h.db.listGroupMembers).toHaveBeenCalledTimes(1);
  });

  it('keeps one entry per project', async () => {
    await resolveAlertEmailRecipients(DB, [], audienceOf(PROJECT));
    await resolveAlertEmailRecipients(DB, [], audienceOf(OTHER_PROJECT));
    await resolveAlertEmailRecipients(DB, [], audienceOf(PROJECT));
    await resolveAlertEmailRecipients(DB, [], audienceOf(OTHER_PROJECT));
    expect(h.db.listUserProjectsByProject.mock.calls.map((call) => call[0])).toEqual([PROJECT, OTHER_PROJECT]);
    expect(h.db.listUsers).toHaveBeenCalledTimes(1);
  });

  it('resetAlertEmailUserCache makes the next resolution read the memberships again', async () => {
    await resolveAlertEmailRecipients(DB, [], audienceOf());
    seed({ users: [...OWNERS, person('late')], rows: [membership('late')] });
    // still the cached answer
    expect(sorted(await resolveAlertEmailRecipients(DB, [], audienceOf()))).toEqual([email('direct'), email('grouped')]);
    resetAlertEmailUserCache();
    expect(await resolveAlertEmailRecipients(DB, [], audienceOf())).toEqual([email('late')]);
    expect(h.db.listUserProjectsByProject).toHaveBeenCalledTimes(2);
  });

  it('expires after 30 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    await resolveAlertEmailRecipients(DB, [], audienceOf());
    vi.setSystemTime(new Date('2026-10-16T10:00:29.900Z'));
    await resolveAlertEmailRecipients(DB, [], audienceOf());
    expect(h.db.listUserProjectsByProject).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-16T10:00:30.100Z'));
    await resolveAlertEmailRecipients(DB, [], audienceOf());
    expect(h.db.listUserProjectsByProject).toHaveBeenCalledTimes(2);
  });
});

describe('EmailAlertChannel with the project_admins audience', () => {
  const event = {
    kind: 'fired',
    rule: {
      id: 'r1', name: 'Agent errors', module: 'agents', metric: 'agent_error_rate', metricLabel: 'Agent Error Rate', unit: '%',
      mode: 'threshold', windowMinutes: 30, operator: 'gt', threshold: 20,
    },
    value: 35, severity: 'warning', firedAt: new Date(), projectName: 'Main', companyName: 'Acme', dashboardUrl: 'u',
  } as never;
  const baseCtx = {
    tenantDbName: DB, tenantId: 't1', tenantSlug: 'acme', projectName: 'Main', companyName: 'Acme', dashboardUrl: 'u', incidentUrl: 'i', incidentId: '1',
  };
  const withProject = { ...baseCtx, projectId: PROJECT } as never;
  const withoutProject = baseCtx as never;
  const channel = { type: 'email', recipients: [], audience: 'project_admins' } as never;

  beforeEach(() => {
    seed({
      users: [...OWNERS, person('ada'), person('bob'), person('plain')],
      rows: [membership('ada'), membership('bob'), membership('plain', { role: 'member' })],
    });
  });

  it('mails the admins of ctx.projectId, not the owners and admins', async () => {
    const results = await new EmailAlertChannel().dispatch(event, channel, withProject);
    expect(sorted(h.sendEmail.mock.calls.map((call) => call[0]))).toEqual([email('ada'), email('bob')]);
    expect(results.map((result) => result.target).sort()).toEqual([email('ada'), email('bob')]);
    expect(results.every((result) => result.type === 'email' && result.success)).toBe(true);
    expect(h.db.listUserProjectsByProject).toHaveBeenCalledWith(PROJECT);
  });

  it('uses the alert templates, fired and resolved', async () => {
    await new EmailAlertChannel().dispatch(event, channel, withProject);
    expect(h.sendEmail).toHaveBeenCalledWith(email('ada'), 'alert-fired', expect.objectContaining({ alertName: 'Agent errors', projectName: 'Main' }));
    h.sendEmail.mockClear();
    await new EmailAlertChannel().dispatch({ ...(event as object), kind: 'resolved' } as never, channel, withProject);
    expect(h.sendEmail).toHaveBeenCalledWith(email('ada'), 'alert-resolved', expect.anything());
  });

  it('adds the listed recipients to the project admins', async () => {
    await new EmailAlertChannel().dispatch(
      event,
      { type: 'email', recipients: ['oncall@else.test', 'ADA@acme.test'], audience: 'project_admins' } as never,
      withProject,
    );
    expect(sorted(h.sendEmail.mock.calls.map((call) => call[0]))).toEqual(sorted(['oncall@else.test', 'ADA@acme.test', email('bob')]));
  });

  it('without ctx.projectId the audience has nothing to resolve against: the owners and admins get it', async () => {
    await new EmailAlertChannel().dispatch(event, channel, withoutProject);
    expect(sorted(h.sendEmail.mock.calls.map((call) => call[0]))).toEqual([email('admin'), email('owner')]);
    expect(h.db.listUserProjectsByProject).not.toHaveBeenCalled();
  });

  it('a channel without the audience ignores the project admins even with a project in the context', async () => {
    await new EmailAlertChannel().dispatch(event, { type: 'email', recipients: ['ops@else.test'] } as never, withProject);
    expect(h.sendEmail.mock.calls.map((call) => call[0])).toEqual(['ops@else.test']);
    expect(h.db.listUserProjectsByProject).not.toHaveBeenCalled();
  });

  it('falls back to the owners and admins for a project without admins', async () => {
    seed({ users: [...OWNERS, person('plain')], rows: [membership('plain', { role: 'member' })] });
    await new EmailAlertChannel().dispatch(event, channel, withProject);
    expect(sorted(h.sendEmail.mock.calls.map((call) => call[0]))).toEqual([email('admin'), email('owner')]);
  });

  it('reports a failed address without stopping the others', async () => {
    h.sendEmail.mockImplementation(async (to: string) => to !== email('ada'));
    const results = await new EmailAlertChannel().dispatch(event, channel, withProject);
    expect(results).toHaveLength(2);
    expect(results.find((result) => result.target === email('ada'))).toMatchObject({ success: false });
    expect(results.find((result) => result.target === email('bob'))).toMatchObject({ success: true });
  });

  it('reports no recipients only when nobody is left at all', async () => {
    seed({ users: [], rows: [] });
    expect(await new EmailAlertChannel().dispatch(event, channel, withProject)).toEqual([
      { type: 'email', target: '(none)', success: false, error: 'No recipients available' },
    ]);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  describe('a test notification', () => {
    const testEvent = { ...(event as object), kind: 'test' } as never;
    const many = (count: number) => Array.from({ length: count }, (_, i) => person(`m${String(i).padStart(2, '0')}`));

    it('is capped at MAX_TEST_EMAIL_RECIPIENTS of the resolved recipients, however many the audience reaches', async () => {
      const people = many(9);
      seed({ users: [...OWNERS, ...people], rows: people.map((p) => membership(String(p._id))) });
      const results = await new EmailAlertChannel().dispatch(testEvent, channel, withProject);
      expect(MAX_TEST_EMAIL_RECIPIENTS).toBe(5);
      expect(h.sendEmail).toHaveBeenCalledTimes(MAX_TEST_EMAIL_RECIPIENTS);
      expect(results).toEqual([{ type: 'email', target: '5 of 9 recipients', success: true }]);
    });

    it('caps listed addresses too', async () => {
      seed({ users: [...OWNERS], rows: [] });
      const listed = Array.from({ length: 8 }, (_, i) => `l${i}@else.test`);
      await new EmailAlertChannel().dispatch(testEvent, { type: 'email', recipients: listed } as never, withProject);
      expect(h.sendEmail).toHaveBeenCalledTimes(5);
      expect(h.sendEmail.mock.calls.map((call) => call[0])).toEqual(listed.slice(0, 5));
    });

    it('reports the number of recipients, singular for one, never an address', async () => {
      const [result] = await new EmailAlertChannel().dispatch(testEvent, { type: 'email', recipients: ['only@else.test'] } as never, withProject);
      expect(result).toEqual({ type: 'email', target: '1 recipient', success: true });
    });

    it('reports a failure as one result with the count and the error', async () => {
      h.sendEmail.mockImplementation(async (to: string) => to !== email('ada'));
      const results = await new EmailAlertChannel().dispatch(testEvent, channel, withProject);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ type: 'email', target: '2 recipients', success: false });
      expect(results[0].error).toContain('mail server');
    });

    it('still reports "no recipients" as before', async () => {
      seed({ users: [], rows: [] });
      expect(await new EmailAlertChannel().dispatch(testEvent, channel, withProject)).toEqual([
        { type: 'email', target: '(none)', success: false, error: 'No recipients available' },
      ]);
    });

    it('does not cap a real notification or a digest, and keeps their per-address results', async () => {
      const people = many(9);
      seed({ users: [...OWNERS, ...people], rows: people.map((p) => membership(String(p._id))) });
      const fired = await new EmailAlertChannel().dispatch(event, channel, withProject);
      expect(fired).toHaveLength(9);
      expect(fired.map((result) => result.target)).toEqual(people.map((p) => String(p.email)));
      h.sendEmail.mockClear();
      await new EmailAlertChannel().sendMessage({ title: 'Digest', summary: 's', fields: [] } as never, channel, withProject);
      expect(h.sendEmail).toHaveBeenCalledTimes(9);
    });
  });

  it('applies to the generic messages (digests) the same way', async () => {
    await new EmailAlertChannel().sendMessage(
      { title: 'Weekly digest', summary: 'All quiet', fields: [] } as never,
      channel,
      withProject,
    );
    expect(sorted(h.sendEmail.mock.calls.map((call) => call[0]))).toEqual([email('ada'), email('bob')]);
    expect(h.sendEmail).toHaveBeenCalledWith(email('ada'), 'alert-message', expect.objectContaining({ title: 'Weekly digest' }));
  });
});
