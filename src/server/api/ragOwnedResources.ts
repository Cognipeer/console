/**
 * What the Knowledge Engine owns outside its own routes: the stored originals and extracted text of a module's
 * documents (ordinary files in the module's bucket, `services/rag/ragSource.ts`) and the vector index its vectors live
 * in.
 *
 * With access control on for a module, its documents are read through the module, where each one is checked. The file
 * and vector routes know nothing of documents, so they serve these objects only to a caller who skips the checks
 * anyway: one who administers the module while the module keeps the admin exception on (`scope.bypass`). An API
 * token never is that caller. For anyone else a file is answered like a file that is not there, and a query on the
 * index is refused, and so is pointing another knowledge base at it (that one would read its vectors unchecked).
 *
 * Another service that sends documents into a module with access control (a crawler's pages) is set up only by a caller
 * who administers that module: those documents skip the checks a writer's upload goes through.
 *
 * A module without access control costs one module read per request, and only when an object names it.
 */

import type { FastifyRequest } from 'fastify';
import { runWithTenantScope, type IRagModule } from '@/lib/database';
import { FileServiceError } from '@/lib/services/files/errors';
import type { ListFilesResponse } from '@/lib/services/files/types';

/** Where a request works: the tenant and the project whose modules, files and indexes it can name. */
export interface RagOwnedScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}

/** What a stored file says about who owns it. */
export interface StoredFileRef {
  key: string;
  metadata?: Record<string, unknown> | null;
}

// ── files ───────────────────────────────────────────────────────────────

/** `ragSource.ts` keeps a module's objects under `knowledge-engine/<module key>/` and stamps `ragModuleKey` on them. */
const OWNED_KEY = /^knowledge-engine\/([^/]+)\//;

/**
 * The modules a stored file says it belongs to: the one stamped on its metadata and the one its key names. An object
 * registered again after its record was lost has the key only, so both count, and a file is kept back when either
 * names a module with access control.
 */
export function ragModuleKeysOfFile(file: StoredFileRef): string[] {
  const keys = new Set<string>();
  const stamped = file.metadata?.ragModuleKey;
  if (typeof stamped === 'string' && stamped.trim() !== '') keys.add(stamped.trim());
  const named = typeof file.key === 'string' ? OWNED_KEY.exec(file.key)?.[1] : undefined;
  if (named) keys.add(named);
  return [...keys];
}

let ragAccessRequestModule: Promise<typeof import('./ragAccessRequest')> | undefined;

/**
 * Loaded when an object names a module: the file routes do not carry the whole Knowledge Engine for plain files. One
 * import is shared by every caller, so the checks of one listing that run side by side load it once.
 */
function loadRagAccessRequest(): Promise<typeof import('./ragAccessRequest')> {
  ragAccessRequestModule ??= import('./ragAccessRequest').catch((error: unknown) => {
    ragAccessRequestModule = undefined;
    throw error;
  });
  return ragAccessRequestModule;
}

/** Access control is on for the module and this request's caller does not skip it. */
async function callerIsKeptOut(request: FastifyRequest, where: RagOwnedScope, ragModuleKey: string): Promise<boolean> {
  const { ragAccessForRequest } = await loadRagAccessRequest();
  const { scope } = await ragAccessForRequest(request, { ...where, ragModuleKey });
  return scope?.enabled === true && !scope.bypass;
}

export interface RagFileGuard {
  /** The caller may not read this file: it belongs to a knowledge base with access control they do not skip. */
  hides(file: StoredFileRef): Promise<boolean>;
  /** The keys among these files that `hides` holds back. */
  hiddenKeys(files: readonly StoredFileRef[]): Promise<Set<string>>;
  /** The files the caller may read, in their order. */
  visible<T extends StoredFileRef>(files: readonly T[]): Promise<T[]>;
  /** Throws the error of a file that does not exist when the caller may not read this one. */
  assertVisible(file: StoredFileRef): Promise<void>;
}

/** The file checks of one request. Each module is looked up once, however many of its files are asked about. */
export function ragFileGuard(request: FastifyRequest, where: RagOwnedScope): RagFileGuard {
  const verdicts = new Map<string, Promise<boolean>>();
  const keepsOut = (moduleKey: string): Promise<boolean> => {
    let verdict = verdicts.get(moduleKey);
    if (!verdict) {
      verdict = callerIsKeptOut(request, where, moduleKey);
      verdicts.set(moduleKey, verdict);
    }
    return verdict;
  };
  const hides = async (file: StoredFileRef): Promise<boolean> => {
    for (const moduleKey of ragModuleKeysOfFile(file)) {
      if (await keepsOut(moduleKey)) return true;
    }
    return false;
  };
  return {
    hides,
    async hiddenKeys(files) {
      const hidden = await Promise.all(files.map(hides));
      return new Set(files.filter((_, index) => hidden[index]).map((file) => file.key));
    },
    async visible(files) {
      const hidden = await Promise.all(files.map(hides));
      return files.filter((_, index) => !hidden[index]);
    },
    async assertVisible(file) {
      // The error `findFileRecord` throws for a key that has no record: the answer is the same, byte for byte.
      if (await hides(file)) throw new FileServiceError('file_not_found', 404, 'File record not found.');
    },
  };
}

/** The most reads one listing makes to fill a page after leaving files out; past it the page is returned short, with where to go on. */
const FILL_ROUNDS_MAX = 20;

/**
 * A listing read that leaves out the files the caller may not read. The page is filled from the following reads (a
 * cursor continues after a whole read, so each asks for exactly what is missing) instead of coming back short with
 * the cursor already past what was dropped. A folder counts as an entry of the page, as it does in the read itself.
 * A page with nothing to leave out is the read as it was.
 */
export function withoutHiddenFiles(
  guard: RagFileGuard,
  read: (cursor: string | undefined, size: number) => Promise<ListFilesResponse>,
): (cursor: string | undefined, size: number) => Promise<ListFilesResponse> {
  return async (cursor, size) => {
    const first = await read(cursor, size);
    const kept = await guard.visible(first.items);
    if (kept.length === first.items.length) return first;

    const items = [...kept];
    const folders = new Set(first.folders ?? []);
    let next = first.nextCursor;
    for (let round = 1; round < FILL_ROUNDS_MAX && next; round += 1) {
      const missing = size - items.length - folders.size;
      if (missing <= 0) break;
      const page = await read(next, missing);
      items.push(...await guard.visible(page.items));
      for (const folder of page.folders ?? []) folders.add(folder);
      // A read that returned nothing ends the listing, whatever cursor it names.
      next = page.items.length === 0 && (page.folders?.length ?? 0) === 0 ? undefined : page.nextCursor;
    }
    return {
      ...first,
      items,
      ...(first.folders ? { folders: [...folders] } : {}),
      nextCursor: next,
    };
  };
}

// ── vector indexes ──────────────────────────────────────────────────────

export interface KbIndexRefusal {
  error: string;
  code: 'kb_access_controlled';
}

export interface RagIndexRef extends RagOwnedScope {
  providerKey: string;
  indexKey: string;
}

/** The modules with access control that keep their vectors in this index. */
async function controlledModulesUsingIndex(index: RagIndexRef): Promise<IRagModule[]> {
  return runWithTenantScope(index.tenantDbName, async (db) => {
    const controlled = (await db.listRagModules({ projectId: index.projectId })).filter(
      (ragModule) => ragModule.access?.enabled === true && ragModule.vectorProviderKey === index.providerKey,
    );
    if (controlled.length === 0) return [];

    const indexKeys = new Set([index.indexKey]);
    if (controlled.some((ragModule) => ragModule.vectorIndexKey !== index.indexKey)) {
      // Attaching an index that is already stored registers a second record for it: the records of one provider that
      // carry the same external id are one index.
      const records = await db.listVectorIndexes({ providerKey: index.providerKey, projectId: index.projectId });
      const externalId = records.find((record) => record.key === index.indexKey)?.externalId;
      if (typeof externalId === 'string' && externalId !== '') {
        for (const record of records) {
          if (record.externalId === externalId) indexKeys.add(record.key);
        }
      }
    }
    return controlled.filter((ragModule) => indexKeys.has(ragModule.vectorIndexKey));
  });
}

const KB_INDEX_REFUSALS = {
  query: 'This index holds the documents of a knowledge base with access control. Query the knowledge base instead.',
  copy: 'This index holds the documents of a knowledge base with access control. Its vectors are not copied to another index.',
  share: 'This index holds the documents of a knowledge base with access control. Another knowledge base does not use it.',
} as const;

/**
 * The refusal for reading a vector index a knowledge base with access control keeps its vectors in, directly (`query`),
 * by copying it to another index (`copy`, a vector migration) or by pointing another knowledge base at it (`share`:
 * that one would read the vectors without the checks), or null when the read may go on: no such module, or a caller
 * who skips the checks in every one of them.
 */
export async function kbIndexRefusal(
  request: FastifyRequest,
  index: RagIndexRef,
  read: keyof typeof KB_INDEX_REFUSALS = 'query',
): Promise<KbIndexRefusal | null> {
  const modules = await controlledModulesUsingIndex(index);
  if (modules.length === 0) return null;

  const { ragAccessForRequest } = await loadRagAccessRequest();
  for (const ragModule of modules) {
    const { scope } = await ragAccessForRequest(request, {
      tenantDbName: index.tenantDbName,
      tenantId: index.tenantId,
      projectId: index.projectId,
      ragModuleKey: ragModule.key,
    });
    if (scope?.enabled === true && !scope.bypass) {
      return { error: KB_INDEX_REFUSALS[read], code: 'kb_access_controlled' };
    }
  }
  return null;
}

// ── documents sent from other services ────────────────────────────────

const KB_INGEST_REFUSAL =
  'This knowledge base has access control. Only its administrators send documents to it from another service.';

/**
 * The refusal for having another service send documents into a knowledge base (a crawler's pages, now or on every
 * later run), or null. Those documents land with no reader check on where they go, and a page replaces the document of
 * the same name, so with access control on only a caller who administers the knowledge base sets that up. No such
 * module, or one without access control: null, and the service answers as it always has.
 */
export async function kbIngestRefusal(
  request: FastifyRequest,
  where: Pick<RagOwnedScope, 'tenantDbName'> & { projectId?: string },
  ragModuleKey: string,
): Promise<KbIndexRefusal | null> {
  const ragModule = await runWithTenantScope(where.tenantDbName, (db) => db.findRagModuleByKey(ragModuleKey, where.projectId));
  if (ragModule?.access?.enabled !== true) return null;
  const { canAdministerRagAccess } = await loadRagAccessRequest();
  if (await canAdministerRagAccess(request, ragModule)) return null;
  return { error: KB_INGEST_REFUSAL, code: 'kb_access_controlled' };
}

/** `kbIngestRefusal` for a crawler's saved or one-off module binding: only a binding that sends pages asks. */
export function kbBindingRefusal(
  request: FastifyRequest,
  where: Pick<RagOwnedScope, 'tenantDbName'> & { projectId?: string },
  rag: { ragModuleKey: string; enabled: boolean } | null | undefined,
): Promise<KbIndexRefusal | null> {
  return rag?.enabled ? kbIngestRefusal(request, where, rag.ragModuleKey) : Promise.resolve(null);
}

/**
 * The refusal for pointing a knowledge base at a vector index: a new one (no `current`), or an edit that moves the one
 * it has. An edit that leaves the index where it is asks nothing, so a knowledge base that already shares an index
 * can still be renamed or tuned.
 */
export async function kbIndexShareRefusal(
  request: FastifyRequest,
  where: RagOwnedScope,
  target: { providerKey: string; indexKey: string },
  current?: { providerKey: string; indexKey: string },
): Promise<KbIndexRefusal | null> {
  if (current && current.providerKey === target.providerKey && current.indexKey === target.indexKey) return null;
  return kbIndexRefusal(request, { ...where, providerKey: target.providerKey, indexKey: target.indexKey }, 'share');
}
