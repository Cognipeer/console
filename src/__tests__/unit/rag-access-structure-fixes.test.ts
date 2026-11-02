/**
 * Who may change what a knowledge base with access control is made of (its folders, the folder of a document that
 * already exists), what a new document may be placed in, and what a refused, racing or malformed request leaves behind.
 *
 *  - folders: create, rename, move and delete are for managers; everyone else is refused before anything is looked at
 *  - placement: a new document goes only into an existing folder the caller may read; a missing and an unreadable
 *    folder are one and the same answer; nothing is written before the checks pass
 *  - an existing document's folder changes only by a manager, whichever way the request comes (a move, an unchanged
 *    upload, a re-ingest); a folder deleted in between is not written to
 *  - documents of another project's module with the same key are not found
 *  - the explain view, malformed ids, matching rules and the removal of an identity directory
 *
 * Real services over real SQLite; only the token lookup and the ingest queue of the client API are stubbed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-structure-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_structure_main';

const hoisted = vi.hoisted(() => ({ requireApiToken: vi.fn(), publishRagIngestJob: vi.fn(async () => undefined) }));

vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: hoisted.requireApiToken };
});
vi.mock('@/lib/services/rag/ragIngestJob', () => ({ publishRagIngestJob: hoisted.publishRagIngestJob }));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider, type IRagDocument, type IRagModule, type IUser } from '@/lib/database';
import { resolvePersonPrincipals } from '@/lib/services/rag/access/identity';
import { resolveRagAccess, type RagAccessScope } from '@/lib/services/rag/access/scope';
import type { KbCaller } from '@/lib/services/rag/access/caller';
import { hashSourceText } from '@/lib/services/rag/ragSource';
import {
  RagAccessError,
  commitRagDocumentPlacement,
  createRagIdentityLinkFor,
  createRagModuleFolder,
  deleteRagIdentityDomainByKey,
  deleteRagModuleFolder,
  explainRagAccess,
  getRagNodeAcl,
  moveRagDocuments,
  prepareRagDocumentPlacement,
  putRagIdentityDomain,
  ragPlacementRowFields,
  setRagNodeAclFromConsole,
  syncRagIdentityUsers,
  updateRagModuleFolder,
  type PreparedRagPlacement,
  type RagAccessContext,
  type RagDocumentPlacementInput,
} from '@/lib/services/rag/ragAccessService';
import { clientRagApiPlugin } from '@/server/api/plugins/client-rag';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'rag_structure_tenant';
const KB = 'kb';
const PLAIN = 'plain';
const TOKEN_ID = 'tok-structure';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 800, chunkOverlap: 100 };
const SAME_TEXT = 'same text';

let db: DatabaseProvider;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId = 'pending';
let projectId = 'pending';
let otherProjectId = 'pending';
const people = {} as Record<'admin' | 'writer' | 'reader', IUser>;
/**
 * kb:  Open, Open2        no permissions of their own: read by whoever reads the module root (everyone)
 *      Shared (+ Inner)   named: writer and reader
 *      Closed (+ Hidden)  named: reader
 */
const ids = {} as Record<'open' | 'open2' | 'shared' | 'inner' | 'closed' | 'hidden' | 'plainA', string>;
const docs = {} as Record<'same' | 'top' | 'inClosed' | 'foreign', string>;

const idOf = (who: keyof typeof people) => String(people[who]._id);
const callerOf = (who: keyof typeof people): KbCaller => ({ kind: 'person', userId: idOf(who) });
const tokenCaller = (): KbCaller => ({ kind: 'token', tokenId: TOKEN_ID, ownerUserId: idOf('admin') });

const ctx = (): RagAccessContext => ({ tenantDbName: TENANT_DB_NAME, tenantId, projectId, actor: idOf('admin') });
const moduleOf = async (key = KB): Promise<IRagModule> => (await db.findRagModuleByKey(key, projectId))!;

async function scopeFor(key: string, caller: KbCaller): Promise<RagAccessScope> {
  return resolveRagAccess({ tenantDbName: TENANT_DB_NAME, tenantId, module: await moduleOf(key), caller });
}

/** The error a call is refused with. */
async function refusal(run: () => Promise<unknown>): Promise<RagAccessError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RagAccessError);
    return error as RagAccessError;
  }
  throw new Error('expected the call to be refused');
}

/** How a refusal looks from outside: nothing in it tells a missing folder from an unreadable one. */
const wire = (error: RagAccessError) => [error.statusCode, error.code, error.message, error.details];

const folderSnapshot = async (key = KB) =>
  (await db.listRagFolders(key, { projectId })).map((f) => `${f.name}<${f.parentId ?? ''}`).sort();
const folderNames = async (key = KB) => (await db.listRagFolders(key, { projectId })).map((f) => f.name).sort();
const folderOf = async (documentId: string) => String((await db.findRagDocumentById(documentId))?.folderId ?? '');

let docCounter = 0;
async function newDoc(extra: Partial<IRagDocument> = {}, key = KB): Promise<string> {
  docCounter += 1;
  return String((await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: key,
    fileName: `doc-${docCounter}.md`,
    status: 'indexed',
    createdBy: 'seed',
    ...extra,
  }))._id);
}

const prepare = async (input: RagDocumentPlacementInput, scope?: RagAccessScope, key = KB): Promise<PreparedRagPlacement> =>
  prepareRagDocumentPlacement(db, ctx(), await moduleOf(key), input, scope);

const commit = async (documentId: string, prepared: PreparedRagPlacement, key = KB): Promise<void> =>
  commitRagDocumentPlacement(db, ctx(), await moduleOf(key), (await db.findRagDocumentById(documentId))!, prepared);

// ── the client API ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: { body: string }) => parseJsonBody<any>(res.body);
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({
  method,
  url: `/api/client/v1${url}`,
  headers: { authorization: 'Bearer tok', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

/** The call as the token alone; the token belongs to the workspace admin, `scope` caps what it may do (null: nothing). */
async function asToken(scope: Record<string, string> | null = null) {
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: TOKEN_ID, userId: idOf('admin'), servicePermissions: scope },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'rag-structure',
    tenantDbName: TENANT_DB_NAME,
    projectId,
    user: (await db.findUserById(idOf('admin')))!,
  });
}

/** The token acting for the writer, who reads Shared and may write documents but administers nothing. */
async function asDelegatedWriter() {
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: TOKEN_ID, userId: idOf('writer'), servicePermissions: null },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'rag-structure',
    tenantDbName: TENANT_DB_NAME,
    projectId,
    user: (await db.findUserById(idOf('writer')))!,
    delegation: {
      state: 'active',
      issuer: 'https://idp.example.com',
      subject: 'writer-subject',
      kind: 'person',
      appOwnerId: idOf('admin'),
      created: false,
    },
  });
}

// ── data ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Structure Test',
    slug: 'rag-structure',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
  otherProjectId = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'seed' } as never))._id);

  const make = async (who: keyof typeof people, role: 'admin' | 'user', servicePermissions?: Record<string, string>) => {
    people[who] = await db.createUser({
      tenantId,
      email: `${who}@example.com`,
      name: who,
      password: '$2b$10$x',
      role,
      licenseId: 'FREE',
      features: [],
      ...(servicePermissions ? { servicePermissions } : {}),
    } as never);
    await db.upsertUserProject({ tenantId, userId: String(people[who]._id), projectId, role: 'member' } as never);
  };
  await make('admin', 'admin');
  await make('writer', 'user', { rag: 'write' });
  await make('reader', 'user', { rag: 'read' });

  const makeModule = (key: string, forProject: string, access?: { enabled: boolean }) => db.createRagModule({
    tenantId,
    projectId: forProject,
    key,
    name: key,
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vec',
    vectorIndexKey: 'idx',
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    ...(access ? { access } : {}),
    createdBy: 'seed',
  });
  await makeModule(KB, projectId, { enabled: true });
  await makeModule(PLAIN, projectId);
  // Module keys are unique per project only: the other project has a "kb" of its own.
  await makeModule(KB, otherProjectId, { enabled: true });

  // Created by an internal caller (no scope), as a connector or a migration would.
  const folder = async (name: string, parentId?: string, key = KB) =>
    (await createRagModuleFolder(ctx(), { ragModuleKey: key, name, ...(parentId ? { parentId } : {}) }))._id;
  ids.open = await folder('Open');
  ids.open2 = await folder('Open2');
  ids.shared = await folder('Shared');
  ids.inner = await folder('Inner', ids.shared);
  ids.closed = await folder('Closed');
  ids.hidden = await folder('Hidden', ids.closed);
  ids.plainA = await folder('Plain A', undefined, PLAIN);
  await setRagNodeAclFromConsole(ctx(), {
    ragModuleKey: KB,
    node: { type: 'folder', id: ids.shared },
    mode: 'own',
    entries: [`user:${idOf('writer')}`, `user:${idOf('reader')}`],
  });
  await setRagNodeAclFromConsole(ctx(), {
    ragModuleKey: KB,
    node: { type: 'folder', id: ids.closed },
    mode: 'own',
    entries: [`user:${idOf('reader')}`, 'email:reader@example.com', `user:${idOf('admin')}`],
  });

  docs.same = await newDoc({
    fileName: 'same.md',
    folderId: ids.open,
    sourceText: SAME_TEXT,
    sourceHash: hashSourceText(SAME_TEXT),
  });
  docs.top = await newDoc();
  docs.inClosed = await newDoc({ folderId: ids.closed });
  await newDoc({ folderId: ids.plainA }, PLAIN);
  docs.foreign = String((await db.createRagDocument({
    tenantId,
    projectId: otherProjectId,
    ragModuleKey: KB,
    fileName: 'foreign.md',
    status: 'indexed',
    createdBy: 'seed',
  }))._id);

  app = await createFastifyApiTestApp(clientRagApiPlugin);
}, 30_000);

beforeEach(() => {
  hoisted.publishRagIngestJob.mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── folders ─────────────────────────────────────────────────────────────

describe('the folders of a knowledge base with access control', () => {
  it('are created, renamed, moved and deleted by managers; anyone else is refused before anything is looked at', async () => {
    const before = await folderSnapshot();
    const callers = [
      await scopeFor(KB, callerOf('writer')),
      await scopeFor(KB, callerOf('reader')),
      await scopeFor(KB, tokenCaller()),
    ];
    for (const scope of callers) {
      expect(scope.manage).toBe(false);
      const attempts: Array<() => Promise<unknown>> = [
        () => createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'Brand new', scope }),
        // What a refusal says must not depend on the folders: a name that is taken, a name that is invalid, a parent that
        // does not exist, a folder that does not exist all read as the same refusal.
        () => createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'open', scope }),
        () => createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'bad/name', scope }),
        () => createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'x', parentId: 'no-such-folder', scope }),
        () => updateRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: ids.open, name: 'Renamed', scope }),
        () => updateRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: ids.open, parentId: ids.open2, scope }),
        () => updateRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: ids.inner, parentId: null, scope }),
        () => updateRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: 'no-such-folder', name: 'x', scope }),
        () => deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: ids.open, scope }),
        () => deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: 'no-such-folder', scope }),
      ];
      const answers = [];
      for (const attempt of attempts) answers.push(wire(await refusal(attempt)));
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
      expect(answers[0]).toEqual([403, 'access_denied', expect.any(String), undefined]);
    }
    expect(await folderSnapshot()).toEqual(before);
  });

  it('are changed by a manager, by an internal caller and, in a module without access control, by anyone', async () => {
    const admin = await scopeFor(KB, callerOf('admin'));
    expect(admin).toMatchObject({ enabled: true, manage: true });

    const byManager = await createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'By manager', scope: admin });
    const byInternal = await createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'By internal caller' });
    const renamed = await updateRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: byManager._id, name: 'By manager 2', scope: admin });
    expect(renamed.path).toBe('By manager 2');
    const moved = await updateRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: byManager._id, parentId: byInternal._id });
    expect(moved.path).toBe('By internal caller/By manager 2');
    await deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: byManager._id, scope: admin });
    await deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: byInternal._id });
    expect(await folderNames()).not.toContain('By internal caller');

    const open = await scopeFor(PLAIN, callerOf('writer'));
    expect(open).toMatchObject({ enabled: false, manage: false });
    const made = await createRagModuleFolder(ctx(), { ragModuleKey: PLAIN, name: 'Anyone', scope: open });
    await updateRagModuleFolder(ctx(), { ragModuleKey: PLAIN, folderId: made._id, name: 'Anyone 2', scope: open });
    await deleteRagModuleFolder(ctx(), { ragModuleKey: PLAIN, folderId: made._id, scope: open });
    expect(await folderNames(PLAIN)).toEqual(['Plain A']);
  });

  it('are not opened by the scope of another module', async () => {
    const open = await scopeFor(PLAIN, callerOf('writer'));
    expect(open.enabled).toBe(false);
    const error = await refusal(() => createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'Sneaky', scope: open }));
    expect(error.code).toBe('access_denied');
    expect(await folderNames()).not.toContain('Sneaky');
  });

  it('keep the folder as it was when a rename that comes with a move cannot be done', async () => {
    const admin = await scopeFor(KB, callerOf('admin'));
    const parent = (await createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'Parent' }))._id;
    const child = (await createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'Child', parentId: parent }))._id;
    const before = await folderSnapshot();

    // Into its own subtree: the loop is found before the new name is written.
    expect((await refusal(() => updateRagModuleFolder(ctx(), {
      ragModuleKey: KB, folderId: parent, name: 'Parent renamed', parentId: child, scope: admin,
    }))).code).toBe('folder_cycle');
    expect((await refusal(() => updateRagModuleFolder(ctx(), {
      ragModuleKey: KB, folderId: parent, name: 'Parent renamed', parentId: parent, scope: admin,
    }))).code).toBe('folder_cycle');
    // To the top level under a name that is taken there.
    expect((await refusal(() => updateRagModuleFolder(ctx(), {
      ragModuleKey: KB, folderId: child, name: 'open', parentId: null, scope: admin,
    }))).code).toBe('folder_exists');
    // Under a folder that does not exist.
    expect((await refusal(() => updateRagModuleFolder(ctx(), {
      ragModuleKey: KB, folderId: child, name: 'Child renamed', parentId: 'no-such-folder', scope: admin,
    }))).code).toBe('folder_not_found');
    expect(await folderSnapshot()).toEqual(before);

    await deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: child, scope: admin });
    await deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: parent, scope: admin });
  });

  it('tell what an undeletable folder holds to managers only', async () => {
    const admin = await scopeFor(KB, callerOf('admin'));
    const writer = await scopeFor(KB, callerOf('writer'));
    const counted = (await createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'Counted' }))._id;
    await createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'Counted child', parentId: counted });
    await newDoc({ folderId: counted });
    await newDoc({ folderId: counted });

    const forWriter = await refusal(() => deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: counted, scope: writer }));
    expect(forWriter.code).toBe('access_denied');
    expect(forWriter.details).toBeUndefined();

    const forManager = await refusal(() => deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: counted, scope: admin }));
    expect(forManager.code).toBe('folder_not_empty');
    expect(forManager.details).toEqual({ folders: 1, documents: 2 });

    // Without access control nothing is hidden, so nothing is held back.
    const open = await scopeFor(PLAIN, callerOf('writer'));
    const forAnyone = await refusal(() => deleteRagModuleFolder(ctx(), { ragModuleKey: PLAIN, folderId: ids.plainA, scope: open }));
    expect(forAnyone.code).toBe('folder_not_empty');
    expect(forAnyone.details).toEqual({ folders: 0, documents: 1 });
  });
});

// ── placing a new document ──────────────────────────────────────────────

describe('placing a new document', () => {
  it('by folder id: a manager uses any folder, anyone else a folder they may read', async () => {
    const writer = await scopeFor(KB, callerOf('writer'));
    for (const id of [ids.open, ids.shared, ids.inner]) expect((await prepare({ folderId: id }, writer)).folderId).toBe(id);
    expect((await prepare({ folderId: null }, writer)).folderId).toBeNull();

    // Closed and below it the writer cannot read; a folder that is not there; a folder of another module.
    const answers = [];
    for (const folderId of [ids.closed, ids.hidden, 'no-such-folder', ids.plainA]) {
      answers.push(wire(await refusal(() => prepare({ folderId }, writer))));
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual([404, 'folder_not_found', 'Folder not found', undefined]);

    const admin = await scopeFor(KB, callerOf('admin'));
    expect((await prepare({ folderId: ids.closed }, admin)).folderId).toBe(ids.closed);
    // An internal caller (no scope) places anywhere.
    expect((await prepare({ folderId: ids.closed })).folderId).toBe(ids.closed);
  });

  it('takes the scope from the input when none is given beside it', async () => {
    const writer = await scopeFor(KB, callerOf('writer'));
    expect((await refusal(() => prepare({ folderId: ids.closed, scope: writer }))).code).toBe('folder_not_found');
    expect((await prepare({ folderId: ids.inner, scope: writer })).folderId).toBe(ids.inner);
  });

  it('by folder path: a folder that exists and may be read, else one answer, and nothing is created', async () => {
    const writer = await scopeFor(KB, callerOf('writer'));
    const before = await folderSnapshot();
    expect((await prepare({ folderPath: 'Shared/Inner' }, writer)).folderId).toBe(ids.inner);
    // Names compare regardless of case and of spaces around a segment.
    expect((await prepare({ folderPath: ' shared / INNER ' }, writer)).folderId).toBe(ids.inner);

    const answers = [];
    for (const folderPath of ['Closed', 'Closed/Hidden', 'Shared/Brand new', 'Nowhere', 'Nowhere/At/All']) {
      answers.push(wire(await refusal(() => prepare({ folderPath }, writer))));
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual([404, 'folder_not_found', 'Folder not found', undefined]);
    expect(await folderSnapshot()).toEqual(before);
  });

  it('by folder path: a manager has the missing folders created, after every name was checked', async () => {
    const admin = await scopeFor(KB, callerOf('admin'));
    const bad = await refusal(() => prepare({ folderPath: 'Brand/New/../Bad' }, admin));
    expect(bad.code).toBe('folder_name_invalid');
    expect(await folderNames()).not.toContain('Brand');

    const prepared = await prepare({ folderPath: 'Managed/Deep/Er' }, admin);
    const leaf = (await db.findRagFolderById(prepared.folderId!))!;
    expect(leaf.name).toBe('Er');
    const parent = (await db.findRagFolderById(String(leaf.parentId)))!;
    expect(parent.name).toBe('Deep');
    expect(prepared.mayMove).toBe(true);
  });

  it('by folder path with permissions that are refused: no folder of the path is left behind', async () => {
    const admin = await scopeFor(KB, callerOf('admin'));
    const before = await folderSnapshot();
    for (const acl of [
      { mode: 'own', entries: ['user:no-such-user'] },
      { mode: 'own', entries: ['not a principal'] },
      { mode: 'shared' },
    ]) {
      const refused = await refusal(() => prepare({ folderPath: 'Left/Behind', acl }, admin));
      expect(['principal_unknown', 'principal_invalid', 'node_invalid']).toContain(refused.code);
    }
    expect(await folderSnapshot()).toEqual(before);
    // The same path with permissions that hold is created.
    const prepared = await prepare({ folderPath: 'Left/Behind', acl: { mode: 'own', entries: [`user:${idOf('reader')}`] } }, admin);
    expect((await db.findRagFolderById(prepared.folderId!))?.name).toBe('Behind');
  });

  it('a token never manages; one the route found allowed to administer counts as a manager', async () => {
    const token = await scopeFor(KB, tokenCaller());
    expect(token.manage).toBe(false);
    const before = await folderSnapshot();

    expect((await refusal(() => prepare({ folderPath: 'Token/Made' }, token))).code).toBe('folder_not_found');
    expect((await refusal(() => prepare({ folderId: ids.closed }, token))).code).toBe('folder_not_found');
    expect((await prepare({ folderId: ids.open }, token)).mayMove).toBe(false);
    expect(await folderSnapshot()).toEqual(before);

    const made = await prepare({ folderPath: 'Token/Made', admin: true }, token);
    expect(made.mayMove).toBe(true);
    expect((await db.findRagFolderById(made.folderId!))?.name).toBe('Made');
    expect((await prepare({ folderId: ids.closed, admin: true }, token)).folderId).toBe(ids.closed);
  });

  it('in a module without access control anyone creates the folders of a path', async () => {
    const open = await scopeFor(PLAIN, callerOf('writer'));
    const prepared = await prepare({ folderPath: 'Made by anyone/Deeper' }, open, PLAIN);
    expect((await db.findRagFolderById(prepared.folderId!))?.name).toBe('Deeper');
    expect(prepared.mayMove).toBe(true);
    expect(await folderNames(PLAIN)).toEqual(expect.arrayContaining(['Made by anyone', 'Deeper']));
  });
});

// ── moving an existing document ─────────────────────────────────────────

describe('the folder of a document that exists', () => {
  const MOVE_REFUSAL = ['access_denied', 403];

  it('changes only by a manager, whichever way the placement arrives', async () => {
    const writer = await scopeFor(KB, callerOf('writer'));
    const viaMove = await refusal(() => moveRagDocuments(ctx(), { ragModuleKey: KB, documentIds: [docs.same], folderId: ids.open2, scope: writer }));
    expect([viaMove.code, viaMove.statusCode]).toEqual(MOVE_REFUSAL);

    for (const input of [{ folderId: ids.open2 }, { folderId: null }, { folderPath: 'Open2' }, { folderPath: 'Shared' }]) {
      const documentId = await newDoc({ folderId: ids.open });
      // The placement itself is fine for a writer (a folder they read, or the top level) ...
      const prepared = await prepare(input, writer);
      expect(prepared.mayMove).toBe(false);
      // ... the move it would do on a document that exists is not.
      const error = await refusal(() => commit(documentId, prepared));
      expect([error.code, error.statusCode]).toEqual(MOVE_REFUSAL);
      // Word for word what the move routes answer.
      expect(error.message).toBe(viaMove.message);
      expect(await folderOf(documentId)).toBe(ids.open);
    }
  });

  it('is left alone, without a refusal, when the placement names the folder it is already in', async () => {
    const writer = await scopeFor(KB, callerOf('writer'));
    const inOpen = await newDoc({ folderId: ids.open });
    await commit(inOpen, await prepare({ folderId: ids.open }, writer));
    await commit(inOpen, await prepare({ folderPath: 'Open' }, writer));
    expect(await folderOf(inOpen)).toBe(ids.open);

    const atTop = await newDoc();
    await commit(atTop, await prepare({ folderId: null }, writer));
    expect(await folderOf(atTop)).toBe('');
  });

  it('is changed for a manager, an internal caller, a token the route found allowed to administer, and in a module without access control', async () => {
    const admin = await scopeFor(KB, callerOf('admin'));
    const token = await scopeFor(KB, tokenCaller());

    const byManager = await newDoc({ folderId: ids.open });
    await commit(byManager, await prepare({ folderId: ids.open2 }, admin));
    expect(await folderOf(byManager)).toBe(ids.open2);
    await commit(byManager, await prepare({ folderId: null }, admin));
    expect(await folderOf(byManager)).toBe('');

    const byInternal = await newDoc({ folderId: ids.open });
    await commit(byInternal, await prepare({ folderPath: 'Open2' }));
    expect(await folderOf(byInternal)).toBe(ids.open2);

    const byToken = await newDoc({ folderId: ids.open });
    await commit(byToken, await prepare({ folderId: ids.open2, admin: true }, token));
    expect(await folderOf(byToken)).toBe(ids.open2);

    const plain = await newDoc({ folderId: ids.plainA }, PLAIN);
    const open = await scopeFor(PLAIN, callerOf('writer'));
    await commit(plain, await prepare({ folderId: null }, open, PLAIN), PLAIN);
    expect(await folderOf(plain)).toBe('');
  });

  it('is not changed by a placement that does not say the caller may: no word is the same as no', async () => {
    const documentId = await newDoc({ folderId: ids.open });
    const error = await refusal(() => commit(documentId, { folderId: ids.open2 }));
    expect(error.code).toBe('access_denied');
    expect(await folderOf(documentId)).toBe(ids.open);
  });

  it('is where a new document starts, so a new document never counts as moved', async () => {
    const writer = await scopeFor(KB, callerOf('writer'));
    const prepared = await prepare({ folderPath: 'Shared/Inner' }, writer);
    const created = String((await db.createRagDocument({
      tenantId,
      projectId,
      ragModuleKey: KB,
      fileName: 'new-row.md',
      status: 'processing',
      createdBy: idOf('writer'),
      ...ragPlacementRowFields(prepared),
    }))._id);
    await commit(created, prepared);
    expect(await folderOf(created)).toBe(ids.inner);
  });

  it('is not written when the folder is deleted between the check and the write', async () => {
    const admin = await scopeFor(KB, callerOf('admin'));
    const vanishing = (await createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'Vanishing' }))._id;
    const byId = await prepare({ folderId: vanishing }, admin);
    const byPath = await prepare({ folderPath: 'Vanishing/Below' }, admin);
    await deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: byPath.folderId!, scope: admin });
    await deleteRagModuleFolder(ctx(), { ragModuleKey: KB, folderId: vanishing, scope: admin });

    const existing = await newDoc({ folderId: ids.open });
    for (const prepared of [byId, byPath]) {
      expect((await refusal(() => commit(existing, prepared))).code).toBe('folder_not_found');
    }
    expect(await folderOf(existing)).toBe(ids.open);

    // A new row was already created in the folder that is gone: the write refuses, the caller marks the row failed.
    const created = String((await db.createRagDocument({
      tenantId,
      projectId,
      ragModuleKey: KB,
      fileName: 'dangling.md',
      status: 'processing',
      createdBy: 'seed',
      ...ragPlacementRowFields(byId),
    }))._id);
    expect((await refusal(() => commit(created, byId))).code).toBe('folder_not_found');
  });
});

// ── the client API ──────────────────────────────────────────────────────

describe('placement on the client API', () => {
  const sameFile = (placement: Record<string, unknown>) => ({
    fileName: 'same.md',
    content: SAME_TEXT,
    async: true,
    ...placement,
  });

  it('a token that is not a Knowledge Engine admin cannot move a document by uploading the same text again', async () => {
    await asToken({ rag: 'write' });
    for (const placement of [{ folderId: ids.open2 }, { folderId: null }, { folderPath: 'Open2' }]) {
      const res = await call('POST', `/rag/modules/${KB}/ingest`, sameFile(placement));
      expect(res.statusCode, res.body).toBe(403);
      expect(body(res).code).toBe('access_denied');
      expect(await folderOf(docs.same)).toBe(ids.open);
    }

    // The folder it already is in is no move.
    const unchanged = await call('POST', `/rag/modules/${KB}/ingest`, sameFile({ folderId: ids.open }));
    expect(unchanged.statusCode, unchanged.body).toBe(202);
    expect(String(body(unchanged).document._id)).toBe(docs.same);
    expect(await folderOf(docs.same)).toBe(ids.open);
    expect(hoisted.publishRagIngestJob).not.toHaveBeenCalled();
  });

  it('a token that administers the Knowledge Engine does move it', async () => {
    await asToken();
    const moved = await call('POST', `/rag/modules/${KB}/ingest`, sameFile({ folderId: ids.open2 }));
    expect(moved.statusCode, moved.body).toBe(202);
    expect(await folderOf(docs.same)).toBe(ids.open2);
    const back = await call('POST', `/rag/modules/${KB}/ingest`, sameFile({ folderPath: 'Open' }));
    expect(back.statusCode, back.body).toBe(202);
    expect(await folderOf(docs.same)).toBe(ids.open);
  });

  it('a re-ingest cannot change the folder either', async () => {
    await asToken({ rag: 'write' });
    for (const placement of [{ folderId: null }, { folderId: ids.open2 }, { folderPath: 'Open2' }]) {
      const res = await call('POST', `/rag/modules/${KB}/documents/${docs.same}`, placement);
      expect(res.statusCode, res.body).toBe(403);
      expect(body(res).code).toBe('access_denied');
      expect(await folderOf(docs.same)).toBe(ids.open);
    }
  });

  it('a new document goes into a folder that exists and may be read; a path creates nothing for a token that administers nothing', async () => {
    await asToken({ rag: 'write' });
    const before = await folderSnapshot();
    const placed = await call('POST', `/rag/modules/${KB}/ingest`, { fileName: 'in-open2.md', content: 'x', async: true, folderId: ids.open2 });
    expect(placed.statusCode, placed.body).toBe(202);
    expect(body(placed).document.folderId).toBe(ids.open2);

    for (const placement of [{ folderPath: 'Fresh/Path' }, { folderPath: 'Open2/Fresh' }, { folderId: ids.closed }, { folderPath: 'Closed' }]) {
      const res = await call('POST', `/rag/modules/${KB}/ingest`, { fileName: 'refused.md', content: 'x', async: true, ...placement });
      expect(res.statusCode, JSON.stringify(placement)).toBe(404);
      expect(body(res).code).toBe('folder_not_found');
    }
    expect(await db.findRagDocumentByFileName(KB, 'refused.md', projectId)).toBeNull();
    expect(await folderSnapshot()).toEqual(before);
  });

  it('a token that administers the Knowledge Engine has the folders of a path created', async () => {
    await asToken();
    const res = await call('POST', `/rag/modules/${KB}/ingest`, { fileName: 'by-admin-token.md', content: 'x', async: true, folderPath: 'Fresh/Path' });
    expect(res.statusCode, res.body).toBe(202);
    const leaf = (await db.listRagFolders(KB, { projectId })).find((f) => f.name === 'Path')!;
    expect(body(res).document.folderId).toBe(String(leaf._id));
    expect((await db.findRagFolderById(String(leaf.parentId)))?.name).toBe('Fresh');
  });

  it('a call made for a person who only writes places into folders that exist and creates none', async () => {
    await asDelegatedWriter();
    const before = await folderSnapshot();
    const placed = await call('POST', `/rag/modules/${KB}/ingest`, { fileName: 'delegated.md', content: 'x', async: true, folderPath: 'Shared/Inner' });
    expect(placed.statusCode, placed.body).toBe(202);
    expect(body(placed).document.folderId).toBe(ids.inner);

    const refused = await call('POST', `/rag/modules/${KB}/ingest`, { fileName: 'delegated-2.md', content: 'x', async: true, folderPath: 'Shared/2027' });
    expect(refused.statusCode).toBe(404);
    expect(body(refused).code).toBe('folder_not_found');
    expect(await folderSnapshot()).toEqual(before);
  });
});

// ── another project's documents ─────────────────────────────────────────

describe('documents of another project\'s module with the same key', () => {
  it('are not found by the permission, move and explain calls — and nothing of theirs changes', async () => {
    const node = { type: 'document' as const, id: docs.foreign };
    const calls: Array<() => Promise<unknown>> = [
      () => getRagNodeAcl(ctx(), { ragModuleKey: KB, node }),
      () => setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node, mode: 'own', entries: [] }),
      () => explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('reader'), documentId: docs.foreign }),
    ];
    for (const run of calls) expect((await refusal(run)).code).toBe('document_not_found');

    const move = await refusal(() => moveRagDocuments(ctx(), { ragModuleKey: KB, documentIds: [docs.top, docs.foreign], folderId: ids.open }));
    expect(move.code).toBe('document_not_found');
    expect(move.details).toEqual({ documentIds: [docs.foreign] });

    const foreign = (await db.findRagDocumentById(docs.foreign))!;
    expect(foreign.folderId).toBeFalsy();
    expect(foreign.aclMode).toBeFalsy();
    expect(await folderOf(docs.top)).toBe('');
  });

  it('are told apart from rows written before documents carried a project, which belong to the module', async () => {
    const legacy = String((await db.createRagDocument({
      tenantId,
      ragModuleKey: KB,
      fileName: 'legacy.md',
      status: 'indexed',
      createdBy: 'seed',
    }))._id);
    expect((await db.findRagDocumentById(legacy))?.projectId).toBeFalsy();

    expect(await getRagNodeAcl(ctx(), { ragModuleKey: KB, node: { type: 'document', id: legacy } })).toMatchObject({ mode: 'inherit' });
    expect((await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('reader'), documentId: legacy })).document).toMatchObject({ readable: true });
    expect(await moveRagDocuments(ctx(), { ragModuleKey: KB, documentIds: [legacy], folderId: ids.open })).toEqual({ moved: 1 });
    expect(await folderOf(legacy)).toBe(ids.open);
  });
});

// ── explain ─────────────────────────────────────────────────────────────

describe('the explain view', () => {
  it('gives the decision to an administrator of the project and who the person is only when asked for it', async () => {
    const brief = await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('reader'), documentId: docs.inClosed });
    expect(Object.keys(brief).sort()).toEqual(['active', 'bypass', 'document', 'enabled', 'manage', 'userId']);
    expect(brief).toMatchObject({ userId: idOf('reader'), active: true, enabled: true, manage: false, bypass: false });

    const full = await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('reader'), documentId: docs.inClosed, identity: true });
    expect(full).toMatchObject({ email: 'reader@example.com', groupIds: [], matches: [] });
    expect(full.principals).toEqual(expect.arrayContaining(['everyone', `user:${idOf('reader')}`, 'email:reader@example.com']));
    expect(full.document).toEqual(brief.document);
  });

  it('answers an administrator of the project only about people who work in it', async () => {
    const outsider = await db.createUser({
      tenantId,
      email: 'outsider@example.com',
      name: 'outsider',
      password: '$2b$10$x',
      role: 'user',
      licenseId: 'FREE',
      features: [],
    } as never);
    const outsiderId = String(outsider._id);
    // The same answer as for nobody: entries of guessed e-mails would otherwise tell who anyone of the workspace is.
    const asked = await refusal(() => explainRagAccess(ctx(), { ragModuleKey: KB, userId: outsiderId, documentId: docs.inClosed }));
    const nobody = await refusal(() => explainRagAccess(ctx(), { ragModuleKey: KB, userId: 'no-such-user', documentId: docs.inClosed }));
    expect(wire(asked)).toEqual(wire(nobody));
    expect(asked.code).toBe('user_not_found');

    // A workspace administrator reaches every project, so the project's administrator asks about them too.
    const admin = await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('admin'), documentId: docs.inClosed });
    expect(admin.userId).toBe(idOf('admin'));
    // An administrator of the whole workspace asks about anyone.
    const full = await explainRagAccess(ctx(), { ragModuleKey: KB, userId: outsiderId, documentId: docs.inClosed, identity: true });
    expect(full).toMatchObject({ userId: outsiderId, email: 'outsider@example.com' });
    // Once they work in the project, so does the project's administrator.
    await db.upsertUserProject({ tenantId, userId: outsiderId, projectId, role: 'member' } as never);
    expect((await explainRagAccess(ctx(), { ragModuleKey: KB, userId: outsiderId, documentId: docs.inClosed })).userId).toBe(outsiderId);
  });

  it('names, of everything the person holds, the keys the deciding node names', async () => {
    const reader = (await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('reader'), documentId: docs.inClosed })).document!;
    expect(reader).toMatchObject({ readable: true, mode: 'inherit', effectiveNode: { type: 'folder', id: ids.closed } });
    // Closed also names the admin; that is not something the reader holds.
    expect([...reader.grantedBy].sort()).toEqual([`user:${idOf('reader')}`, 'email:reader@example.com'].sort());

    const writer = (await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('writer'), documentId: docs.inClosed })).document!;
    expect(writer).toMatchObject({ readable: false, grantedBy: [] });

    // No permissions anywhere on the way up: the module root, open to everyone.
    const open = (await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('writer'), documentId: docs.same })).document!;
    expect(open).toMatchObject({ readable: true, effectiveNode: { type: 'module', id: KB }, grantedBy: [], openToEveryone: true });

    // A document with permissions of its own is its own deciding node.
    const own = await newDoc({ folderId: ids.open });
    await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: { type: 'document', id: own }, mode: 'own', entries: [`user:${idOf('writer')}`] });
    const named = (await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('writer'), documentId: own })).document!;
    expect(named).toMatchObject({ readable: true, mode: 'own', effectiveNode: { type: 'document', id: own }, grantedBy: [`user:${idOf('writer')}`] });
  });

  it('decides with the keys it prints, not with the ones remembered from the last seconds', async () => {
    const group = await db.createGroup({ tenantId, name: 'Closed readers', createdBy: 'seed' });
    const groupId = String(group._id);
    const folder = (await createRagModuleFolder(ctx(), { ragModuleKey: KB, name: 'Group only' }))._id;
    await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: { type: 'folder', id: folder }, mode: 'own', entries: [`group:${groupId}`] });
    const documentId = await newDoc({ folderId: folder });

    // The writer's keys are remembered while they are in no group ...
    expect((await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, idOf('writer'))).principals).not.toContain(`group:${groupId}`);
    await db.addGroupMember({ tenantId, groupId, userId: idOf('writer'), role: 'member' });
    expect((await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, idOf('writer'))).principals).not.toContain(`group:${groupId}`);

    // ... but the explanation is made of the keys the person holds now, and says so with the same keys.
    const explained = await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('writer'), documentId, identity: true });
    expect(explained.principals).toContain(`group:${groupId}`);
    expect(explained.groupIds).toEqual([groupId]);
    expect(explained.document).toMatchObject({ readable: true, grantedBy: [`group:${groupId}`] });
  });
});

// ── ids the store cannot parse ──────────────────────────────────────────

describe('an id the store cannot parse', () => {
  const bsonError = () => Object.assign(new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer'), { name: 'BSONError' });

  /** The store, with the lookups of `abc` failing the way MongoDB's ObjectId constructor does; every other id is looked up for real. */
  function failOnMalformedIds() {
    const user = db.findUserById.bind(db);
    const document = db.findRagDocumentById.bind(db);
    const token = db.findApiTokenById.bind(db);
    vi.spyOn(db, 'findUserById').mockImplementation(async (id) => { if (id === 'abc') throw bsonError(); return user(id); });
    vi.spyOn(db, 'findRagDocumentById').mockImplementation(async (id) => { if (id === 'abc') throw bsonError(); return document(id); });
    vi.spyOn(db, 'findApiTokenById').mockImplementation(async (id, tenantId) => { if (id === 'abc') throw bsonError(); return token(id, tenantId); });
  }

  it('is an id nobody has: not found, not a server error', async () => {
    failOnMalformedIds();
    try {
      expect((await refusal(() => explainRagAccess(ctx(), { ragModuleKey: KB, userId: 'abc' }))).code).toBe('user_not_found');
      expect((await refusal(() => setRagNodeAclFromConsole(ctx(), {
        ragModuleKey: KB, node: { type: 'folder', id: ids.open }, mode: 'own', entries: ['user:abc'],
      }))).code).toBe('principal_unknown');
      expect((await refusal(() => setRagNodeAclFromConsole(ctx(), {
        ragModuleKey: KB, node: { type: 'folder', id: ids.open }, mode: 'own', entries: ['token:abc'],
      }))).code).toBe('principal_unknown');
      expect((await refusal(() => getRagNodeAcl(ctx(), { ragModuleKey: KB, node: { type: 'document', id: 'abc' } }))).code).toBe('document_not_found');
      expect((await refusal(() => explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('reader'), documentId: 'abc' }))).code).toBe('document_not_found');
      // The ids that are fine are looked up as before.
      expect((await explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('reader'), documentId: docs.same })).document?.readable).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('is a console user nobody has when it is linked to a directory user', async () => {
    await putRagIdentityDomain(ctx(), { key: 'malformed', label: 'Malformed' });
    failOnMalformedIds();
    try {
      const error = await refusal(() => createRagIdentityLinkFor(ctx(), {
        domain: 'malformed', externalKind: 'user', externalId: 'u1', consoleKind: 'user', consoleId: 'abc',
      }));
      expect(error.code).toBe('link_invalid');
    } finally {
      vi.restoreAllMocks();
    }
    await deleteRagIdentityDomainByKey(ctx(), 'malformed');
  });

  it('hides no other failure: a store that is down stays a failure', async () => {
    vi.spyOn(db, 'findUserById').mockRejectedValue(new Error('store is down'));
    try {
      await expect(explainRagAccess(ctx(), { ragModuleKey: KB, userId: idOf('reader') })).rejects.toThrow('store is down');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ── identity directories ────────────────────────────────────────────────

describe('identity directories', () => {
  it('check every matching rule; an empty list stays an empty list, no list keeps the rules', async () => {
    const bad: unknown[] = [
      [{}, {}],
      [{ console: 'email', external: 'nonsense' }],
      [{ console: 'phone', external: 'email' }],
      [{ console: 'email', external: 'attr:' }],
      [{ console: 'email', external: 'attr:has space' }],
      Array.from({ length: 9 }, () => ({ console: 'email', external: 'email' })),
      'email',
      { console: 'email', external: 'email' },
    ];
    for (const userMatch of bad) {
      const error = await refusal(() => putRagIdentityDomain(ctx(), { key: 'rules', label: 'Rules', userMatch }));
      expect(error.code, JSON.stringify(userMatch)).toBe('domain_invalid');
    }
    expect(await db.findRagIdentityDomain('rules')).toBeNull();

    const rule = { console: 'externalId' as const, external: 'upn' as const };
    expect((await putRagIdentityDomain(ctx(), { key: 'rules', label: 'Rules', userMatch: [rule] })).userMatch).toEqual([rule]);
    // Not sent, or null: the rules stay.
    expect((await putRagIdentityDomain(ctx(), { key: 'rules', label: 'Rules' })).userMatch).toEqual([rule]);
    expect((await putRagIdentityDomain(ctx(), { key: 'rules', label: 'Rules', userMatch: null })).userMatch).toEqual([rule]);
    // An empty list is a list.
    const cleared = await putRagIdentityDomain(ctx(), { key: 'rules', label: 'Rules', userMatch: [] });
    expect(cleared.userMatch).toEqual([]);
    expect((await db.findRagIdentityDomain('rules'))?.userMatch).toEqual([]);
    await deleteRagIdentityDomainByKey(ctx(), 'rules');
  });

  it('take, when removed, the permissions that name them, their users and their links — and only theirs', async () => {
    await putRagIdentityDomain(ctx(), { key: 'qdms', label: 'QDMS' });
    await putRagIdentityDomain(ctx(), { key: 'qdms-2', label: 'QDMS 2' });
    await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
      domain: 'qdms',
      runId: 'run-1',
      users: [{ extId: 'u1', email: 'writer@example.com', groups: ['g1'] }],
    });
    await createRagIdentityLinkFor(ctx(), { domain: 'qdms', externalKind: 'user', externalId: 'u1', consoleKind: 'user', consoleId: idOf('reader') });

    const folderEntries = [`user:${idOf('reader')}`, 'x:qdms:g:g1', 'x:qdms:all', 'x:qdms-2:all', 'everyone'];
    await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: { type: 'folder', id: ids.open2 }, mode: 'own', entries: folderEntries });
    const documentId = await newDoc({ folderId: ids.open });
    await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: { type: 'document', id: documentId }, mode: 'own', entries: ['x:qdms:u:u1'] });
    const entriesOf = async (type: 'folder' | 'document', id: string) =>
      (await db.listRagAclEntries(KB, { projectId, nodeType: type, nodeId: id })).map((e) => e.principal).sort();
    expect(await entriesOf('folder', ids.open2)).toEqual([...folderEntries].sort());

    await deleteRagIdentityDomainByKey(ctx(), 'qdms');

    expect(await entriesOf('folder', ids.open2)).toEqual([`user:${idOf('reader')}`, 'x:qdms-2:all', 'everyone'].sort());
    expect(await entriesOf('document', documentId)).toEqual([]);
    expect(await db.findRagIdentityDomain('qdms')).toBeNull();
    expect(await db.listRagIdentityLinks({ domain: 'qdms' })).toEqual([]);
    expect((await db.listRagIdentityUsers('qdms', { limit: 0 })).total).toBe(0);
    expect((await db.findRagIdentityDomain('qdms-2'))?.key).toBe('qdms-2');

    // A directory made later under the same key starts empty: nothing is named, nothing is revived.
    await putRagIdentityDomain(ctx(), { key: 'qdms', label: 'QDMS again' });
    expect((await resolvePersonPrincipals(TENANT_DB_NAME, tenantId, idOf('reader'), { fresh: true })).principals.some((key) => key.startsWith('x:qdms:'))).toBe(false);
    expect(await entriesOf('folder', ids.open2)).toEqual([`user:${idOf('reader')}`, 'x:qdms-2:all', 'everyone'].sort());

    await deleteRagIdentityDomainByKey(ctx(), 'qdms');
    await deleteRagIdentityDomainByKey(ctx(), 'qdms-2');
    await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: { type: 'folder', id: ids.open2 }, mode: 'inherit' });
  });

  it('stay while a knowledge base root names nothing else: without them it would be open to everyone', async () => {
    await putRagIdentityDomain(ctx(), { key: 'sole', label: 'Sole' });
    const root = { type: 'module' as const, id: KB };
    const rootEntries = async () =>
      (await db.listRagAclEntries(KB, { projectId, nodeType: 'module', nodeId: KB })).map((e) => e.principal).sort();
    await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: root, mode: 'own', entries: ['x:sole:all'] });
    try {
      const error = await refusal(() => deleteRagIdentityDomainByKey(ctx(), 'sole'));
      expect(error.code).toBe('domain_in_use');
      expect(error.statusCode).toBe(409);
      expect(error.details).toEqual({ modules: [KB] });
      expect((await db.findRagIdentityDomain('sole'))?.key).toBe('sole');
      expect(await rootEntries()).toEqual(['x:sole:all']);

      // With another entry on the root the directory goes, and the root keeps what is left.
      await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: root, mode: 'own', entries: ['x:sole:all', `group:${(await db.createGroup({ tenantId, name: 'Staff', createdBy: 'seed' }))._id}`] });
      await deleteRagIdentityDomainByKey(ctx(), 'sole');
      expect(await db.findRagIdentityDomain('sole')).toBeNull();
      expect(await rootEntries()).toHaveLength(1);
      expect((await rootEntries())[0]).toMatch(/^group:/);
    } finally {
      await setRagNodeAclFromConsole(ctx(), { ragModuleKey: KB, node: root, mode: 'own', entries: [] });
    }
  });
});
