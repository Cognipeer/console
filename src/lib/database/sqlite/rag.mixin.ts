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
         chunkConfig, status, totalDocuments, totalChunks, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description,
         @embeddingModelKey, @vectorProviderKey, @vectorIndexKey, @fileBucketKey, @fileProviderKey,
         @chunkConfig, @status, @totalDocuments, @totalChunks, @metadata,
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
        (id, tenantId, projectId, ragModuleKey, fileKey, fileName, contentType, size,
         status, chunkCount, errorMessage, lastIndexedAt, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @ragModuleKey, @fileKey, @fileName, @contentType, @size,
         @status, @chunkCount, @errorMessage, @lastIndexedAt, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: doc.tenantId,
        projectId: doc.projectId ?? null,
        ragModuleKey: doc.ragModuleKey,
        fileKey: doc.fileKey ?? null,
        fileName: doc.fileName,
        contentType: doc.contentType ?? null,
        size: doc.size ?? null,
        status: doc.status,
        chunkCount: doc.chunkCount ?? 0,
        errorMessage: doc.errorMessage ?? null,
        lastIndexedAt: doc.lastIndexedAt ? doc.lastIndexedAt.toISOString() : null,
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
        (id, tenantId, projectId, ragModuleKey, documentId, chunkIndex, vectorId, content, metadata, createdAt)
        VALUES (@id, @tenantId, @projectId, @ragModuleKey, @documentId, @chunkIndex, @vectorId, @content, @metadata, @createdAt)
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
        (id, tenantId, projectId, ragModuleKey, query, topK, matchCount, latencyMs, metadata, createdAt)
        VALUES (@id, @tenantId, @projectId, @ragModuleKey, @query, @topK, @matchCount, @latencyMs, @metadata, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        ragModuleKey: log.ragModuleKey,
        query: log.query,
        topK: log.topK,
        matchCount: log.matchCount,
        latencyMs: log.latencyMs ?? null,
        metadata: this.toJson(log.metadata ?? {}),
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) } as IRagQueryLog;
    }

    async listRagQueryLogs(
      ragModuleKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    ): Promise<IRagQueryLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['ragModuleKey = @ragModuleKey'];
      const params: Record<string, unknown> = { ragModuleKey };
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }

      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragQueryLogs} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapQueryLogRow(r));
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
        fileName: r.fileName as string,
        contentType: r.contentType as string | undefined,
        size: r.size as number | undefined,
        status: r.status as IRagDocument['status'],
        chunkCount: r.chunkCount as number,
        errorMessage: r.errorMessage as string | undefined,
        lastIndexedAt: r.lastIndexedAt ? this.toDate(r.lastIndexedAt) : undefined,
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
        latencyMs: r.latencyMs as number | undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
