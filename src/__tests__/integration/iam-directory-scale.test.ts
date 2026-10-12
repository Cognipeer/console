/**
 * The directory queries stay fast on a big organisation - the same checks on BOTH
 * backends. By default a workspace of about a thousand and a half people is seeded
 * (a few seconds); `RUN_SCALE_TESTS=1` seeds the documented scale instead: 20,000
 * people, 200 groups (one of 5,000 members) and 10,000 API tokens.
 *
 * No index is added for any of it: the listings are scans, and these ceilings are
 * generous on purpose (a regression to "read everything per request" is what they
 * catch). The measured p95 of each step is printed so they can be tightened.
 */
import { beforeAll, expect, it } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const FULL = process.env.RUN_SCALE_TESTS === '1';
const USERS = FULL ? 20_000 : 1_500;
const GROUPS = FULL ? 200 : 30;
const BIG_GROUP_MEMBERS = FULL ? 5_000 : 400;
const TOKENS = FULL ? 10_000 : 700;
/** Writes in flight at once while seeding. */
const BATCH = 40;

const LIST_CEILING_MS = 500;
const LIST_AND_COUNT_CEILING_MS = 1_000;
const REPEATS = 5;

async function inBatches<T>(items: readonly T[], work: (item: T, index: number) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH) {
    await Promise.all(items.slice(i, i + BATCH).map((item, offset) => work(item, i + offset)));
  }
}

/** Time `run` a few times; the 95th percentile (the slowest of five, here). */
async function p95(label: string, run: () => Promise<unknown>): Promise<number> {
  await run(); // warm up
  const times: number[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const started = performance.now();
    await run();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const value = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)];
  console.log(`[scale] ${label}: p95 ${value.toFixed(0)} ms (${USERS} users)`);
  return value;
}

describeForEachProvider('IAM directory at scale', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let dbName: string;
  const groupIds: string[] = [];
  const ownerIds: string[] = [];

  beforeAll(async () => {
    db = getDb();
    const slug = `iamscale-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Scale', slug, dbName, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.switchToTenant(dbName);

    const roles = ['user', 'user', 'user', 'user', 'project_admin', 'admin'] as const;
    const indexes = Array.from({ length: USERS }, (_, i) => i);
    const userIds: string[] = new Array(USERS);
    await inBatches(indexes, async (i) => {
      const n = String(i).padStart(6, '0');
      const user = await db.createUser({
        tenantId,
        email: i % 25 === 0 ? '' : `person${n}@corp.example`,
        name: `Person ${n}`,
        password: 'h',
        role: roles[i % roles.length],
        licenseId: 'FREE',
        features: [],
        ...(i % 25 === 0 ? { canLogin: false } : {}),
        ...(i % 17 === 0 ? { status: 'disabled' as const } : {}),
        ...(i % 11 === 0 ? { authProvider: (['ldap', 'oidc', 'saml'] as const)[i % 3], externalId: `ext-${n}` } : {}),
        ...(i % 13 === 0 ? { invitedBy: 'someone', invitedAt: new Date() } : {}),
      } as never);
      userIds[i] = String(user._id);
    });
    ownerIds.push(userIds[0]);

    await inBatches(Array.from({ length: GROUPS }, (_, i) => i), async (i) => {
      const group = await db.createGroup({ tenantId, name: `Team ${String(i).padStart(3, '0')}`, createdBy: 't', source: i % 10 === 0 ? 'ldap' : 'local' } as never);
      groupIds[i] = String(group._id);
    });
    // team 000 is the big one; the rest have a few members each
    await inBatches(userIds.slice(0, BIG_GROUP_MEMBERS), (id) => db.addGroupMember({ groupId: groupIds[0], userId: id, tenantId, role: 'member' }));
    await inBatches(userIds.slice(0, Math.min(userIds.length, GROUPS * 5)), (id, i) =>
      db.addGroupMember({ groupId: groupIds[1 + (i % (GROUPS - 1))], userId: id, tenantId, role: 'member' }));

    await inBatches(Array.from({ length: TOKENS }, (_, i) => i), (i) => db.createApiToken({
      tenantId,
      userId: userIds[(i * 7) % USERS],
      label: `token ${i}`,
      tokenHash: `scale-${slug}-${i}`,
      tokenPrefix: `cp_${i}`,
      createdBy: 'x',
      ...(i % 3 === 0 ? { servicePermissions: { agents: 'read' } } : {}),
      ...(i % 5 === 0 ? { expiresAt: new Date(Date.now() - 60_000) } : {}),
    } as never));
  }, FULL ? 1_800_000 : 120_000);

  it('lists a page of people within the ceiling, and with the total within its own', async () => {
    const list = await p95('list 25', () => db.iamListUsers({ tenantId, limit: 25 }));
    expect(list).toBeLessThan(LIST_CEILING_MS);
    const withCount = await p95('list 25 + count', () => Promise.all([db.iamListUsers({ tenantId, limit: 25 }), db.iamCountUsers({ tenantId })]));
    expect(withCount).toBeLessThan(LIST_AND_COUNT_CEILING_MS);
    expect(await db.iamCountUsers({ tenantId })).toBe(USERS);
  });

  it('filters and sorts without reading the table into memory', async () => {
    const filter = { tenantId, roles: ['user', 'admin'], status: 'active' as const, invited: false, q: 'person0', canLogin: true };
    const sorted = await p95('filtered + sorted list', () => db.iamListUsers({ ...filter, sort: 'email', dir: 'desc', limit: 25 }));
    expect(sorted).toBeLessThan(LIST_CEILING_MS);
    const counted = await p95('filtered list + count', () => Promise.all([db.iamListUsers({ ...filter, limit: 25 }), db.iamCountUsers(filter)]));
    expect(counted).toBeLessThan(LIST_AND_COUNT_CEILING_MS);
    const page = await db.iamListUsers({ ...filter, sort: 'email', dir: 'desc', limit: 25 });
    expect(page.items.length).toBeGreaterThan(0);
    const emails = page.items.map((user) => user.email.toLowerCase());
    expect(emails).toEqual([...emails].sort().reverse());
  });

  it('pages deep into a sorted list', async () => {
    const deep = await p95('deep page', () => db.iamListUsers({ tenantId, limit: 25, offset: Math.floor(USERS / 2), sort: 'createdAt', dir: 'desc' }));
    expect(deep).toBeLessThan(LIST_CEILING_MS * 2);
  });

  it('lists the people of the biggest group, and one page of its members', async () => {
    const members = await p95('people of the big group', () => db.iamListUsers({ tenantId, groupId: groupIds[0], limit: 25, sort: 'name' }));
    expect(members).toBeLessThan(LIST_CEILING_MS * 2);
    expect(await db.iamCountUsers({ tenantId, groupId: groupIds[0] })).toBe(BIG_GROUP_MEMBERS);
    const page = await p95('one page of group members', async () => {
      const ids = await db.iamListGroupMemberIds(groupIds[0], { limit: 25, offset: 100 });
      await db.iamListUsers({ tenantId, ids: ids.items, limit: 25 });
    });
    expect(page).toBeLessThan(LIST_CEILING_MS);
  });

  it('lists the tokens a viewer may see, leaving the owner\'s out in the query', async () => {
    const filter = { tenantId, excludeUserIds: ownerIds, status: 'active' as const };
    const tokens = await p95('token list (excluding the owner)', () => db.iamListTokens({ ...filter, limit: 25 }));
    expect(tokens).toBeLessThan(LIST_CEILING_MS);
    const withCount = await p95('token list + count', () => Promise.all([db.iamListTokens({ ...filter, limit: 25 }), db.iamCountTokens(filter)]));
    expect(withCount).toBeLessThan(LIST_AND_COUNT_CEILING_MS);
    const all = await db.iamCountTokens({ tenantId });
    expect(all).toBe(TOKENS);
    expect(await db.iamCountTokens({ tenantId, excludeUserIds: ownerIds })).toBeLessThanOrEqual(all);
  });

  it('lists groups with their member counts', async () => {
    const groups = await p95('groups + counts', async () => {
      const page = await db.iamListGroups({ tenantId, limit: 100 });
      await db.iamCountGroupMembers(page.items.map((group) => String(group._id)));
    });
    expect(groups).toBeLessThan(LIST_CEILING_MS);
    expect(await db.iamCountGroups({ tenantId })).toBe(GROUPS);
  });
});
