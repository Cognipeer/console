/**
 * Unit tests - what the access views say a person holds is what the search-time engine gives them
 *
 * The dashboard's views (who holds a key, which console people a directory user is tied to) are computed for every
 * person at once by the kernel in access/audience.ts, over rows read in bulk. The engine (`resolvePersonPrincipals`)
 * answers the same question for one person with one query per rule. If the two ever disagreed, a screen would say
 * "5 people can read this" about a permission that lets 6 in. This fixture holds every case the matching knows - rules
 * that win and lose, guests, the cap on matches, the SSO id taken as the directory id, console groups standing for
 * directory groups, links of every kind (including the ones that are ignored), host-application accounts, a disabled
 * account, a second and a third directory - and checks, for each person, that both give the same keys and the same
 * record of how they were matched.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-parity-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_parity_main';

vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));

import { reloadConfig } from '@/lib/core/config';
import {
  disconnectDatabase,
  getDatabase,
  type DatabaseProvider,
  type IGroup,
  type IGroupMember,
  type IRagIdentityDomain,
  type IRagIdentityLink,
  type IRagIdentityUser,
  type IUser,
} from '@/lib/database';
import {
  consoleKeysOf,
  domainKeysOf,
  holdersByKey,
  indexDirectoryMatches,
  matchablePersonOf,
  memoryFinder,
  previewUserMatch,
  type DirectoryFinder,
  type DirectoryMatch,
  type MatchablePerson,
  type PersonIdentityMatch,
} from '@/lib/services/rag/access/audience';
import { resolvePersonPrincipals, userMatchRulesOf } from '@/lib/services/rag/access/identity';
import {
  createRagIdentityLinkFor,
  putRagIdentityDomain,
  syncRagIdentityUsers,
  type RagAccessContext,
} from '@/lib/services/rag/ragAccessService';

const TENANT_DB_NAME = 'rag_parity_tenant';

let db: DatabaseProvider;
let tenantId = 'pending';
let ctx: RagAccessContext;

const people: Record<string, IUser> = {};
const groups: Record<string, IGroup> = {};

interface World {
  users: IUser[];
  groupRows: IGroup[];
  memberships: IGroupMember[];
  domains: IRagIdentityDomain[];
  linksByDomain: Map<string, IRagIdentityLink[]>;
  finderByDomain: Map<string, DirectoryFinder>;
  rowsByDomain: Map<string, IRagIdentityUser[]>;
}
let world: World;

async function readWorld(): Promise<World> {
  const users = (await db.iamListUsers({ tenantId, limit: 200 })).items;
  const domains = await db.listRagIdentityDomains();
  const linksByDomain = new Map<string, IRagIdentityLink[]>();
  const finderByDomain = new Map<string, DirectoryFinder>();
  const rowsByDomain = new Map<string, IRagIdentityUser[]>();
  for (const domain of domains) {
    linksByDomain.set(domain.key, await db.listRagIdentityLinks({ domain: domain.key }));
    const rows: IRagIdentityUser[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await db.listRagIdentityUsers(domain.key, { limit: 200, offset });
      rows.push(...page.users);
      if (rows.length >= page.total || page.users.length === 0) break;
    }
    rowsByDomain.set(domain.key, rows);
    finderByDomain.set(domain.key, memoryFinder(rows));
  }
  return {
    users,
    groupRows: await db.listGroups(tenantId),
    memberships: await db.listGroupMembersByTenant(tenantId),
    domains,
    linksByDomain,
    finderByDomain,
    rowsByDomain,
  };
}

function personOf(user: IUser): MatchablePerson {
  const groupById = new Map(world.groupRows.map((g) => [String(g._id), g] as const));
  const memberOf = world.memberships
    .filter((m) => String(m.userId) === String(user._id))
    .map((m) => ({ _id: String(m.groupId), externalId: groupById.get(String(m.groupId))?.externalId }));
  return matchablePersonOf(user, memberOf);
}

function kernelHolds(person: MatchablePerson): { keys: string[]; matches: PersonIdentityMatch[] } {
  const keys = new Set(consoleKeysOf(person));
  const matches: PersonIdentityMatch[] = [];
  for (const domain of world.domains) {
    const result = domainKeysOf(
      person,
      {
        key: domain.key,
        rules: userMatchRulesOf(domain),
        matchGroupsByExternalId: domain.matchGroupsByExternalId !== false,
        links: world.linksByDomain.get(domain.key) ?? [],
      },
      world.finderByDomain.get(domain.key) as DirectoryFinder,
    );
    for (const key of result.keys) keys.add(key);
    matches.push(...result.matches);
  }
  return { keys: [...keys], matches };
}

/** A match as a comparable line: which directory, how, by which rule, which external ids (order does not matter). */
const lineOf = (m: PersonIdentityMatch): string =>
  [m.domain, m.via, m.rule ? `${m.rule.console}>${m.rule.external}` : '-', [...m.externalIds].sort().join('|')].join(' ');

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Parity Test',
    slug: 'rag-parity-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);

  const make = async (name: string, extra: Record<string, unknown> = {}) => {
    people[name] = await db.createUser({
      tenantId,
      email: `${name}@example.com`,
      name,
      password: '$2b$10$x',
      role: 'user',
      licenseId: 'FREE',
      features: [],
      ...extra,
    } as never);
  };
  await make('ada');
  await make('bob', { email: 'bob@corp.example', externalId: 'E-200' });
  await make('carol', { email: 'Carol@Example.com' });
  await make('dave');
  await make('admin', { role: 'admin' });
  await make('gone', { status: 'disabled' });
  // Accounts of host applications: the address and the subject on them are only what the application claimed.
  await make('host', { kind: 'external', canLogin: false, email: 'victim@corp.example', externalId: 'E-300' });
  await make('hostLinked', { kind: 'external', canLogin: false, email: 'host-linked@shop.example' });
  // A member whose SSO id has no row in any directory.
  await make('sso', { externalId: 'NOROW-2' });
  // Shares an address with twelve directory users (the engine keeps ten).
  await make('lead', { email: 'team@corp.example' });
  await make('linker', { email: 'linker@elsewhere.example' });
  await make('dup', { email: 'dup@corp.example' });

  const makeGroup = async (name: string, externalId: string | undefined, members: string[]) => {
    groups[name] = await db.createGroup({ tenantId, name, ...(externalId ? { externalId } : {}), createdBy: 'seed' });
    for (const member of members) {
      await db.addGroupMember({ tenantId, groupId: String(groups[name]._id), userId: String(people[member]._id), role: 'member' });
    }
  };
  await makeGroup('Finance', 'cn=finance', ['ada', 'host', 'linker']);
  await makeGroup('Ops', ' cn=ops ', ['ada', 'dave']);
  await makeGroup('Plain', undefined, ['bob']);
  // A group that was deleted after people joined it: the membership row stays.
  await db.addGroupMember({ tenantId, groupId: 'deleted-group', userId: String(people.carol._id), role: 'member' });

  ctx = { tenantDbName: TENANT_DB_NAME, tenantId, actor: String(people.admin._id) };

  await putRagIdentityDomain(ctx, {
    key: 'corp',
    label: 'Corp',
    userMatch: [
      { console: 'email', external: 'email' },
      { console: 'externalId', external: 'id' },
      { console: 'email', external: 'attr:mailAlias' },
    ],
  });
  await putRagIdentityDomain(ctx, { key: 'partners', label: 'Partners', matchGroupsByExternalId: false });
  await putRagIdentityDomain(ctx, { key: 'sso-only', label: 'SSO only', userMatch: [{ console: 'externalId', external: 'id' }] });

  await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
    domain: 'corp',
    runId: 'run-1',
    users: [
      { extId: 'E-100', name: 'Ada Lovelace', email: 'ada@example.com', groups: ['fin-readers', 'ops'] },
      { extId: 'E-200', email: 'robert@corp.example', groups: ['fin-readers'] },
      { extId: 'E-300', email: 'carol@example.com', type: 'guest', groups: ['partners'] },
      { extId: 'E-400', attrs: { mailAlias: 'DAVE@example.com' }, groups: ['ops'] },
      { extId: 'E-500', email: 'victim@corp.example', groups: ['fin-readers'] },
      { extId: 'E-600', email: 'gone@example.com' },
      { extId: 'E-700', email: 'linked@corp.example', groups: ['linked-g'] },
      { extId: 'E-800', email: 'unmatched@corp.example' },
      { extId: 'E-900', email: 'dup@corp.example', groups: ['dup-g'] },
      ...Array.from({ length: 12 }, (_, i) => ({ extId: `C-${String(i).padStart(2, '0')}`, email: 'team@corp.example', groups: ['crowd'] })),
    ],
  });
  await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
    domain: 'partners',
    runId: 'run-1',
    users: [
      { extId: 'P-1', email: 'ada@example.com', groups: ['p-g'] },
      { extId: 'P-2', upn: 'bob@corp.example' },
      { extId: 'P-3', email: 'dave@example.com', type: 'guest', groups: ['p-g2'] },
      { extId: 'P-4', email: 'dup@corp.example' },
    ],
  });

  const link = (domain: string, externalKind: 'user' | 'group', externalId: string, consoleKind: 'user' | 'group', consoleId: string) =>
    createRagIdentityLinkFor(ctx, { domain, externalKind, externalId, consoleKind, consoleId });
  await link('corp', 'user', 'E-700', 'user', String(people.linker._id));
  await link('corp', 'user', 'GHOST', 'user', String(people.linker._id));
  await link('corp', 'group', 'g-extra', 'user', String(people.linker._id));
  await link('corp', 'group', 'fin-wide', 'group', String(groups.Finance._id));
  await link('corp', 'group', 'ops-wide', 'group', String(groups.Ops._id));
  // The one way an account of a host application reaches a directory user, and a group.
  await link('corp', 'user', 'E-100', 'user', String(people.hostLinked._id));
  await link('corp', 'group', 'host-g', 'user', String(people.hostLinked._id));
  await link('partners', 'user', 'P-3', 'user', String(people.ada._id));
  await link('partners', 'group', 'p-fin', 'group', String(groups.Finance._id));
  // A disabled account linked to a user: it holds "everyone" only.
  await link('corp', 'user', 'E-400', 'user', String(people.gone._id));
  // Not a valid link (refused on create), but a row like this can exist: it must be ignored by both.
  await db.createRagIdentityLink({
    tenantId,
    domain: 'corp',
    externalKind: 'user',
    externalId: 'E-800',
    consoleKind: 'group',
    consoleId: String(groups.Finance._id),
    createdBy: 'seed',
  });
  // A link of a directory that no longer exists: not applied.
  await db.createRagIdentityLink({
    tenantId,
    domain: 'removed',
    externalKind: 'group',
    externalId: 'old',
    consoleKind: 'user',
    consoleId: String(people.ada._id),
    createdBy: 'seed',
  });

  world = await readWorld();
}, 30_000);

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the fixture covers every way a person is matched', () => {
  it('has a person for each case, and directories with the rows they need', () => {
    expect(world.users).toHaveLength(Object.keys(people).length);
    expect(world.domains.map((d) => d.key).sort()).toEqual(['corp', 'partners', 'sso-only']);
    expect(world.rowsByDomain.get('corp')).toHaveLength(21);
    expect(world.rowsByDomain.get('partners')).toHaveLength(4);
  });
});

describe('the keys and the record of how a person was matched', () => {
  it('are the same for every person, from the engine and from the kernel', async () => {
    const seen = new Set<string>();
    for (const user of world.users) {
      const real = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(user._id), { fresh: true });
      const kernel = kernelHolds(personOf(user));
      expect([...kernel.keys].sort(), `${user.name}: keys`).toEqual([...real.principals].sort());
      expect(kernel.matches.map(lineOf).sort(), `${user.name}: matches`).toEqual(real.matches.map(lineOf).sort());
      for (const m of real.matches) seen.add(m.via);
    }
    // Every way of being matched occurred at least once, so the comparison above was not vacuous.
    expect([...seen].sort()).toEqual(['external_id', 'group_external_id', 'link', 'rule']);
  });

  it('give an account of a host application its groups and its links, and no rule or external-id match', async () => {
    for (const name of ['host', 'hostLinked']) {
      const real = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people[name]._id), { fresh: true });
      const kernel = kernelHolds(personOf(people[name]));
      expect([...kernel.keys].sort()).toEqual([...real.principals].sort());
      expect(real.matches.filter((m) => m.via === 'rule' || m.via === 'external_id'), name).toEqual([]);
    }
    const linked = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.hostLinked._id), { fresh: true });
    expect(linked.principals).toEqual(expect.arrayContaining(['x:corp:u:E-100', 'x:corp:g:host-g', 'x:corp:all']));
    const claimed = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.host._id), { fresh: true });
    expect(claimed.principals.some((key) => key.includes('E-500'))).toBe(false);
  });

  it('keep at most ten matches of one rule, the first by id', async () => {
    const real = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.lead._id), { fresh: true });
    const rule = real.matches.find((m) => m.domain === 'corp' && m.via === 'rule');
    expect(rule?.externalIds).toEqual(Array.from({ length: 10 }, (_, i) => `C-${String(i).padStart(2, '0')}`));
    expect(kernelHolds(personOf(people.lead)).keys.sort()).toEqual([...real.principals].sort());
  });

  it('give a disabled account "everyone" and nothing else', async () => {
    const real = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.gone._id), { fresh: true });
    expect(real.principals).toEqual(['everyone']);
    expect(kernelHolds(personOf(people.gone)).keys).toEqual(['everyone']);
  });
});

describe('which console people a directory user is tied to', () => {
  const pairs = (index: Map<string, DirectoryMatch[]>, via: 'rule' | 'link'): string[] =>
    [...index].flatMap(([extId, matches]) => matches.filter((m) => m.via === via).map((m) => `${extId}|${m.userId}`)).sort();

  it('are the ones the engine matched by rule, in every directory', async () => {
    for (const domain of world.domains) {
      const rules = userMatchRulesOf(domain);
      const index = indexDirectoryMatches(
        world.users.map(personOf),
        { key: domain.key, rules, links: world.linksByDomain.get(domain.key) ?? [] },
        world.finderByDomain.get(domain.key) as DirectoryFinder,
      );
      const fromEngine: string[] = [];
      for (const user of world.users) {
        const real = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(user._id), { fresh: true });
        for (const m of real.matches) {
          if (m.domain === domain.key && m.via === 'rule') for (const extId of m.externalIds) fromEngine.push(`${extId}|${user._id}`);
        }
      }
      expect(pairs(index, 'rule'), domain.key).toEqual(fromEngine.sort());
    }
  });

  it('are, through links, the listed directory users the active people\'s user links name', () => {
    const corp = world.domains.find((d) => d.key === 'corp') as IRagIdentityDomain;
    const index = indexDirectoryMatches(
      world.users.map(personOf),
      { key: 'corp', rules: userMatchRulesOf(corp), links: world.linksByDomain.get('corp') ?? [] },
      world.finderByDomain.get('corp') as DirectoryFinder,
    );
    // linker -> E-700 and hostLinked -> E-100 count; GHOST is not in the directory and gone is disabled (E-400 stays rule-only).
    expect(pairs(index, 'link')).toEqual([`E-100|${people.hostLinked._id}`, `E-700|${people.linker._id}`].sort());
  });

  it('is the same count of people from the kernel\'s two ways of asking: who holds a key, and what a user is tied to', () => {
    const corp = world.domains.find((d) => d.key === 'corp') as IRagIdentityDomain;
    const all = world.users.map(personOf);
    const find = world.finderByDomain.get('corp') as DirectoryFinder;
    const held = new Map<string, string[]>();
    for (const p of all) if (p.active) held.set(p.userId, domainKeysOf(p, {
      key: 'corp', rules: userMatchRulesOf(corp), matchGroupsByExternalId: true, links: world.linksByDomain.get('corp') ?? [],
    }, find).keys);
    const holders = holdersByKey(held);
    const preview = previewUserMatch(userMatchRulesOf(corp), all, { key: 'corp', links: world.linksByDomain.get('corp') ?? [] }, find);
    // Everyone tied to a member by a rule or a link holds that member's key; so the people tied to a user are among its holders.
    for (const [extId, matches] of preview.byDirectoryUser) {
      const holding = new Set(holders.get(`x:corp:u:${extId}`) ?? []);
      for (const match of matches) expect(holding.has(match.userId), `${match.userId} holds x:corp:u:${extId}`).toBe(true);
    }
    expect(preview.matchedPeople).toBeGreaterThan(0);
    expect(preview.considered).toBe(all.filter((p) => p.active).length);
  });
});
