/**
 * MongoDB Provider – RAG operations mixin
 *
 * Includes RAG modules, documents, chunks, and query logs.
 */

import { ObjectId, type Filter } from 'mongodb';
import type {
  IRagModule,
  IRagDocument,
  IRagChunk,
  IRagQueryLog,
  RagDocumentAccessFilter,
  RagDocumentListFilters,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';
import { OBJECT_ID_HEX, toObjectIds } from './objectIds';

/**
 * `$bucket` boundaries are [lower, upper), so an exact 1.0 needs a boundary
 * above it or it falls out of the histogram entirely. Mirrored arithmetically
 * in `sqlite/rag.mixin.ts` — the two must produce identical labels.
 */
const SCORE_BUCKET_BOUNDARIES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.0001];

/** Labels, ascending: '0.0'..'0.9' plus '1.0'. The trailing sentinel is not one. */
const SCORE_BUCKET_LABELS = SCORE_BUCKET_BOUNDARIES.slice(0, -1).map((b) => b.toFixed(1));

/**
 * Scores outside [0, 1.0001) — a provider handing back a raw distance rather
 * than a normalized similarity. `$bucket` errors without a default; these are
 * dropped rather than charted, because they belong to no bucket.
 */
const SCORE_BUCKET_OUT_OF_RANGE = 'out-of-range';

/**
 * Fields an update clears by passing an explicit `undefined`: they are removed
 * from the stored document (`$unset`), not written as null - the same rule as
 * `rag-reindex.mixin.ts`, and what SQLite's NULL reads back as. Only the access
 * control fields are listed; every other field of these updates is untouched.
 */
const MODULE_NULLABLE_FIELDS: readonly string[] = ['access'];
const DOCUMENT_NULLABLE_FIELDS: readonly string[] = ['folderId', 'aclMode', 'aclManaged'];
/** Written only through `bumpRagModuleAclRevision` (and at create). */
const MODULE_BUMP_ONLY_FIELDS: readonly string[] = ['aclRevision'];

/** What `countRagDocuments` can narrow by (a list's paging and project fields are its own arguments here). */
type RagDocumentCountFilters = Pick<
  RagDocumentListFilters,
  'status' | 'search' | 'folderId' | 'ids' | 'access' | 'aclMode' | 'aclManaged' | 'withUnscoped'
>;

function distinctStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/**
 * Moves the listed fields out of `set` when they are present but empty
 * (undefined or null) and returns them as an `$unset` spec.
 */
function takeClearedFields(set: Record<string, unknown>, fields: readonly string[]): Record<string, ''> {
  const unset: Record<string, ''> = {};
  for (const field of fields) {
    if (!Object.hasOwn(set, field)) continue;
    if (set[field] === undefined || set[field] === null) {
      delete set[field];
      unset[field] = '';
    }
  }
  return unset;
}

/** `fields` that an insert would store as null: dropped instead, so the document simply lacks them. */
function dropEmptyFields(record: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (record[field] === undefined || record[field] === null) delete record[field];
  }
}

/** A stored module, read back: access-control fields that are null read as absent, like SQLite's NULL. */
function toRagModule(doc: { _id?: unknown }): IRagModule {
  const out: Record<string, unknown> = { ...doc, _id: doc._id?.toString() };
  dropEmptyFields(out, [...MODULE_NULLABLE_FIELDS, ...MODULE_BUMP_ONLY_FIELDS]);
  return out as unknown as IRagModule;
}

/** A stored document, read back: access-control fields that are null read as absent, like SQLite's NULL. */
function toRagDocument(doc: { _id?: unknown }): IRagDocument {
  const out: Record<string, unknown> = { ...doc, _id: doc._id?.toString() };
  dropEmptyFields(out, DOCUMENT_NULLABLE_FIELDS);
  return out as unknown as IRagDocument;
}

export function RagMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RagOps extends Base {
    // ── RAG Module operations ────────────────────────────────────────

    async createRagModule(
      ragModule: Omit<IRagModule, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagModule> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Record<string, unknown> = { ...ragModule, createdAt: now, updatedAt: now };
      // An access-control field that was not given is left out of the document,
      // not stored as null (an `$inc` on a null aclRevision would throw).
      dropEmptyFields(doc, [...MODULE_NULLABLE_FIELDS, ...MODULE_BUMP_ONLY_FIELDS]);
      const result = await db
        .collection(COLLECTIONS.ragModules)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() } as unknown as IRagModule;
    }

    async updateRagModule(
      id: string,
      data: Partial<Omit<IRagModule, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      for (const field of MODULE_BUMP_ONLY_FIELDS) delete updateData[field];
      const unset = takeClearedFields(updateData, MODULE_NULLABLE_FIELDS);
      const result = await db
        .collection<IRagModule>(COLLECTIONS.ragModules)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          Object.keys(unset).length > 0 ? { $set: updateData, $unset: unset } : { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return toRagModule(result);
    }

    /** Pipeline update, so a module that never had the field (or holds null) starts from 0; all matching modules, like SQLite. */
    async bumpRagModuleAclRevision(ragModuleKey: string, projectId?: string): Promise<void> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key: ragModuleKey };
      if (projectId !== undefined) Object.assign(filter, this.buildProjectScopeFilter(projectId));
      await db.collection(COLLECTIONS.ragModules).updateMany(
        filter,
        [{ $set: { aclRevision: { $add: [{ $ifNull: ['$aclRevision', 0] }, 1] } } }],
      );
    }

    async incrementRagModuleTotals(
      id: string,
      delta: { documents?: number; chunks?: number },
    ): Promise<void> {
      const db = this.getTenantDb();
      // Pipeline update rather than `$inc` so a decrement can be clamped at 0
      // and a module created without the fields still starts from 0.
      const add = (field: string, by: number) => ({
        $max: [0, { $add: [{ $ifNull: [`$${field}`, 0] }, by] }],
      });
      await db.collection(COLLECTIONS.ragModules).updateOne(
        { _id: new ObjectId(id) },
        [{
          $set: {
            totalDocuments: add('totalDocuments', delta.documents ?? 0),
            totalChunks: add('totalChunks', delta.chunks ?? 0),
            updatedAt: new Date(),
          },
        }],
      );
    }

    async deleteRagModule(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragModules)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    }

    async findRagModuleById(id: string): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IRagModule>(COLLECTIONS.ragModules)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return toRagModule(doc);
    }

    async findRagModuleByKey(key: string, projectId?: string): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      // When projectId is provided, scope the lookup to that project.
      // When undefined, find by key alone (tenant-wide) — used by client API where
      // the token authenticates the tenant, not a specific project.
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) {
        Object.assign(filter, this.buildProjectScopeFilter(projectId));
      }
      const doc = await db
        .collection<IRagModule>(COLLECTIONS.ragModules)
        .findOne(filter as Filter<IRagModule>);
      if (!doc) return null;
      return toRagModule(doc);
    }

    async listRagModules(filters?: {
      projectId?: string;
      status?: IRagModule['status'];
      search?: string;
    }): Promise<IRagModule[]> {
      const db = this.getTenantDb();
      // When projectId is provided, scope to that project.
      // When undefined, list all modules in the tenant (used by client API).
      const query: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(filters.projectId));
      }
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        query.$or = [
          { name: { $regex: this.escapeRegex(filters.search), $options: 'i' } },
          { key: { $regex: this.escapeRegex(filters.search), $options: 'i' } },
        ];
      }
      const docs = await db
        .collection<IRagModule>(COLLECTIONS.ragModules)
        .find(query as Filter<IRagModule>)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => toRagModule(d));
    }

    // ── RAG Document operations ──────────────────────────────────────

    async createRagDocument(
      doc: Omit<IRagDocument, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagDocument> {
      const db = this.getTenantDb();
      const now = new Date();
      const record: Record<string, unknown> = { ...doc, createdAt: now, updatedAt: now };
      // Folder / ACL fields that were not given are left out, not stored as null.
      dropEmptyFields(record, DOCUMENT_NULLABLE_FIELDS);
      const result = await db
        .collection(COLLECTIONS.ragDocuments)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as unknown as IRagDocument;
    }

    async updateRagDocument(
      id: string,
      data: Partial<Omit<IRagDocument, 'tenantId' | 'ragModuleKey' | 'createdBy'>>,
    ): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const unset = takeClearedFields(updateData, DOCUMENT_NULLABLE_FIELDS);
      const result = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          Object.keys(unset).length > 0 ? { $set: updateData, $unset: unset } : { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return toRagDocument(result);
    }

    async deleteRagDocument(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const removed = await db
        .collection(COLLECTIONS.ragDocuments)
        .findOneAndDelete({ _id: new ObjectId(id) }, { projection: { ragModuleKey: 1 } });
      if (!removed) return false;
      // The permission entries that sat on this document go with it.
      await db
        .collection(COLLECTIONS.ragAclEntries)
        .deleteMany({ ragModuleKey: removed.ragModuleKey, nodeType: 'document', nodeId: id });
      return true;
    }

    async findRagDocumentById(id: string): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return toRagDocument(doc);
    }

    async findRagDocumentByFileName(
      ragModuleKey: string,
      fileName: string,
      projectId?: string,
    ): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { ragModuleKey, fileName };
      if (projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(projectId));
      }
      const doc = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .findOne(query as Filter<IRagDocument>, { sort: { createdAt: -1 } });
      if (!doc) return null;
      return toRagDocument(doc);
    }

    async listRagDocumentsByFileName(
      ragModuleKey: string,
      fileName: string,
      projectId?: string,
    ): Promise<IRagDocument[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { ragModuleKey, fileName };
      if (projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(projectId));
      }
      const docs = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .find(query as Filter<IRagDocument>, { sort: { createdAt: -1, _id: -1 } })
        .toArray();
      return docs.map((doc) => toRagDocument(doc));
    }

    async listRagDocuments(
      ragModuleKey: string,
      filters?: RagDocumentListFilters,
    ): Promise<IRagDocument[]> {
      const db = this.getTenantDb();
      const query = this.buildRagDocumentListQuery(ragModuleKey, filters);
      let cursor = db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .find(query as Filter<IRagDocument>)
        // _id breaks ties so a page boundary never repeats or drops a row
        // when several documents share a createdAt (bulk imports do).
        .sort({ createdAt: -1, _id: -1 });
      if (filters?.offset) cursor = cursor.skip(filters.offset);
      if (filters?.limit !== undefined) cursor = cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => toRagDocument(d));
    }

    async countRagDocuments(
      ragModuleKey: string,
      projectId?: string,
      filters?: RagDocumentCountFilters,
    ): Promise<number> {
      const db = this.getTenantDb();
      const query = this.buildRagDocumentCountQuery(ragModuleKey, projectId, filters);
      return db
        .collection(COLLECTIONS.ragDocuments)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .countDocuments(query as any);
    }

    /** One count per folder (`''` = top level), over exactly the rows `countRagDocuments` counts for the same arguments. */
    async countRagDocumentsByFolder(
      ragModuleKey: string,
      projectId: string | undefined,
      filters?: Pick<RagDocumentListFilters, 'access' | 'withUnscoped'>,
    ): Promise<Record<string, number>> {
      const db = this.getTenantDb();
      const query = this.buildRagDocumentCountQuery(ragModuleKey, projectId, filters);
      // A document without a folder (missing or null) is one group, and an empty folder id is another: both are the top level.
      const rows = await db
        .collection(COLLECTIONS.ragDocuments)
        .aggregate<{ _id: unknown; count: number }>([
          { $match: query },
          { $group: { _id: '$folderId', count: { $sum: 1 } } },
        ])
        .toArray();
      const counts = new Map<string, number>();
      for (const row of rows) {
        const folder = row._id === null || row._id === undefined ? '' : String(row._id);
        counts.set(folder, (counts.get(folder) ?? 0) + row.count);
      }
      return Object.fromEntries(counts);
    }

    /** Same filters and order as `listRagDocuments`, ids only. `limit` is required. */
    async listRagDocumentIds(
      ragModuleKey: string,
      filters: RagDocumentListFilters & { limit: number },
    ): Promise<string[]> {
      // `limit(0)` means "no limit" to MongoDB and "nothing" to SQLite: make both nothing.
      if (!(filters.limit > 0)) return [];
      const db = this.getTenantDb();
      const query = this.buildRagDocumentListQuery(ragModuleKey, filters);
      let cursor = db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .find(query as Filter<IRagDocument>, { projection: { _id: 1 } })
        .sort({ createdAt: -1, _id: -1 });
      const offset = Math.floor(filters.offset ?? 0);
      if (offset > 0) cursor = cursor.skip(offset);
      cursor = cursor.limit(Math.floor(filters.limit));
      const docs = await cursor.toArray();
      return docs.map((d) => String(d._id));
    }

    /**
     * The documents with these ids, without `sourceText` (excluded in the
     * query, so the text is not sent over the wire). Ids that do not exist are
     * skipped; the rest come back in the order the ids were given, each once.
     */
    async findRagDocumentsByIds(ids: string[]): Promise<IRagDocument[]> {
      // ObjectId strings are lower-case hex when read back, so match them that way.
      const wanted = [...new Set(distinctStrings(ids).filter((id) => OBJECT_ID_HEX.test(id)).map((id) => id.toLowerCase()))];
      if (wanted.length === 0) return [];
      const db = this.getTenantDb();
      const docs = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .find({ _id: { $in: toObjectIds(wanted) } } as Filter<IRagDocument>, { projection: { sourceText: 0 } })
        .toArray();
      const byId = new Map(docs.map((d) => [String(d._id), toRagDocument(d)] as const));
      return wanted.flatMap((id) => {
        const doc = byId.get(id);
        return doc ? [doc] : [];
      });
    }

    /** The query of `listRagDocuments` / `listRagDocumentIds`: module, project scope, status, search, folder, ids, access. */
    private buildRagDocumentListQuery(
      ragModuleKey: string,
      filters?: RagDocumentListFilters,
    ): Record<string, unknown> {
      // When projectId is provided, scope to that project.
      // When undefined, list all documents for this module (tenant-wide for client API).
      const query: Record<string, unknown> = { ragModuleKey };
      if (filters?.projectId !== undefined) {
        Object.assign(query, this.buildRagDocumentProjectScope(filters.projectId, filters.withUnscoped === true));
      }
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        query.fileName = { $regex: this.escapeRegex(filters.search), $options: 'i' };
      }
      this.applyRagDocumentSelection(query, filters);
      return query;
    }

    /**
     * The query of `countRagDocuments` / `countRagDocumentsByFolder`: module, project scope, status, search, selection.
     * An absent project is scoped like `buildProjectScopeFilter(undefined)`: only the rows that carry no project.
     */
    private buildRagDocumentCountQuery(
      ragModuleKey: string,
      projectId: string | undefined,
      filters?: RagDocumentCountFilters,
    ): Record<string, unknown> {
      const query: Record<string, unknown> = {
        ragModuleKey,
        ...this.buildRagDocumentProjectScope(projectId, filters?.withUnscoped === true),
      };
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        query.fileName = { $regex: this.escapeRegex(filters.search), $options: 'i' };
      }
      this.applyRagDocumentSelection(query, filters);
      return query;
    }

    /** A project's rows; with `withUnscoped` also the rows that carry no project. */
    private buildRagDocumentProjectScope(projectId: string | undefined, withUnscoped: boolean): Record<string, unknown> {
      const scoped = this.buildProjectScopeFilter(projectId);
      if (!withUnscoped || !projectId?.trim()) return scoped;
      const unscoped = this.buildProjectScopeFilter(undefined) as { $or: unknown[] };
      return { $or: [scoped, ...unscoped.$or] };
    }

    /**
     * Which documents: a folder (or the top level), a set of ids, whether they
     * carry their own permissions and who keeps those, and/or what an access
     * scope may read. The access clause goes under `$and`, because the project
     * scope may already have put an `$or` on the query. An empty id list
     * matches nothing. 'inherit' and 'console' are "everything but 'own' /
     * 'sync'", so a document without the field (or with it null) is theirs.
     */
    private applyRagDocumentSelection(
      query: Record<string, unknown>,
      filters?: Pick<RagDocumentListFilters, 'folderId' | 'ids' | 'access' | 'aclMode' | 'aclManaged'>,
    ): void {
      if (!filters) return;
      if (filters.folderId === null || filters.folderId === '') {
        // `null` also matches a document that has no folderId at all.
        query.folderId = { $in: [null, ''] };
      } else if (typeof filters.folderId === 'string') {
        query.folderId = filters.folderId;
      }
      if (filters.ids !== undefined) query._id = { $in: toObjectIds(filters.ids) };
      if (filters.aclMode === 'own') query.aclMode = 'own';
      else if (filters.aclMode === 'inherit') query.aclMode = { $ne: 'own' };
      if (filters.aclManaged === 'sync') query.aclManaged = 'sync';
      else if (filters.aclManaged === 'console') query.aclManaged = { $ne: 'sync' };
      if (filters.access) {
        const clause = this.buildRagAccessQuery(filters.access);
        if (clause) query.$and = [...((query.$and as unknown[] | undefined) ?? []), clause];
      }
    }

    /**
     * `RagDocumentAccessFilter` as a Mongo filter. A document matches when it has
     * its own ACL and its id is allowed, or it inherits and its folder is
     * allowed, or it inherits from the top level and the top level is allowed
     * (`aclMode: { $ne: 'own' }` also matches a document with no aclMode).
     * `negate` inverts the whole test. Returns null when there is nothing to add
     * (a negated match-nothing).
     */
    private buildRagAccessQuery(access: RagDocumentAccessFilter): Record<string, unknown> | null {
      const clauses: Record<string, unknown>[] = [];
      const own = toObjectIds(access.ownAllowedIds);
      if (own.length > 0) clauses.push({ aclMode: 'own', _id: { $in: own } });
      const folders = distinctStrings(access.inheritFolderIds);
      if (folders.length > 0) clauses.push({ aclMode: { $ne: 'own' }, folderId: { $in: folders } });
      if (access.includeTopLevel) clauses.push({ aclMode: { $ne: 'own' }, folderId: { $in: [null, ''] } });
      if (clauses.length === 0) return access.negate ? null : { _id: { $in: [] } };
      return access.negate ? { $nor: clauses } : { $or: clauses };
    }

    // ── RAG Chunk operations ─────────────────────────────────────────

    async bulkInsertRagChunks(
      chunks: Omit<IRagChunk, '_id' | 'createdAt'>[],
    ): Promise<void> {
      if (chunks.length === 0) return;
      const db = this.getTenantDb();
      const now = new Date();
      const records = chunks.map((c) => ({ ...c, createdAt: now }));
      await db
        .collection(COLLECTIONS.ragChunks)
        .insertMany(records);
    }

    async findRagChunksByVectorIds(vectorIds: string[]): Promise<IRagChunk[]> {
      if (vectorIds.length === 0) return [];
      const db = this.getTenantDb();
      const docs = await db
        .collection<IRagChunk>(COLLECTIONS.ragChunks)
        .find({ vectorId: { $in: vectorIds } })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagChunk);
    }

    async findRagChunksByDocumentId(documentId: string): Promise<IRagChunk[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection<IRagChunk>(COLLECTIONS.ragChunks)
        .find({ documentId })
        .sort({ chunkIndex: 1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagChunk);
    }

    async deleteRagChunksByDocumentId(documentId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragChunks)
        .deleteMany({ documentId });
      return result.deletedCount;
    }

    // ── RAG Query Log operations ─────────────────────────────────────

    async createRagQueryLog(
      log: Omit<IRagQueryLog, '_id' | 'createdAt'>,
    ): Promise<IRagQueryLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...log, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.ragQueryLogs)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IRagQueryLog;
    }

    async listRagQueryLogs(
      ragModuleKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date; zeroOnly?: boolean; projectId?: string; userId?: string },
    ): Promise<IRagQueryLog[]> {
      const db = this.getTenantDb();
      const query = this.buildRagQueryLogFilter(ragModuleKey, options);
      if (options?.zeroOnly) query.matchCount = 0;
      if (options?.userId !== undefined) query.userId = options.userId;
      const cursor = db
        .collection<IRagQueryLog>(COLLECTIONS.ragQueryLogs)
        .find(query as Filter<IRagQueryLog>)
        .sort({ createdAt: -1 });
      if (options?.skip) cursor.skip(options.skip);
      cursor.limit(options?.limit ?? 50);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagQueryLog);
    }

    async countRagQueryLogs(
      ragModuleKey: string,
      options?: { from?: Date; to?: Date; projectId?: string },
    ): Promise<{
      total: number;
      avgLatencyMs: number;
      zeroMatchCount: number;
      minScoreFilteredCount: number;
    }> {
      const db = this.getTenantDb();
      const query = this.buildRagQueryLogFilter(ragModuleKey, options);
      const [agg] = await db
        .collection(COLLECTIONS.ragQueryLogs)
        .aggregate([
          { $match: query },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              avgLatencyMs: { $avg: '$latencyMs' },
              zeroMatchCount: { $sum: { $cond: [{ $eq: ['$matchCount', 0] }, 1, 0] } },
              // A missing preFilterMatchCount compares as null, which is below
              // any number, so pre-change logs never count as filtered-out.
              minScoreFilteredCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$matchCount', 0] },
                        { $gt: ['$preFilterMatchCount', 0] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
        .toArray();
      return {
        total: (agg?.total as number | undefined) ?? 0,
        avgLatencyMs: agg?.avgLatencyMs ? Math.round(agg.avgLatencyMs as number) : 0,
        zeroMatchCount: (agg?.zeroMatchCount as number | undefined) ?? 0,
        minScoreFilteredCount: (agg?.minScoreFilteredCount as number | undefined) ?? 0,
      };
    }

    async aggregateRagQueryScoreDistribution(
      ragModuleKey: string,
      options?: { from?: Date; to?: Date; projectId?: string },
    ): Promise<Array<{ bucket: string; count: number }>> {
      const db = this.getTenantDb();
      const query = this.buildRagQueryLogFilter(ragModuleKey, options);
      // Logs written before topScore existed carry no score to bucket.
      query.topScore = { $type: 'number' };

      const rows = await db
        .collection(COLLECTIONS.ragQueryLogs)
        .aggregate<{ _id: number | string; count: number }>([
          { $match: query },
          {
            $bucket: {
              groupBy: '$topScore',
              boundaries: SCORE_BUCKET_BOUNDARIES,
              default: SCORE_BUCKET_OUT_OF_RANGE,
              output: { count: { $sum: 1 } },
            },
          },
        ])
        .toArray();

      const counts = new Map(
        rows
          .filter((row) => typeof row._id === 'number')
          .map((row) => [(row._id as number).toFixed(1), row.count]),
      );
      // Always every bucket: a histogram missing its empty bars reads as a
      // different distribution, and it is exactly where the two backends' own
      // grouping would otherwise disagree.
      return SCORE_BUCKET_LABELS.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
    }

    async deleteRagQueryLogsOlderThan(before: Date, ragModuleKey?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { createdAt: { $lt: before } };
      if (ragModuleKey) query.ragModuleKey = ragModuleKey;
      const result = await db.collection(COLLECTIONS.ragQueryLogs).deleteMany(query);
      return result.deletedCount;
    }

    // ── RAG module teardown ──────────────────────────────────────────

    async deleteRagDocumentsByModuleKey(ragModuleKey: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragDocuments)
        .deleteMany({ ragModuleKey });
      return result.deletedCount;
    }

    async deleteRagChunksByModuleKey(ragModuleKey: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragChunks)
        .deleteMany({ ragModuleKey });
      return result.deletedCount;
    }

    async countRagModulesByVectorIndexKey(
      vectorIndexKey: string,
      options?: { projectId?: string; excludeKey?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { vectorIndexKey };
      if (options?.projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(options.projectId));
      }
      // The module being edited must not count itself as a co-tenant of its
      // own index.
      if (options?.excludeKey) query.key = { $ne: options.excludeKey };
      return db
        .collection(COLLECTIONS.ragModules)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .countDocuments(query as any);
    }

    /** Shared module + project + date-window match for every query-log read. */
    /**
     * Module keys are unique only WITHIN a project, so a query-log read filtered by
     * ragModuleKey alone picks up the rows of a same-key module in another project
     * of the tenant — including the verbatim end-user query text.
     *
     * Rows written with no projectId (logs predating project stamping, and every
     * query through /client/v1, which passes projectId undefined) cannot be
     * attributed to either module. They stay visible to the module's owner: hiding
     * a project's own history is the worse of the two failure modes, and the caller
     * has already been verified to own a module with this key.
     */
    private buildRagQueryLogFilter(
      ragModuleKey: string,
      options?: { from?: Date; to?: Date; projectId?: string },
    ): Record<string, unknown> {
      const query: Record<string, unknown> = { ragModuleKey };
      if (options?.projectId) {
        query.$or = [
          { projectId: options.projectId },
          { projectId: { $exists: false } },
          { projectId: null },
        ];
      }
      if (options?.from || options?.to) {
        const dateFilter: Record<string, Date> = {};
        if (options.from) dateFilter.$gte = options.from;
        if (options.to) dateFilter.$lte = options.to;
        query.createdAt = dateFilter;
      }
      return query;
    }
  };
}
