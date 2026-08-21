/**
 * SQLite Provider – RAG operations mixin
 *
 * Includes RAG modules, documents, chunks, and query logs.
 */

import type {
  IRagModule,
  IRagDocument,
  IRagChunk,
  IRagQueryLog,
  RagDocumentStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

/** Labels, ascending: '0.0'..'0.9' plus '1.0'. Mirrors `mongodb/rag.mixin.ts`. */
const SCORE_BUCKET_LABELS = Array.from({ length: 11 }, (_, i) => (i / 10).toFixed(1));

/** Exclusive upper bound, so an exact 1.0 still lands in the last bucket. */
const SCORE_BUCKET_UPPER = 1.0001;

export function RagMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class RagOps extends Base {
    // ── RAG Module operations ────────────────────────────────────────

    async createRagModule(
      ragModule: Omit<IRagModule, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagModule> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.ragModules}
        (id, tenantId, projectId, key, name, description,
         embeddingModelKey, vectorProviderKey, vectorIndexKey, fileBucketKey, fileProviderKey,
         chunkConfig, status, rerankerKey, rerankerOversample, defaultTopK, defaultMinScore, responseDetail,
         defaultFilter, filterableFields, hybrid, isolateByModule,
         reindexRequired, activeReindexRunKey, lastReindexAt,
         totalDocuments, totalChunks, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description,
         @embeddingModelKey, @vectorProviderKey, @vectorIndexKey, @fileBucketKey, @fileProviderKey,
         @chunkConfig, @status, @rerankerKey, @rerankerOversample, @defaultTopK, @defaultMinScore, @responseDetail,
         @defaultFilter, @filterableFields, @hybrid, @isolateByModule,
         @reindexRequired, @activeReindexRunKey, @lastReindexAt,
         @totalDocuments, @totalChunks, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: ragModule.tenantId,
        projectId: ragModule.projectId ?? null,
        key: ragModule.key,
        name: ragModule.name,
        description: ragModule.description ?? null,
        embeddingModelKey: ragModule.embeddingModelKey,
        vectorProviderKey: ragModule.vectorProviderKey,
        vectorIndexKey: ragModule.vectorIndexKey,
        fileBucketKey: ragModule.fileBucketKey ?? null,
        fileProviderKey: ragModule.fileProviderKey ?? null,
        chunkConfig: this.toJson(ragModule.chunkConfig),
        status: ragModule.status,
        rerankerKey: ragModule.rerankerKey ?? null,
        rerankerOversample: ragModule.rerankerOversample ?? null,
        defaultTopK: ragModule.defaultTopK ?? null,
        defaultMinScore: ragModule.defaultMinScore ?? null,
        responseDetail: ragModule.responseDetail ?? null,
        defaultFilter: ragModule.defaultFilter ? this.toJson(ragModule.defaultFilter) : null,
        filterableFields: ragModule.filterableFields ? this.toJson(ragModule.filterableFields) : null,
        hybrid: ragModule.hybrid ? this.toJson(ragModule.hybrid) : null,
        isolateByModule: ragModule.isolateByModule === undefined ? null : this.toBoolInt(ragModule.isolateByModule),
        reindexRequired: ragModule.reindexRequired === undefined ? null : this.toBoolInt(ragModule.reindexRequired),
        activeReindexRunKey: ragModule.activeReindexRunKey ?? null,
        lastReindexAt: ragModule.lastReindexAt ? ragModule.lastReindexAt.toISOString() : null,
        totalDocuments: ragModule.totalDocuments ?? 0,
        totalChunks: ragModule.totalChunks ?? 0,
        metadata: this.toJson(ragModule.metadata ?? {}),
        createdBy: ragModule.createdBy,
        updatedBy: ragModule.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...ragModule, _id: id, createdAt: new Date(now), updatedAt: new Date(now) } as IRagModule;
    }

    async updateRagModule(
      id: string,
      data: Partial<Omit<IRagModule, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.embeddingModelKey !== undefined) { sets.push('embeddingModelKey = @embeddingModelKey'); params.embeddingModelKey = data.embeddingModelKey; }
      if (data.vectorProviderKey !== undefined) { sets.push('vectorProviderKey = @vectorProviderKey'); params.vectorProviderKey = data.vectorProviderKey; }
      if (data.vectorIndexKey !== undefined) { sets.push('vectorIndexKey = @vectorIndexKey'); params.vectorIndexKey = data.vectorIndexKey; }
      if (data.fileBucketKey !== undefined) { sets.push('fileBucketKey = @fileBucketKey'); params.fileBucketKey = data.fileBucketKey; }
      if (data.fileProviderKey !== undefined) { sets.push('fileProviderKey = @fileProviderKey'); params.fileProviderKey = data.fileProviderKey; }
      if (data.chunkConfig !== undefined) { sets.push('chunkConfig = @chunkConfig'); params.chunkConfig = this.toJson(data.chunkConfig); }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.totalDocuments !== undefined) { sets.push('totalDocuments = @totalDocuments'); params.totalDocuments = data.totalDocuments; }
      if (data.totalChunks !== undefined) { sets.push('totalChunks = @totalChunks'); params.totalChunks = data.totalChunks; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      // Presence, not value, for everything an operator can CLEAR. The service
      // turns the API's `null` into an explicit `undefined` (updateRagModule,
      // `request.X ?? undefined`), which Mongo's $set writes as null. A
      // `!== undefined` guard here silently drops the clear while the API
      // reports success, so the two backends disagree about what a PATCH did.
      const clearable = [
        ['rerankerKey', () => data.rerankerKey ?? null],
        ['rerankerOversample', () => data.rerankerOversample ?? null],
        ['defaultTopK', () => data.defaultTopK ?? null],
        ['defaultMinScore', () => data.defaultMinScore ?? null],
        ['responseDetail', () => data.responseDetail ?? null],
        ['defaultFilter', () => (data.defaultFilter ? this.toJson(data.defaultFilter) : null)],
        ['filterableFields', () => (data.filterableFields ? this.toJson(data.filterableFields) : null)],
        ['hybrid', () => (data.hybrid ? this.toJson(data.hybrid) : null)],
        ['isolateByModule', () => (data.isolateByModule === undefined ? null : this.toBoolInt(data.isolateByModule))],
      ] as const;
      for (const [column, value] of clearable) {
        if (!Object.hasOwn(data, column)) continue;
        sets.push(`${column} = @${column}`);
        params[column] = value();
      }
      if (data.reindexRequired !== undefined) { sets.push('reindexRequired = @reindexRequired'); params.reindexRequired = this.toBoolInt(data.reindexRequired); }
      if (data.lastReindexAt !== undefined) { sets.push('lastReindexAt = @lastReindexAt'); params.lastReindexAt = data.lastReindexAt instanceof Date ? data.lastReindexAt.toISOString() : data.lastReindexAt; }
      // Presence, not value: a finished run clears the pointer by passing an
      // explicit `undefined`, which Mongo's $set writes as null. Skipping it
      // here would strand the module on a run that no longer exists.
      if (Object.hasOwn(data, 'activeReindexRunKey')) {
        sets.push('activeReindexRunKey = @activeReindexRunKey');
        params.activeReindexRunKey = data.activeReindexRunKey ?? null;
      }

      db.prepare(`UPDATE ${TABLES.ragModules} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRagModuleById(id);
    }

    async deleteRagModule(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.ragModules} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findRagModuleById(id: string): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.ragModules} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapModuleRow(row) : null;
    }

    async findRagModuleByKey(key: string, projectId?: string): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      const clauses: string[] = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      const row = db.prepare(
        `SELECT * FROM ${TABLES.ragModules} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow | undefined;
      return row ? this.mapModuleRow(row) : null;
    }

    async listRagModules(filters?: {
      projectId?: string;
      status?: IRagModule['status'];
      search?: string;
    }): Promise<IRagModule[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(filters.projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.search) {
        clauses.push('(name LIKE @search OR key LIKE @search)');
        params.search = this.likePattern(filters.search);
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragModules} ${where} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapModuleRow(r));
    }

    // ── RAG Document operations ──────────────────────────────────────

    async createRagDocument(
      doc: Omit<IRagDocument, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagDocument> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.ragDocuments}
        (id, tenantId, projectId, ragModuleKey, fileKey, fileBucketKey, fileProviderKey,
         fileName, contentType, size, status, chunkCount, errorMessage, lastIndexedAt,
         chunkConfig, sourceText, sourceTextKey, sourceHash, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @ragModuleKey, @fileKey, @fileBucketKey, @fileProviderKey,
         @fileName, @contentType, @size, @status, @chunkCount, @errorMessage, @lastIndexedAt,
         @chunkConfig, @sourceText, @sourceTextKey, @sourceHash, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: doc.tenantId,
        projectId: doc.projectId ?? null,
        ragModuleKey: doc.ragModuleKey,
        fileKey: doc.fileKey ?? null,
        fileBucketKey: doc.fileBucketKey ?? null,
        fileProviderKey: doc.fileProviderKey ?? null,
        fileName: doc.fileName,
        contentType: doc.contentType ?? null,
        size: doc.size ?? null,
        status: doc.status,
        chunkCount: doc.chunkCount ?? 0,
        errorMessage: doc.errorMessage ?? null,
        lastIndexedAt: doc.lastIndexedAt ? doc.lastIndexedAt.toISOString() : null,
        chunkConfig: doc.chunkConfig ? this.toJson(doc.chunkConfig) : null,
        sourceText: doc.sourceText ?? null,
        sourceTextKey: doc.sourceTextKey ?? null,
        sourceHash: doc.sourceHash ?? null,
        metadata: this.toJson(doc.metadata ?? {}),
        createdBy: doc.createdBy,
        updatedBy: doc.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...doc, _id: id, createdAt: new Date(now), updatedAt: new Date(now) } as IRagDocument;
    }

    async updateRagDocument(
      id: string,
      data: Partial<Omit<IRagDocument, 'tenantId' | 'ragModuleKey' | 'createdBy'>>,
    ): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.fileKey !== undefined) { sets.push('fileKey = @fileKey'); params.fileKey = data.fileKey; }
      if (data.fileName !== undefined) { sets.push('fileName = @fileName'); params.fileName = data.fileName; }
      if (data.contentType !== undefined) { sets.push('contentType = @contentType'); params.contentType = data.contentType; }
      if (data.size !== undefined) { sets.push('size = @size'); params.size = data.size; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.chunkCount !== undefined) { sets.push('chunkCount = @chunkCount'); params.chunkCount = data.chunkCount; }
      if (data.errorMessage !== undefined) { sets.push('errorMessage = @errorMessage'); params.errorMessage = data.errorMessage; }
      if (data.lastIndexedAt !== undefined) { sets.push('lastIndexedAt = @lastIndexedAt'); params.lastIndexedAt = data.lastIndexedAt instanceof Date ? data.lastIndexedAt.toISOString() : data.lastIndexedAt; }
      if (data.fileBucketKey !== undefined) { sets.push('fileBucketKey = @fileBucketKey'); params.fileBucketKey = data.fileBucketKey; }
      if (data.fileProviderKey !== undefined) { sets.push('fileProviderKey = @fileProviderKey'); params.fileProviderKey = data.fileProviderKey; }
      // Presence, not value. re-ingest passes an explicit `undefined` to CLEAR
      // sourceHash when the text it stored is a reconstruction; a
      // `!== undefined` guard would skip that and leave the stale hash of the
      // true original sitting next to the join, so the user's corrective
      // re-upload would be de-duplicated away against a hash of content that is
      // no longer there.
      const clearableDoc = [
        ['chunkConfig', () => (data.chunkConfig ? this.toJson(data.chunkConfig) : null)],
        ['sourceText', () => data.sourceText ?? null],
        ['sourceTextKey', () => data.sourceTextKey ?? null],
        ['sourceHash', () => data.sourceHash ?? null],
      ] as const;
      for (const [column, value] of clearableDoc) {
        if (!Object.hasOwn(data, column)) continue;
        sets.push(`${column} = @${column}`);
        params[column] = value();
      }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(`UPDATE ${TABLES.ragDocuments} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRagDocumentById(id);
    }

    async deleteRagDocument(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.ragDocuments} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findRagDocumentById(id: string): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.ragDocuments} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapDocRow(row) : null;
    }

    async findRagDocumentByFileName(
      ragModuleKey: string,
      fileName: string,
      projectId?: string,
    ): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const clauses: string[] = ['ragModuleKey = @ragModuleKey', 'fileName = @fileName'];
      const params: Record<string, unknown> = { ragModuleKey, fileName };

      if (projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }

      const row = db.prepare(
        `SELECT * FROM ${TABLES.ragDocuments} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC LIMIT 1`,
      ).get(params) as SqliteRow | undefined;
      return row ? this.mapDocRow(row) : null;
    }

    async listRagDocuments(
      ragModuleKey: string,
      filters?: { projectId?: string; status?: RagDocumentStatus; search?: string },
    ): Promise<IRagDocument[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['ragModuleKey = @ragModuleKey'];
      const params: Record<string, unknown> = { ragModuleKey };

      if (filters?.projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(filters.projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.search) { clauses.push('fileName LIKE @search'); params.search = this.likePattern(filters.search); }

      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragDocuments} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapDocRow(r));
    }

    async countRagDocuments(ragModuleKey: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ['ragModuleKey = @ragModuleKey'];
      const params: Record<string, unknown> = { ragModuleKey };
      if (projectId) {
        const scopeFilter = this.buildProjectScopeFilter(projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.ragDocuments} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow;
      return (row.cnt as number) || 0;
    }

    // ── RAG Chunk operations ─────────────────────────────────────────

    async bulkInsertRagChunks(
      chunks: Omit<IRagChunk, '_id' | 'createdAt'>[],
    ): Promise<void> {
      if (chunks.length === 0) return;
      const db = this.getTenantDb();
      const now = this.now();
      const insert = db.prepare(`
        INSERT INTO ${TABLES.ragChunks}
        (id, tenantId, projectId, ragModuleKey, documentId, chunkIndex, vectorId, content,
         charStart, charEnd, headingPath, tokenCount, metadata, createdAt)
        VALUES (@id, @tenantId, @projectId, @ragModuleKey, @documentId, @chunkIndex, @vectorId, @content,
         @charStart, @charEnd, @headingPath, @tokenCount, @metadata, @createdAt)
      `);

      const tx = db.transaction((items: typeof chunks) => {
        for (const c of items) {
          insert.run({
            id: this.newId(),
            tenantId: c.tenantId,
            projectId: c.projectId ?? null,
            ragModuleKey: c.ragModuleKey,
            documentId: c.documentId,
            chunkIndex: c.chunkIndex,
            vectorId: c.vectorId,
            content: c.content,
            charStart: c.charStart ?? null,
            charEnd: c.charEnd ?? null,
            headingPath: c.headingPath ? this.toJson(c.headingPath) : null,
            tokenCount: c.tokenCount ?? null,
            metadata: this.toJson(c.metadata ?? {}),
            createdAt: now,
          });
        }
      });
      tx(chunks);
    }

    async findRagChunksByVectorIds(vectorIds: string[]): Promise<IRagChunk[]> {
      if (vectorIds.length === 0) return [];
      const db = this.getTenantDb();
      const placeholders = vectorIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragChunks} WHERE vectorId IN (${placeholders})`,
      ).all(...vectorIds) as SqliteRow[];
      return rows.map((r) => this.mapChunkRow(r));
    }

    async findRagChunksByDocumentId(documentId: string): Promise<IRagChunk[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragChunks} WHERE documentId = @documentId ORDER BY chunkIndex ASC`,
      ).all({ documentId }) as SqliteRow[];
      return rows.map((r) => this.mapChunkRow(r));
    }

    async deleteRagChunksByDocumentId(documentId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.ragChunks} WHERE documentId = @documentId`)
        .run({ documentId }).changes;
    }

    // ── RAG Query Log operations ─────────────────────────────────────

    async createRagQueryLog(
      log: Omit<IRagQueryLog, '_id' | 'createdAt'>,
    ): Promise<IRagQueryLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.ragQueryLogs}
        (id, tenantId, projectId, ragModuleKey, query, topK, matchCount,
         preFilterMatchCount, topScore, avgScore, minScoreApplied, hybrid,
         latencyMs, metadata,
         userId, apiTokenId, actorType, createdAt)
        VALUES (@id, @tenantId, @projectId, @ragModuleKey, @query, @topK, @matchCount,
         @preFilterMatchCount, @topScore, @avgScore, @minScoreApplied, @hybrid,
         @latencyMs, @metadata,
         @userId, @apiTokenId, @actorType, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        ragModuleKey: log.ragModuleKey,
        query: log.query,
        topK: log.topK,
        matchCount: log.matchCount,
        preFilterMatchCount: log.preFilterMatchCount ?? null,
        topScore: log.topScore ?? null,
        avgScore: log.avgScore ?? null,
        minScoreApplied: log.minScoreApplied ?? null,
        hybrid: log.hybrid === undefined ? null : this.toBoolInt(log.hybrid),
        latencyMs: log.latencyMs ?? null,
        metadata: this.toJson(log.metadata ?? {}),
        userId: log.userId ?? null,
        apiTokenId: log.apiTokenId ?? null,
        actorType: log.actorType ?? null,
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) } as IRagQueryLog;
    }

    async listRagQueryLogs(
      ragModuleKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date; zeroOnly?: boolean; projectId?: string },
    ): Promise<IRagQueryLog[]> {
      const db = this.getTenantDb();
      const { clauses, params } = this.buildRagQueryLogFilter(ragModuleKey, options);
      if (options?.zeroOnly) clauses.push('matchCount = 0');

      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragQueryLogs} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapQueryLogRow(r));
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
      const { clauses, params } = this.buildRagQueryLogFilter(ragModuleKey, options);

      const row = db.prepare(`
        SELECT
          COUNT(*) as total,
          AVG(latencyMs) as avgLatencyMs,
          SUM(CASE WHEN matchCount = 0 THEN 1 ELSE 0 END) as zeroMatchCount,
          SUM(CASE WHEN matchCount = 0 AND COALESCE(preFilterMatchCount, 0) > 0 THEN 1 ELSE 0 END) as minScoreFilteredCount
        FROM ${TABLES.ragQueryLogs} WHERE ${clauses.join(' AND ')}
      `).get(params) as {
        total: number;
        avgLatencyMs: number | null;
        zeroMatchCount: number | null;
        minScoreFilteredCount: number | null;
      };
      return {
        total: row?.total ?? 0,
        avgLatencyMs: row?.avgLatencyMs ? Math.round(row.avgLatencyMs) : 0,
        // SUM over zero rows is NULL, not 0.
        zeroMatchCount: row?.zeroMatchCount ?? 0,
        minScoreFilteredCount: row?.minScoreFilteredCount ?? 0,
      };
    }

    async aggregateRagQueryScoreDistribution(
      ragModuleKey: string,
      options?: { from?: Date; to?: Date; projectId?: string },
    ): Promise<Array<{ bucket: string; count: number }>> {
      const db = this.getTenantDb();
      const { clauses, params } = this.buildRagQueryLogFilter(ragModuleKey, options);
      // Logs written before topScore existed carry no score to bucket, and a
      // provider handing back a raw distance belongs to no bucket at all —
      // the same rows Mongo's $bucket sends to its `default`.
      clauses.push('topScore IS NOT NULL', 'topScore >= 0', `topScore < ${SCORE_BUCKET_UPPER}`);

      const rows = db.prepare(`
        SELECT CAST(topScore * 10 AS INTEGER) as bucket, COUNT(*) as count
        FROM ${TABLES.ragQueryLogs} WHERE ${clauses.join(' AND ')}
        GROUP BY bucket ORDER BY bucket ASC
      `).all(params) as Array<{ bucket: number; count: number }>;

      const counts = new Map(rows.map((r) => [(Number(r.bucket) / 10).toFixed(1), Number(r.count)]));
      // Always every bucket: a histogram missing its empty bars reads as a
      // different distribution, and it is exactly where the two backends' own
      // grouping would otherwise disagree.
      return SCORE_BUCKET_LABELS.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
    }

    async deleteRagQueryLogsOlderThan(before: Date, ragModuleKey?: string): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ['createdAt < @before'];
      const params: Record<string, unknown> = { before: before.toISOString() };
      if (ragModuleKey) { clauses.push('ragModuleKey = @ragModuleKey'); params.ragModuleKey = ragModuleKey; }
      return db.prepare(
        `DELETE FROM ${TABLES.ragQueryLogs} WHERE ${clauses.join(' AND ')}`,
      ).run(params).changes;
    }

    // ── RAG module teardown ──────────────────────────────────────────

    async deleteRagDocumentsByModuleKey(ragModuleKey: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.ragDocuments} WHERE ragModuleKey = @ragModuleKey`)
        .run({ ragModuleKey }).changes;
    }

    async deleteRagChunksByModuleKey(ragModuleKey: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.ragChunks} WHERE ragModuleKey = @ragModuleKey`)
        .run({ ragModuleKey }).changes;
    }

    async countRagModulesByVectorIndexKey(
      vectorIndexKey: string,
      options?: { projectId?: string; excludeKey?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ['vectorIndexKey = @vectorIndexKey'];
      const params: Record<string, unknown> = { vectorIndexKey };
      if (options?.projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(options.projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      // The module being edited must not count itself as a co-tenant of its
      // own index.
      if (options?.excludeKey) { clauses.push('key != @excludeKey'); params.excludeKey = options.excludeKey; }
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.ragModules} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow;
      return (row.cnt as number) || 0;
    }

    /** Shared module + date-window WHERE for every query-log read. */
    /**
     * Module keys are unique only WITHIN a project, so filtering by
     * ragModuleKey alone picks up the rows of a same-key module in another
     * project of the tenant — including the verbatim end-user query text.
     *
     * Rows with no projectId (logs predating project stamping, and every query
     * through /client/v1, which passes projectId undefined) cannot be
     * attributed to either module. They stay visible to the module's owner:
     * hiding a project's own history is the worse of the two failure modes,
     * and the caller has already been verified to own a module with this key.
     */
    private buildRagQueryLogFilter(
      ragModuleKey: string,
      options?: { from?: Date; to?: Date; projectId?: string },
    ): { clauses: string[]; params: Record<string, unknown> } {
      const clauses: string[] = ['ragModuleKey = @ragModuleKey'];
      const params: Record<string, unknown> = { ragModuleKey };
      if (options?.projectId) {
        clauses.push('(projectId = @projectId OR projectId IS NULL)');
        params.projectId = options.projectId;
      }
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }
      return { clauses, params };
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapModuleRow(r: SqliteRow): IRagModule {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        embeddingModelKey: r.embeddingModelKey as string,
        vectorProviderKey: r.vectorProviderKey as string,
        vectorIndexKey: r.vectorIndexKey as string,
        fileBucketKey: r.fileBucketKey as string | undefined,
        fileProviderKey: r.fileProviderKey as string | undefined,
        chunkConfig: this.parseJson(r.chunkConfig, { strategy: 'recursive_character', chunkSize: 1000, chunkOverlap: 200 }),
        status: r.status as IRagModule['status'],
        rerankerKey: (r.rerankerKey as string | null | undefined) ?? undefined,
        rerankerOversample: (r.rerankerOversample as number | null | undefined) ?? undefined,
        defaultTopK: (r.defaultTopK as number | null | undefined) ?? undefined,
        defaultMinScore: (r.defaultMinScore as number | null | undefined) ?? undefined,
        responseDetail: (r.responseDetail as IRagModule['responseDetail'] | null | undefined) ?? undefined,
        defaultFilter: r.defaultFilter ? this.parseJson(r.defaultFilter, undefined) : undefined,
        filterableFields: r.filterableFields ? this.parseJson(r.filterableFields, undefined) : undefined,
        hybrid: r.hybrid ? this.parseJson(r.hybrid, undefined) : undefined,
        isolateByModule: r.isolateByModule === null || r.isolateByModule === undefined ? undefined : this.fromBoolInt(r.isolateByModule),
        reindexRequired: r.reindexRequired === null || r.reindexRequired === undefined ? undefined : this.fromBoolInt(r.reindexRequired),
        activeReindexRunKey: (r.activeReindexRunKey as string | null | undefined) ?? undefined,
        lastReindexAt: r.lastReindexAt ? this.toDate(r.lastReindexAt) : undefined,
        totalDocuments: r.totalDocuments as number,
        totalChunks: r.totalChunks as number,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapDocRow(r: SqliteRow): IRagDocument {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        ragModuleKey: r.ragModuleKey as string,
        fileKey: r.fileKey as string | undefined,
        fileBucketKey: r.fileBucketKey as string | undefined,
        fileProviderKey: r.fileProviderKey as string | undefined,
        fileName: r.fileName as string,
        contentType: r.contentType as string | undefined,
        size: r.size as number | undefined,
        status: r.status as IRagDocument['status'],
        chunkCount: r.chunkCount as number,
        errorMessage: r.errorMessage as string | undefined,
        lastIndexedAt: r.lastIndexedAt ? this.toDate(r.lastIndexedAt) : undefined,
        chunkConfig: r.chunkConfig ? this.parseJson(r.chunkConfig, undefined) : undefined,
        sourceText: r.sourceText as string | undefined,
        sourceTextKey: r.sourceTextKey as string | undefined,
        sourceHash: r.sourceHash as string | undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapChunkRow(r: SqliteRow): IRagChunk {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        ragModuleKey: r.ragModuleKey as string,
        documentId: r.documentId as string,
        chunkIndex: r.chunkIndex as number,
        vectorId: r.vectorId as string,
        content: r.content as string,
        charStart: r.charStart as number | undefined,
        charEnd: r.charEnd as number | undefined,
        headingPath: r.headingPath ? this.parseJson(r.headingPath, undefined) : undefined,
        tokenCount: r.tokenCount as number | undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdAt: this.toDate(r.createdAt),
      };
    }

    protected mapQueryLogRow(r: SqliteRow): IRagQueryLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        ragModuleKey: r.ragModuleKey as string,
        query: r.query as string,
        topK: r.topK as number,
        matchCount: r.matchCount as number,
        preFilterMatchCount: (r.preFilterMatchCount as number | null | undefined) ?? undefined,
        topScore: (r.topScore as number | null | undefined) ?? undefined,
        avgScore: (r.avgScore as number | null | undefined) ?? undefined,
        minScoreApplied: (r.minScoreApplied as number | null | undefined) ?? undefined,
        hybrid: r.hybrid === null || r.hybrid === undefined ? undefined : this.fromBoolInt(r.hybrid),
        latencyMs: r.latencyMs as number | undefined,
        metadata: this.parseJson(r.metadata, {}),
        userId: (r.userId as string | null) ?? undefined,
        apiTokenId: (r.apiTokenId as string | null) ?? undefined,
        actorType: (r.actorType as IRagQueryLog['actorType'] | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
