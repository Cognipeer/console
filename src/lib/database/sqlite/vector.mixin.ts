/**
 * SQLite Provider – Vector index operations mixin
 */

import type { IVectorIndexRecord, IVectorQueryLog, IVectorQueryStats } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function VectorMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class VectorOps extends Base {

    async createVectorIndex(
      indexData: Omit<IVectorIndexRecord, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IVectorIndexRecord> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.vectorIndexes}
        (id, tenantId, projectId, providerKey, key, name, externalId, dimension, metric, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @providerKey, @key, @name, @externalId, @dimension, @metric, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: indexData.tenantId,
        projectId: indexData.projectId ?? null,
        providerKey: indexData.providerKey,
        key: indexData.key,
        name: indexData.name,
        externalId: indexData.externalId,
        dimension: indexData.dimension,
        metric: indexData.metric,
        metadata: this.toJson(indexData.metadata ?? {}),
        createdBy: indexData.createdBy,
        updatedBy: indexData.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...indexData, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateVectorIndex(
      id: string,
      data: Partial<Omit<IVectorIndexRecord, 'tenantId' | 'providerKey' | 'key'>>,
    ): Promise<IVectorIndexRecord | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.externalId !== undefined) { sets.push('externalId = @externalId'); params.externalId = data.externalId; }
      if (data.dimension !== undefined) { sets.push('dimension = @dimension'); params.dimension = data.dimension; }
      if (data.metric !== undefined) { sets.push('metric = @metric'); params.metric = data.metric; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(`UPDATE ${TABLES.vectorIndexes} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findVectorIndexById(id);
    }

    async deleteVectorIndex(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.vectorIndexes} WHERE id = @id`).run({ id }).changes > 0;
    }

    async listVectorIndexes(filters?: {
      providerKey?: string; projectId?: string; search?: string;
    }): Promise<IVectorIndexRecord[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.providerKey) { clauses.push('providerKey = @providerKey'); params.providerKey = filters.providerKey; }
      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.search) {
        clauses.push('(name LIKE @search OR key LIKE @search)');
        params.search = this.likePattern(filters.search.trim());
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.vectorIndexes} ${where} ORDER BY createdAt DESC`)
        .all(params) as SqliteRow[];
      return rows.map((r) => this.mapVectorRow(r));
    }

    async findVectorIndexById(id: string): Promise<IVectorIndexRecord | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.vectorIndexes} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapVectorRow(row) : null;
    }

    async findVectorIndexByKey(providerKey: string, key: string, projectId?: string): Promise<IVectorIndexRecord | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.vectorIndexes} WHERE providerKey = @providerKey AND key = @key`;
      const params: Record<string, unknown> = { providerKey, key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapVectorRow(row) : null;
    }

    async findVectorIndexByExternalId(providerKey: string, externalId: string, projectId?: string): Promise<IVectorIndexRecord | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.vectorIndexes} WHERE providerKey = @providerKey AND externalId = @externalId`;
      const params: Record<string, unknown> = { providerKey, externalId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapVectorRow(row) : null;
    }

    async createVectorQueryLog(
      log: Omit<IVectorQueryLog, '_id'>,
    ): Promise<IVectorQueryLog> {
      const db = this.getTenantDb();
      const id = this.newId();

      db.prepare(`
        INSERT INTO ${TABLES.vectorQueryLogs}
        (id, tenantId, projectId, providerKey, indexKey, topK, matchCount, latencyMs,
         avgScore, filterApplied, userId, apiTokenId, actorType, timestamp)
        VALUES (@id, @tenantId, @projectId, @providerKey, @indexKey, @topK, @matchCount, @latencyMs,
         @avgScore, @filterApplied, @userId, @apiTokenId, @actorType, @timestamp)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        providerKey: log.providerKey,
        indexKey: log.indexKey,
        topK: log.topK,
        matchCount: log.matchCount,
        latencyMs: log.latencyMs,
        avgScore: log.avgScore ?? null,
        filterApplied: log.filterApplied ? 1 : 0,
        userId: log.userId ?? null,
        apiTokenId: log.apiTokenId ?? null,
        actorType: log.actorType ?? null,
        timestamp: log.timestamp.toISOString(),
      });

      return { ...log, _id: id };
    }

    async aggregateVectorQueryStats(params: {
      indexKey: string;
      from: Date;
      to: Date;
    }): Promise<IVectorQueryStats> {
      const db = this.getTenantDb();
      // Timestamps are stored as ISO-8601 UTC strings, so lexical comparison
      // orders them correctly and substr() yields the same UTC day bucket the
      // MongoDB $dateToString pipeline produces.
      const bind = {
        indexKey: params.indexKey,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      };
      const window = 'indexKey = @indexKey AND timestamp >= @from AND timestamp <= @to';

      const daily = db.prepare(`
        SELECT substr(timestamp, 1, 10) AS date,
               COUNT(*) AS queryCount,
               AVG(latencyMs) AS avgLatencyMs,
               AVG(avgScore) AS avgScore,
               SUM(CASE WHEN filterApplied = 1 THEN 1 ELSE 0 END) AS filterCount
        FROM ${TABLES.vectorQueryLogs}
        WHERE ${window}
        GROUP BY date
        ORDER BY date
      `).all(bind) as SqliteRow[];

      const totals = db.prepare(`
        SELECT COUNT(*) AS totalQueries,
               AVG(latencyMs) AS avgLatencyMs,
               AVG(avgScore) AS avgScore,
               MIN(latencyMs) AS minLatencyMs,
               MAX(latencyMs) AS maxLatencyMs
        FROM ${TABLES.vectorQueryLogs}
        WHERE ${window}
      `).get(bind) as SqliteRow | undefined;

      const topKDist = db.prepare(`
        SELECT topK, COUNT(*) AS count
        FROM ${TABLES.vectorQueryLogs}
        WHERE ${window}
        GROUP BY topK
        ORDER BY topK
      `).all(bind) as SqliteRow[];

      return {
        daily: daily.map((row) => ({
          date: row.date as string,
          queryCount: (row.queryCount as number | undefined) ?? 0,
          avgLatencyMs: (row.avgLatencyMs as number | undefined) ?? 0,
          avgScore: (row.avgScore as number | null | undefined) ?? null,
          filterCount: (row.filterCount as number | undefined) ?? 0,
        })),
        totals: {
          totalQueries: (totals?.totalQueries as number | undefined) ?? 0,
          avgLatencyMs: (totals?.avgLatencyMs as number | null | undefined) ?? null,
          avgScore: (totals?.avgScore as number | null | undefined) ?? null,
          minLatencyMs: (totals?.minLatencyMs as number | null | undefined) ?? null,
          maxLatencyMs: (totals?.maxLatencyMs as number | null | undefined) ?? null,
        },
        topKDistribution: topKDist.map((row) => ({
          topK: (row.topK as number | undefined) ?? 0,
          count: (row.count as number | undefined) ?? 0,
        })),
      };
    }

    protected mapVectorRow(r: SqliteRow): IVectorIndexRecord {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        providerKey: r.providerKey as string,
        key: r.key as string,
        name: r.name as string,
        externalId: r.externalId as string,
        dimension: r.dimension as number,
        metric: r.metric as 'cosine' | 'dot' | 'euclidean',
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
