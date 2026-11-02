/**
 * Who reads which document of a knowledge base with access control, decided
 * over real SQLite: folder inheritance, own permissions, the module root,
 * broken chains, managers with and without the admin exception, tokens,
 * delegated calls, anonymous callers — and how people are matched to the
 * users and groups of an identity directory (e-mail, UPN, external id,
 * attributes, group external ids, manual links).
 *
 * Every scope is also checked against the database: the filter a scope hands
 * to the store must select exactly the documents `canReadDocument` allows.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-scope-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_scope_main';

vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider, type IRagDocument, type IUser } from '@/lib/database';
import { invalidateRagIdentityCache, resolveCallerPrincipals, resolvePersonPrincipals } from '@/lib/services/rag/access/identity';
import { resolveRagAccess, type RagAccessScope } from '@/lib/services/rag/access/scope';
import type { KbCaller } from '@/lib/services/rag/access/caller';
import {
  createRagIdentityLinkFor,
  createRagModuleFolder,
  deleteRagIdentityLinkById,
  putRagIdentityDomain,
  setRagNodeAclFromConsole,
  syncRagIdentityUsers,
  type RagAccessContext,
} from '@/lib/services/rag/ragAccessService';
import { updateRagModule } from '@/lib/services/rag/ragService';

const TENANT_DB_NAME = 'rag_scope_tenant';
const KB = 'kb';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 800, chunkOverlap: 100 };

let db: DatabaseProvider;
let tenantId = 'pending';
let projectId = 'pending';
let ctx: RagAccessContext;
const people = {} as Record<'ada' | 'bob' | 'carol' | 'dave' | 'admin' | 'gone' | 'host' | 'hostMember' | 'shopper' | 'sso', IUser>;
let financeGroupId = 'pending';
const folders = {} as Record<'public' | 'finance' | 'q1' | 'board', string>;
const docs = {} as Record<'top' | 'public' | 'q1' | 'board' | 'adaOnly' | 'orphan', IRagDocument>;
const TOKEN_ID = 'tok-reporting';

const person = (who: keyof typeof people): KbCaller => ({ kind: 'person', userId: String(people[who]._id) });

async function scopeOf(caller: KbCaller): Promise<RagAccessScope> {
  const ragModule = (await db.findRagModuleByKey(KB, projectId))!;
  return resolveRagAccess({ tenantDbName: TENANT_DB_NAME, tenantId, module: ragModule, caller });
}

/** The documents a scope reads — asserted to be exactly what its database filter selects. */
async function readable(caller: KbCaller): Promise<string[]> {
  const scope = await scopeOf(caller);
  const fresh = await db.listRagDocuments(KB, { projectId });
  const byScope = (Object.keys(docs) as Array<keyof typeof docs>)
    .filter((name) => scope.canReadDocument(fresh.find((d) => String(d._id) === String(docs[name]._id))!))
    .sort();
  const filter = scope.documentFilter();
  if (filter) {
    const ids = new Set(await db.listRagDocumentIds(KB, { projectId, access: filter, limit: 100 }));
    const byDb = (Object.keys(docs) as Array<keyof typeof docs>).filter((name) => ids.has(String(docs[name]._id))).sort();
    expect(byDb, 'the database filter selects what canReadDocument allows').toEqual(byScope);
    const denied = new Set(await db.listRagDocumentIds(KB, { projectId, access: { ...filter, negate: true }, limit: 100 }));
    expect([...ids].filter((id) => denied.has(id)), 'a document is either readable or not').toEqual([]);
    expect(ids.size + denied.size).toBe(Object.keys(docs).length);
  }
  return byScope;
}

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Scope Test',
    slug: 'rag-scope-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);

  const make = async (who: keyof typeof people, extra: Record<string, unknown> = {}) => {
    people[who] = await db.createUser({
      tenantId,
      email: `${who}@example.com`,
      name: who,
      password: '$2b$10$x',
      role: 'user',
      licenseId: 'FREE',
      features: [],
      servicePermissions: { rag: 'read' },
      ...extra,
    } as never);
  };
  await make('ada');
  await make('bob', { email: 'bob@corp.example', externalId: 'E-200' });
  await make('carol', { email: 'Carol@Example.com' });
  await make('dave');
  await make('admin', { role: 'admin', servicePermissions: undefined });
  await make('gone', { status: 'disabled' });
  // Accounts of host applications (kind 'external'): the address on them is only what the application claimed.
  await make('host', {
    kind: 'external',
    canLogin: false,
    email: 'victim@corp.example',
    externalId: 'E-300',
    externalIds: { 'https://shop.example': 'E-200' },
  });
  await make('hostMember', { kind: 'external', canLogin: false, email: 'host-member@shop.example' });
  // A member whose host-application subjects look like ids of the directory, and one whose SSO id has no directory row.
  await make('shopper', { externalIds: { 'https://shop.example': 'E-200', 'https://other.example': 'NOROW-1' } });
  await make('sso', { externalId: 'NOROW-2' });

  const group = await db.createGroup({ tenantId, name: 'Finance', externalId: 'cn=finance', createdBy: 'seed' });
  financeGroupId = String(group._id);
  await db.addGroupMember({ tenantId, groupId: financeGroupId, userId: String(people.ada._id), role: 'member' });
  await db.addGroupMember({ tenantId, groupId: financeGroupId, userId: String(people.hostMember._id), role: 'member' });

  await db.createRagModule({
    tenantId,
    projectId,
    key: KB,
    name: 'Handbook',
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vec',
    vectorIndexKey: 'idx',
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    access: { enabled: true },
    createdBy: 'seed',
  });

  ctx = { tenantDbName: TENANT_DB_NAME, tenantId, projectId, actor: String(people.admin._id) };
  folders.public = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Public' }))._id;
  folders.finance = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Finance' }))._id;
  folders.q1 = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Q1', parentId: folders.finance }))._id;
  folders.board = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Board' }))._id;

  const doc = async (fileName: string, extra: Partial<IRagDocument> = {}) => db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: KB,
    fileName,
    status: 'indexed',
    createdBy: 'seed',
    ...extra,
  });
  docs.top = await doc('top.md');
  docs.public = await doc('public.md', { folderId: folders.public });
  docs.q1 = await doc('q1.md', { folderId: folders.q1 });
  docs.board = await doc('board.md', { folderId: folders.board });
  docs.adaOnly = await doc('ada-only.md');
  docs.orphan = await doc('orphan.md', { folderId: 'a-folder-that-was-deleted' });

  await putRagIdentityDomain(ctx, {
    key: 'corp',
    label: 'Corp directory',
    userMatch: [
      { console: 'email', external: 'email' },
      { console: 'externalId', external: 'id' },
      { console: 'email', external: 'attr:mailAlias' },
    ],
  });
  await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
    domain: 'corp',
    runId: 'run-1',
    users: [
      { extId: 'E-200', email: 'robert@corp.example', groups: ['fin-readers'] },
      { extId: 'E-300', email: 'carol@example.com', type: 'guest', groups: ['partners'] },
      { extId: 'E-400', attrs: { mailAlias: 'DAVE@example.com' }, groups: ['ops'] },
      { extId: 'E-500', email: 'victim@corp.example', groups: ['fin-readers'] },
    ],
  });

  await setRagNodeAclFromConsole(ctx, {
    ragModuleKey: KB,
    node: { type: 'folder', id: folders.finance },
    mode: 'own',
    entries: [`group:${financeGroupId}`, 'x:corp:g:fin-readers'],
  });
  await setRagNodeAclFromConsole(ctx, { ragModuleKey: KB, node: { type: 'folder', id: folders.board }, mode: 'own', entries: [] });
  await setRagNodeAclFromConsole(ctx, {
    ragModuleKey: KB,
    node: { type: 'document', id: String(docs.adaOnly._id) },
    mode: 'own',
    entries: [`user:${String(people.ada._id)}`],
  });
  // A token named directly (written as a token's sync would; the console checks tokens exist).
  await db.replaceRagAclEntries(KB, { type: 'document', id: String(docs.board._id) }, [
    { tenantId, projectId, principal: `token:${TOKEN_ID}`, createdBy: 'seed' },
  ], projectId);
  await db.updateRagDocument(String(docs.board._id), { aclMode: 'own' });
}, 30_000);

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('folder inheritance and own permissions', () => {
  it('an anonymous caller reads what the root opens to everyone, nothing else', async () => {
    expect(await readable({ kind: 'anonymous', reason: 'public' })).toEqual(['public', 'top']);
    expect(await readable({ kind: 'anonymous', reason: 'trigger' })).toEqual(['public', 'top']);
  });

  it('a group member reads the group\'s folder and what lies below it', async () => {
    expect(await readable(person('ada'))).toEqual(['adaOnly', 'public', 'q1', 'top']);
  });

  it('a folder with an empty own list and a document whose folder is gone are read by nobody', async () => {
    for (const caller of [person('ada'), person('bob'), person('dave')]) {
      const names = await readable(caller);
      expect(names).not.toContain('orphan');
    }
    expect(await readable(person('dave'))).not.toContain('board');
  });

  it('a disabled person is only "everyone"', async () => {
    const { principals } = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.gone._id), { fresh: true });
    expect(principals).toEqual(['everyone']);
    expect(await readable(person('gone'))).toEqual(['public', 'top']);
  });

  it('a change of permissions is seen by the next scope', async () => {
    await setRagNodeAclFromConsole(ctx, { ragModuleKey: KB, node: { type: 'folder', id: folders.public }, mode: 'own', entries: [`user:${String(people.dave._id)}`] });
    expect(await readable({ kind: 'anonymous', reason: 'public' })).toEqual(['top']);
    expect(await readable(person('dave'))).toEqual(['public', 'top']);
    await setRagNodeAclFromConsole(ctx, { ragModuleKey: KB, node: { type: 'folder', id: folders.public }, mode: 'inherit' });
    expect(await readable({ kind: 'anonymous', reason: 'public' })).toEqual(['public', 'top']);
  });

  it('permissions on the root close the top level and everything that inherits it', async () => {
    await setRagNodeAclFromConsole(ctx, { ragModuleKey: KB, node: { type: 'module', id: KB }, mode: 'own', entries: [`group:${financeGroupId}`] });
    try {
      expect(await readable({ kind: 'anonymous', reason: 'public' })).toEqual([]);
      expect(await readable(person('ada'))).toEqual(['adaOnly', 'public', 'q1', 'top']);
      // Finance has its own list: bob still reads Q1 through the directory group.
      expect(await readable(person('bob'))).toEqual(['q1']);
    } finally {
      await setRagNodeAclFromConsole(ctx, { ragModuleKey: KB, node: { type: 'module', id: KB }, mode: 'own', entries: [] });
    }
  });
});

describe('callers that are not a person acting for themselves', () => {
  it('a token reads what is open to everyone and what names the token', async () => {
    const caller: KbCaller = { kind: 'token', tokenId: TOKEN_ID, ownerUserId: String(people.ada._id) };
    const { principals } = await resolveCallerPrincipals(TENANT_DB_NAME, tenantId, caller);
    expect([...principals].sort()).toEqual(['everyone', `token:${TOKEN_ID}`]);
    // Never the owner's documents.
    expect(await readable(caller)).toEqual(['board', 'public', 'top']);
  });

  it('a delegated call reads as the person it acts for, never as the token, and never manages', async () => {
    const caller: KbCaller = { kind: 'person', userId: String(people.admin._id), tokenId: TOKEN_ID, delegated: true };
    const scope = await scopeOf(caller);
    expect(scope.manage).toBe(false);
    expect(scope.enforced).toBe(true);
    expect(scope.principals.has(`token:${TOKEN_ID}`)).toBe(false);
    expect(await readable({ kind: 'person', userId: String(people.ada._id), tokenId: TOKEN_ID, delegated: true }))
      .toEqual(['adaOnly', 'public', 'q1', 'top']);
  });
});

describe('Knowledge Engine admins', () => {
  it('read everything by default; management views show everything', async () => {
    const scope = await scopeOf(person('admin'));
    expect(scope).toMatchObject({ enabled: true, manage: true, bypass: true, enforced: false });
    expect(scope.managementFilter()).toBeUndefined();
  });

  it('without the admin exception they read by their own permissions, and still manage', async () => {
    const moduleId = String((await db.findRagModuleByKey(KB, projectId))!._id);
    await updateRagModule(TENANT_DB_NAME, moduleId, { access: { enabled: true, adminBypass: false }, updatedBy: 'admin' });
    try {
      const scope = await scopeOf(person('admin'));
      expect(scope).toMatchObject({ manage: true, bypass: false, enforced: true });
      expect(scope.managementFilter()).toBeUndefined();
      expect(await readable(person('admin'))).toEqual(['public', 'top']);
    } finally {
      await updateRagModule(TENANT_DB_NAME, moduleId, { access: { enabled: true }, updatedBy: 'admin' });
    }
  });

  it('a module without access control is open to every caller without any lookup', async () => {
    const scope = await resolveRagAccess({
      tenantDbName: TENANT_DB_NAME,
      tenantId,
      module: { key: 'plain', projectId },
      caller: { kind: 'anonymous', reason: 'public' },
    });
    expect(scope).toMatchObject({ enabled: false, enforced: false });
    expect(scope.documentFilter()).toBeUndefined();
    expect(scope.canReadDocument({ ...docs.board, ragModuleKey: 'plain' })).toBe(true);
    expect(scope.canReadDocument(docs.board)).toBe(false);
  });
});

describe('matching people to an identity directory', () => {
  it('by an external id: bob is directory user E-200 and gets its groups', async () => {
    const { principals, matches } = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.bob._id), { fresh: true });
    expect(principals).toEqual(expect.arrayContaining(['x:corp:u:E-200', 'x:corp:g:fin-readers', 'x:corp:all']));
    expect(matches).toEqual([expect.objectContaining({ domain: 'corp', via: 'rule', rule: { console: 'externalId', external: 'id' } })]);
    expect(await readable(person('bob'))).toEqual(['public', 'q1', 'top']);
  });

  it('by e-mail, case-insensitively; a guest does not get the directory-wide key', async () => {
    const { principals } = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.carol._id), { fresh: true });
    expect(principals).toEqual(expect.arrayContaining(['email:carol@example.com', 'x:corp:u:E-300', 'x:corp:g:partners']));
    expect(principals).not.toContain('x:corp:all');
  });

  it('by a directory attribute', async () => {
    const { principals } = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.dave._id), { fresh: true });
    expect(principals).toEqual(expect.arrayContaining(['x:corp:u:E-400', 'x:corp:g:ops', 'x:corp:all']));
  });

  it('a console group with an external id is that group of the directory', async () => {
    const { principals, matches } = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.ada._id), { fresh: true });
    expect(principals).toEqual(expect.arrayContaining([`group:${financeGroupId}`, 'x:corp:g:cn=finance']));
    expect(matches).toEqual(expect.arrayContaining([expect.objectContaining({ via: 'group_external_id', externalIds: ['cn=finance'] })]));
  });

  it('a manual link of a console group to a directory group reaches its members', async () => {
    await createRagIdentityLinkFor(ctx, {
      domain: 'corp',
      externalKind: 'group',
      externalId: 'board-members',
      consoleKind: 'group',
      consoleId: financeGroupId,
    });
    const { principals } = await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people.ada._id));
    expect(principals).toContain('x:corp:g:board-members');
    expect(await readable(person('dave'))).toEqual(['public', 'top']);
  });
});

describe('accounts of host applications', () => {
  const principalsOf = async (who: keyof typeof people) => resolvePersonPrincipals(TENANT_DB_NAME, tenantId, String(people[who]._id), { fresh: true });

  it('hold no e-mail key and match no directory user, whatever address, id or subject they carry', async () => {
    const host = await principalsOf('host');
    // Its address is a directory user's (E-500, in the group Finance names), and its ids are other directory users' (E-300, E-200).
    expect(host.principals.sort()).toEqual(['everyone', `user:${String(people.host._id)}`].sort());
    expect(host.matches).toEqual([]);
    expect(host).not.toHaveProperty('email');
    expect(await readable(person('host'))).toEqual(await readable({ kind: 'anonymous', reason: 'public' }));
  });

  it('would get all of that as an ordinary member: it is the kind of account that matters', async () => {
    const id = String(people.host._id);
    // The kind of an account never changes in practice; the principals of a person are remembered for a few seconds.
    const setKind = async (kind: 'member' | 'external') => {
      await db.updateUser(id, { kind });
      invalidateRagIdentityCache(TENANT_DB_NAME);
    };
    await setKind('member');
    try {
      const asMember = await principalsOf('host');
      expect(asMember.principals).toEqual(expect.arrayContaining([
        'email:victim@corp.example',
        'x:corp:u:E-500',
        'x:corp:g:fin-readers',
      ]));
      expect(await readable(person('host'))).toContain('q1');
    } finally {
      await setKind('external');
    }
    expect((await principalsOf('host')).principals).not.toContain('x:corp:g:fin-readers');
    expect(await readable(person('host'))).not.toContain('q1');
  });

  it('keep the keys of their console groups, which a folder may name', async () => {
    const { principals } = await principalsOf('hostMember');
    expect(principals).toEqual(expect.arrayContaining([`group:${financeGroupId}`, 'x:corp:g:cn=finance']));
    expect(principals.some((key) => key.startsWith('email:'))).toBe(false);
    expect(principals).not.toContain('x:corp:all');
    expect(await readable(person('hostMember'))).toEqual(['public', 'q1', 'top']);
  });

  it('are matched by a link an administrator made by hand, and by nothing else', async () => {
    const link = await createRagIdentityLinkFor(ctx, {
      domain: 'corp',
      externalKind: 'user',
      externalId: 'E-500',
      consoleKind: 'user',
      consoleId: String(people.host._id),
    });
    try {
      const { principals } = await principalsOf('host');
      expect(principals).toEqual(expect.arrayContaining(['x:corp:u:E-500', 'x:corp:g:fin-readers']));
      expect(await readable(person('host'))).toContain('q1');
    } finally {
      await deleteRagIdentityLinkById(ctx, String(link._id));
    }
    expect((await principalsOf('host')).principals).not.toContain('x:corp:u:E-500');
  });

  it('a subject a host application chose is never the id of a directory user — row or no row', async () => {
    const shopper = await principalsOf('shopper');
    // E-200 is a directory user (bob's); NOROW-1 is in no directory. Neither is the shopper's.
    expect(shopper.principals.some((key) => key.startsWith('x:corp:u:'))).toBe(false);
    expect(shopper.principals).not.toContain('x:corp:g:fin-readers');
    expect(shopper.matches).toEqual([]);
    expect(await readable(person('shopper'))).toEqual(['public', 'top']);
  });

  it('the SSO id of a member still counts, with a directory row or without one', async () => {
    const bob = await principalsOf('bob');
    expect(bob.principals).toContain('x:corp:u:E-200');
    const sso = await principalsOf('sso');
    expect(sso.principals).toContain('x:corp:u:NOROW-2');
    expect(sso.matches).toEqual([expect.objectContaining({ domain: 'corp', via: 'external_id', externalIds: ['NOROW-2'] })]);
  });
});
