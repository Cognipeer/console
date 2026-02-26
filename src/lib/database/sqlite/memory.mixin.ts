/**
 * SQLite Provider – Memory operations mixin
 *
 * Includes memory stores and memory items.
 */

import type {
  IMemoryStore,
  IMemoryItem,
  IMemoryStoreConfig,
  MemoryScope,
  MemorySource,
  MemoryStoreStatus,
  MemoryItemStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function MemoryMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class MemoryOps extends Base {
    // ── Memory Store operations ──────────────────────────────────────

    async createMemoryStore(
      store: Omit<IMemoryStore, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IMemoryStore> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.memoryStores}
        (id, tenantId, projectId, key, name, description,
         vectorProviderKey, vectorIndexKey, embeddingModelKey,
         config, status, memoryCount, lastActivityAt,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description,
         @vectorProviderKey, @vectorIndexKey, @embeddingModelKey,
         @config, @status, @memoryCount, @lastActivityAt,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: store.tenantId,
        projectId: store.projectId,
        key: store.key,
        name: store.name,
        description: store.description ?? null,
        vectorProviderKey: store.vectorProviderKey,
        vectorIndexKey: store.vectorIndexKey,
        embeddingModelKey: store.embeddingModelKey,
        config: this.toJson(store.config ?? {}),
        status: store.status,
        memoryCount: store.memoryCount ?? 0,
        lastActivityAt: store.lastActivityAt ? store.lastActivityAt.toISOString() : null,
        createdBy: store.createdBy,
        updatedBy: store.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...store, _id: id, createdAt: new Date(now), updatedAt: new Date(now) } as IMemoryStore;
    }

    async updateMemoryStore(
      id: string,
      data: Partial<Omit<IMemoryStore, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IMemoryStore | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.vectorProviderKey !== undefined) { sets.push('vectorProviderKey = @vectorProviderKey'); params.vectorProviderKey = data.vectorProviderKey; }
      if (data.vectorIndexKey !== undefined) { sets.push('vectorIndexKey = @vectorIndexKey'); params.vectorIndexKey = data.vectorIndexKey; }
      if (data.embeddingModelKey !== undefined) { sets.push('embeddingModelKey = @embeddingModelKey'); params.embeddingModelKey = data.embeddingModelKey; }
      if (data.config !== undefined) { sets.push('config = @config'); params.config = this.toJson(data.config); }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.memoryCount !== undefined) { sets.push('memoryCount = @memoryCount'); params.memoryCount = data.memoryCount; }
      if (data.lastActivityAt !== undefined) { sets.push('lastActivityAt = @lastActivityAt'); params.lastActivityAt = data.lastActivityAt instanceof Date ? data.lastActivityAt.toISOString() : data.lastActivityAt; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.memoryStores} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findMemoryStoreById(id);
    }

    async deleteMemoryStore(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.memoryStores} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findMemoryStoreById(id: string): Promise<IMemoryStore | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.memoryStores} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapStoreRow(row) : null;
    }

    async findMemoryStoreByKey(key: string, projectId?: string): Promise<IMemoryStore | null> {
      const db = this.getTenantDb();
      const clauses: string[] = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(
        `SELECT * FROM ${TABLES.memoryStores} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow | undefined;
      return row ? this.mapStoreRow(row) : null;
    }

    async listMemoryStores(filters?: {
      projectId?: string;
      status?: MemoryStoreStatus;
      search?: string;
    }): Promise<IMemoryStore[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.search) {
        clauses.push('(name LIKE @search OR key LIKE @search)');
        params.search = this.likePattern(filters.search);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.memoryStores} ${where} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapStoreRow(r));
    }

    async countMemoryStores(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (projectId) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${TABLES.memoryStores} ${where}`).get(params) as SqliteRow;
      return (row.cnt as number) || 0;
    }

    // ── Memory Item operations ───────────────────────────────────────

    async createMemoryItem(
      item: Omit<IMemoryItem, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IMemoryItem> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.memoryItems}
        (id, tenantId, projectId, storeKey, content, contentHash, summary,
         scope, scopeId, metadata, tags, source, importance,
         accessCount, lastAccessedAt, embeddingVersion, vectorId,
         expiresAt, status, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @storeKey, @content, @contentHash, @summary,
         @scope, @scopeId, @metadata, @tags, @source, @importance,
         @accessCount, @lastAccessedAt, @embeddingVersion, @vectorId,
         @expiresAt, @status, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: item.tenantId,
        projectId: item.projectId,
        storeKey: item.storeKey,
        content: item.content,
        contentHash: item.contentHash,
        summary: item.summary ?? null,
        scope: item.scope,
        scopeId: item.scopeId ?? null,
        metadata: this.toJson(item.metadata ?? {}),
        tags: this.toJson(item.tags ?? []),
        source: item.source ?? null,
        importance: item.importance ?? 0.5,
        accessCount: item.accessCount ?? 0,
        lastAccessedAt: item.lastAccessedAt ? item.lastAccessedAt.toISOString() : null,
        embeddingVersion: item.embeddingVersion ?? '',
        vectorId: item.vectorId ?? '',
        expiresAt: item.expiresAt ? item.expiresAt.toISOString() : null,
        status: item.status ?? 'active',
        createdAt: now,
        updatedAt: now,
      });

      return { ...item, _id: id, createdAt: new Date(now), updatedAt: new Date(now) } as IMemoryItem;
    }

    async updateMemoryItem(
      id: string,
      data: Partial<Omit<IMemoryItem, 'tenantId' | 'storeKey'>>,
    ): Promise<IMemoryItem | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.content !== undefined) { sets.push('content = @content'); params.content = data.content; }
      if (data.contentHash !== undefined) { sets.push('contentHash = @contentHash'); params.contentHash = data.contentHash; }
      if (data.summary !== undefined) { sets.push('summary = @summary'); params.summary = data.summary; }
      if (data.scope !== undefined) { sets.push('scope = @scope'); params.scope = data.scope; }
      if (data.scopeId !== undefined) { sets.push('scopeId = @scopeId'); params.scopeId = data.scopeId; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.tags !== undefined) { sets.push('tags = @tags'); params.tags = this.toJson(data.tags); }
      if (data.source !== undefined) { sets.push('source = @source'); params.source = data.source; }
      if (data.importance !== undefined) { sets.push('importance = @importance'); params.importance = data.importance; }
      if (data.embeddingVersion !== undefined) { sets.push('embeddingVersion = @embeddingVersion'); params.embeddingVersion = data.embeddingVersion; }
      if (data.vectorId !== undefined) { sets.push('vectorId = @vectorId'); params.vectorId = data.vectorId; }
      if (data.expiresAt !== undefined) { sets.push('expiresAt = @expiresAt'); params.expiresAt = data.expiresAt instanceof Date ? data.expiresAt.toISOString() : data.expiresAt; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }

      db.prepare(`UPDATE ${TABLES.memoryItems} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findMemoryItemById(id);
    }

    async deleteMemoryItem(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.memoryItems} WHERE id = @id`).run({ id }).changes === 1;
    }

    async deleteMemoryItems(
      storeKey: string,
      filter?: { scope?: MemoryScope; scopeId?: string; tags?: string[]; before?: Date },
    ): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ['storeKey = @storeKey'];
      const params: Record<string, unknown> = { storeKey };
      if (filter?.scope) { clauses.push('scope = @scope'); params.scope = filter.scope; }
      if (filter?.scopeId) { clauses.push('scopeId = @scopeId'); params.scopeId = filter.scopeId; }
      if (filter?.tags?.length) {
        // Match any row whose tags JSON array intersects with the provided tags
        const tagClauses = filter.tags.map((t, i) => {
          const pKey = `tag${i}`;
          params[pKey] = `%"${t}"%`;
          return `tags LIKE @${pKey}`;
        });
        clauses.push(`(${tagClauses.join(' OR ')})`);
      }
      if (filter?.before) { clauses.push('createdAt < @before'); params.before = filter.before.toISOString(); }
      return db.prepare(
        `DELETE FROM ${TABLES.memoryItems} WHERE ${clauses.join(' AND ')}`,
      ).run(params).changes;
    }

    async findMemoryItemById(id: string): Promise<IMemoryItem | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.memoryItems} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapItemRow(row) : null;
    }

    async findMemoryItemByHash(storeKey: string, contentHash: string): Promise<IMemoryItem | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.memoryItems} WHERE storeKey = @storeKey AND contentHash = @contentHash`,
      ).get({ storeKey, contentHash }) as SqliteRow | undefined;
      return row ? this.mapItemRow(row) : null;
    }

    async listMemoryItems(
      storeKey: string,
      filters?: {
        projectId?: string;
        scope?: MemoryScope;
        scopeId?: string;
        tags?: string[];
        status?: MemoryItemStatus;
        search?: string;
        limit?: number;
        skip?: number;
      },
    ): Promise<{ items: IMemoryItem[]; total: number }> {
      const db = this.getTenantDb();
      const clauses: string[] = ['storeKey = @storeKey'];
      const params: Record<string, unknown> = { storeKey };

      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.scope) { clauses.push('scope = @scope'); params.scope = filters.scope; }
      if (filters?.scopeId) { clauses.push('scopeId = @scopeId'); params.scopeId = filters.scopeId; }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.tags?.length) {
        const tagClauses = filters.tags.map((t, i) => {
          const pKey = `tag${i}`;
          params[pKey] = `%"${t}"%`;
          return `tags LIKE @${pKey}`;
        });
        clauses.push(`(${tagClauses.join(' OR ')})`);
      }
      if (filters?.search) { clauses.push('content LIKE @search'); params.search = this.likePattern(filters.search); }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const limit = filters?.limit ?? 50;
      const skip = filters?.skip ?? 0;

      const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM ${TABLES.memoryItems} ${where}`).get(params) as SqliteRow;
      const total = (totalRow.cnt as number) || 0;

      const rows = db.prepare(
        `SELECT * FROM ${TABLES.memoryItems} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];

      return { items: rows.map((r) => this.mapItemRow(r)), total };
    }

    async countMemoryItems(storeKey: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ['storeKey = @storeKey'];
      const params: Record<string, unknown> = { storeKey };
      if (projectId) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.memoryItems} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow;
      return (row.cnt as number) || 0;
    }

    async incrementMemoryAccess(id: string): Promise<void> {
      const db = this.getTenantDb();
      db.prepare(`
        UPDATE ${TABLES.memoryItems}
        SET accessCount = accessCount + 1, lastAccessedAt = @now
        WHERE id = @id
      `).run({ id, now: this.now() });
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapStoreRow(r: SqliteRow): IMemoryStore {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        vectorProviderKey: r.vectorProviderKey as string,
        vectorIndexKey: r.vectorIndexKey as string,
        embeddingModelKey: r.embeddingModelKey as string,
        config: this.parseJson<IMemoryStoreConfig>(r.config, {
          embeddingDimension: 1536,
          metric: 'cosine',
          defaultScope: 'global',
          deduplication: false,
          autoSummarize: false,
        }),
        status: r.status as IMemoryStore['status'],
        memoryCount: r.memoryCount as number,
        lastActivityAt: r.lastActivityAt ? this.toDate(r.lastActivityAt) : undefined,
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapItemRow(r: SqliteRow): IMemoryItem {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string,
        storeKey: r.storeKey as string,
        content: r.content as string,
        contentHash: r.contentHash as string,
        summary: r.summary as string | undefined,
        scope: r.scope as MemoryScope,
        scopeId: r.scopeId as string | undefined,
        metadata: this.parseJson(r.metadata, {}),
        tags: this.parseJson<string[]>(r.tags, []),
        source: (r.source as MemorySource) || undefined,
        importance: r.importance as number,
        accessCount: r.accessCount as number,
        lastAccessedAt: r.lastAccessedAt ? this.toDate(r.lastAccessedAt) : undefined,
        embeddingVersion: r.embeddingVersion as string,
        vectorId: r.vectorId as string,
        expiresAt: r.expiresAt ? this.toDate(r.expiresAt) : undefined,
        status: r.status as IMemoryItem['status'],
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
