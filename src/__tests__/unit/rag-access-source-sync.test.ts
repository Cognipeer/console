/**
 * What a connector's sync writes into a knowledge base with access control, through the integration API:
 *
 *  - the folders of a source path, every one of them by the source's own id (a rename or a move follows the source)
 *  - a folder's permissions: an unchanged write leaves the node, and the tree's revision, alone
 *  - an existing document put into its folder with its permissions; the document is the source's from then on
 *  - the directory's members (not its guests) and its groups decide who reads
 *
 * Real services over real SQLite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-source-sync-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_source_sync_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider, type IUser } from '@/lib/database';
import { resolveRagAccess } from '@/lib/services/rag/access/scope';
import {
  RagAccessError,
  ensureRagFolderChain,
  ensureRagFolderPath,
  placeRagDocumentFromSource,
  setRagNodeAcl,
  setRagNodeAclFromConsole,
  syncRagIdentityUsers,
  upsertRagIdentityDomainFromSource,
  type RagAccessContext,
} from '@/lib/services/rag/ragAccessService';

const TENANT_DB_NAME = 'rag_source_sync_tenant';
const KB = 'kb';
const DOMAIN = 'src-s1';
const SOURCE = { connectorId: 'c1', sourceId: 's1' };
const ACTOR = 'system:connectors';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 800, chunkOverlap: 100 };

let db: DatabaseProvider;
let tenantId = 'pending';
let projectId = 'pending';
const people = {} as Record<'ada' | 'bob' | 'gary' | 'admin', IUser>;

const ctx = (): RagAccessContext => ({ tenantDbName: TENANT_DB_NAME, tenantId, projectId, actor: String(people.admin._id) });
const moduleOf = async () => (await db.findRagModuleByKey(KB, projectId))!;
const revision = async () => (await moduleOf()).aclRevision ?? 0;
const chainOf = (segments: Array<[string, string]>) => ensureRagFolderChain(TENANT_DB_NAME, tenantId, projectId, {
  ragModuleKey: KB,
  source: SOURCE,
  segments: segments.map(([externalId, name]) => ({ externalId, name })),
  actor: ACTOR,
});
const folderAcl = (id: string, mode: 'own' | 'inherit', entries: Array<string | { principal: string; label?: string }> = []) =>
  setRagNodeAcl(TENANT_DB_NAME, tenantId, projectId, { ragModuleKey: KB, node: { type: 'folder', id }, mode, entries, managed: 'sync', actor: ACTOR });
const place = (documentId: string, folderId: string | null, mode: 'own' | 'inherit', entries: string[] = []) =>
  placeRagDocumentFromSource(TENANT_DB_NAME, tenantId, projectId, { ragModuleKey: KB, documentId, folderId, acl: { mode, entries }, actor: ACTOR });

async function reads(who: keyof typeof people, documentId: string): Promise<boolean> {
  const scope = await resolveRagAccess({ tenantDbName: TENANT_DB_NAME, tenantId, module: await moduleOf(), caller: { kind: 'person', userId: String(people[who]._id) } });
  return scope.canReadDocument((await db.findRagDocumentById(documentId))!);
}

let docCounter = 0;
async function newDoc(): Promise<string> {
  docCounter += 1;
  return String((await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: KB,
    fileName: `synced-${docCounter}.md`,
    status: 'indexed',
    createdBy: ACTOR,
  }))._id);
}

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({ companyName: 'Rag Source Sync', slug: 'rag-source-sync', dbName: TENANT_DB_NAME, licenseType: 'FREE', ownerId: 'pending' });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
  const make = async (who: keyof typeof people, role: 'admin' | 'user') => {
    people[who] = await db.createUser({
      tenantId,
      email: `${who}@example.com`,
      name: who,
      password: '$2b$10$x',
      role,
      licenseId: 'FREE',
      features: [],
      ...(role === 'user' ? { servicePermissions: { rag: 'read' } } : {}),
    } as never);
    await db.upsertUserProject({ tenantId, userId: String(people[who]._id), projectId, role: 'member' } as never);
  };
  await make('admin', 'admin');
  await make('ada', 'user');
  await make('bob', 'user');
  await make('gary', 'user');
  await db.createRagModule({
    tenantId,
    projectId,
    key: KB,
    name: KB,
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vec',
    vectorIndexKey: 'idx',
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    access: { enabled: true },
    createdBy: 'seed',
  });
  await upsertRagIdentityDomainFromSource(TENANT_DB_NAME, tenantId, { key: DOMAIN, label: 'Files', kind: 'generic', connectorId: SOURCE.connectorId, actor: ACTOR });
  await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
    domain: DOMAIN,
    runId: 'run-1',
    users: [
      { extId: 'u-ada', email: 'ada@example.com', groups: ['g-finance'] },
      { extId: 'u-bob', upn: 'BOB@example.com' },
      { extId: 'u-gary', email: 'gary@example.com', type: 'guest', groups: ['g-finance'] },
    ],
  });
}, 30_000);

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the folders of a source path', () => {
  it('are made once, top level first, and come back by the source ids however the path is asked for', async () => {
    const chain = await chainOf([['lib', 'Documents'], ['fin', 'Finance']]);
    expect(chain).toHaveLength(2);
    const before = await revision();
    expect(await chainOf([['lib', 'Documents'], ['fin', 'Finance']])).toEqual(chain);
    expect(await ensureRagFolderPath(TENANT_DB_NAME, tenantId, projectId, {
      ragModuleKey: KB, source: SOURCE, segments: [{ externalId: 'lib', name: 'Documents' }, { externalId: 'fin', name: 'Finance' }], actor: ACTOR,
    })).toBe(chain[1]);
    expect(await revision(), 'an unchanged path writes nothing').toBe(before);
    expect(await chainOf([])).toEqual([]);
  });

  it('follow a rename and a move in the source', async () => {
    const [lib, fin] = await chainOf([['lib', 'Documents'], ['fin', 'Finance']]);
    const [top, moved] = await chainOf([['fin', 'Money/Reports']]);
    expect([top, moved]).toEqual([fin, undefined]);
    const folder = (await db.listRagFolders(KB, { projectId })).find((f) => String(f._id) === fin)!;
    expect(folder.name).toBe('Money-Reports');
    expect(folder.parentId ?? undefined).toBeUndefined();
    expect(await chainOf([['lib', 'Documents'], ['fin', 'Finance']])).toEqual([lib, fin]);
  });

  it('are refused past the depth limit', async () => {
    const deep = Array.from({ length: 65 }, (_, i) => [`d${i}`, `D${i}`] as [string, string]);
    await expect(chainOf(deep)).rejects.toMatchObject({ code: 'folder_too_deep' });
  });
});

describe('the permissions a sync writes on a folder', () => {
  it('move the tree revision only when they change', async () => {
    const [, fin] = await chainOf([['lib', 'Documents'], ['fin', 'Finance']]);
    await folderAcl(fin, 'own', [{ principal: `x:${DOMAIN}:g:g-finance`, label: 'Finance' }]);
    const after = await revision();
    await folderAcl(fin, 'own', [{ principal: `x:${DOMAIN}:g:g-finance`, label: 'Finance' }]);
    expect(await revision(), 'the same principals and labels again').toBe(after);
    await folderAcl(fin, 'own', [{ principal: `x:${DOMAIN}:g:g-finance`, label: 'Finance team' }]);
    expect(await revision(), 'a new label is a change').toBeGreaterThan(after);
    const relabelled = await revision();
    await folderAcl(fin, 'inherit');
    expect(await revision()).toBeGreaterThan(relabelled);
    const inherited = await revision();
    await folderAcl(fin, 'inherit');
    expect(await revision()).toBe(inherited);
  });

  it('name only directories that exist', async () => {
    const [lib] = await chainOf([['lib', 'Documents']]);
    await expect(folderAcl(lib, 'own', ['x:no-such-directory:all'])).rejects.toMatchObject({ code: 'principal_unknown' });
  });
});

describe('a synced document put into its folder with its permissions', () => {
  it('is read by the directory people the permissions name, and only by them', async () => {
    const [, fin] = await chainOf([['lib', 'Documents'], ['fin', 'Finance']]);
    const doc = await newDoc();
    await place(doc, fin, 'own', [`x:${DOMAIN}:g:g-finance`]);
    const row = (await db.findRagDocumentById(doc))!;
    expect([String(row.folderId), row.aclMode, row.aclManaged]).toEqual([fin, 'own', 'sync']);
    expect(await reads('ada', doc)).toBe(true);
    expect(await reads('bob', doc)).toBe(false);
    expect(await reads('gary', doc), 'a guest in the group reads what the group reads').toBe(true);

    await place(doc, null, 'own', [`x:${DOMAIN}:all`]);
    expect(String((await db.findRagDocumentById(doc))!.folderId ?? '')).toBe('');
    expect(await reads('bob', doc), 'matched by sign-in name').toBe(true);
    expect(await reads('ada', doc)).toBe(true);
    expect(await reads('gary', doc), 'the members of a directory are not its guests').toBe(false);

    await place(doc, null, 'own', []);
    expect(await reads('ada', doc)).toBe(false);
    expect(await reads('admin', doc), 'admins still read (adminBypass)').toBe(true);
  });

  it('inherits its folder when the source says so', async () => {
    const [lib] = await chainOf([['lib', 'Documents']]);
    await folderAcl(lib, 'own', [`x:${DOMAIN}:u:u-bob`]);
    const doc = await newDoc();
    await place(doc, lib, 'inherit');
    expect(await reads('bob', doc)).toBe(true);
    expect(await reads('ada', doc)).toBe(false);
  });

  it('changes only through the source from then on', async () => {
    const doc = await newDoc();
    await place(doc, null, 'own', [`x:${DOMAIN}:all`]);
    const error = await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: { type: 'document', id: doc }, mode: 'own', entries: [] })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RagAccessError);
    expect((error as RagAccessError).code).toBe('acl_managed_by_source');
  });

  it('is not found in another module, and names only directories that exist', async () => {
    await expect(placeRagDocumentFromSource(TENANT_DB_NAME, tenantId, projectId, {
      ragModuleKey: KB, documentId: '000000000000000000000000', folderId: null, acl: { mode: 'inherit' }, actor: ACTOR,
    })).rejects.toBeInstanceOf(RagAccessError);
    const doc = await newDoc();
    await expect(place(doc, null, 'own', ['x:no-such-directory:all'])).rejects.toMatchObject({ code: 'principal_unknown' });
    expect((await db.findRagDocumentById(doc))!.aclManaged, 'a refused placement writes nothing').toBeUndefined();
  });
});
