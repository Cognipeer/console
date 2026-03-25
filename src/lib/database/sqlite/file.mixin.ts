/**
 * SQLite Provider – File record + bucket operations mixin
 */

import type { IFileRecord, IFileBucketRecord } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function FileMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class FileOps extends Base {

    // ── File Records ────────────────────────────────────────────────

    async createFileRecord(record: Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>): Promise<IFileRecord> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.files}
        (id, tenantId, projectId, providerKey, bucketKey, key, name, size, contentType, checksum, etag,
         metadata, markdownKey, markdownStatus, markdownError, markdownSize, markdownContentType,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @providerKey, @bucketKey, @key, @name, @size, @contentType, @checksum, @etag,
         @metadata, @markdownKey, @markdownStatus, @markdownError, @markdownSize, @markdownContentType,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        providerKey: record.providerKey,
        bucketKey: record.bucketKey,
        key: record.key,
        name: record.name,
        size: record.size,
        contentType: record.contentType ?? null,
        checksum: record.checksum ?? null,
        etag: record.etag ?? null,
        metadata: this.toJson(record.metadata ?? {}),
        markdownKey: record.markdownKey ?? null,
        markdownStatus: record.markdownStatus ?? 'pending',
        markdownError: record.markdownError ?? null,
        markdownSize: record.markdownSize ?? null,
        markdownContentType: record.markdownContentType ?? null,
        createdBy: record.createdBy,
        updatedBy: record.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateFileRecord(
      id: string,
      data: Partial<Omit<IFileRecord, 'tenantId' | 'providerKey' | 'key' | 'createdBy'>>,
    ): Promise<IFileRecord | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.size !== undefined) { sets.push('size = @size'); params.size = data.size; }
      if (data.contentType !== undefined) { sets.push('contentType = @contentType'); params.contentType = data.contentType; }
      if (data.checksum !== undefined) { sets.push('checksum = @checksum'); params.checksum = data.checksum; }
      if (data.etag !== undefined) { sets.push('etag = @etag'); params.etag = data.etag; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.markdownKey !== undefined) { sets.push('markdownKey = @markdownKey'); params.markdownKey = data.markdownKey; }
      if (data.markdownStatus !== undefined) { sets.push('markdownStatus = @markdownStatus'); params.markdownStatus = data.markdownStatus; }
      if (data.markdownError !== undefined) { sets.push('markdownError = @markdownError'); params.markdownError = data.markdownError; }
      if (data.markdownSize !== undefined) { sets.push('markdownSize = @markdownSize'); params.markdownSize = data.markdownSize; }
      if (data.markdownContentType !== undefined) { sets.push('markdownContentType = @markdownContentType'); params.markdownContentType = data.markdownContentType; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(`UPDATE ${TABLES.files} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findFileRecordById(id);
    }

    async deleteFileRecord(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.files} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findFileRecordById(id: string): Promise<IFileRecord | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.files} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapFileRow(row) : null;
    }

    async findFileRecordByKey(providerKey: string, bucketKey: string, key: string, projectId?: string): Promise<IFileRecord | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.files} WHERE providerKey = @providerKey AND bucketKey = @bucketKey AND key = @key`;
      const params: Record<string, unknown> = { providerKey, bucketKey, key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapFileRow(row) : null;
    }

    async listFileRecords(filters: {
      providerKey: string; bucketKey: string; projectId?: string;
      search?: string; limit?: number; cursor?: string;
    }): Promise<{ items: IFileRecord[]; nextCursor?: string }> {
      const db = this.getTenantDb();
      const clauses: string[] = ['providerKey = @providerKey', 'bucketKey = @bucketKey'];
      const params: Record<string, unknown> = { providerKey: filters.providerKey, bucketKey: filters.bucketKey };

      if (filters.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters.search) { clauses.push('name LIKE @search'); params.search = this.likePattern(filters.search.trim()); }
      if (filters.cursor) { clauses.push('id > @cursor'); params.cursor = filters.cursor; }

      const limit = (filters.limit ?? 50) + 1;
      const where = `WHERE ${clauses.join(' AND ')}`;

      const rows = db.prepare(`SELECT * FROM ${TABLES.files} ${where} ORDER BY id ASC LIMIT @limit`)
        .all({ ...params, limit }) as SqliteRow[];

      const items = rows.map((r) => this.mapFileRow(r));
      let nextCursor: string | undefined;
      if (items.length > (filters.limit ?? 50)) {
        const overflow = items.pop();
        nextCursor = overflow?._id as string;
      }

      return { items, nextCursor };
    }

    async countFileRecords(filters?: { projectId?: string }): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(*) as cnt FROM ${TABLES.files}`;
      const params: Record<string, unknown> = {};
      if (filters?.projectId) { sql += ' WHERE projectId = @projectId'; params.projectId = filters.projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow;
      return (row?.cnt as number) ?? 0;
    }

    async sumFileRecordBytes(filters?: { projectId?: string }): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COALESCE(SUM(size), 0) as total FROM ${TABLES.files}`;
      const params: Record<string, unknown> = {};
      if (filters?.projectId) { sql += ' WHERE projectId = @projectId'; params.projectId = filters.projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow;
      return (row?.total as number) ?? 0;
    }

    async getProjectVectorCountApprox(projectId: string): Promise<number> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT count FROM ${TABLES.vectorCounters} WHERE projectId = @projectId`)
        .get({ projectId }) as SqliteRow | undefined;
      return (row?.count as number) ?? 0;
    }

    async incrementProjectVectorCountApprox(projectId: string, delta: number): Promise<number> {
      const db = this.getTenantDb();
      db.prepare(`
        INSERT INTO ${TABLES.vectorCounters} (projectId, count) VALUES (@projectId, @delta)
        ON CONFLICT(projectId) DO UPDATE SET count = count + @delta
      `).run({ projectId, delta });
      const row = db.prepare(`SELECT count FROM ${TABLES.vectorCounters} WHERE projectId = @projectId`)
        .get({ projectId }) as SqliteRow;
      return (row?.count as number) ?? 0;
    }

    // ── File Buckets ────────────────────────────────────────────────

    async createFileBucket(bucket: Omit<IFileBucketRecord, '_id' | 'createdAt' | 'updatedAt'>): Promise<IFileBucketRecord> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.fileBuckets}
        (id, tenantId, projectId, key, name, providerKey, description, status, prefix, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @providerKey, @description, @status, @prefix, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: bucket.tenantId,
        projectId: bucket.projectId ?? null,
        key: bucket.key,
        name: bucket.name,
        providerKey: bucket.providerKey,
        description: bucket.description ?? null,
        status: bucket.status,
        prefix: bucket.prefix ?? null,
        metadata: this.toJson(bucket.metadata ?? {}),
        createdBy: bucket.createdBy,
        updatedBy: bucket.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...bucket, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateFileBucket(
      id: string,
      data: Partial<Omit<IFileBucketRecord, 'tenantId' | 'key' | 'providerKey'>>,
    ): Promise<IFileBucketRecord | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.prefix !== undefined) { sets.push('prefix = @prefix'); params.prefix = data.prefix; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(`UPDATE ${TABLES.fileBuckets} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findFileBucketById(id);
    }

    async deleteFileBucket(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.fileBuckets} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findFileBucketById(id: string): Promise<IFileBucketRecord | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.fileBuckets} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapBucketRow(row) : null;
    }

    async findFileBucketByKey(tenantId: string, key: string, projectId?: string): Promise<IFileBucketRecord | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.fileBuckets} WHERE tenantId = @tenantId AND key = @key`;
      const params: Record<string, unknown> = { tenantId, key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapBucketRow(row) : null;
    }

    async listFileBuckets(tenantId: string, projectId?: string): Promise<IFileBucketRecord[]> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.fileBuckets} WHERE tenantId = @tenantId`;
      const params: Record<string, unknown> = { tenantId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      sql += ' ORDER BY createdAt DESC';
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapBucketRow(r));
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapFileRow(r: SqliteRow): IFileRecord {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        providerKey: r.providerKey as string,
        bucketKey: r.bucketKey as string,
        key: r.key as string,
        name: r.name as string,
        size: (r.size as number) ?? 0,
        contentType: r.contentType as string | undefined,
        checksum: r.checksum as string | undefined,
        etag: r.etag as string | undefined,
        metadata: this.parseJson(r.metadata, {}),
        markdownKey: r.markdownKey as string | undefined,
        markdownStatus: (r.markdownStatus as IFileRecord['markdownStatus']) ?? 'pending',
        markdownError: r.markdownError as string | undefined,
        markdownSize: r.markdownSize as number | undefined,
        markdownContentType: r.markdownContentType as string | undefined,
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapBucketRow(r: SqliteRow): IFileBucketRecord {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        key: r.key as string,
        name: r.name as string,
        providerKey: r.providerKey as string,
        description: r.description as string | undefined,
        status: r.status as 'active' | 'disabled',
        prefix: r.prefix as string | undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
