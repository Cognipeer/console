/**
 * SQLite Provider – File record + bucket operations mixin
 */

import type { IFileRecord, IFileBucketRecord, IFileBucketStats, IFileEntriesPage, FileListPurpose, FileRecordPatch, FileTypeFilter } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';
import { keyPrefixUpperBound, walkFileEntries, type KeyRange } from '../fileEntryWalk';
import { FILE_KIND_RULES, type FileKindRule } from '../fileTypeFilter';

/** SQLite refuses an expression tree deeper than 1000 terms, and every bucket asked for adds one: a longer list is asked in slices. */
const STATS_BUCKETS_PER_QUERY = 400;

/** Keys asked for in one `IN (...)`: well under the limit on bound variables of older SQLite builds. */
const KEYS_PER_QUERY = 400;

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
         metadata, markdownKey, markdownStatus, markdownError, markdownSize, markdownContentType, markdownExtraction,
         purpose, conversationId, agentKey, expiresAt, uploadedBy, origin,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @providerKey, @bucketKey, @key, @name, @size, @contentType, @checksum, @etag,
         @metadata, @markdownKey, @markdownStatus, @markdownError, @markdownSize, @markdownContentType, @markdownExtraction,
         @purpose, @conversationId, @agentKey, @expiresAt, @uploadedBy, @origin,
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
        markdownExtraction: record.markdownExtraction ? this.toJson(record.markdownExtraction) : null,
        purpose: record.purpose ?? null,
        conversationId: record.conversationId ?? null,
        agentKey: record.agentKey ?? null,
        expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
        uploadedBy: record.uploadedBy ?? null,
        origin: record.origin ?? null,
        createdBy: record.createdBy,
        updatedBy: record.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateFileRecord(id: string, data: FileRecordPatch): Promise<IFileRecord | null> {
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
      if (data.markdownExtraction !== undefined) { sets.push('markdownExtraction = @markdownExtraction'); params.markdownExtraction = data.markdownExtraction ? this.toJson(data.markdownExtraction) : null; }
      if (data.expiresAt !== undefined) { sets.push('expiresAt = @expiresAt'); params.expiresAt = data.expiresAt ? new Date(data.expiresAt).toISOString() : null; }
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

    async listFileRecordsByKeys(filters: {
      providerKey: string; bucketKey: string; projectId?: string; keys: string[]; field?: 'key' | 'markdownKey';
    }): Promise<IFileRecord[]> {
      const db = this.getTenantDb();
      // The column is picked from this list, never from the caller's text.
      const column = filters.field === 'markdownKey' ? 'markdownKey' : 'key';
      const keys = [...new Set(filters.keys)];
      const records: IFileRecord[] = [];
      for (let at = 0; at < keys.length; at += KEYS_PER_QUERY) {
        const slice = keys.slice(at, at + KEYS_PER_QUERY);
        const clauses: string[] = ['providerKey = @providerKey', 'bucketKey = @bucketKey'];
        const params: Record<string, unknown> = { providerKey: filters.providerKey, bucketKey: filters.bucketKey };
        if (filters.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
        clauses.push(`${column} IN (${slice.map((key, index) => { params[`k${index}`] = key; return `@k${index}`; }).join(', ')})`);
        const rows = db.prepare(`SELECT * FROM ${TABLES.files} WHERE ${clauses.join(' AND ')}`).all(params) as SqliteRow[];
        records.push(...rows.map((row) => this.mapFileRow(row)));
      }
      return records;
    }

    /** `purpose` as a SQL condition: session files, or everything that is not one. */
    protected filePurposeClause(purpose: FileListPurpose | undefined): string | null {
      if (purpose === 'conversation') return "purpose = 'conversation'";
      if (purpose === 'other') return "(purpose IS NULL OR purpose <> 'conversation')";
      return null;
    }

    /**
     * A kind of file (`fileTypeFilter.ts`) as a SQL condition: the content type with its parameters dropped,
     * and the extension of the name only when no kind claims the content type. The rule values are constants
     * of that module, quoted here rather than bound because there are many and they never come from a caller.
     */
    protected fileTypeClause(type: FileTypeFilter): string {
      const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
      const startsWith = (column: string, prefix: string) => `${column} LIKE ${quote(`${escapeLike(prefix)}%`)} ESCAPE '\\'`;
      const endsWith = (column: string, suffix: string) => `${column} LIKE ${quote(`%${escapeLike(suffix)}`)} ESCAPE '\\'`;
      const mime = "lower(trim(CASE WHEN instr(coalesce(contentType, ''), ';') > 0 THEN substr(contentType, 1, instr(contentType, ';') - 1) ELSE coalesce(contentType, '') END))";
      const name = "lower(coalesce(name, ''))";
      const byContentType = (rule: FileKindRule) => [
        ...rule.mimeTypes.map((value) => `${mime} = ${quote(value)}`),
        ...rule.mimePrefixes.map((prefix) => startsWith(mime, prefix)),
      ];
      const byExtension = (rule: FileKindRule) => rule.extensions.map((extension) => endsWith(name, extension));
      const rules = Object.values(FILE_KIND_RULES);
      const claimed = `(${rules.flatMap(byContentType).join(' OR ')})`;
      if (type === 'other') {
        return `(NOT ${claimed} AND NOT (${rules.flatMap(byExtension).join(' OR ')}))`;
      }
      const rule = FILE_KIND_RULES[type];
      const typed = byContentType(rule);
      return `(${typed.length > 0 ? `${typed.join(' OR ')} OR ` : ''}(NOT ${claimed} AND (${byExtension(rule).join(' OR ')})))`;
    }

    async listFileRecords(filters: {
      providerKey: string; bucketKey: string; projectId?: string;
      search?: string; prefix?: string; purpose?: FileListPurpose; type?: FileTypeFilter; limit?: number; cursor?: string;
    }): Promise<{ items: IFileRecord[]; nextCursor?: string }> {
      const db = this.getTenantDb();
      const clauses: string[] = ['providerKey = @providerKey', 'bucketKey = @bucketKey'];
      const params: Record<string, unknown> = { providerKey: filters.providerKey, bucketKey: filters.bucketKey };

      if (filters.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters.prefix) {
        // A key range, not LIKE: exact (LIKE ignores case) and served by the (providerKey, bucketKey, key) index.
        clauses.push('key >= @prefix');
        params.prefix = filters.prefix;
        const upper = keyPrefixUpperBound(filters.prefix);
        if (upper !== undefined) { clauses.push('key < @prefixUpper'); params.prefixUpper = upper; }
      }
      const purposeClause = this.filePurposeClause(filters.purpose);
      if (purposeClause) clauses.push(purposeClause);
      if (filters.type) clauses.push(this.fileTypeClause(filters.type));
      if (filters.search) {
        // Folded on both sides (`LIKE` alone folds the case of ASCII letters only, so "ŞÖYLE" never found "şöyle.txt"
        // although MongoDB's `$regex` did), and with the escape character declared: `%` and `_` typed in the box are
        // looked for as typed, not read as wildcards.
        clauses.push("iam_fold(name) LIKE iam_fold(@search) ESCAPE '\\'");
        params.search = `%${filters.search.trim().replace(/[\\%_]/g, '\\$&')}%`;
      }
      if (filters.cursor) { clauses.push('id > @cursor'); params.cursor = filters.cursor; }

      const limit = (filters.limit ?? 50) + 1;
      const where = `WHERE ${clauses.join(' AND ')}`;

      const rows = db.prepare(`SELECT * FROM ${TABLES.files} ${where} ORDER BY id ASC LIMIT @limit`)
        .all({ ...params, limit }) as SqliteRow[];

      const items = rows.map((r) => this.mapFileRow(r));
      let nextCursor: string | undefined;
      if (items.length > (filters.limit ?? 50)) {
        // One row past the page proves there is more. The cursor is the last row the page returns: the next
        // read continues after it (`id > cursor`), so the row that proved it is not skipped.
        items.pop();
        nextCursor = items[items.length - 1]?._id as string | undefined;
      }

      return { items, nextCursor };
    }

    async listFileEntries(filters: {
      providerKey: string; bucketKey: string; projectId?: string;
      prefix: string; purpose?: FileListPurpose; limit?: number; cursor?: string;
    }): Promise<IFileEntriesPage> {
      const db = this.getTenantDb();
      const purposeClause = this.filePurposeClause(filters.purpose);
      const probe = async (range: KeyRange, limit: number): Promise<IFileRecord[]> => {
        const clauses: string[] = ['providerKey = @providerKey', 'bucketKey = @bucketKey'];
        const params: Record<string, unknown> = { providerKey: filters.providerKey, bucketKey: filters.bucketKey, limit };
        if (filters.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
        if (range.gte !== undefined) { clauses.push('key >= @gte'); params.gte = range.gte; }
        if (range.gt !== undefined) { clauses.push('key > @gt'); params.gt = range.gt; }
        if (range.lt !== undefined) { clauses.push('key < @lt'); params.lt = range.lt; }
        if (purposeClause) clauses.push(purposeClause);
        const rows = db.prepare(`SELECT * FROM ${TABLES.files} WHERE ${clauses.join(' AND ')} ORDER BY key ASC LIMIT @limit`)
          .all(params) as SqliteRow[];
        return rows.map((r) => this.mapFileRow(r));
      };
      return walkFileEntries(probe, {
        prefix: filters.prefix,
        limit: Math.min(Math.max(filters.limit ?? 50, 1), 200),
        cursor: filters.cursor,
      });
    }

    async listFileRecordsByConversation(conversationId: string): Promise<IFileRecord[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.files} WHERE conversationId = @conversationId ORDER BY createdAt ASC, rowid ASC`)
        .all({ conversationId }) as SqliteRow[];
      return rows.map((r) => this.mapFileRow(r));
    }

    async listExpiredConversationFiles(before: Date, limit: number): Promise<IFileRecord[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.files}
        WHERE purpose = 'conversation' AND expiresAt IS NOT NULL AND expiresAt < @before
        ORDER BY expiresAt ASC, createdAt ASC, rowid ASC LIMIT @limit
      `).all({ before: before.toISOString(), limit }) as SqliteRow[];
      return rows.map((r) => this.mapFileRow(r));
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
      // The Markdown copy of a file is an object in the provider too; MongoDB counts it, so does this.
      let sql = `SELECT COALESCE(SUM(size + COALESCE(markdownSize, 0)), 0) as total FROM ${TABLES.files}`;
      const params: Record<string, unknown> = {};
      if (filters?.projectId) { sql += ' WHERE projectId = @projectId'; params.projectId = filters.projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow;
      return (row?.total as number) ?? 0;
    }

    async listFileBucketStats(filters?: {
      projectId?: string;
      buckets?: Array<{ providerKey: string; bucketKey: string }>;
    }): Promise<IFileBucketStats[]> {
      if (filters?.buckets && filters.buckets.length === 0) return [];
      if (filters?.buckets && filters.buckets.length > STATS_BUCKETS_PER_QUERY) {
        // Each bucket once, so a bucket asked for twice is not reported by two slices.
        const unique = [...new Map(filters.buckets.map((bucket) => [`${bucket.providerKey}\u0000${bucket.bucketKey}`, bucket])).values()];
        const rows: IFileBucketStats[] = [];
        for (let at = 0; at < unique.length; at += STATS_BUCKETS_PER_QUERY) {
          rows.push(...await this.listFileBucketStats({ ...filters, buckets: unique.slice(at, at + STATS_BUCKETS_PER_QUERY) }));
        }
        return rows;
      }
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.buckets) {
        // One equality pair per bucket: each term is an index range on (providerKey, bucketKey, key).
        const pairs = filters.buckets.map((bucket, index) => {
          params[`providerKey${index}`] = bucket.providerKey;
          params[`bucketKey${index}`] = bucket.bucketKey;
          return `(providerKey = @providerKey${index} AND bucketKey = @bucketKey${index})`;
        });
        clauses.push(`(${pairs.join(' OR ')})`);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT providerKey, bucketKey, COUNT(*) AS fileCount, COALESCE(SUM(size + COALESCE(markdownSize, 0)), 0) AS totalBytes
        FROM ${TABLES.files}${where}
        GROUP BY providerKey, bucketKey
      `).all(params) as SqliteRow[];
      return rows.map((row) => ({
        providerKey: row.providerKey as string,
        bucketKey: row.bucketKey as string,
        fileCount: (row.fileCount as number) ?? 0,
        totalBytes: (row.totalBytes as number) ?? 0,
      }));
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
        ...(r.markdownExtraction ? { markdownExtraction: this.parseJson(r.markdownExtraction, undefined) as IFileRecord['markdownExtraction'] } : {}),
        ...(r.purpose ? { purpose: r.purpose as 'conversation' } : {}),
        ...(r.conversationId ? { conversationId: r.conversationId as string } : {}),
        ...(r.agentKey ? { agentKey: r.agentKey as string } : {}),
        ...(r.expiresAt ? { expiresAt: this.toDate(r.expiresAt) } : {}),
        ...(r.uploadedBy ? { uploadedBy: r.uploadedBy as string } : {}),
        ...(r.origin ? { origin: r.origin as NonNullable<IFileRecord['origin']> } : {}),
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
