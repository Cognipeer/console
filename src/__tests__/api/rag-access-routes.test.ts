/**
 * Knowledge Engine access control over HTTP: folders, document placement,
 * permissions, the explain view and identity directories — and how the
 * document routes of the Knowledge Engine plugin follow a module's permissions.
 *
 * Real gate, real authorization engine, real SQLite. The people:
 *   admin    workspace admin: administers the Knowledge Engine (and reads everything by default)
 *   writer   Knowledge Engine write: lists folders, cannot change them, move documents or set permissions
 *   reader   Knowledge Engine read, named in the Finance folder's permissions
 *   outsider Knowledge Engine read, named nowhere
 *   projectAdmin Knowledge Engine admin of this project, not of the workspace (see `gate` below)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-access-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_access_main';

// ragService pulls in to-markdown, whose file-type CJS import trips vitest's ESM resolver.
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));

// A custom policy can allow rag.admin inside one project and not in the workspace. The engine's answer to the quiet
// workspace-level question is "no" for the people listed here; everything else is the real engine.
const gate = vi.hoisted(() => ({ notWorkspaceAdmin: new Set<string>() }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    serviceActionAllowedForRequest: ((request, service, level, options) => {
      if (options?.workspace && gate.notWorkspaceAdmin.has(String(request.headers['x-user-id'] ?? ''))) return Promise.resolve(false);
      return actual.serviceActionAllowedForRequest(request, service, level, options);
    }) as typeof actual.serviceActionAllowedForRequest,
  };
});

import type { FastifyPluginAsync } from 'fastify';
import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type IUser } from '@/lib/database';
import { syncRagIdentityUsers } from '@/lib/services/rag/ragAccessService';
import { ragApiPlugin } from '@/server/api/plugins/rag';
import { ragAccessApiPlugin } from '@/server/api/plugins/rag-access';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'rag_access_tenant';
const MODULE_KEY = 'kb';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 800, chunkOverlap: 100 };

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId = 'pending';
let projectId = 'pending';
const users = {} as Record<'admin' | 'writer' | 'reader' | 'outsider' | 'projectAdmin', IUser>;
const docs = {} as Record<'open' | 'finance' | 'privateNote', string>;
let financeFolderId = 'pending';
/** A document of ANOTHER project's module that has the same key as this one. */
let foreignDocId = 'pending';

type Who = keyof typeof users;

function headersOf(who: Who, json = false) {
  return {
    'x-tenant-db-name': TENANT_DB_NAME,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'rag-access',
    'x-user-id': String(users[who]._id),
    'x-user-role': String(users[who].role),
    'x-user-email': String(users[who].email),
    'x-license-type': 'FREE',
    cookie: `active_project_id=${projectId}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: { body: string }) => parseJsonBody<any>(res.body);

const send = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({
  method,
  url: `/api${url}`,
  headers: headersOf(who, payload !== undefined),
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

async function listedDocuments(who: Who): Promise<string[]> {
  const res = await send(who, 'GET', `/rag/modules/${MODULE_KEY}/documents`);
  expect(res.statusCode, res.body).toBe(200);
  return (body(res).documents as Array<{ _id: string }>).map((d) => String(d._id)).sort();
}

const both: FastifyPluginAsync = async (instance) => {
  await instance.register(ragApiPlugin);
  await instance.register(ragAccessApiPlugin);
};

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Access Test',
    slug: 'rag-access-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);

  const make = async (who: Who, role: 'admin' | 'user', servicePermissions?: Record<string, string>) => {
    users[who] = await db.createUser({
      tenantId,
      email: `${who}@example.com`,
      name: who,
      password: '$2b$10$x',
      role,
      licenseId: 'FREE',
      features: [],
      ...(servicePermissions ? { servicePermissions } : {}),
    } as never);
    await db.upsertUserProject({ tenantId, userId: String(users[who]._id), projectId, role: 'member' } as never);
  };
  await make('admin', 'admin');
  await make('writer', 'user', { rag: 'write' });
  await make('reader', 'user', { rag: 'read' });
  await make('outsider', 'user', { rag: 'read' });
  await make('projectAdmin', 'admin');
  gate.notWorkspaceAdmin.add(String(users.projectAdmin._id));

  await db.createRagModule({
    tenantId,
    projectId,
    key: MODULE_KEY,
    name: 'Handbook',
    embeddingModelKey: 'embed-model',
    vectorProviderKey: 'vec-provider',
    vectorIndexKey: 'vec-index',
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    access: { enabled: true },
    createdBy: String(users.admin._id),
  });
  const doc = async (fileName: string) => String((await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: MODULE_KEY,
    fileName,
    status: 'indexed',
    createdBy: String(users.admin._id),
  }))._id);
  docs.open = await doc('holidays.md');
  docs.finance = await doc('budget-2027.md');
  docs.privateNote = await doc('board-notes.md');

  // Module keys are unique per project only: another project has a "kb" of its own.
  const otherProjectId = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'seed' } as never))._id);
  await db.createRagModule({
    tenantId,
    projectId: otherProjectId,
    key: MODULE_KEY,
    name: 'Other handbook',
    embeddingModelKey: 'embed-model',
    vectorProviderKey: 'vec-provider',
    vectorIndexKey: 'vec-index',
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    createdBy: String(users.admin._id),
  });
  foreignDocId = String((await db.createRagDocument({
    tenantId,
    projectId: otherProjectId,
    ragModuleKey: MODULE_KEY,
    fileName: 'other-project.md',
    status: 'indexed',
    createdBy: String(users.admin._id),
  }))._id);

  app = await createFastifyApiTestApp(both);
}, 30_000);

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('folders', () => {
  it('an admin creates, renames and lists folders; sibling names are unique regardless of case', async () => {
    const created = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/folders`, { name: 'Finance' });
    expect(created.statusCode, created.body).toBe(201);
    financeFolderId = body(created).folder._id;
    expect(body(created).folder).toMatchObject({ name: 'Finance', path: 'Finance', aclMode: 'inherit' });

    const duplicate = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/folders`, { name: 'finance' });
    expect(duplicate.statusCode).toBe(409);
    expect(body(duplicate).code).toBe('folder_exists');

    const child = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/folders`, { name: 'Drafts', parentId: financeFolderId });
    expect(child.statusCode).toBe(201);
    expect(body(child).folder.path).toBe('Finance/Drafts');

    const renamed = await send('admin', 'PATCH', `/rag/modules/${MODULE_KEY}/folders/${body(child).folder._id}`, { name: 'Draft budgets' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(body(renamed).folder.path).toBe('Finance/Draft budgets');

    const listed = await send('reader', 'GET', `/rag/modules/${MODULE_KEY}/folders`);
    expect(listed.statusCode).toBe(200);
    expect((body(listed).folders as Array<{ path: string }>).map((f) => f.path)).toEqual(['Finance', 'Finance/Draft budgets']);

    const removed = await send('admin', 'DELETE', `/rag/modules/${MODULE_KEY}/folders/${body(child).folder._id}`);
    expect(removed.statusCode, removed.body).toBe(200);
  });

  it('with access control on, a writer neither creates, renames, moves nor deletes a folder — and nothing changes', async () => {
    const folderUrl = `/rag/modules/${MODULE_KEY}/folders`;
    const foldersOf = async () => (await (await getDatabase()).listRagFolders(MODULE_KEY, { projectId })).map((f) => `${f.name}:${f.parentId ?? ''}`);
    const before = await foldersOf();
    expect(before).toEqual([`Finance:`]);

    const attempts = [
      await send('writer', 'POST', folderUrl, { name: 'Layoffs 2027' }),
      await send('writer', 'POST', folderUrl, { name: 'Drafts', parentId: financeFolderId }),
      await send('writer', 'PATCH', `${folderUrl}/${financeFolderId}`, { name: 'Money' }),
      await send('writer', 'PATCH', `${folderUrl}/${financeFolderId}`, { parentId: null }),
      await send('writer', 'PATCH', `${folderUrl}/${financeFolderId}`, { name: 'Money', parentId: null }),
      await send('writer', 'DELETE', `${folderUrl}/${financeFolderId}`),
    ];
    for (const res of attempts) {
      expect(res.statusCode, res.body).toBe(403);
      expect(body(res)).toMatchObject({ code: 'access_denied' });
      // A refusal says nothing about what the folders hold.
      expect(body(res)).not.toHaveProperty('details');
    }
    expect(await foldersOf()).toEqual(before);

    // The same name is not "taken" for a writer: there is nothing to learn from the answer.
    const taken = await send('writer', 'POST', folderUrl, { name: 'finance' });
    const free = await send('writer', 'POST', folderUrl, { name: 'something-else' });
    expect([taken.statusCode, body(taken).code]).toEqual([free.statusCode, body(free).code]);
  });

  it('refuses names with a slash, and a parent from another module', async () => {
    const slash = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/folders`, { name: 'a/b' });
    expect(slash.statusCode).toBe(400);
    expect(body(slash).code).toBe('folder_name_invalid');

    const foreign = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/folders`, { name: 'x', parentId: 'no-such-folder' });
    expect(foreign.statusCode).toBe(404);
    expect(body(foreign).code).toBe('folder_not_found');
  });

  it('a refused rename-and-move leaves the folder as it was; so does a move that cannot happen', async () => {
    const folderUrl = `/rag/modules/${MODULE_KEY}/folders`;
    const child = body(await send('admin', 'POST', folderUrl, { name: 'Inner', parentId: financeFolderId })).folder._id as string;
    // Into its own subtree: the loop is found before the new name is written.
    const loop = await send('admin', 'PATCH', `${folderUrl}/${financeFolderId}`, { name: 'Money', parentId: child });
    expect(loop.statusCode).toBe(409);
    expect(body(loop).code).toBe('folder_cycle');
    const listed = await send('admin', 'GET', folderUrl);
    expect((body(listed).folders as Array<{ name: string }>).map((f) => f.name)).toEqual(['Finance', 'Inner']);
    expect((await send('admin', 'DELETE', `${folderUrl}/${child}`)).statusCode).toBe(200);
  });

  it('answers 404 for a module that does not exist', async () => {
    const res = await send('writer', 'GET', '/rag/modules/missing-module/folders');
    expect(res.statusCode).toBe(404);
  });
});

describe('document placement', () => {
  it('with access control on, only a Knowledge Engine admin moves documents', async () => {
    const byWriter = await send('writer', 'POST', `/rag/modules/${MODULE_KEY}/documents/move`, {
      documentIds: [docs.finance],
      folderId: financeFolderId,
    });
    expect(byWriter.statusCode).toBe(403);
    expect(body(byWriter).code).toBe('access_denied');

    const byAdmin = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/documents/move`, {
      documentIds: [docs.finance],
      folderId: financeFolderId,
    });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(body(byAdmin)).toEqual({ moved: 1 });
  });

  it('moves one document with PATCH, and validates the body', async () => {
    const bad = await send('admin', 'PATCH', `/rag/modules/${MODULE_KEY}/documents/${docs.privateNote}`, { folderId: 7 });
    expect(bad.statusCode).toBe(400);

    const missing = await send('admin', 'PATCH', `/rag/modules/${MODULE_KEY}/documents/no-such-document`, { folderId: null });
    expect(missing.statusCode).toBe(404);
    expect(body(missing).code).toBe('document_not_found');

    const toTop = await send('admin', 'PATCH', `/rag/modules/${MODULE_KEY}/documents/${docs.privateNote}`, { folderId: null });
    expect(toTop.statusCode, toTop.body).toBe(200);
    expect(body(toTop)).toEqual({ moved: 0 });
  });

  it('a writer cannot move a document by re-ingesting it either', async () => {
    const database = await getDatabase();
    const archiveId = body(await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/folders`, { name: 'Archive' })).folder._id as string;
    try {
      // To the top level, to another folder by id, to another folder by path: the document stays where the admin put it.
      for (const placement of [{ folderId: null }, { folderId: archiveId }, { folderPath: 'Archive' }]) {
        const res = await send('writer', 'POST', `/rag/modules/${MODULE_KEY}/documents/${docs.finance}`, placement);
        expect(res.statusCode, res.body).toBe(403);
        expect(body(res)).toMatchObject({ code: 'access_denied' });
      }
      expect(String((await database.findRagDocumentById(docs.finance))?.folderId)).toBe(financeFolderId);
    } finally {
      await send('admin', 'DELETE', `/rag/modules/${MODULE_KEY}/folders/${archiveId}`);
    }
  });

  it('a writer ingests a new document only into a folder that exists, and nothing is created for a path', async () => {
    const database = await getDatabase();
    const before = (await database.listRagFolders(MODULE_KEY, { projectId })).length;
    for (const placement of [{ folderPath: 'Finance/2028' }, { folderPath: 'Brand new' }, { folderId: 'no-such-folder' }]) {
      const res = await send('writer', 'POST', `/rag/modules/${MODULE_KEY}/documents`, { fileName: 'new.md', content: 'text', ...placement });
      expect(res.statusCode, res.body).toBe(404);
      expect(body(res).code).toBe('folder_not_found');
    }
    expect(await database.findRagDocumentByFileName(MODULE_KEY, 'new.md', projectId)).toBeNull();
    expect((await database.listRagFolders(MODULE_KEY, { projectId })).length).toBe(before);
  });

  it('with access control on, deleting a folder that still holds documents is for admins, who are told how many', async () => {
    const byWriter = await send('writer', 'DELETE', `/rag/modules/${MODULE_KEY}/folders/${financeFolderId}`);
    expect(byWriter.statusCode).toBe(403);
    expect(body(byWriter)).toMatchObject({ code: 'access_denied' });
    expect(body(byWriter)).not.toHaveProperty('details');

    const byAdmin = await send('admin', 'DELETE', `/rag/modules/${MODULE_KEY}/folders/${financeFolderId}`);
    expect(byAdmin.statusCode).toBe(409);
    expect(body(byAdmin)).toMatchObject({ code: 'folder_not_empty', details: { documents: 1 } });
  });

  it('documents of another project\'s module with the same key are not found, whatever the route', async () => {
    const database = await getDatabase();
    const move = await send('admin', 'PATCH', `/rag/modules/${MODULE_KEY}/documents/${foreignDocId}`, { folderId: null });
    expect(move.statusCode).toBe(404);
    expect(body(move).code).toBe('document_not_found');

    const moveMany = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/documents/move`, {
      documentIds: [docs.open, foreignDocId],
      folderId: financeFolderId,
    });
    expect(moveMany.statusCode).toBe(404);
    expect(body(moveMany)).toMatchObject({ code: 'document_not_found', details: { documentIds: [foreignDocId] } });

    const setAcl = await send('admin', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, { node: `document:${foreignDocId}`, mode: 'own', entries: [] });
    expect(setAcl.statusCode).toBe(404);
    const getAcl = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/acl?node=document:${foreignDocId}`);
    expect(getAcl.statusCode).toBe(404);
    const explain = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=${String(users.reader._id)}&documentId=${foreignDocId}`);
    expect(explain.statusCode).toBe(404);
    expect(body(explain).code).toBe('document_not_found');

    // Neither the other project's row nor this module's documents were touched.
    const row = await database.findRagDocumentById(foreignDocId);
    expect(row?.folderId).toBeFalsy();
    expect(row?.aclMode).toBeFalsy();
    expect((await database.findRagDocumentById(docs.open))?.folderId).toBeFalsy();
  });
});

describe('permissions', () => {
  it('are for Knowledge Engine admins only', async () => {
    const get = await send('writer', 'GET', `/rag/modules/${MODULE_KEY}/acl`);
    expect(get.statusCode).toBe(403);
    const put = await send('writer', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, { node: `folder:${financeFolderId}`, mode: 'own', entries: [] });
    expect(put.statusCode).toBe(403);
  });

  it('refuses entries that name nobody, or a user who does not exist', async () => {
    const invalid = await send('admin', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, {
      node: `folder:${financeFolderId}`,
      mode: 'own',
      entries: ['somebody'],
    });
    expect(invalid.statusCode).toBe(400);
    expect(body(invalid).code).toBe('principal_invalid');

    const unknown = await send('admin', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, {
      node: `folder:${financeFolderId}`,
      mode: 'own',
      entries: ['user:000000000000000000000000'],
    });
    expect(unknown.statusCode).toBe(400);
    expect(body(unknown).code).toBe('principal_unknown');
  });

  it('a folder with its own permissions, and a document closed to everyone', async () => {
    const folder = await send('admin', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, {
      node: `folder:${financeFolderId}`,
      mode: 'own',
      entries: [{ principal: `user:${String(users.reader._id)}`, label: 'Reader' }],
    });
    expect(folder.statusCode, folder.body).toBe(200);
    expect(body(folder).acl).toMatchObject({
      mode: 'own',
      entries: [{ principal: `user:${String(users.reader._id)}`, kind: 'user', label: 'Reader' }],
    });

    const closed = await send('admin', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, {
      node: { type: 'document', id: docs.privateNote },
      mode: 'own',
      entries: [],
    });
    expect(closed.statusCode, closed.body).toBe(200);

    const inherited = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/acl?node=document:${docs.finance}`);
    expect(inherited.statusCode).toBe(200);
    expect(body(inherited).acl).toMatchObject({
      mode: 'inherit',
      entries: [],
      effective: { node: { type: 'folder', id: financeFolderId } },
    });

    const root = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/acl`);
    expect(body(root).acl).toMatchObject({ node: { type: 'module' }, mode: 'own', effective: { openToEveryone: true } });
  });

  it('the module root cannot inherit', async () => {
    const res = await send('admin', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, { node: 'module', mode: 'inherit' });
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('node_invalid');
  });
});

describe('document routes follow the permissions', () => {
  it('lists only what a person may read; administrators see everything', async () => {
    expect(await listedDocuments('outsider')).toEqual([docs.open].sort());
    expect(await listedDocuments('reader')).toEqual([docs.open, docs.finance].sort());
    expect(await listedDocuments('admin')).toEqual([docs.open, docs.finance, docs.privateNote].sort());
  });

  it('answers an unreadable document like a missing one', async () => {
    const hidden = await send('outsider', 'GET', `/rag/modules/${MODULE_KEY}/documents/${docs.finance}`);
    expect(hidden.statusCode).toBe(404);
    expect(body(hidden)).toEqual({ error: 'Document not found' });

    const visible = await send('reader', 'GET', `/rag/modules/${MODULE_KEY}/documents/${docs.finance}`);
    expect(visible.statusCode).toBe(200);
  });

  it('a writer places a new document only into a folder they may read; an unreadable one is answered like a missing one', async () => {
    const database = await getDatabase();
    // Finance has its own permissions, and they do not name the writer.
    const ask = (placement: Record<string, unknown>) => send('writer', 'POST', `/rag/modules/${MODULE_KEY}/documents`, {
      fileName: 'forbidden.md',
      content: 'text',
      ...placement,
    });
    const missingPath = await ask({ folderPath: 'Nowhere' });
    const unreadablePath = await ask({ folderPath: 'Finance' });
    const missingId = await ask({ folderId: 'no-such-folder' });
    const unreadableId = await ask({ folderId: financeFolderId });
    for (const res of [missingPath, unreadablePath, missingId, unreadableId]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(body(res).code).toBe('folder_not_found');
    }
    // Not one word tells the two cases apart.
    expect(unreadablePath.body).toBe(missingPath.body);
    expect(unreadableId.body).toBe(missingId.body);
    expect(unreadablePath.body).toBe(unreadableId.body);
    expect(await database.findRagDocumentByFileName(MODULE_KEY, 'forbidden.md', projectId)).toBeNull();
  });

  it('a folder listing narrows to one folder', async () => {
    const res = await send('reader', 'GET', `/rag/modules/${MODULE_KEY}/documents?folderId=${financeFolderId}`);
    expect(res.statusCode).toBe(200);
    expect((body(res).documents as Array<{ _id: string }>).map((d) => String(d._id))).toEqual([docs.finance]);

    const top = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/documents?folderId=root`);
    expect((body(top).documents as Array<{ _id: string }>).map((d) => String(d._id)).sort()).toEqual([docs.open, docs.privateNote].sort());
  });

  it('explains who reads a document and why', async () => {
    const noUser = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain`);
    expect(noUser.statusCode).toBe(400);

    const unknown = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=000000000000000000000000`);
    expect(unknown.statusCode).toBe(404);
    expect(body(unknown).code).toBe('user_not_found');

    // An id the store cannot even parse names nobody either; it is not a server error.
    const malformed = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=abc`);
    expect(malformed.statusCode).toBe(404);
    expect(body(malformed).code).toBe('user_not_found');
    const badEntry = await send('admin', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, { node: `folder:${financeFolderId}`, mode: 'own', entries: ['user:abc'] });
    expect(badEntry.statusCode).toBe(400);
    expect(body(badEntry).code).toBe('principal_unknown');
    const badDocument = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/acl?node=document:abc`);
    expect(badDocument.statusCode).toBe(404);
    expect(body(badDocument).code).toBe('document_not_found');

    const reader = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=${String(users.reader._id)}&documentId=${docs.finance}`);
    expect(reader.statusCode, reader.body).toBe(200);
    expect(body(reader).explanation).toMatchObject({
      enabled: true,
      manage: false,
      document: {
        documentId: docs.finance,
        mode: 'inherit',
        effectiveNode: { type: 'folder', id: financeFolderId },
        readable: true,
        grantedBy: [`user:${String(users.reader._id)}`],
      },
    });
    // A workspace admin also learns who the person is.
    expect(body(reader).explanation.principals).toContain(`user:${String(users.reader._id)}`);
    expect(body(reader).explanation).toMatchObject({ email: 'reader@example.com', groupIds: [] });

    const outsider = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=${String(users.outsider._id)}&documentId=${docs.finance}`);
    expect(body(outsider).explanation.document.readable).toBe(false);

    const byWriter = await send('writer', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=${String(users.reader._id)}`);
    expect(byWriter.statusCode).toBe(403);
  });

  it('tells an administrator of this project the decision, and only a workspace administrator who the person is', async () => {
    const url = `/rag/modules/${MODULE_KEY}/access/explain?userId=${String(users.reader._id)}&documentId=${docs.finance}`;
    const byProjectAdmin = await send('projectAdmin', 'GET', url);
    expect(byProjectAdmin.statusCode, byProjectAdmin.body).toBe(200);
    const shown = body(byProjectAdmin).explanation;
    expect(shown).toMatchObject({
      userId: String(users.reader._id),
      active: true,
      enabled: true,
      manage: false,
      document: { readable: true, effectiveNode: { type: 'folder', id: financeFolderId }, grantedBy: [`user:${String(users.reader._id)}`] },
    });
    // Neither the address, nor the groups, nor the keys the person holds, nor how a directory matched them.
    for (const field of ['email', 'groupIds', 'principals', 'matches']) expect(shown).not.toHaveProperty(field);

    const byAdmin = await send('admin', 'GET', url);
    for (const field of ['email', 'groupIds', 'principals', 'matches']) expect(body(byAdmin).explanation).toHaveProperty(field);

    // The directories and their links are the workspace's, not the project's.
    expect((await send('projectAdmin', 'GET', '/rag/identity/domains')).statusCode).toBe(403);
  });
});

describe('identity directories map external users and groups to people', () => {
  it('are managed by workspace Knowledge Engine admins only', async () => {
    expect((await send('writer', 'GET', '/rag/identity/domains')).statusCode).toBe(403);
    expect((await send('writer', 'PUT', '/rag/identity/domains/contoso', { label: 'Contoso' })).statusCode).toBe(403);
    expect((await send('writer', 'GET', '/rag/identity/links')).statusCode).toBe(403);
  });

  it('refuses an invalid directory key', async () => {
    const res = await send('admin', 'PUT', '/rag/identity/domains/Not%20Valid', { label: 'x' });
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('domain_invalid');
  });

  it('a directory group in a folder\'s permissions reaches the people whose e-mail matches', async () => {
    const put = await send('admin', 'PUT', '/rag/identity/domains/contoso', { label: 'Contoso directory' });
    expect(put.statusCode, put.body).toBe(200);
    expect(body(put).domain).toMatchObject({ key: 'contoso', label: 'Contoso directory', kind: 'generic' });

    // What a connector's sync stores: the directory's users with their groups.
    await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
      domain: 'contoso',
      runId: 'run-1',
      users: [
        { extId: 'aad-reader', email: 'OUTSIDER@example.com', groups: ['grp-finance'] },
        { extId: 'aad-other', email: 'someone-else@example.com', groups: ['grp-hr'] },
      ],
    });
    const directory = await send('admin', 'GET', '/rag/identity/domains/contoso/users?search=example');
    expect(directory.statusCode).toBe(200);
    expect(body(directory).total).toBe(2);

    const listed = await send('admin', 'GET', '/rag/identity/domains');
    expect((body(listed).domains as Array<{ key: string }>).map((d) => d.key)).toEqual(['contoso']);

    // The outsider is not named in the folder, but their e-mail matches a member of grp-finance.
    expect(await listedDocuments('outsider')).toEqual([docs.open].sort());
    const acl = await send('admin', 'PUT', `/rag/modules/${MODULE_KEY}/acl`, {
      node: `folder:${financeFolderId}`,
      mode: 'own',
      entries: [`user:${String(users.reader._id)}`, 'x:contoso:g:grp-finance'],
    });
    expect(acl.statusCode, acl.body).toBe(200);
    expect(await listedDocuments('outsider')).toEqual([docs.open, docs.finance].sort());

    const explained = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=${String(users.outsider._id)}&documentId=${docs.finance}`);
    expect(body(explained).explanation.principals).toEqual(expect.arrayContaining([
      'x:contoso:u:aad-reader',
      'x:contoso:g:grp-finance',
      'x:contoso:all',
    ]));
    // Of everything the person holds, only the key the Finance folder names is given as the reason.
    expect(body(explained).explanation.document).toMatchObject({
      readable: true,
      effectiveNode: { type: 'folder', id: financeFolderId },
      grantedBy: ['x:contoso:g:grp-finance'],
    });
  });

  it('refuses matching rules that compare nothing, and keeps an empty list as an empty list', async () => {
    const bad = [
      [{}, {}],
      [{ console: 'email', external: 'nonsense' }],
      [{ console: 'phone', external: 'email' }],
      [{ console: 'email', external: 'attr:' }],
      [{ console: 'email', external: 'attr:has space' }],
      'email',
    ];
    for (const userMatch of bad) {
      const res = await send('admin', 'PUT', '/rag/identity/domains/contoso', { label: 'Contoso directory', userMatch });
      expect(res.statusCode, JSON.stringify(userMatch)).toBe(400);
      expect(body(res).code).toBe('domain_invalid');
    }
    const database = await getDatabase();
    // None of those changed the directory.
    expect((await database.findRagIdentityDomain('contoso'))?.userMatch).toEqual([]);

    const custom = await send('admin', 'PUT', '/rag/identity/domains/contoso', {
      label: 'Contoso directory',
      userMatch: [{ console: 'email', external: 'attr:mail' }],
    });
    expect(custom.statusCode, custom.body).toBe(200);
    expect(body(custom).domain.userMatch).toEqual([{ console: 'email', external: 'attr:mail' }]);

    // Leaving the rules out keeps them; sending an empty list clears them (the default rules apply again).
    const untouched = await send('admin', 'PUT', '/rag/identity/domains/contoso', { label: 'Contoso directory' });
    expect(body(untouched).domain.userMatch).toEqual([{ console: 'email', external: 'attr:mail' }]);
    const cleared = await send('admin', 'PUT', '/rag/identity/domains/contoso', { label: 'Contoso directory', userMatch: [] });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(body(cleared).domain.userMatch).toEqual([]);
    expect((await database.findRagIdentityDomain('contoso'))?.userMatch).toEqual([]);
  });

  it('a manual link maps a directory user to a console user', async () => {
    const link = await send('admin', 'POST', '/rag/identity/links', {
      domain: 'contoso',
      externalKind: 'user',
      externalId: 'aad-other',
      consoleKind: 'user',
      consoleId: String(users.writer._id),
    });
    expect(link.statusCode, link.body).toBe(201);
    const linkId = body(link).link._id;

    const groupToUser = await send('admin', 'POST', '/rag/identity/links', {
      domain: 'contoso',
      externalKind: 'user',
      externalId: 'aad-other',
      consoleKind: 'group',
      consoleId: 'some-group',
    });
    expect(groupToUser.statusCode).toBe(400);
    expect(body(groupToUser).code).toBe('link_invalid');

    // An id the store cannot parse is a user nobody has, not a server error.
    const malformed = await send('admin', 'POST', '/rag/identity/links', {
      domain: 'contoso',
      externalKind: 'user',
      externalId: 'aad-other',
      consoleKind: 'user',
      consoleId: 'abc',
    });
    expect(malformed.statusCode).toBe(400);
    expect(body(malformed).code).toBe('link_invalid');

    const listed = await send('admin', 'GET', `/rag/identity/links?domain=contoso&consoleKind=user&consoleId=${String(users.writer._id)}`);
    expect((body(listed).links as Array<{ _id: string }>).map((l) => String(l._id))).toEqual([String(linkId)]);

    const explained = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=${String(users.writer._id)}`);
    expect(body(explained).explanation.principals).toEqual(expect.arrayContaining(['x:contoso:u:aad-other', 'x:contoso:g:grp-hr']));

    const removed = await send('admin', 'DELETE', `/rag/identity/links/${String(linkId)}`);
    expect(removed.statusCode, removed.body).toBe(200);
    const after = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/explain?userId=${String(users.writer._id)}`);
    expect(body(after).explanation.principals).not.toContain('x:contoso:u:aad-other');
  });

  it('a directory that is all a knowledge base\'s root names stays until the root names something else', async () => {
    const rootUrl = `/rag/modules/${MODULE_KEY}/acl`;
    const setRoot = (entries: string[]) => send('admin', 'PUT', rootUrl, { node: 'module', mode: 'own', entries });
    expect((await setRoot(['x:contoso:all'])).statusCode).toBe(200);
    try {
      // Without it the root would have no entries and the whole knowledge base would be open to everyone.
      const blocked = await send('admin', 'DELETE', '/rag/identity/domains/contoso');
      expect(blocked.statusCode, blocked.body).toBe(409);
      expect(body(blocked)).toMatchObject({ code: 'domain_in_use', details: { modules: [MODULE_KEY] } });
      expect((await (await getDatabase()).findRagIdentityDomain('contoso'))?.key).toBe('contoso');
    } finally {
      expect((await setRoot([])).statusCode).toBe(200);
    }
  });

  it('deleting a directory takes its users, links and the permissions naming it with it', async () => {
    const database = await getDatabase();
    const financeEntries = async () => (await database.listRagAclEntries(MODULE_KEY, {
      projectId,
      nodeType: 'folder',
      nodeId: financeFolderId,
    })).map((e) => e.principal).sort();
    expect(await financeEntries()).toEqual([`user:${String(users.reader._id)}`, 'x:contoso:g:grp-finance'].sort());

    const removed = await send('admin', 'DELETE', '/rag/identity/domains/contoso');
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await listedDocuments('outsider')).toEqual([docs.open].sort());
    const gone = await send('admin', 'GET', '/rag/identity/domains/contoso/users');
    expect(gone.statusCode).toBe(404);
    expect(body(gone).code).toBe('domain_not_found');

    // The entry that named the directory is gone; the one naming a person stays.
    expect(await financeEntries()).toEqual([`user:${String(users.reader._id)}`]);

    // A directory made later under the same key does not bring the old permission back.
    expect((await send('admin', 'PUT', '/rag/identity/domains/contoso', { label: 'Contoso again' })).statusCode).toBe(200);
    await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
      domain: 'contoso',
      runId: 'run-2',
      users: [{ extId: 'aad-reader', email: 'outsider@example.com', groups: ['grp-finance'] }],
    });
    expect(await listedDocuments('outsider')).toEqual([docs.open].sort());
    expect((await send('admin', 'DELETE', '/rag/identity/domains/contoso')).statusCode).toBe(200);
  });
});

describe('turning access control on and off', () => {
  it('is for Knowledge Engine admins only, and off means everyone reads everything again', async () => {
    const byWriter = await send('writer', 'PATCH', `/rag/modules/${MODULE_KEY}`, { access: { enabled: false }, name: 'Renamed by writer' });
    expect(byWriter.statusCode).toBe(403);
    expect(body(byWriter).code).toBe('access_denied');
    // Refused means nothing changed — not the switch, not the other fields of the same request.
    const stored = await (await getDatabase()).findRagModuleByKey(MODULE_KEY, projectId);
    expect(stored?.access).toEqual({ enabled: true });
    expect(stored?.name).toBe('Handbook');
    expect(await listedDocuments('outsider')).toEqual([docs.open].sort());

    const off = await send('admin', 'PATCH', `/rag/modules/${MODULE_KEY}`, { access: { enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(await listedDocuments('outsider')).toEqual([docs.open, docs.finance, docs.privateNote].sort());

    const on = await send('admin', 'PATCH', `/rag/modules/${MODULE_KEY}`, { access: { enabled: true, adminBypass: false } });
    expect(on.statusCode, on.body).toBe(200);
    expect(await listedDocuments('outsider')).toEqual([docs.open].sort());
    // Without the admin exception, administrators still see every document in management views.
    expect(await listedDocuments('admin')).toEqual([docs.open, docs.finance, docs.privateNote].sort());
  });
});
