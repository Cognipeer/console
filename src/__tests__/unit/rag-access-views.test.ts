/**
 * The views behind the Access tab and the identity directory screens, over real SQLite: the summary of a knowledge
 * base, the permission state of listed rows, who a key stands for, the pickers, and the people, groups and links of
 * a directory with how they match console people - plus the two pieces a connector uses (the strict rule check and
 * the directory it keeps) and the cache that keeps the directory join for 30 seconds.
 *
 * The people: admin (workspace admin), ada (Finance), bob (SSO id E-200), carol (mixed-case address), dave (not in
 * the project), eve (in the project through the Eng group), gone (disabled), host (an account of a host application).
 * The directory "corp" has seven users; its rules match ada by e-mail, bob by SSO id, carol by e-mail (a guest), dave
 * by an attribute, and eve is linked by hand.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-views-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_views_main';

vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider, type IRagDocument, type IUser } from '@/lib/database';
import {
  DEFAULT_USER_MATCH,
  invalidateRagIdentityCache,
  ragIdentityCacheGeneration,
  userMatchRulesOf,
} from '@/lib/services/rag/access/identity';
import {
  RagAccessError,
  cleanUserMatchRules,
  createRagIdentityLinkFor,
  createRagModuleFolder,
  deleteRagIdentityLinkById,
  listRagModuleFolders,
  putRagIdentityDomain,
  setRagNodeAclFromConsole,
  syncRagIdentityUsers,
  upsertRagIdentityDomainFromSource,
  type RagAccessContext,
} from '@/lib/services/rag/ragAccessService';
import {
  MAX_AUDIENCE_PRINCIPALS,
  MAX_MATCHED_PEOPLE,
  getRagAccessAudience,
  getRagAccessSummary,
  getRagNodeStates,
  listRagIdentityGroups,
  listRagIdentityLinkViews,
  listRagIdentityPeople,
  previewRagIdentityMatch,
  resetRagAccessViewCaches,
  searchRagAccessPrincipals,
  searchRagConsolePeople,
} from '@/lib/services/rag/ragAccessViews';

const TENANT_DB_NAME = 'rag_views_tenant';
const KB = 'kb';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 800, chunkOverlap: 100 };

let db: DatabaseProvider;
let tenantId = 'pending';
let projectId = 'pending';
let otherProjectId = 'pending';
let ctx: RagAccessContext;
const people = {} as Record<'admin' | 'ada' | 'bob' | 'carol' | 'dave' | 'eve' | 'gone' | 'host', IUser>;
const groupIds = {} as Record<'Finance' | 'Eng' | 'Ops', string>;
const folders = {} as Record<'public' | 'finance' | 'q1' | 'board' | 'archive' | 'synced', string>;
const docs = {} as Record<'top' | 'public' | 'q1' | 'adaOnly' | 'oldClosed' | 'closed' | 'synced' | 'legacy', string>;
let foreignFolderId = 'pending';
let foreignDocId = 'pending';
let tokenId = 'pending';
const linkIds = {} as Record<'eve' | 'finance' | 'ghost', string>;

const id = (who: keyof typeof people): string => String(people[who]._id);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createModule = (key: string, extra: Record<string, unknown> = {}) => db.createRagModule({
  tenantId,
  projectId,
  key,
  name: key,
  embeddingModelKey: 'embed',
  vectorProviderKey: 'vec',
  vectorIndexKey: 'idx',
  chunkConfig: CHUNK_CONFIG,
  status: 'active',
  access: { enabled: true },
  createdBy: 'seed',
  ...extra,
} as never);

const createDoc = (moduleKey: string, fileName: string, extra: Partial<IRagDocument> = {}) => db.createRagDocument({
  tenantId,
  projectId,
  ragModuleKey: moduleKey,
  fileName,
  status: 'indexed',
  createdBy: 'seed',
  ...extra,
});

/** A module with `folders` closed folders (own permissions, no entry) and `documents` closed documents. */
async function closedModule(key: string, folderCount: number, documentCount: number): Promise<void> {
  await createModule(key);
  for (let i = 0; i < folderCount; i += 1) {
    await db.createRagFolder({ tenantId, projectId, ragModuleKey: key, name: `Folder ${String(i).padStart(2, '0')}`, aclMode: 'own', createdBy: 'seed' });
  }
  for (let i = 0; i < documentCount; i += 1) {
    const doc = await createDoc(key, `closed-${String(i).padStart(2, '0')}.md`);
    await db.updateRagDocument(String(doc._id), { aclMode: 'own' });
    await wait(2);
  }
}

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Views Test',
    slug: 'rag-views-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
  otherProjectId = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'seed' } as never))._id);

  const make = async (who: keyof typeof people, extra: Record<string, unknown> = {}) => {
    people[who] = await db.createUser({
      tenantId,
      email: `${who}@example.com`,
      name: who,
      password: '$2b$10$x',
      role: 'user',
      licenseId: 'FREE',
      features: [],
      ...extra,
    } as never);
  };
  await make('admin', { role: 'admin' });
  await make('ada');
  await make('bob', { email: 'bob@corp.example', externalId: 'E-200' });
  await make('carol', { email: 'Carol@Example.com' });
  await make('dave');
  await make('eve');
  await make('gone', { status: 'disabled' });
  await make('host', { kind: 'external', canLogin: false, email: 'victim@corp.example', externalId: 'E-300' });
  for (const who of ['ada', 'bob', 'carol', 'gone'] as const) {
    await db.upsertUserProject({ tenantId, userId: id(who), projectId, role: 'member' } as never);
  }

  const makeGroup = async (name: keyof typeof groupIds, externalId: string | undefined, members: Array<keyof typeof people>) => {
    const group = await db.createGroup({ tenantId, name, ...(externalId ? { externalId } : {}), createdBy: 'seed' });
    groupIds[name] = String(group._id);
    for (const member of members) await db.addGroupMember({ tenantId, groupId: groupIds[name], userId: id(member), role: 'member' });
  };
  await makeGroup('Finance', 'cn=finance', ['ada']);
  await makeGroup('Eng', undefined, ['eve']);
  await makeGroup('Ops', 'ops', []);
  await db.upsertGroupProject({ tenantId, groupId: groupIds.Eng, projectId, role: 'member' } as never);

  ctx = { tenantDbName: TENANT_DB_NAME, tenantId, projectId, actor: id('admin') };

  // The directory.
  await putRagIdentityDomain(ctx, {
    key: 'corp',
    label: 'Corp directory',
    userMatch: [
      { console: 'email', external: 'email' },
      { console: 'externalId', external: 'id' },
      { console: 'email', external: 'attr:mailAlias' },
    ],
  });
  await putRagIdentityDomain(ctx, { key: 'partners', label: 'Partners' });
  await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
    domain: 'corp',
    runId: 'run-1',
    users: [
      { extId: 'E-100', name: 'Ada Lovelace', email: 'ada@example.com', groups: ['fin-readers', 'ops'] },
      { extId: 'E-200', email: 'robert@corp.example', groups: ['fin-readers'] },
      { extId: 'E-300', email: 'carol@example.com', type: 'guest', groups: ['partners'] },
      { extId: 'E-400', attrs: { mailAlias: 'DAVE@example.com' }, groups: ['ops'] },
      { extId: 'E-500', email: 'victim@corp.example', groups: ['fin-readers'] },
      { extId: 'E-700', email: 'unmatched@corp.example' },
      { extId: 'E-800', email: 'eve-ext@corp.example' },
    ],
  });
  linkIds.eve = String((await createRagIdentityLinkFor(ctx, { domain: 'corp', externalKind: 'user', externalId: 'E-800', consoleKind: 'user', consoleId: id('eve') }))._id);
  await wait(5);
  linkIds.finance = String((await createRagIdentityLinkFor(ctx, { domain: 'corp', externalKind: 'group', externalId: 'fin-readers', consoleKind: 'group', consoleId: groupIds.Finance }))._id);
  await wait(5);
  linkIds.ghost = String((await createRagIdentityLinkFor(ctx, { domain: 'corp', externalKind: 'user', externalId: 'GHOST', consoleKind: 'user', consoleId: id('ada') }))._id);

  // The knowledge base.
  await createModule(KB);
  await createModule('kb-off', { access: undefined });
  await createModule('kb-foreign');
  folders.public = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Public' }))._id;
  folders.finance = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Finance' }))._id;
  folders.q1 = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Q1', parentId: folders.finance }))._id;
  folders.board = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Board' }))._id;
  folders.archive = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Archive' }))._id;
  folders.synced = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Synced' }))._id;
  foreignFolderId = (await createRagModuleFolder(ctx, { ragModuleKey: 'kb-foreign', name: 'Elsewhere' }))._id;

  docs.top = String((await createDoc(KB, 'top.md'))._id);
  docs.public = String((await createDoc(KB, 'public.md', { folderId: folders.public }))._id);
  docs.q1 = String((await createDoc(KB, 'q1.md', { folderId: folders.q1 }))._id);
  docs.adaOnly = String((await createDoc(KB, 'ada-only.md'))._id);
  docs.oldClosed = String((await createDoc(KB, 'old-closed.md'))._id);
  await wait(5);
  docs.closed = String((await createDoc(KB, 'closed.md'))._id);
  docs.synced = String((await createDoc(KB, 'synced.md', { folderId: folders.synced }))._id);
  docs.legacy = String((await createDoc(KB, 'legacy.md'))._id);
  foreignDocId = String((await createDoc('kb-foreign', 'elsewhere.md'))._id);

  const own = (node: { type: 'folder' | 'document'; id: string }, entries: unknown[]) =>
    setRagNodeAclFromConsole(ctx, { ragModuleKey: KB, node, mode: 'own', entries });
  await own({ type: 'folder', id: folders.finance }, [`group:${groupIds.Finance}`, { principal: 'x:corp:g:fin-readers', label: 'Finance readers' }]);
  await own({ type: 'folder', id: folders.board }, []);
  await own({ type: 'folder', id: folders.archive }, []);
  await own({ type: 'folder', id: folders.synced }, ['x:corp:all']);
  await db.updateRagFolder(folders.synced, { aclManaged: 'sync' });
  await own({ type: 'document', id: docs.adaOnly }, [`user:${id('ada')}`, { principal: 'x:corp:u:E-200', label: 'Robert (finance)' }]);
  await own({ type: 'document', id: docs.oldClosed }, []);
  await own({ type: 'document', id: docs.closed }, []);
  await own({ type: 'document', id: docs.synced }, [{ principal: 'x:corp:g:ops', label: 'Ops team' }]);
  await db.updateRagDocument(docs.synced, { aclManaged: 'sync' });
  await own({ type: 'document', id: docs.legacy }, [{ principal: 'x:corp:g:legacy-group', label: 'Legacy' }]);

  tokenId = String((await db.createApiToken({
    userId: id('ada'), tenantId, projectId, label: 'Reporting', tokenHash: 'secret-hash-1', tokenPrefix: 'cgp_ab12', createdBy: id('ada'),
  } as never))._id);
  await db.createApiToken({
    userId: id('ada'), tenantId, projectId, label: 'Old', tokenHash: 'secret-hash-2', tokenPrefix: 'cgp_old0', createdBy: id('ada'),
    expiresAt: new Date(Date.now() - 86_400_000),
  } as never);
  await db.createApiToken({
    userId: id('ada'), tenantId, projectId: otherProjectId, label: 'Elsewhere', tokenHash: 'secret-hash-3', tokenPrefix: 'cgp_oth0', createdBy: id('ada'),
  } as never);
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const refused = (code: string, statusCode: number) => expect.objectContaining({ name: 'RagAccessError', code, statusCode });

describe('cleanUserMatchRules', () => {
  it('returns the rules checked, each reduced to its two sides', () => {
    expect(cleanUserMatchRules([
      { console: 'email', external: 'email', extra: 'dropped' },
      { console: 'externalId', external: 'id' },
      { console: 'email', external: 'attr:mail.alias-1_x' },
    ])).toEqual([
      { console: 'email', external: 'email' },
      { console: 'externalId', external: 'id' },
      { console: 'email', external: 'attr:mail.alias-1_x' },
    ]);
  });

  it('takes an empty list (the default rules) and refuses anything that is no list, nothing sent included', () => {
    expect(cleanUserMatchRules([])).toEqual([]);
    for (const raw of [undefined, null, {}, 'email', 3, { length: 0 }]) {
      expect(() => cleanUserMatchRules(raw), String(raw)).toThrow(RagAccessError);
      try { cleanUserMatchRules(raw); } catch (error) { expect(error).toEqual(refused('domain_invalid', 400)); }
    }
  });

  it('refuses more than eight rules, a rule that compares nothing known, and an attribute name no store can look up', () => {
    const rule = { console: 'email', external: 'email' };
    expect(cleanUserMatchRules(Array.from({ length: 8 }, () => rule))).toHaveLength(8);
    expect(() => cleanUserMatchRules(Array.from({ length: 9 }, () => rule))).toThrow(/at most 8/);
    for (const bad of [
      { console: 'phone', external: 'email' },
      { console: 'email', external: 'phone' },
      { console: 'email', external: 'attr:' },
      { console: 'email', external: 'attr:has space' },
      { console: 'email', external: `attr:${'a'.repeat(65)}` },
      null,
      'email',
    ]) {
      expect(() => cleanUserMatchRules([bad]), JSON.stringify(bad)).toThrow(RagAccessError);
    }
  });
});

describe('upsertRagIdentityDomainFromSource', () => {
  const source = { tenantDbName: TENANT_DB_NAME, connector: 'conn-1', actor: 'system:connector:conn-1' };
  const sync = (input: Record<string, unknown>) => upsertRagIdentityDomainFromSource(source.tenantDbName, tenantId, {
    key: 'entra',
    label: 'Entra',
    connectorId: source.connector,
    actor: source.actor,
    ...input,
  } as never);

  it('refuses a rule list that is not valid, and writes nothing', async () => {
    await expect(sync({ userMatch: [{ console: 'email', external: 'phone' }] })).rejects.toEqual(refused('domain_invalid', 400));
    await expect(sync({ userMatch: 'email' })).rejects.toEqual(refused('domain_invalid', 400));
    expect(await db.findRagIdentityDomain('entra')).toBeNull();
  });

  it('keeps the rules and the group setting of the connector, owned by it', async () => {
    const created = await sync({
      userMatch: [{ console: 'externalId', external: 'attr:employeeId' }],
      matchGroupsByExternalId: false,
    });
    expect(created).toMatchObject({
      key: 'entra',
      source: { kind: 'connector', connectorId: 'conn-1' },
      userMatch: [{ console: 'externalId', external: 'attr:employeeId' }],
      matchGroupsByExternalId: false,
    });
    expect(userMatchRulesOf(created)).toEqual([{ console: 'externalId', external: 'attr:employeeId' }]);

    // Not sent: kept. A value that is no boolean is not a setting: kept as well.
    const again = await sync({ label: 'Entra ID', matchGroupsByExternalId: 'yes' });
    expect(again).toMatchObject({
      label: 'Entra ID',
      userMatch: [{ console: 'externalId', external: 'attr:employeeId' }],
      matchGroupsByExternalId: false,
    });
    const flipped = await sync({ matchGroupsByExternalId: true });
    expect(flipped.matchGroupsByExternalId).toBe(true);
    // An empty list is a setting too: the defaults.
    const defaults = await sync({ userMatch: [] });
    expect(defaults.userMatch).toEqual([]);
    expect(userMatchRulesOf(defaults)).toEqual([...DEFAULT_USER_MATCH]);
  });

  it('is refused for a directory another connector keeps', async () => {
    await expect(upsertRagIdentityDomainFromSource(TENANT_DB_NAME, tenantId, {
      key: 'entra', connectorId: 'conn-2', actor: 'system:connector:conn-2',
    })).rejects.toEqual(refused('domain_managed_by_source', 409));
  });
});

describe('ragIdentityCacheGeneration', () => {
  it('changes for a tenant when its identity cache is invalidated, and only then', () => {
    const before = ragIdentityCacheGeneration('tenant-a');
    const other = ragIdentityCacheGeneration('tenant-b');
    invalidateRagIdentityCache('tenant-a');
    expect(ragIdentityCacheGeneration('tenant-a')).not.toBe(before);
    expect(ragIdentityCacheGeneration('tenant-b')).toBe(other);
  });

  it('changes for every tenant, those never seen before included, when all are invalidated', () => {
    const seen = ragIdentityCacheGeneration('tenant-c');
    const unseen = ragIdentityCacheGeneration('tenant-never-invalidated');
    invalidateRagIdentityCache();
    expect(ragIdentityCacheGeneration('tenant-c')).not.toBe(seen);
    expect(ragIdentityCacheGeneration('tenant-never-invalidated')).not.toBe(unseen);
  });

  it('is moved by the writes that change a directory: rules, users, links', async () => {
    const generation = () => ragIdentityCacheGeneration(TENANT_DB_NAME);
    let last = generation();
    const moved = () => { const now = generation(); const did = now !== last; last = now; return did; };
    await putRagIdentityDomain(ctx, { key: 'corp', label: 'Corp directory' });
    expect(moved()).toBe(true);
    await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, { domain: 'partners', runId: 'r', users: [{ extId: 'P-1', email: 'p1@partner.example' }] });
    expect(moved()).toBe(true);
    const link = await createRagIdentityLinkFor(ctx, { domain: 'partners', externalKind: 'user', externalId: 'P-1', consoleKind: 'user', consoleId: id('dave') });
    expect(moved()).toBe(true);
    await deleteRagIdentityLinkById(ctx, String(link._id));
    expect(moved()).toBe(true);
  });
});

describe('the folder list', () => {
  it('counts the documents directly in each folder', async () => {
    const list = await listRagModuleFolders(ctx, KB);
    const byName = Object.fromEntries(list.map((f) => [f.name, f]));
    expect(byName.Public.documents).toBe(1);
    expect(byName.Q1.documents).toBe(1);
    expect(byName.Synced.documents).toBe(1);
    expect(byName.Finance.documents).toBe(0);
    expect(byName.Board.documents).toBe(0);
    expect(list.every((f) => f.pathOnly === undefined)).toBe(true);
    expect(list.map((f) => f.path)).toEqual([...list.map((f) => f.path)].sort((a, b) => a.localeCompare(b)));
  });

  it('leaves the documents out of a created folder, which is a new empty one', async () => {
    const created = await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Scratch' });
    expect(created.documents).toBeUndefined();
    expect(created.pathOnly).toBeUndefined();
    const listed = (await listRagModuleFolders(ctx, KB)).find((f) => f.name === 'Scratch');
    expect(listed?.documents).toBe(0);
    await db.deleteRagFolder(created._id);
  });
});

describe('the summary of the Access tab', () => {
  it('counts folders and documents, lists what nobody can read, and names the directories the permissions use', async () => {
    const summary = await getRagAccessSummary(ctx, KB);
    expect(summary).toMatchObject({
      enabled: true,
      adminBypass: true,
      root: { entries: 0, openToEveryone: true },
      folders: { total: 6, own: 4, synced: 1, closed: 2 },
      documents: { total: 8, own: 5, synced: 1, closed: 2 },
      closedComplete: true,
      // Documents naming a corp key: ada-only.md (E-200), synced.md (ops) and legacy.md (a group nobody has);
      // folders: Finance (fin-readers) and Synced (everyone in corp).
      directories: [{ key: 'corp', label: 'Corp directory', documents: 3, folders: 2 }],
    });
    // Closed folders first, by path; then closed documents, newest first.
    expect(summary.closed).toEqual([
      { type: 'folder', id: folders.archive, name: 'Archive', path: 'Archive' },
      { type: 'folder', id: folders.board, name: 'Board', path: 'Board' },
      { type: 'document', id: docs.closed, name: 'closed.md' },
      { type: 'document', id: docs.oldClosed, name: 'old-closed.md' },
    ]);
  });

  it('shows a root that names people as not open to everyone, and the admin exception turned off', async () => {
    await setRagNodeAclFromConsole(ctx, { ragModuleKey: KB, node: { type: 'module', id: KB }, mode: 'own', entries: [`group:${groupIds.Eng}`] });
    try {
      expect((await getRagAccessSummary(ctx, KB)).root).toEqual({ entries: 1, openToEveryone: false });
    } finally {
      await setRagNodeAclFromConsole(ctx, { ragModuleKey: KB, node: { type: 'module', id: KB }, mode: 'own', entries: [] });
    }
    const moduleRow = (await db.findRagModuleByKey(KB, projectId))!;
    await db.updateRagModule(String(moduleRow._id), { access: { enabled: true, adminBypass: false } });
    try {
      expect(await getRagAccessSummary(ctx, KB)).toMatchObject({ enabled: true, adminBypass: false });
    } finally {
      await db.updateRagModule(String(moduleRow._id), { access: { enabled: true } });
    }
  });

  it('answers for a knowledge base with access control off, and refuses one that is not there', async () => {
    expect(await getRagAccessSummary(ctx, 'kb-off')).toMatchObject({
      enabled: false,
      adminBypass: true,
      root: { openToEveryone: true },
      folders: { total: 0, own: 0, synced: 0, closed: 0 },
      documents: { total: 0, own: 0, synced: 0, closed: 0 },
      closed: [],
      closedComplete: true,
      directories: [],
    });
    await expect(getRagAccessSummary(ctx, 'nope')).rejects.toEqual(refused('module_not_found', 404));
    await expect(getRagAccessSummary({ ...ctx, projectId: otherProjectId }, KB)).rejects.toEqual(refused('module_not_found', 404));
  });

  it('lists 50 closed items at most, and says when the list is not all of them', async () => {
    await closedModule('kb-fifty', 50, 0);
    const fifty = await getRagAccessSummary(ctx, 'kb-fifty');
    expect(fifty.closed).toHaveLength(50);
    expect(fifty.folders.closed).toBe(50);
    expect(fifty.closedComplete).toBe(true);

    await closedModule('kb-many', 51, 0);
    const many = await getRagAccessSummary(ctx, 'kb-many');
    expect(many.closed).toHaveLength(50);
    expect(many.folders.closed).toBe(51);
    expect(many.closedComplete).toBe(false);

    await closedModule('kb-docs', 0, 52);
    const documents = await getRagAccessSummary(ctx, 'kb-docs');
    expect(documents.documents).toMatchObject({ own: 52, closed: 52 });
    expect(documents.closed).toHaveLength(50);
    expect(documents.closed.every((item) => item.type === 'document')).toBe(true);
    expect(documents.closedComplete).toBe(false);
    // Newest first: the last created is the first listed.
    expect(documents.closed[0]).toMatchObject({ name: 'closed-51.md' });
  });

  it('fills the rest of the list with documents, and is complete only when no closed item is left out', async () => {
    await closedModule('kb-mix-a', 49, 1);
    const fits = await getRagAccessSummary(ctx, 'kb-mix-a');
    expect(fits.closed.map((item) => item.type)).toEqual([...Array(49).fill('folder'), 'document']);
    expect(fits.closedComplete).toBe(true);

    await closedModule('kb-mix-b', 49, 2);
    const cut = await getRagAccessSummary(ctx, 'kb-mix-b');
    expect(cut.closed).toHaveLength(50);
    expect(cut.closed[49]).toMatchObject({ type: 'document', name: 'closed-01.md' });
    expect(cut.closedComplete).toBe(false);
  });
});

describe('the permission state of listed rows', () => {
  it('answers mode, source and entries, keyed by kind and id', async () => {
    const nodes = await getRagNodeStates(ctx, KB, {
      folderIds: [folders.finance, folders.q1, folders.board, folders.synced],
      documentIds: [docs.adaOnly, docs.top, docs.synced, docs.closed],
    });
    expect(nodes).toEqual({
      [`folder:${folders.finance}`]: { mode: 'own', entries: 2 },
      [`folder:${folders.q1}`]: { mode: 'inherit', entries: 0 },
      [`folder:${folders.board}`]: { mode: 'own', entries: 0 },
      [`folder:${folders.synced}`]: { mode: 'own', managed: 'sync', entries: 1 },
      [`document:${docs.adaOnly}`]: { mode: 'own', entries: 2 },
      [`document:${docs.top}`]: { mode: 'inherit', entries: 0 },
      [`document:${docs.synced}`]: { mode: 'own', managed: 'sync', entries: 1 },
      [`document:${docs.closed}`]: { mode: 'own', entries: 0 },
    });
  });

  it('leaves out ids that are not in the knowledge base, however they look', async () => {
    const nodes = await getRagNodeStates(ctx, KB, {
      folderIds: [folders.finance, foreignFolderId, 'no-such-folder', '', '65f0c2a1e4b0a1b2c3d4e5f6'],
      documentIds: [docs.top, foreignDocId, 'no-such-document', 'not an id at all'],
    });
    expect(Object.keys(nodes).sort()).toEqual([`document:${docs.top}`, `folder:${folders.finance}`].sort());
  });

  it('asks for nothing when nothing is listed, and refuses a knowledge base that is not there', async () => {
    expect(await getRagNodeStates(ctx, KB, {})).toEqual({});
    expect(await getRagNodeStates(ctx, KB, { folderIds: [], documentIds: [] })).toEqual({});
    await expect(getRagNodeStates(ctx, 'nope', { folderIds: [folders.finance] })).rejects.toEqual(refused('module_not_found', 404));
  });

  it('looks at 500 ids of each kind at most', async () => {
    const many = Array.from({ length: 700 }, (_, i) => `ghost-${i}`);
    const nodes = await getRagNodeStates(ctx, KB, { folderIds: [...many, folders.finance], documentIds: many });
    // The real folder is the 701st id: past the limit, so it is not looked at.
    expect(nodes).toEqual({});
  });
});

describe('who a key stands for', () => {
  const ask = (keys: string[], directoryCounts = false) => getRagAccessAudience(ctx, KB, keys, { directoryCounts });

  it('names people, with their count: 1 for an active person, 0 for a disabled one or one who is gone', async () => {
    const audience = await ask(['everyone', `user:${id('ada')}`, `user:${id('gone')}`, 'user:no-such-user', `user:${id('host')}`]);
    expect(audience.everyone).toEqual({ kind: 'everyone', exists: true, people: null });
    expect(audience[`user:${id('ada')}`]).toEqual({ kind: 'user', label: 'ada', detail: 'ada@example.com', exists: true, people: 1 });
    expect(audience[`user:${id('gone')}`]).toMatchObject({ kind: 'user', exists: true, people: 0 });
    expect(audience['user:no-such-user']).toEqual({ kind: 'user', exists: false, people: 0 });
    // A person of a host application is a person too: the key reaches them.
    expect(audience[`user:${id('host')}`]).toMatchObject({ exists: true, people: 1 });
  });

  it('counts the active members of a group', async () => {
    const audience = await ask([`group:${groupIds.Finance}`, `group:${groupIds.Ops}`, 'group:no-such-group']);
    expect(audience[`group:${groupIds.Finance}`]).toEqual({ kind: 'group', label: 'Finance', exists: true, people: 1 });
    expect(audience[`group:${groupIds.Ops}`]).toMatchObject({ exists: true, people: 0 });
    expect(audience['group:no-such-group']).toEqual({ kind: 'group', exists: false, people: 0 });
    // A disabled member does not count.
    await db.addGroupMember({ tenantId, groupId: groupIds.Ops, userId: id('gone'), role: 'member' });
    await db.addGroupMember({ tenantId, groupId: groupIds.Ops, userId: id('dave'), role: 'member' });
    try {
      expect((await ask([`group:${groupIds.Ops}`]))[`group:${groupIds.Ops}`].people).toBe(1);
    } finally {
      await db.removeGroupMember(groupIds.Ops, id('gone'));
      await db.removeGroupMember(groupIds.Ops, id('dave'));
    }
  });

  it('names a token by its label and visible prefix, never counts it, and shows no secret', async () => {
    const audience = await ask([`token:${tokenId}`, 'token:no-such-token']);
    expect(audience[`token:${tokenId}`]).toEqual({ kind: 'token', label: 'Reporting', detail: 'cgp_ab12', exists: true, people: null });
    expect(audience['token:no-such-token']).toEqual({ kind: 'token', exists: false, people: null });
    expect(JSON.stringify(audience)).not.toContain('secret-hash');
  });

  it('counts the active people who have an address; not the accounts of host applications, whose address is only claimed', async () => {
    const audience = await ask(['email:carol@example.com', 'email:Carol@Example.com', 'email:victim@corp.example', 'email:nobody@example.com']);
    expect(audience['email:carol@example.com']).toEqual({ kind: 'email', label: 'carol@example.com', exists: true, people: 1 });
    expect(audience['email:Carol@Example.com']).toMatchObject({ label: 'carol@example.com', people: 1 });
    expect(audience['email:victim@corp.example'].people).toBe(0);
    expect(audience['email:nobody@example.com'].people).toBe(0);
  });

  it('counts the people a directory key reaches, for the workspace\'s admins', async () => {
    const audience = await ask([
      'x:corp:all', 'x:corp:u:E-100', 'x:corp:u:E-200', 'x:corp:u:E-500', 'x:corp:g:fin-readers', 'x:corp:g:ops',
      'x:corp:g:legacy-group', 'x:corp:u:E-NOBODY', 'x:nope:all', 'x:nope:u:1',
    ], true);
    // ada, bob, dave (members) and eve (by her link); carol is a guest.
    expect(audience['x:corp:all']).toEqual({ kind: 'external_all', label: 'All members', detail: 'Corp directory', exists: true, people: 4 });
    expect(audience['x:corp:u:E-100']).toEqual({ kind: 'external_user', label: 'Ada Lovelace', detail: 'Corp directory', exists: true, people: 1 });
    // The directory user has no name: its address. The label stored on a permission is the fallback, not the first choice.
    expect(audience['x:corp:u:E-200']).toMatchObject({ label: 'robert@corp.example', people: 1 });
    // E-500 carries the address an account of a host application claims: nobody is matched to it.
    expect(audience['x:corp:u:E-500']).toMatchObject({ exists: true, people: 0 });
    // ada and bob through the directory, and ada again through the Finance group that is linked to it.
    expect(audience['x:corp:g:fin-readers']).toEqual({ kind: 'external_group', label: 'Finance readers', detail: 'Corp directory', exists: true, people: 2 });
    expect(audience['x:corp:g:ops']).toMatchObject({ label: 'Ops team', people: 2 });
    expect(audience['x:corp:g:legacy-group']).toMatchObject({ label: 'Legacy', people: 0 });
    expect(audience['x:corp:u:E-NOBODY']).toMatchObject({ exists: true, people: 0 });
    expect(audience['x:nope:all']).toEqual({ kind: 'external_all', label: 'All members', exists: false, people: 0 });
    expect(audience['x:nope:u:1']).toEqual({ kind: 'external_user', exists: false, people: 0 });
  });

  it('counts nothing of a directory for anyone else, and takes no name from it', async () => {
    const audience = await ask(['x:corp:all', 'x:corp:u:E-100', 'x:corp:u:E-200', 'x:corp:g:fin-readers', 'x:nope:all']);
    expect(audience['x:corp:all']).toEqual({ kind: 'external_all', label: 'All members', detail: 'Corp directory', exists: true, people: null });
    // E-100 has no stored label; E-200 has one on a permission.
    expect(audience['x:corp:u:E-100']).toEqual({ kind: 'external_user', detail: 'Corp directory', exists: true, people: null });
    expect(audience['x:corp:u:E-200']).toEqual({ kind: 'external_user', label: 'Robert (finance)', detail: 'Corp directory', exists: true, people: null });
    expect(audience['x:corp:g:fin-readers']).toMatchObject({ label: 'Finance readers', people: null });
    expect(audience['x:nope:all']).toMatchObject({ exists: false, people: null });
    expect(JSON.stringify(audience)).not.toContain('Ada Lovelace');
  });

  it('takes a stored name only from this knowledge base for anyone else; a workspace admin reads every one, a source\'s first', async () => {
    const row = (principal: string, label: string, project: string, managed?: 'sync') =>
      ({ tenantId, projectId: project, principal, label, ...(managed ? { managed } : {}), createdBy: 'seed' });
    const put = (moduleKey: string, nodeId: string, rows: ReturnType<typeof row>[], project = projectId) =>
      db.replaceRagAclEntries(moduleKey, { type: 'folder', id: nodeId }, rows as never, project);
    const keys = ['x:corp:g:elsewhere', 'x:corp:g:other-project', 'x:corp:g:payroll'];
    try {
      await put('kb-foreign', 'labels-foreign', [row('x:corp:g:elsewhere', 'Elsewhere only', projectId)]);
      // The same key of knowledge base in another project.
      await put(KB, 'labels-other-project', [row('x:corp:g:other-project', 'Other project', otherProjectId)], otherProjectId);
      await put(KB, 'labels-synced', [row('x:corp:g:payroll', 'Payroll', projectId, 'sync')]);
      await put(KB, 'labels-console', [row('x:corp:g:payroll', 'zzz Payroll', projectId)]);

      const member = await ask(keys);
      expect(member['x:corp:g:elsewhere']).toEqual({ kind: 'external_group', detail: 'Corp directory', exists: true, people: null });
      expect(member['x:corp:g:other-project']).toEqual({ kind: 'external_group', detail: 'Corp directory', exists: true, people: null });
      expect(member['x:corp:g:payroll']).toMatchObject({ label: 'Payroll' });

      const admin = await ask(keys, true);
      expect(admin['x:corp:g:elsewhere']).toMatchObject({ label: 'Elsewhere only' });
      expect(admin['x:corp:g:other-project']).toMatchObject({ label: 'Other project' });
      expect(admin['x:corp:g:payroll']).toMatchObject({ label: 'Payroll' });
    } finally {
      await put('kb-foreign', 'labels-foreign', []);
      await put(KB, 'labels-other-project', [], otherProjectId);
      await put(KB, 'labels-synced', []);
      await put(KB, 'labels-console', []);
    }
  });

  it('is keyed by the key as asked; keys that are no principal are left out; at most 1000 are looked at', async () => {
    const audience = await ask(['user:', 'bogus', 'x:Bad Dir:all', '', 'x:corp:z:1', 'group:', `group:${groupIds.Finance}`, `group:${groupIds.Finance}`]);
    expect(Object.keys(audience)).toEqual([`group:${groupIds.Finance}`]);
    const many = await ask(Array.from({ length: MAX_AUDIENCE_PRINCIPALS + 1 }, (_, i) => `user:ghost-${i}`));
    expect(Object.keys(many)).toHaveLength(MAX_AUDIENCE_PRINCIPALS);
    expect(many[`user:ghost-${MAX_AUDIENCE_PRINCIPALS}`]).toBeUndefined();
    expect(await ask([])).toEqual({});
  });

  it('refuses a knowledge base that is not there', async () => {
    await expect(getRagAccessAudience(ctx, 'nope', ['everyone'])).rejects.toEqual(refused('module_not_found', 404));
  });
});

describe('the pickers', () => {
  const names = (items: Array<{ label: string }>) => items.map((i) => i.label);

  it('offers the people who can open the project: members, people of an assigned group, owners and admins', async () => {
    const items = await searchRagAccessPrincipals(ctx, KB, { type: 'user' });
    // dave is in no group or project, gone is disabled, host is an account of a host application.
    expect(names(items)).toEqual(['ada', 'admin', 'bob', 'carol', 'eve']);
    expect(items[0]).toEqual({ principal: `user:${id('ada')}`, kind: 'user', label: 'ada', detail: 'ada@example.com' });
  });

  it('searches by name or address and keeps the limit between 1 and 50', async () => {
    expect(names(await searchRagAccessPrincipals(ctx, KB, { type: 'user', q: 'car' }))).toEqual(['carol']);
    expect(names(await searchRagAccessPrincipals(ctx, KB, { type: 'user', q: '  corp.example ' }))).toEqual(['bob']);
    expect(await searchRagAccessPrincipals(ctx, KB, { type: 'user', q: 'dave' })).toEqual([]);
    expect(await searchRagAccessPrincipals(ctx, KB, { type: 'user', limit: 2 })).toHaveLength(2);
    expect(await searchRagAccessPrincipals(ctx, KB, { type: 'user', limit: 0 })).toHaveLength(1);
    expect(await searchRagAccessPrincipals(ctx, KB, { type: 'user', limit: -5 })).toHaveLength(1);
    expect(await searchRagAccessPrincipals(ctx, KB, { type: 'user', limit: 100_000 })).toHaveLength(5);
  });

  it('offers groups with how many people are in them', async () => {
    const items = await searchRagAccessPrincipals(ctx, KB, { type: 'group' });
    expect(items).toEqual(expect.arrayContaining([
      { principal: `group:${groupIds.Finance}`, kind: 'group', label: 'Finance', detail: '1 person' },
      { principal: `group:${groupIds.Eng}`, kind: 'group', label: 'Eng', detail: '1 person' },
      { principal: `group:${groupIds.Ops}`, kind: 'group', label: 'Ops', detail: '0 people' },
    ]));
    expect(names(await searchRagAccessPrincipals(ctx, KB, { type: 'group', q: 'fin' }))).toEqual(['Finance']);
  });

  it('offers the active tokens of the project by label and prefix, with no secret', async () => {
    const items = await searchRagAccessPrincipals(ctx, KB, { type: 'token' });
    expect(items).toEqual([{ principal: `token:${tokenId}`, kind: 'token', label: 'Reporting', detail: 'cgp_ab12' }]);
    expect(JSON.stringify(items)).not.toContain('secret-hash');
    expect(names(await searchRagAccessPrincipals(ctx, KB, { type: 'token', q: 'nothing' }))).toEqual([]);
  });

  it('offers console people and groups of the whole workspace to link to a directory', async () => {
    const users = await searchRagConsolePeople(ctx, { type: 'user' });
    expect(names(users)).toEqual(['ada', 'admin', 'bob', 'carol', 'dave', 'eve']);
    expect(users[0]).toEqual({ id: id('ada'), kind: 'user', label: 'ada', detail: 'ada@example.com' });
    expect(names(await searchRagConsolePeople(ctx, { type: 'user', q: 'dav' }))).toEqual(['dave']);
    const groups = await searchRagConsolePeople(ctx, { type: 'group', q: 'e' });
    expect(groups).toEqual(expect.arrayContaining([{ id: groupIds.Eng, kind: 'group', label: 'Eng', detail: '1 person' }]));
  });

  it('refuses a knowledge base that is not there', async () => {
    await expect(searchRagAccessPrincipals(ctx, 'nope', { type: 'user' })).rejects.toEqual(refused('module_not_found', 404));
  });
});

describe('the people of a directory', () => {
  const peopleOf = async (options: Parameters<typeof listRagIdentityPeople>[2] = {}) => listRagIdentityPeople(ctx, 'corp', options);

  it('shows each user with the console people it is tied to, and how', async () => {
    const page = await peopleOf();
    const byId = Object.fromEntries(page.users.map((u) => [u.extId, u]));
    expect(page.total).toBe(7);
    expect(byId['E-100']).toMatchObject({
      name: 'Ada Lovelace', email: 'ada@example.com', type: 'member', groups: 2,
      console: [{ userId: id('ada'), name: 'ada', email: 'ada@example.com', via: 'rule', rule: 0 }],
    });
    expect(byId['E-200'].console).toEqual([{ userId: id('bob'), name: 'bob', email: 'bob@corp.example', via: 'rule', rule: 1 }]);
    expect(byId['E-300']).toMatchObject({ type: 'guest', console: [{ userId: id('carol'), via: 'rule', rule: 0 }] });
    expect(byId['E-400'].console).toEqual([{ userId: id('dave'), name: 'dave', email: 'dave@example.com', via: 'rule', rule: 2 }]);
    expect(byId['E-800'].console).toEqual([{ userId: id('eve'), name: 'eve', email: 'eve@example.com', via: 'link', linkId: linkIds.eve }]);
    // The address on E-500 is what an account of a host application claims: it is nobody's.
    expect(byId['E-500'].console).toEqual([]);
    expect(byId['E-700'].console).toEqual([]);
  });

  it('totals the whole directory, whatever the page shows', async () => {
    const page = await peopleOf({ limit: 2 });
    expect(page.users).toHaveLength(2);
    expect(page.summary).toEqual({
      directoryUsers: 7,
      matchedUsers: 5,
      consolePeople: 6,
      matchedPeople: 5,
      groups: 4,
      rules: [
        { console: 'email', external: 'email' },
        { console: 'externalId', external: 'id' },
        { console: 'email', external: 'attr:mailAlias' },
      ],
      defaults: false,
      matchGroupsByExternalId: true,
    });
    const filtered = await peopleOf({ search: 'robert' });
    expect(filtered.users.map((u) => u.extId)).toEqual(['E-200']);
    expect(filtered.total).toBe(1);
    expect(filtered.summary.directoryUsers).toBe(7);
  });

  it('keeps the matched or the unmatched users, pages them, and searches', async () => {
    const matched = await peopleOf({ filter: 'matched' });
    expect(matched.users.map((u) => u.extId).sort()).toEqual(['E-100', 'E-200', 'E-300', 'E-400', 'E-800']);
    expect(matched.total).toBe(5);
    const unmatched = await peopleOf({ filter: 'unmatched' });
    expect(unmatched.users.map((u) => u.extId).sort()).toEqual(['E-500', 'E-700']);
    expect(unmatched.total).toBe(2);
    const first = await peopleOf({ limit: 3 });
    const second = await peopleOf({ limit: 3, offset: 3 });
    const third = await peopleOf({ limit: 3, offset: 6 });
    expect([...first.users, ...second.users, ...third.users].map((u) => u.extId).sort())
      .toEqual(['E-100', 'E-200', 'E-300', 'E-400', 'E-500', 'E-700', 'E-800']);
    expect(await peopleOf({ filter: 'matched', search: 'carol' })).toMatchObject({ total: 1, users: [{ extId: 'E-300' }] });
    expect(await peopleOf({ filter: 'unmatched', search: 'carol' })).toMatchObject({ total: 0, users: [] });
  });

  it('shows the default rules for a directory that stores none, and says so', async () => {
    const page = await listRagIdentityPeople(ctx, 'partners');
    expect(page.summary).toMatchObject({ defaults: true, rules: [...DEFAULT_USER_MATCH], directoryUsers: expect.any(Number) });
  });

  it('refuses a directory that is not there', async () => {
    await expect(listRagIdentityPeople(ctx, 'nope')).rejects.toEqual(refused('domain_not_found', 404));
    await expect(listRagIdentityPeople(ctx, '')).rejects.toEqual(refused('domain_not_found', 404));
  });
});

describe('what unsaved rules would match', () => {
  const preview = (userMatch: unknown, extra: Record<string, unknown> = {}) =>
    previewRagIdentityMatch(ctx, 'corp', { userMatch, ...extra } as never);

  it('counts users and people for the rules as typed, and lists the users nobody matches', async () => {
    const result = await preview([{ console: 'email', external: 'email' }]);
    // ada and carol by e-mail; eve is linked by hand.
    expect(result).toMatchObject({
      rules: [{ console: 'email', external: 'email' }],
      directoryUsers: 7,
      matchedUsers: 3,
      consolePeople: 6,
      matchedPeople: 3,
      decidedByRule: [2],
    });
    expect(result.unmatchedUsers.map((u) => u.extId).sort()).toEqual(['E-200', 'E-400', 'E-500', 'E-700']);
    expect(result.unmatchedUsers.find((u) => u.extId === 'E-500')).toEqual({ extId: 'E-500', email: 'victim@corp.example', type: 'member' });
    expect(result.truncated).toBeUndefined();
  });

  it('previews the default rules for an empty list, and an SSO-id rule on its own', async () => {
    const defaults = await preview([]);
    expect(defaults.rules).toEqual([...DEFAULT_USER_MATCH]);
    expect(defaults.matchedUsers).toBe(3);
    expect(defaults.decidedByRule).toEqual([2, 0]);
    const byId = await preview([{ console: 'externalId', external: 'id' }]);
    expect(byId).toMatchObject({ matchedUsers: 2, matchedPeople: 2, decidedByRule: [1] });
    const aliases = await preview([{ console: 'email', external: 'attr:mailAlias' }, { console: 'email', external: 'email' }]);
    expect(aliases.decidedByRule).toEqual([1, 2]);
  });

  it('changes nothing that is stored', async () => {
    await preview([{ console: 'externalId', external: 'id' }]);
    const stored = await db.findRagIdentityDomain('corp');
    expect(stored?.userMatch).toHaveLength(3);
  });

  it('lists 20 unmatched users at most, ordered by address', async () => {
    await putRagIdentityDomain(ctx, { key: 'crowd', label: 'Crowd', userMatch: [{ console: 'email', external: 'email' }] });
    await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
      domain: 'crowd',
      runId: 'r',
      users: Array.from({ length: 30 }, (_, i) => ({ extId: `K-${i}`, email: `user${String(i).padStart(2, '0')}@crowd.example` })),
    });
    const result = await previewRagIdentityMatch(ctx, 'crowd', { userMatch: [{ console: 'email', external: 'email' }] });
    expect(result.directoryUsers).toBe(30);
    expect(result.matchedUsers).toBe(0);
    expect(result.unmatchedUsers).toHaveLength(20);
    expect(result.unmatchedUsers.map((u) => u.email)).toEqual(Array.from({ length: 20 }, (_, i) => `user${String(i).padStart(2, '0')}@crowd.example`));
  });

  it('checks the rules like a saved list, and the flag, before it looks at the directory', async () => {
    for (const bad of [undefined, null, 'email', [{ console: 'phone', external: 'email' }], Array.from({ length: 9 }, () => ({ console: 'email', external: 'email' }))]) {
      await expect(preview(bad), JSON.stringify(bad)).rejects.toEqual(refused('domain_invalid', 400));
    }
    await expect(preview([], { matchGroupsByExternalId: 'yes' })).rejects.toEqual(refused('domain_invalid', 400));
    await expect(preview([], { matchGroupsByExternalId: false })).resolves.toMatchObject({ directoryUsers: 7 });
    await expect(previewRagIdentityMatch(ctx, 'nope', { userMatch: [] })).rejects.toEqual(refused('domain_not_found', 404));
    await expect(previewRagIdentityMatch(ctx, 'nope', { userMatch: 'x' })).rejects.toEqual(refused('domain_invalid', 400));
  });
});

describe('the groups of a directory', () => {
  const groupsOf = (options: Parameters<typeof listRagIdentityGroups>[2] = {}) => listRagIdentityGroups(ctx, 'corp', options);

  it('lists the groups its users belong to and those a permission names, by name, with who stands for them', async () => {
    const { groups, total } = await groupsOf();
    expect(total).toBe(4);
    expect(groups).toEqual([
      { id: 'fin-readers', name: 'Finance readers', users: 3, console: [{ id: groupIds.Finance, name: 'Finance', via: 'link', linkId: linkIds.finance }] },
      { id: 'legacy-group', name: 'Legacy', users: 0, console: [] },
      { id: 'ops', name: 'Ops team', users: 2, console: [{ id: groupIds.Ops, name: 'Ops', via: 'external_id' }] },
      { id: 'partners', users: 1, console: [] },
    ]);
  });

  it('searches name and id ignoring case, and pages', async () => {
    expect((await groupsOf({ search: 'FIN' })).groups.map((g) => g.id)).toEqual(['fin-readers']);
    expect((await groupsOf({ search: 'partn' })).total).toBe(1);
    expect((await groupsOf({ search: 'nothing' }))).toEqual({ groups: [], total: 0 });
    const page = await groupsOf({ limit: 2, offset: 2 });
    expect(page.groups.map((g) => g.id)).toEqual(['ops', 'partners']);
    expect(page.total).toBe(4);
    expect((await groupsOf({ limit: 1 })).groups).toHaveLength(1);
  });

  it('lets a console group stand for a directory group by external id only while the directory allows it', async () => {
    await putRagIdentityDomain(ctx, { key: 'corp', matchGroupsByExternalId: false });
    try {
      const { groups } = await groupsOf();
      expect(groups.find((g) => g.id === 'ops')?.console).toEqual([]);
      expect(groups.find((g) => g.id === 'fin-readers')?.console).toHaveLength(1);
    } finally {
      await putRagIdentityDomain(ctx, { key: 'corp', matchGroupsByExternalId: true });
    }
    expect((await groupsOf()).groups.find((g) => g.id === 'ops')?.console).toHaveLength(1);
  });

  it('refuses a directory that is not there', async () => {
    await expect(listRagIdentityGroups(ctx, 'nope')).rejects.toEqual(refused('domain_not_found', 404));
  });
});

describe('the links of a directory', () => {
  it('names both ends of each link, newest first, and leaves out a name that is gone', async () => {
    const links = await listRagIdentityLinkViews(ctx, 'corp');
    expect(links).toHaveLength(3);
    const byId = Object.fromEntries(links.map((l) => [l._id, l]));
    expect(byId[linkIds.eve]).toMatchObject({
      externalKind: 'user', externalId: 'E-800', externalName: 'eve-ext@corp.example',
      consoleKind: 'user', consoleId: id('eve'), consoleName: 'eve', consoleDetail: 'eve@example.com',
    });
    expect(byId[linkIds.finance]).toMatchObject({
      externalKind: 'group', externalId: 'fin-readers', externalName: 'Finance readers',
      consoleKind: 'group', consoleId: groupIds.Finance, consoleName: 'Finance', consoleDetail: '1 person',
    });
    expect(byId[linkIds.ghost].externalName).toBeUndefined();
    expect(byId[linkIds.ghost]).toMatchObject({ consoleName: 'ada' });
    const times = links.map((l) => Date.parse(l.createdAt as string));
    expect(times.every((t) => Number.isFinite(t))).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Times arrive as ISO strings.
    expect(links.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l.createdAt as string))).toBe(true);
  });

  it('shows a link whose console end was deleted, without its name', async () => {
    const stray = await db.createRagIdentityLink({
      tenantId, domain: 'corp', externalKind: 'group', externalId: 'ops', consoleKind: 'group', consoleId: 'deleted-group', createdBy: 'seed',
    });
    try {
      const view = (await listRagIdentityLinkViews(ctx, 'corp')).find((l) => l._id === String(stray._id));
      expect(view).toBeDefined();
      expect(view?.consoleName).toBeUndefined();
      expect(view?.consoleDetail).toBeUndefined();
      expect(view?.externalName).toBe('Ops team');
    } finally {
      await db.deleteRagIdentityLink(String(stray._id));
    }
  });

  it('refuses a directory that is not there, and lists nothing for one without links', async () => {
    await expect(listRagIdentityLinkViews(ctx, 'nope')).rejects.toEqual(refused('domain_not_found', 404));
    expect(await listRagIdentityLinkViews(ctx, 'crowd')).toEqual([]);
  });
});

describe('the directory join is kept for a while', () => {
  it('is built once for many views, shared by callers that arrive together, and again after an invalidation', async () => {
    resetRagAccessViewCaches();
    const spy = vi.spyOn(db, 'listGroupMembersByTenant');
    try {
      await Promise.all([listRagIdentityPeople(ctx, 'corp'), listRagIdentityGroups(ctx, 'corp'), listRagIdentityPeople(ctx, 'corp', { filter: 'matched' })]);
      await getRagAccessAudience(ctx, KB, ['x:corp:all'], { directoryCounts: true });
      expect(spy).toHaveBeenCalledTimes(1);

      invalidateRagIdentityCache('another-tenant');
      await listRagIdentityPeople(ctx, 'corp');
      expect(spy).toHaveBeenCalledTimes(1);

      invalidateRagIdentityCache(TENANT_DB_NAME);
      await listRagIdentityPeople(ctx, 'corp');
      expect(spy).toHaveBeenCalledTimes(2);

      // A write through the service drops it, and the next view sees it.
      const before = (await listRagIdentityPeople(ctx, 'corp')).summary.matchedPeople;
      const link = await createRagIdentityLinkFor(ctx, { domain: 'corp', externalKind: 'user', externalId: 'E-700', consoleKind: 'user', consoleId: id('admin') });
      try {
        expect((await listRagIdentityPeople(ctx, 'corp')).summary.matchedPeople).toBe(before + 1);
        expect(spy.mock.calls.length).toBeGreaterThan(2);
      } finally {
        await deleteRagIdentityLinkById(ctx, String(link._id));
      }
      expect((await listRagIdentityPeople(ctx, 'corp')).summary.matchedPeople).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('is built per list of rules: a preview does not replace what the saved rules show', async () => {
    resetRagAccessViewCaches();
    const saved = (await listRagIdentityPeople(ctx, 'corp')).summary.matchedUsers;
    await previewRagIdentityMatch(ctx, 'corp', { userMatch: [{ console: 'externalId', external: 'id' }] });
    expect((await listRagIdentityPeople(ctx, 'corp')).summary.matchedUsers).toBe(saved);
  });

  it('expires after 30 seconds', async () => {
    resetRagAccessViewCaches();
    const spy = vi.spyOn(db, 'listGroupMembersByTenant');
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      await listRagIdentityPeople(ctx, 'corp');
      vi.setSystemTime(Date.now() + 29_000);
      await listRagIdentityPeople(ctx, 'corp');
      expect(spy).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2_000);
      await listRagIdentityPeople(ctx, 'corp');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not keep a load that failed', async () => {
    resetRagAccessViewCaches();
    const spy = vi.spyOn(db, 'listGroupMembersByTenant').mockRejectedValueOnce(new Error('store unavailable'));
    try {
      await expect(listRagIdentityPeople(ctx, 'corp')).rejects.toThrow('store unavailable');
      await expect(listRagIdentityPeople(ctx, 'corp')).resolves.toMatchObject({ total: 7 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a workspace larger than the people limit', () => {
  /** A workspace of `total` active people the list pages through, and the real store for everything else. */
  const workspaceOf = (total: number) => {
    const real = db.iamListUsers.bind(db);
    return vi.spyOn(db, 'iamListUsers').mockImplementation(async (query) => {
      if (query.ids) return real(query);
      const offset = query.offset ?? 0;
      const items: IUser[] = [];
      for (let i = offset; i < Math.min(offset + query.limit, total); i += 1) {
        items.push({ _id: `bulk-${i}`, tenantId, email: `bulk${i}@bulk.example`, name: `Bulk ${i}`, status: 'active' } as unknown as IUser);
      }
      return { items, hasMore: offset + items.length < total };
    });
  };

  it('reads 50,000 people, and the answers say when there are more', async () => {
    resetRagAccessViewCaches();
    const spy = workspaceOf(MAX_MATCHED_PEOPLE + 1);
    try {
      const page = await listRagIdentityPeople(ctx, 'corp', { limit: 1 });
      // The people the links name (eve, ada) are fetched even though they are past the limit.
      expect(page.summary).toMatchObject({ truncated: true, consolePeople: MAX_MATCHED_PEOPLE + 2 });
      expect(await previewRagIdentityMatch(ctx, 'corp', { userMatch: [] })).toMatchObject({ truncated: true, consolePeople: MAX_MATCHED_PEOPLE + 2 });
    } finally {
      spy.mockRestore();
      resetRagAccessViewCaches();
    }
  }, 30_000);

  it('says nothing of it when the workspace is exactly as large as the limit', async () => {
    resetRagAccessViewCaches();
    const spy = workspaceOf(MAX_MATCHED_PEOPLE);
    try {
      const page = await listRagIdentityPeople(ctx, 'corp', { limit: 1 });
      expect(page.summary.consolePeople).toBe(MAX_MATCHED_PEOPLE + 2);
      expect(page.summary).not.toHaveProperty('truncated');
    } finally {
      spy.mockRestore();
      resetRagAccessViewCaches();
    }
  }, 30_000);
});

describe('the service barrel', () => {
  it('exports the views and the rule check for other packages', async () => {
    const barrel = await import('@/lib/services/rag');
    for (const name of [
      'getRagAccessSummary', 'getRagNodeStates', 'getRagAccessAudience', 'searchRagAccessPrincipals', 'searchRagConsolePeople',
      'listRagIdentityPeople', 'previewRagIdentityMatch', 'listRagIdentityGroups', 'listRagIdentityLinkViews',
      'cleanUserMatchRules', 'upsertRagIdentityDomainFromSource', 'listRagModuleFolders',
    ] as const) {
      expect(typeof barrel[name], name).toBe('function');
    }
  });
});
