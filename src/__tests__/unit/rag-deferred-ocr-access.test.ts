/**
 * A scan uploaded to a knowledge base WITH ACCESS CONTROL, whose pages are read by OCR in the ingest job and not in the
 * upload request: `ingestFile` -> `ingestDocument` with `extraction.stage: 'queued'` -> a `pending` row and a queued job
 * -> `indexPendingRagDocument` -> `extractQueuedDocument` -> `indexDocumentContent`.
 *
 * What the upload decided (the folder, the permissions) and what the job writes must not get in each other's way:
 *
 *   a. a refused placement stores nothing: no row, no stored source, no queued job (the check runs before the first write)
 *   b. the pending row starts with its placement (folder, own permissions) and is closed until its entries exist; the
 *      entries are written before the job is queued; while it waits, people the ACL does not name cannot read it
 *   c. the job patches text, extraction and status and nothing else: an admin's move or permission change made while the
 *      job waited for the pages is kept (no whole-row write from the copy the job loaded)
 *   d. the job indexes through the module's pipeline; when the document is not open to everyone its model calls are
 *      marked, and whether it is open is read when the job runs, not when the file was uploaded
 *   e. `_crawlerKey` in an upload's metadata is dropped, and the job indexes the metadata the row holds
 *   f. a document deleted while it waits loses its permission entries, and the job finds no row and stops
 *   g. with access control off the same flow works: the placement is stored and not applied
 *
 * Real services over the real providers (SQLite, and MongoDB when mongodb-memory-server runs: PARITY_SKIP_MONGODB=1 skips
 * it). Only what leaves the process is replaced: the OCR engine, the embedding model, the vector store, the file store (an
 * in-memory bucket) and the job queue (the payload is kept and the job is run by hand, as the consumer would).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => {
  type Stored = { bucketKey: string; fileName: string; contentType?: string; data: Buffer };
  const objects = new Map<string, Stored>();
  let serial = 0;
  return {
    objects,
    getDatabase: vi.fn(),
    extract: vi.fn(),
    embed: vi.fn(),
    upsert: vi.fn(),
    publish: vi.fn(),
    uploadFile: vi.fn(async (
      _tenantDbName: string,
      _tenantId: string,
      _projectId: string,
      params: { bucketKey: string; fileName: string; contentType?: string; data: Buffer; keyHint?: string },
    ) => {
      serial += 1;
      const key = `${params.keyHint ?? params.fileName}#${serial}`;
      objects.set(key, { bucketKey: params.bucketKey, fileName: params.fileName, contentType: params.contentType, data: params.data });
      return { record: { key } };
    }),
    downloadFile: vi.fn(async (_tenantDbName: string, _tenantId: string, _projectId: string, bucketKey: string, key: string) => {
      const stored = objects.get(key);
      if (!stored || stored.bucketKey !== bucketKey) throw new Error(`no such object: ${key}`);
      return { data: stored.data, fileName: stored.fileName, contentType: stored.contentType };
    }),
    deleteFile: vi.fn(async (_tenantDbName: string, _tenantId: string, _projectId: string, bucketKey: string, key: string) => (
      objects.get(key)?.bucketKey === bucketKey && objects.delete(key)
    )),
    /** Payloads of the jobs the upload queued, in order. */
    published: [] as Array<Record<string, unknown>>,
    /** The knowledge-base marks that were set at each embedding call. */
    marksAtEmbed: [] as string[][],
    /** Runs while the OCR engine is "reading the pages": what an admin does in the meantime. */
    duringOcr: undefined as undefined | (() => Promise<void>),
    reportProgress: false,
  };
});

vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: vi.fn() }));
vi.mock('@/lib/services/extraction/engine', () => ({
  extractDocument: h.extract,
  convertGuarded: vi.fn(),
  DocumentConversionRefused: class extends Error {},
  removePowerPointWorkingFiles: vi.fn(),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
  handleEmbeddingRequest: h.embed,
}));
vi.mock('@/lib/services/vector/vectorService', () => ({
  upsertVectors: h.upsert,
  queryVectorIndex: vi.fn().mockResolvedValue({ matches: [] }),
  deleteVectors: vi.fn().mockResolvedValue({ deleted: 0 }),
  vectorFilterOperatorsOf: vi.fn(() => []),
}));
vi.mock('@/lib/services/reranker', () => ({ runReranker: vi.fn() }));
vi.mock('@/lib/services/rag/ragIngestJob', () => ({ publishRagIngestJob: h.publish }));
vi.mock('@/lib/services/files/fileService', () => ({
  uploadFile: h.uploadFile,
  downloadFile: h.downloadFile,
  deleteFile: h.deleteFile,
}));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: h.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db = (await h.getDatabase()) as DatabaseProvider;
      return db.runWithTenant!(tenantDbName, () => fn(db));
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { DatabaseProvider, IRagDocument, IUser } from '@/lib/database';
import type { ExtractionRequest, ExtractionResult } from '@/lib/services/extraction';
import { currentRestrictedKnowledgeTags, restrictedKnowledgeTag } from '@/lib/services/rag/access/exposure';
import { resolveRagAccess, type RagAccessScope } from '@/lib/services/rag/access/scope';
import { RAG_CRAWLER_MARK, isPageOfCrawler } from '@/lib/services/rag/crawlerMark';
import {
  RagAccessError,
  createRagModuleFolder,
  moveRagDocuments,
  setRagNodeAclFromConsole,
  type RagAccessContext,
  type RagDocumentPlacementInput,
} from '@/lib/services/rag/ragAccessService';
import {
  deleteRagDocument,
  indexPendingRagDocument,
  ingestDocument,
  ingestFile,
  reingestDocument,
  updateRagModule,
} from '@/lib/services/rag/ragService';
import { RagOriginalMissingError } from '@/lib/services/rag/errors';
import { describeForEachProvider } from '../integration/db-parity.helper';

type Persona = 'admin' | 'member' | 'outsider';
const PERSONAS: Persona[] = ['admin', 'member', 'outsider'];

const BUCKET = 'kb-bucket';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 200, chunkOverlap: 20 };
const OCR = { mode: 'auto' as const, languages: ['tr', 'en'] };
const PDF = Buffer.from('%PDF-1.4 a scanned contract');
const OCR_TEXT = [
  '# Salary bands 2026',
  'Band A pays one hundred per month and Band B pays two hundred per month. These are the salary bands for 2026.',
  'Promotions between bands are decided once a year by the review board, in the first quarter of the year.',
  'Nothing in this document is to be shared outside the human resources team without a written approval.',
].join('\n\n');

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** What the job may write to a document row: its text, how it was extracted, and where it stands. */
const JOB_FIELDS = [
  'status', 'errorMessage', 'extraction', 'chunkCount', 'lastIndexedAt', 'size',
  'sourceText', 'sourceTextKey', 'sourceHash', 'fileKey', 'fileBucketKey', 'fileProviderKey',
];
/** The two places the text can live (on the row, or in the bucket): one of them is cleared on purpose. */
const CLEARED_ON_PURPOSE = ['sourceText', 'sourceTextKey'];

interface JobPayload {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  documentId: string;
}

interface Kb {
  key: string;
  id: string;
  /** A folder that only the member may read. */
  legal: string;
  /** A folder without permissions of its own: it reads like the knowledge base (everyone). */
  open: string;
}

interface Patch {
  id: string;
  patch: Record<string, unknown>;
  /** Who wrote it: the job under test, or an admin acting while the job waits. */
  by: 'job' | 'admin';
}

function ocrAnswer(text = OCR_TEXT): ExtractionResult {
  return { raw: text, text, report: { sourceType: 'mixed', engine: 'local', pageCount: 3, ocrPages: [1, 2], warnings: [] } };
}

describeForEachProvider('Deferred OCR ingest into a knowledge base with access control', (getDb) => {
  let tenantDbName = '';
  let tenantId = '';
  let projectId = '';
  const people = {} as Record<Persona, IUser>;
  let kbCounter = 0;
  let adminOps = 0;
  const watched: Array<{ mockRestore(): void }> = [];

  const idOf = (who: Persona) => String(people[who]._id);
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => getDb().runWithTenant!(tenantDbName, fn);
  const ctx = (): RagAccessContext => ({ tenantDbName, tenantId, projectId, actor: idOf('admin') });
  const own = (...principals: string[]) => ({ mode: 'own', entries: principals });
  const user = (who: Persona) => `user:${idOf(who)}`;

  // ── data ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    h.getDatabase.mockImplementation(async () => getDb());
    const db = getDb();
    const slug = `ocr-acl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Acme', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' }))._id);
    await inTenant(async () => {
      projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
      for (const [who, role] of [['admin', 'admin'], ['member', 'user'], ['outsider', 'user']] as const) {
        people[who] = await db.createUser({
          tenantId,
          email: `${who}@example.com`,
          name: who,
          password: '$2b$10$x',
          role,
          licenseId: 'FREE',
          features: [],
          ...(role === 'user' ? { servicePermissions: { rag: 'write' } } : {}),
        } as never);
      }
    });
  });

  afterAll(async () => {
    await drainPendingTasks();
    h.getDatabase.mockReset();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.objects.clear();
    h.published.length = 0;
    h.marksAtEmbed.length = 0;
    h.duringOcr = undefined;
    h.reportProgress = false;
    adminOps = 0;
    h.publish.mockImplementation(async (payload: Record<string, unknown>) => { h.published.push(payload); });
    h.upsert.mockResolvedValue({ upserted: 1 });
    h.embed.mockImplementation(async (input: { body: { input: string[] } }) => {
      h.marksAtEmbed.push(currentRestrictedKnowledgeTags());
      return { response: { data: input.body.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) } };
    });
    h.extract.mockImplementation(async (request: ExtractionRequest) => {
      if (h.reportProgress) request.onProgress?.({ completed: 1, total: 3 });
      await h.duringOcr?.();
      return ocrAnswer();
    });
  });

  afterEach(() => {
    for (const spy of watched.splice(0)) spy.mockRestore();
  });

  /** A knowledge base with OCR and a file bucket (so a scan can be deferred); access control on unless `access` says otherwise. */
  async function makeKb(options: { access?: false | { enabled: boolean; adminBypass?: boolean }; folders?: boolean } = {}): Promise<Kb> {
    kbCounter += 1;
    const key = `kb-${kbCounter}`;
    const access = options.access === undefined ? { enabled: true } : options.access;
    const created = await inTenant(() => getDb().createRagModule({
      tenantId,
      projectId,
      key,
      name: key,
      embeddingModelKey: 'embed',
      vectorProviderKey: 'vec',
      vectorIndexKey: 'idx',
      fileBucketKey: BUCKET,
      fileProviderKey: 'disk',
      chunkConfig: CHUNK_CONFIG,
      extraction: { ocr: OCR },
      status: 'active',
      ...(access ? { access } : {}),
      createdBy: 'seed',
    }));
    const kb: Kb = { key, id: String(created._id), legal: '', open: '' };
    if (options.folders === false) return kb;
    kb.legal = (await createRagModuleFolder(ctx(), { ragModuleKey: key, name: 'Legal' }))._id;
    kb.open = (await createRagModuleFolder(ctx(), { ragModuleKey: key, name: 'Public' }))._id;
    await setRagNodeAclFromConsole(ctx(), { ragModuleKey: key, node: { type: 'folder', id: kb.legal }, mode: 'own', entries: [user('member')] });
    return kb;
  }

  const moduleOf = (key: string) => inTenant(() => getDb().findRagModuleByKey(key, projectId));
  const rowOf = (id: string) => inTenant(() => getDb().findRagDocumentById(id));
  const rowsOf = (kb: Kb) => inTenant(() => getDb().listRagDocuments(kb.key, { projectId }));
  const foldersOf = (kb: Kb) => inTenant(() => getDb().listRagFolders(kb.key, { projectId }));
  const chunksOf = (id: string) => inTenant(() => getDb().findRagChunksByDocumentId(id));
  const entryRows = (kbKey: string, id: string) => inTenant(() => getDb().listRagAclEntries(kbKey, { projectId, nodeType: 'document', nodeId: id }));
  const entriesOf = async (kbKey: string, id: string) => (await entryRows(kbKey, id)).map((entry) => entry.principal).sort();

  /** As the routes do: the caller's scope (the engine's answer on "administers the knowledge base" is `manage`). */
  async function scopeFor(kbKey: string, who: Persona): Promise<RagAccessScope> {
    return resolveRagAccess({
      tenantDbName,
      tenantId,
      module: (await moduleOf(kbKey))!,
      caller: { kind: 'person', userId: idOf(who) },
      manage: who === 'admin',
    });
  }

  /** Who may read `row` in retrieval, per person. */
  async function readsOf(kbKey: string, row: IRagDocument): Promise<Record<Persona, boolean>> {
    const reads = {} as Record<Persona, boolean>;
    for (const who of PERSONAS) reads[who] = (await scopeFor(kbKey, who)).canReadDocument(row);
    return reads;
  }

  /** The documents a person's management view lists, through the database filter the list routes use. */
  async function listedFor(kbKey: string, who: Persona): Promise<string[]> {
    const access = (await scopeFor(kbKey, who)).managementFilter();
    const rows = await inTenant(() => getDb().listRagDocuments(kbKey, { projectId, ...(access ? { access } : {}) }));
    return rows.map((row) => String(row._id));
  }

  /** Placement, permissions and the entries of a document: what the job must leave as it finds it. */
  async function placementOf(kbKey: string, id: string) {
    const row = (await rowOf(id))!;
    return {
      folderId: row.folderId ?? null,
      aclMode: row.aclMode ?? null,
      aclManaged: row.aclManaged ?? null,
      entries: (await entryRows(kbKey, id)).map((entry) => ({
        _id: String(entry._id),
        principal: entry.principal,
        label: entry.label ?? null,
        managed: entry.managed ?? null,
        createdBy: entry.createdBy ?? null,
      })).sort((a, b) => a.principal.localeCompare(b.principal)),
    };
  }

  // ── the upload and the job ────────────────────────────────────────────

  interface UploadOptions {
    who?: Persona;
    fileName?: string;
    metadata?: Record<string, unknown>;
    placement?: Omit<RagDocumentPlacementInput, 'scope'>;
    /** 'deferExtraction' is the dashboard's upload, 'deferIndexing' the client API's `async: true`. */
    defer?: 'deferExtraction' | 'deferIndexing';
  }

  /** A scan uploaded the way the routes do: the caller's scope travels as `access` and with the placement. */
  async function upload(kb: Kb, options: UploadOptions = {}): Promise<IRagDocument> {
    const who = options.who ?? 'admin';
    const scope = await scopeFor(kb.key, who);
    return inTenant(() => ingestFile(tenantDbName, tenantId, projectId, {
      ragModuleKey: kb.key,
      fileName: options.fileName ?? 'scan.pdf',
      fileData: PDF,
      contentType: 'application/pdf',
      ...(options.defer === 'deferIndexing' ? { deferIndexing: true } : { deferExtraction: true }),
      createdBy: idOf(who),
      access: scope,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.placement ? { placement: { ...options.placement, scope } } : {}),
    }));
  }

  const queued = (): JobPayload => h.published.at(-1) as unknown as JobPayload;

  /** The ingest consumer: the job of the payload that was queued, inside the tenant scope. */
  const runJob = (payload: JobPayload = queued()) => inTenant(() => indexPendingRagDocument(
    payload.tenantDbName, payload.tenantId, payload.projectId, payload.ragModuleKey, payload.documentId,
  ));

  /** An admin acting while the job waits for the pages: what they write is told apart from the job's. */
  async function asAdmin<T>(fn: () => Promise<T>): Promise<T> {
    adminOps += 1;
    try {
      return await fn();
    } finally {
      adminOps -= 1;
    }
  }

  /**
   * Spies on the writes of the document rows and permission entries (calling through), and records every patch made to a
   * row. Installed after a test's setup so that the setup is not counted.
   */
  function watch() {
    const db = getDb();
    const real = { update: db.updateRagDocument.bind(db), replaceAcl: db.replaceRagAclEntries.bind(db) };
    const patches: Patch[] = [];
    const update = vi.spyOn(db, 'updateRagDocument').mockImplementation(async (id, patch) => {
      patches.push({ id: String(id), patch: { ...patch }, by: adminOps > 0 ? 'admin' : 'job' });
      return real.update(id, patch);
    });
    const create = vi.spyOn(db, 'createRagDocument');
    const replaceAcl = vi.spyOn(db, 'replaceRagAclEntries');
    const createFolder = vi.spyOn(db, 'createRagFolder');
    watched.push(update, create, replaceAcl, createFolder);
    return { patches, update, create, replaceAcl, createFolder, real };
  }
  type Watch = ReturnType<typeof watch>;

  const order = (spy: { mock: { invocationCallOrder: number[] } }) => spy.mock.invocationCallOrder[0];

  /** The error an upload is refused with. */
  async function refusal(attempt: Promise<unknown>): Promise<RagAccessError> {
    try {
      await attempt;
    } catch (error) {
      expect(error).toBeInstanceOf(RagAccessError);
      return error as RagAccessError;
    }
    throw new Error('expected the upload to be refused');
  }

  async function expectNothingStored(kb: Kb, w: Watch) {
    expect(await rowsOf(kb)).toEqual([]);
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.objects.size).toBe(0);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
    expect(h.extract).not.toHaveBeenCalled();
    expect(w.create).not.toHaveBeenCalled();
    expect(w.update).not.toHaveBeenCalled();
    expect(w.replaceAcl).not.toHaveBeenCalled();
  }

  /** The job wrote text, extraction and status; it never wrote a field that is not its own, and left no `undefined` behind. */
  function expectNarrowPatches(patches: Patch[]) {
    const mine = patches.filter((entry) => entry.by === 'job');
    expect(mine.length).toBeGreaterThan(0);
    for (const { patch } of mine) {
      for (const forbidden of ['folderId', 'aclMode', 'aclManaged', 'metadata']) {
        expect(Object.hasOwn(patch, forbidden), `the job patched "${forbidden}"`).toBe(false);
      }
      for (const [key, value] of Object.entries(patch)) {
        expect(JOB_FIELDS, `the job patched "${key}"`).toContain(key);
        // MongoDB stores an `undefined` as null (no ignoreUndefined), and both providers read a present key as "clear it".
        if (value === undefined) expect(CLEARED_ON_PURPOSE, `"${key}" is undefined in a patch of the job`).toContain(key);
      }
    }
  }

  const embeddedUnder = () => [...new Set(h.marksAtEmbed.map((marks) => marks.join('|')))].sort();
  const markOf = (kb: Kb) => restrictedKnowledgeTag({ key: kb.key, projectId });

  // ── a. a refused placement stores nothing ─────────────────────────────

  describe('a refused placement stores nothing', () => {
    it('a folder of another module (404): no pending row, no stored source, no queued job', async () => {
      const kb = await makeKb();
      const elsewhere = await makeKb();
      const w = watch();

      const error = await refusal(upload(kb, { placement: { folderId: elsewhere.open } }));

      expect([error.statusCode, error.code, error.message]).toEqual([404, 'folder_not_found', 'Folder not found']);
      await expectNothingStored(kb, w);
      // the other module's folder was not touched either
      expect(await rowsOf(elsewhere)).toEqual([]);
    });

    it('an upload read in the request (not deferred) is refused before its pages are read', async () => {
      const kb = await makeKb();
      const elsewhere = await makeKb();
      const scope = await scopeFor(kb.key, 'admin');
      const w = watch();

      const error = await refusal(inTenant(() => ingestFile(tenantDbName, tenantId, projectId, {
        ragModuleKey: kb.key,
        fileName: 'scan.pdf',
        fileData: PDF,
        contentType: 'application/pdf',
        createdBy: idOf('admin'),
        access: scope,
        placement: { folderId: elsewhere.open, scope },
      })));

      expect([error.statusCode, error.code]).toEqual([404, 'folder_not_found']);
      await expectNothingStored(kb, w);
    });

    it.each(['user:no-such-user', `user:${'0'.repeat(24)}`])('an unknown principal %s (400 principal_unknown): nothing is stored', async (principal) => {
      const kb = await makeKb();
      const w = watch();

      const error = await refusal(upload(kb, { placement: { folderId: kb.open, acl: own(principal) } }));

      expect([error.statusCode, error.code]).toEqual([400, 'principal_unknown']);
      expect(error.details).toEqual({ principals: [principal] });
      await expectNothingStored(kb, w);
    });

    it('an unknown principal on a path that would create folders: no folder of the path is left behind', async () => {
      const kb = await makeKb();
      const foldersBefore = (await foldersOf(kb)).map((folder) => folder.name).sort();
      const w = watch();

      const error = await refusal(upload(kb, { placement: { folderPath: 'Fresh/Path', acl: own('user:no-such-user') } }));

      expect(error.code).toBe('principal_unknown');
      expect(w.createFolder).not.toHaveBeenCalled();
      expect((await foldersOf(kb)).map((folder) => folder.name).sort()).toEqual(foldersBefore);
      await expectNothingStored(kb, w);
    });

    it('a folder the uploader cannot read answers exactly like a folder that does not exist', async () => {
      const kb = await makeKb();
      const w = watch();

      const hidden = await refusal(upload(kb, { who: 'outsider', placement: { folderId: kb.legal } }));
      const missing = await refusal(upload(kb, { who: 'outsider', placement: { folderId: 'no-such-folder' } }));

      expect([hidden.statusCode, hidden.code, hidden.message, hidden.details]).toEqual([404, 'folder_not_found', 'Folder not found', undefined]);
      expect([missing.statusCode, missing.code, missing.message, missing.details]).toEqual([hidden.statusCode, hidden.code, hidden.message, hidden.details]);
      await expectNothingStored(kb, w);
    });
  });

  // ── b. the pending row starts with its placement ──────────────────────

  describe('the pending row starts with its placement', () => {
    it.each([
      ['the dashboard upload (deferExtraction)', 'deferExtraction'],
      ['the client API upload with async (deferIndexing)', 'deferIndexing'],
    ] as const)('%s: created with its folder and own permissions, the entries follow, and only then is the job queued', async (_label, defer) => {
      const kb = await makeKb();
      const w = watch();
      let atCommit: { row: IRagDocument; reads: Record<Persona, boolean> } | undefined;
      w.replaceAcl.mockImplementationOnce(async (...args) => {
        // The instant before the entries exist.
        const row = (await getDb().findRagDocumentById(args[1].id))!;
        atCommit = { row, reads: await readsOf(kb.key, row) };
        return w.real.replaceAcl(...args);
      });

      const document = await upload(kb, { defer, placement: { folderId: kb.open, acl: own(user('member')) } });
      const id = String(document._id);

      // The row as it was created: pending, extraction still to run, the original kept for the job, and its placement.
      expect(w.create).toHaveBeenCalledTimes(1);
      const created = w.create.mock.calls[0][0];
      expect(created).toMatchObject({
        status: 'pending',
        size: 0,
        sourceText: '',
        folderId: kb.open,
        aclMode: 'own',
        extraction: { sourceType: 'ocr', stage: 'queued', fileHash: sha256(PDF), requested: OCR },
        fileBucketKey: BUCKET,
        createdBy: idOf('admin'),
      });
      expect(created.fileKey).toBeTruthy();
      expect(created).not.toHaveProperty('aclManaged');
      expect(h.objects.get(created.fileKey!)).toMatchObject({ bucketKey: BUCKET, fileName: 'scan.pdf' });
      expect(h.objects.size).toBe(1);

      // Closed from the first moment: until its entries were written nobody but a manager could read it ...
      expect(atCommit!.row).toMatchObject({ _id: expect.anything(), status: 'pending', folderId: kb.open, aclMode: 'own' });
      expect(atCommit!.reads).toEqual({ admin: true, member: false, outsider: false });
      // ... then the people it names can.
      expect(await entriesOf(kb.key, id)).toEqual([user('member')]);
      expect(await entryRows(kb.key, id)).toEqual([expect.objectContaining({ createdBy: idOf('admin'), projectId })]);
      expect(await readsOf(kb.key, (await rowOf(id))!)).toEqual({ admin: true, member: true, outsider: false });

      // Original stored -> row created closed -> entries written -> job queued, and nothing was patched in between.
      expect(order(h.uploadFile)).toBeLessThan(order(w.create));
      expect(order(w.create)).toBeLessThan(order(w.replaceAcl));
      expect(order(w.replaceAcl)).toBeLessThan(order(h.publish));
      expect(w.update).not.toHaveBeenCalled();
      expect(h.published).toEqual([{ tenantDbName, tenantId, projectId, ragModuleKey: kb.key, documentId: id }]);
      expect(h.extract).not.toHaveBeenCalled();
    });

    it('while it is pending a member the ACL does not name cannot read it, and the admin can through the admin exception', async () => {
      const kb = await makeKb();
      const pending = String((await upload(kb, { placement: { folderId: kb.open, acl: own(user('member')) } }))._id);
      const control = String((await upload(kb, { fileName: 'handbook.pdf', placement: { folderId: kb.open } }))._id);
      const row = (await rowOf(pending))!;
      expect(row.status).toBe('pending');

      expect(await scopeFor(kb.key, 'admin')).toMatchObject({ manage: true, bypass: true, enforced: false });
      expect(await readsOf(kb.key, row)).toEqual({ admin: true, member: true, outsider: false });
      // Through the database filter of the list routes (a different query on each provider).
      expect(await listedFor(kb.key, 'admin')).toEqual(expect.arrayContaining([pending, control]));
      expect((await listedFor(kb.key, 'member')).sort()).toEqual([pending, control].sort());
      expect(await listedFor(kb.key, 'outsider')).toEqual([control]);
    });

    it('with the admin exception off the admin still sees the pending row in the management view, but retrieval stays closed to them', async () => {
      const kb = await makeKb({ access: { enabled: true, adminBypass: false } });
      const pending = String((await upload(kb, { placement: { folderId: kb.open, acl: own(user('member')) } }))._id);
      const row = (await rowOf(pending))!;

      expect(await scopeFor(kb.key, 'admin')).toMatchObject({ manage: true, bypass: false, enforced: true });
      expect(await readsOf(kb.key, row)).toEqual({ admin: false, member: true, outsider: false });
      expect(await listedFor(kb.key, 'admin')).toContain(pending);
      expect(await listedFor(kb.key, 'outsider')).not.toContain(pending);
    });

    it('placed in a restricted folder without permissions of its own, it is created inside that folder and needs no entries', async () => {
      const kb = await makeKb();
      const w = watch();

      const id = String((await upload(kb, { placement: { folderId: kb.legal } }))._id);

      expect(w.create.mock.calls[0][0]).toMatchObject({ status: 'pending', folderId: kb.legal });
      expect(w.create.mock.calls[0][0]).not.toHaveProperty('aclMode');
      expect(w.replaceAcl).not.toHaveBeenCalled();
      expect(w.update).not.toHaveBeenCalled();
      expect(await readsOf(kb.key, (await rowOf(id))!)).toEqual({ admin: true, member: true, outsider: false });
      expect(await listedFor(kb.key, 'outsider')).toEqual([]);
    });
  });

  // ── c. what the job writes ────────────────────────────────────────────

  describe('the OCR job patches only text, extraction and status', () => {
    it('reads the stored original, writes the text and its record, and leaves the folder, the permissions and the entries as they are', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.legal, acl: own(user('member'), user('outsider')) } }))._id);
      const before = await placementOf(kb.key, id);
      const original = (await rowOf(id))!.fileKey;
      h.reportProgress = true;
      const w = watch();

      await runJob();

      // What was read: the original the upload kept, with the OCR setting the row was queued with, as a background job.
      expect(h.extract).toHaveBeenCalledTimes(1);
      const request = h.extract.mock.calls[0][0] as ExtractionRequest;
      expect(request).toMatchObject({
        fileName: 'scan.pdf',
        contentType: 'application/pdf',
        source: 'knowledge-engine',
        budget: 'background',
        ocr: OCR,
        scope: { tenantDbName, tenantId, projectId, userId: idOf('admin') },
      });
      expect(request.data.equals(PDF)).toBe(true);

      // What was written.
      expectNarrowPatches(w.patches);
      const row = (await rowOf(id))!;
      expect(row).toMatchObject({
        status: 'indexed',
        sourceText: OCR_TEXT,
        sourceHash: sha256(OCR_TEXT),
        size: Buffer.byteLength(OCR_TEXT),
        fileKey: original,
        fileBucketKey: BUCKET,
        extraction: { sourceType: 'mixed', engine: 'local', pageCount: 3, ocrPages: 2, fileHash: sha256(PDF), requested: OCR },
      });
      expect(row.extraction).not.toHaveProperty('stage');
      expect(row.extraction).not.toHaveProperty('progress');
      expect(row.chunkCount).toBeGreaterThan(0);
      // The progress the engine reported was written as an extraction patch, like the rest.
      expect(w.patches.some(({ patch }) => (patch.extraction as { progress?: unknown } | undefined)?.progress !== undefined)).toBe(true);

      // What was left alone: the placement and the very entries (same rows, not rewritten).
      expect(await placementOf(kb.key, id)).toEqual(before);
      expect(w.replaceAcl).not.toHaveBeenCalled();
      expect(w.create).not.toHaveBeenCalled();
      expect(await readsOf(kb.key, row)).toEqual({ admin: true, member: true, outsider: true });
    });

    it('indexes the OCR text through the module: vectors named by module and document, the chunks, the totals', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.open } }))._id);

      await runJob();

      const row = (await rowOf(id))!;
      expect(h.upsert).toHaveBeenCalledTimes(1);
      const [dbName, tenant, project, { providerKey, indexKey, vectors }] = h.upsert.mock.calls[0];
      expect([dbName, tenant, project, providerKey, indexKey]).toEqual([tenantDbName, tenantId, projectId, 'vec', 'idx']);
      expect(vectors).toHaveLength(row.chunkCount!);
      vectors.forEach((vector: { id: string; metadata: Record<string, unknown> }, index: number) => {
        expect(vector.id).toBe(`${kb.key}:${id}:${index}`);
        expect(vector.metadata).toMatchObject({ _ragModule: kb.key, _documentId: id, _fileName: 'scan.pdf', _chunkIndex: index });
      });
      const chunks = await chunksOf(id);
      expect(chunks).toHaveLength(row.chunkCount!);
      expect(chunks.map((chunk) => chunk.content).join('\n')).toContain('Band A pays one hundred per month');
      expect(await moduleOf(kb.key)).toMatchObject({ totalDocuments: 1, totalChunks: row.chunkCount });
    });

    it.each([
      ['into another folder', (kb: Kb) => kb.open],
      ['to the top level', () => null],
    ])('keeps an admin\'s move %s and permission change made while it waited for the pages', async (_label, target) => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.legal, acl: own(user('member')) } }))._id);
      const w = watch();
      const moveTo = target(kb);
      h.duringOcr = () => asAdmin(async () => {
        await moveRagDocuments(ctx(), {
          ragModuleKey: kb.key, documentIds: [id], folderId: moveTo, scope: await scopeFor(kb.key, 'admin'),
        });
        await setRagNodeAclFromConsole(ctx(), {
          ragModuleKey: kb.key, node: { type: 'document', id }, mode: 'own', entries: [user('outsider')],
        });
      });

      await runJob();

      // The admin acted while the job was reading, before it wrote the text ...
      const adminAt = w.patches.findIndex((entry) => entry.by === 'admin');
      const textAt = w.patches.findIndex((entry) => entry.by === 'job' && 'sourceText' in entry.patch);
      expect(adminAt).toBeGreaterThan(-1);
      expect(textAt).toBeGreaterThan(adminAt);
      expect(w.patches.filter((entry) => entry.by === 'admin').map((entry) => entry.patch)).toEqual([
        { folderId: moveTo ?? undefined },
        { aclMode: 'own', aclManaged: undefined },
      ]);
      // ... and what they did is still there: the job did not write the row it loaded back.
      expectNarrowPatches(w.patches);
      const row = (await rowOf(id))!;
      expect(row.status).toBe('indexed');
      expect(row.sourceText).toBe(OCR_TEXT);
      expect(row.folderId ?? null).toBe(moveTo);
      expect(row.aclMode).toBe('own');
      expect(row.aclManaged ?? null).toBeNull();
      expect(await entriesOf(kb.key, id)).toEqual([user('outsider')]);
      expect(await readsOf(kb.key, row)).toEqual({ admin: true, member: false, outsider: true });
    });

    it('keeps an admin\'s move and permission change made while the job was still in the queue', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.legal, acl: own(user('member')) } }))._id);
      const job = queued();
      const w = watch();
      await asAdmin(async () => {
        await moveRagDocuments(ctx(), {
          ragModuleKey: kb.key, documentIds: [id], folderId: kb.open, scope: await scopeFor(kb.key, 'admin'),
        });
        await setRagNodeAclFromConsole(ctx(), {
          ragModuleKey: kb.key, node: { type: 'document', id }, mode: 'own', entries: [user('outsider')],
        });
      });
      const afterAdmin = await placementOf(kb.key, id);
      expect(afterAdmin).toMatchObject({ folderId: kb.open, aclMode: 'own', entries: [expect.objectContaining({ principal: user('outsider') })] });

      await runJob(job);

      expectNarrowPatches(w.patches);
      // the same folder, the same permissions and the very same entry rows as the admin left them
      expect(await placementOf(kb.key, id)).toEqual(afterAdmin);
      const row = (await rowOf(id))!;
      expect(row.status).toBe('indexed');
      expect(await readsOf(kb.key, row)).toEqual({ admin: true, member: false, outsider: true });
    });

    it('keeps the ownership of a document a source placed (aclManaged), with its folder and entries', async () => {
      const kb = await makeKb();
      const w = watch();

      const id = String((await upload(kb, { placement: { folderId: kb.legal, acl: own(user('member')), aclManaged: 'sync' } }))._id);

      expect(w.create.mock.calls[0][0]).toMatchObject({ status: 'pending', folderId: kb.legal, aclMode: 'own', aclManaged: 'sync' });
      const before = await placementOf(kb.key, id);
      expect(before).toMatchObject({
        folderId: kb.legal,
        aclMode: 'own',
        aclManaged: 'sync',
        entries: [expect.objectContaining({ principal: user('member'), managed: 'sync' })],
      });
      w.patches.length = 0;

      await runJob();

      expectNarrowPatches(w.patches);
      expect((await rowOf(id))!.status).toBe('indexed');
      expect(await placementOf(kb.key, id)).toEqual(before);
      expect(await readsOf(kb.key, (await rowOf(id))!)).toEqual({ admin: true, member: true, outsider: false });
    });

    it('does not close again a document an admin opened (inherit) while it waited', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.open, acl: own(user('member')) } }))._id);
      const w = watch();
      h.duringOcr = () => asAdmin(async () => {
        await setRagNodeAclFromConsole(ctx(), { ragModuleKey: kb.key, node: { type: 'document', id }, mode: 'inherit' });
      });

      await runJob();

      expectNarrowPatches(w.patches);
      const row = (await rowOf(id))!;
      expect(row.status).toBe('indexed');
      expect(row.aclMode ?? null).toBeNull();
      expect(row.folderId).toBe(kb.open);
      expect(await entriesOf(kb.key, id)).toEqual([]);
      expect(await readsOf(kb.key, row)).toEqual({ admin: true, member: true, outsider: true });
    });

    it('a run that fails keeps the placement and the entries, and the document stays closed to those it never named', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.open, acl: own(user('member')) } }))._id);
      const before = await placementOf(kb.key, id);
      const w = watch();
      h.extract.mockRejectedValue(new Error('converter exploded'));

      await expect(runJob()).rejects.toThrow('converter exploded');

      expectNarrowPatches(w.patches);
      const row = (await rowOf(id))!;
      expect(row).toMatchObject({ status: 'failed', errorMessage: 'converter exploded' });
      expect(row.extraction).toEqual({ sourceType: 'ocr', fileHash: sha256(PDF), requested: OCR });
      expect(await placementOf(kb.key, id)).toEqual(before);
      expect(await readsOf(kb.key, row)).toEqual({ admin: true, member: true, outsider: false });
      expect(h.upsert).not.toHaveBeenCalled();
    });

    it('a document whose original is gone fails without reading anything, and keeps its placement', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.legal, acl: own(user('member')) } }))._id);
      const before = await placementOf(kb.key, id);
      h.objects.clear();
      const w = watch();

      await runJob();

      expect(h.extract).not.toHaveBeenCalled();
      expectNarrowPatches(w.patches);
      expect(await rowOf(id)).toMatchObject({ status: 'failed', errorMessage: 'The original file is no longer stored; upload it again.' });
      expect(await placementOf(kb.key, id)).toEqual(before);
    });
  });

  // ── d. the model calls of the indexing ────────────────────────────────

  describe('the model calls of the indexing', () => {
    it.each([
      ['its own permissions name people', (kb: Kb) => ({ folderId: kb.open, acl: own(user('member')) })],
      ['it sits in a folder only some people read', (kb: Kb) => ({ folderId: kb.legal })],
    ])('are marked with the knowledge base when %s', async (_label, placement) => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: placement(kb) }))._id);

      await runJob();

      expect((await rowOf(id))!.status).toBe('indexed');
      expect(h.marksAtEmbed.length).toBeGreaterThan(0);
      expect(embeddedUnder()).toEqual([markOf(kb)]);
      // The mark belongs to the indexing work alone.
      expect(currentRestrictedKnowledgeTags()).toEqual([]);
    });

    it.each([
      ['its own permissions name everyone', (kb: Kb) => ({ folderId: kb.legal, acl: own('everyone') })],
      ['it sits in a folder everyone reads', (kb: Kb) => ({ folderId: kb.open })],
      ['it has no placement at all', () => undefined],
    ])('are not marked when %s', async (_label, placement) => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: placement(kb) }))._id);

      await runJob();

      expect((await rowOf(id))!.status).toBe('indexed');
      expect(h.marksAtEmbed.length).toBeGreaterThan(0);
      expect(embeddedUnder()).toEqual(['']);
    });

    it('read the permissions when the job runs: a document restricted while it waited is marked', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.open } }))._id);
      h.duringOcr = () => asAdmin(async () => {
        await setRagNodeAclFromConsole(ctx(), { ragModuleKey: kb.key, node: { type: 'document', id }, mode: 'own', entries: [user('member')] });
      });

      await runJob();

      expect(embeddedUnder()).toEqual([markOf(kb)]);
    });

    it('read the permissions when the job runs: a document opened while it waited is not marked', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.open, acl: own(user('member')) } }))._id);
      h.duringOcr = () => asAdmin(async () => {
        await setRagNodeAclFromConsole(ctx(), { ragModuleKey: kb.key, node: { type: 'document', id }, mode: 'inherit' });
      });

      await runJob();

      expect(h.marksAtEmbed.length).toBeGreaterThan(0);
      expect(embeddedUnder()).toEqual(['']);
    });

    it('read the document as it is when the job runs: one moved into a restricted folder while it waited is marked', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.open } }))._id);
      h.duringOcr = () => asAdmin(async () => {
        await moveRagDocuments(ctx(), {
          ragModuleKey: kb.key, documentIds: [id], folderId: kb.legal, scope: await scopeFor(kb.key, 'admin'),
        });
      });

      await runJob();

      expect(embeddedUnder()).toEqual([markOf(kb)]);
    });
  });

  // ── e. the crawler's mark ─────────────────────────────────────────────

  describe('the mark of the crawler', () => {
    it.each(['crawler-9', ''])('an upload that carries _crawlerKey %j in its metadata does not pass for a page of the crawler, in the row or in the index', async (forged) => {
      const kb = await makeKb();
      const id = String((await upload(kb, { metadata: { team: 'legal', [RAG_CRAWLER_MARK]: forged } }))._id);

      const stored = (await rowOf(id))!;
      expect(stored.metadata).toEqual({ team: 'legal', _sourceType: 'converted' });
      expect(Object.hasOwn(stored.metadata!, RAG_CRAWLER_MARK)).toBe(false);
      expect(isPageOfCrawler(stored.metadata, forged)).toBe(false);
      expect(isPageOfCrawler(stored.metadata, undefined)).toBe(false);

      // The queue carries ids only: the job has nothing from the request to rebuild the metadata from.
      expect(Object.keys(queued()).sort()).toEqual(['documentId', 'projectId', 'ragModuleKey', 'tenantDbName', 'tenantId']);

      const w = watch();
      await runJob();

      expect(w.patches.some(({ patch }) => 'metadata' in patch)).toBe(false);
      expect((await rowOf(id))!.metadata).toEqual(stored.metadata);
      const vectors = h.upsert.mock.calls[0][3].vectors as Array<{ metadata: Record<string, unknown> }>;
      expect(vectors.length).toBeGreaterThan(0);
      for (const vector of vectors) {
        expect(vector.metadata).toMatchObject({ team: 'legal', _sourceType: 'converted' });
        expect(Object.hasOwn(vector.metadata, RAG_CRAWLER_MARK)).toBe(false);
      }
      for (const chunk of await chunksOf(id)) expect(Object.hasOwn(chunk.metadata ?? {}, RAG_CRAWLER_MARK)).toBe(false);
    });

    it('the mark of the crawler\'s own deferred ingest is neither stripped nor rebuilt by the job', async () => {
      const kb = await makeKb();
      const document = await inTenant(() => ingestDocument(tenantDbName, tenantId, projectId, {
        ragModuleKey: kb.key,
        fileName: 'https://example.com/page',
        content: 'A page the crawler found, with enough words to make one chunk.',
        deferIndexing: true,
        sentByCrawler: { crawlerKey: 'crawler-1' },
        metadata: { url: 'https://example.com/page' },
        createdBy: 'system:crawler',
      }));
      const id = String(document._id);
      expect(isPageOfCrawler((await rowOf(id))!.metadata, 'crawler-1')).toBe(true);

      await runJob();

      const row = (await rowOf(id))!;
      expect(row.status).toBe('indexed');
      expect(row.metadata).toEqual({ url: 'https://example.com/page', [RAG_CRAWLER_MARK]: 'crawler-1' });
      const vectors = h.upsert.mock.calls[0][3].vectors as Array<{ metadata: Record<string, unknown> }>;
      expect(vectors.every((vector) => vector.metadata[RAG_CRAWLER_MARK] === 'crawler-1')).toBe(true);
    });
  });

  // ── f. deleted while it waits ─────────────────────────────────────────

  describe('a document deleted while it waits', () => {
    it('loses its permission entries and its stored original, and the job finds no row and stops', async () => {
      const kb = await makeKb();
      const keep = String((await upload(kb, { fileName: 'keep.pdf', placement: { folderId: kb.open, acl: own(user('member')) } }))._id);
      const gone = String((await upload(kb, { fileName: 'gone.pdf', placement: { folderId: kb.open, acl: own(user('member'), user('outsider')) } }))._id);
      const job = queued();
      expect(job.documentId).toBe(gone);
      expect(await entriesOf(kb.key, gone)).toEqual([user('member'), user('outsider')].sort());
      expect(h.objects.size).toBe(2);
      const w = watch();

      expect(await inTenant(() => deleteRagDocument(tenantDbName, tenantId, projectId, { ragModuleKey: kb.key, documentId: gone }))).toBe(true);

      // The entries go with the document (deleteRagDocumentAcl asks for them to be replaced by none) ...
      expect(w.replaceAcl).toHaveBeenCalledWith(kb.key, { type: 'document', id: gone }, [], projectId);
      expect(await rowOf(gone)).toBeNull();
      expect(await entriesOf(kb.key, gone)).toEqual([]);
      expect(await inTenant(() => getDb().hasRagAclEntries(kb.key, 'document', gone, projectId))).toBe(false);
      // ... and so does the original that was waiting for the job. The other document keeps both.
      expect(h.objects.size).toBe(1);
      expect([...h.objects.values()][0].fileName).toBe('keep.pdf');
      expect(await entriesOf(kb.key, keep)).toEqual([user('member')]);

      // The job that was queued for it.
      vi.clearAllMocks();
      await runJob(job);

      expect(h.extract).not.toHaveBeenCalled();
      expect(h.embed).not.toHaveBeenCalled();
      expect(h.upsert).not.toHaveBeenCalled();
      expect(w.update).not.toHaveBeenCalled();
      expect(w.create).not.toHaveBeenCalled();
      expect(await rowOf(gone)).toBeNull();
      expect(await chunksOf(gone)).toEqual([]);
      expect(await rowsOf(kb)).toHaveLength(1);
      expect(await moduleOf(kb.key)).toMatchObject({ totalChunks: 0 });
    });
  });

  describe('a document deleted while the job works on it', () => {
    it('deleted while its pages are read: nothing is indexed and no text is stored for it', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.open, acl: own(user('member')) } }))._id);
      const job = queued();
      h.duringOcr = async () => {
        expect(await inTenant(() => deleteRagDocument(tenantDbName, tenantId, projectId, { ragModuleKey: kb.key, documentId: id }))).toBe(true);
      };
      vi.clearAllMocks();

      await runJob(job);

      expect(h.extract).toHaveBeenCalledTimes(1);
      expect(h.uploadFile).not.toHaveBeenCalled();
      expect(h.embed).not.toHaveBeenCalled();
      expect(h.upsert).not.toHaveBeenCalled();
      expect(await rowOf(id)).toBeNull();
      expect(await chunksOf(id)).toEqual([]);
      expect(await rowsOf(kb)).toEqual([]);
      expect(await moduleOf(kb.key)).toMatchObject({ totalChunks: 0 });
    });

    it('deleted while it is embedded: its chunks are removed again and the totals do not count it', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb, { placement: { folderId: kb.open } }))._id);
      const job = queued();
      let deleted = false;
      h.embed.mockImplementation(async (input: { body: { input: string[] } }) => {
        if (!deleted) {
          deleted = true;
          expect(await inTenant(() => deleteRagDocument(tenantDbName, tenantId, projectId, { ragModuleKey: kb.key, documentId: id }))).toBe(true);
        }
        return { response: { data: input.body.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) } };
      });

      await runJob(job);

      expect(deleted).toBe(true);
      expect(await rowOf(id)).toBeNull();
      expect(await chunksOf(id)).toEqual([]);
      expect(await moduleOf(kb.key)).toMatchObject({ totalChunks: 0 });
    });
  });

  describe('a job that cannot run', () => {
    it('fails the document with its extraction record settled, so it no longer says it waits to be read', async () => {
      const kb = await makeKb();
      const id = String((await upload(kb))._id);
      expect((await rowOf(id))!.extraction).toMatchObject({ stage: 'queued' });

      await runJob({ ...queued(), ragModuleKey: 'no-such-module' });

      const row = (await rowOf(id))!;
      expect(row.status).toBe('failed');
      expect(row.errorMessage).toContain('no-such-module');
      expect(row.extraction?.stage ?? null).toBeNull();
      expect(h.extract).not.toHaveBeenCalled();
    });
  });

  describe('a re-extract that is refused', () => {
    it('leaves the folder and the permissions of the document as they were (409, nothing moved)', async () => {
      const kb = await makeKb();
      // Text only: there is no original to read again.
      const id = String((await inTenant(() => ingestDocument(tenantDbName, tenantId, projectId, {
        ragModuleKey: kb.key,
        fileName: 'notes.txt',
        content: 'Notes typed in, with enough words to make one chunk of text.',
        createdBy: idOf('admin'),
      })))._id);
      const before = await placementOf(kb.key, id);
      const scope = await scopeFor(kb.key, 'admin');

      await expect(inTenant(() => reingestDocument(tenantDbName, tenantId, projectId, {
        ragModuleKey: kb.key,
        documentId: id,
        reextract: true,
        placement: { folderId: kb.legal, acl: own(user('outsider')), scope },
        updatedBy: idOf('admin'),
      }))).rejects.toBeInstanceOf(RagOriginalMissingError);

      expect(await placementOf(kb.key, id)).toEqual(before);
    });
  });

  // ── g. access control off ─────────────────────────────────────────────

  describe('with access control off', () => {
    it.each([
      ['no access setting', false],
      ['access.enabled false', { enabled: false }],
    ] as const)('(%s) the placement is stored and not applied, the job works as usual, and switching it on applies what was stored', async (_label, access) => {
      const kb = await makeKb({ access, folders: false });
      const id = String((await upload(kb, { placement: { folderPath: 'Team/Docs', acl: own(user('member')) } }))._id);

      // Stored: the folder the path named (made on the way), the own permissions, the entry.
      const folder = (await foldersOf(kb)).find((candidate) => candidate.name === 'Docs')!;
      const pending = (await rowOf(id))!;
      expect(pending).toMatchObject({ status: 'pending', folderId: String(folder._id), aclMode: 'own' });
      expect(await entriesOf(kb.key, id)).toEqual([user('member')]);
      // Not applied: everyone reads it, whoever the entry names.
      expect(await readsOf(kb.key, pending)).toEqual({ admin: true, member: true, outsider: true });
      expect(await listedFor(kb.key, 'outsider')).toContain(id);
      const before = await placementOf(kb.key, id);
      const w = watch();

      await runJob();

      expectNarrowPatches(w.patches);
      expect(await rowOf(id)).toMatchObject({ status: 'indexed', sourceText: OCR_TEXT });
      expect(await placementOf(kb.key, id)).toEqual(before);
      expect(h.marksAtEmbed.length).toBeGreaterThan(0);
      expect(embeddedUnder()).toEqual(['']);

      // The module switches access control on: the placement that was kept now decides.
      await inTenant(() => updateRagModule(tenantDbName, kb.id, { access: { enabled: true }, updatedBy: idOf('admin') }));
      expect(await readsOf(kb.key, (await rowOf(id))!)).toEqual({ admin: true, member: true, outsider: false });
      expect(await listedFor(kb.key, 'outsider')).not.toContain(id);
    });
  });
});
