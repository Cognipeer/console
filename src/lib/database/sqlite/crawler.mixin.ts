/**
 * SQLite Provider – Crawlers, Crawl jobs & results mixin
 */

import type {
  ICrawler,
  ICrawlJob,
  ICrawlResult,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function CrawlerMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class CrawlerOps extends Base {
    // ── Crawlers ─────────────────────────────────────────────────────
    async createCrawler(
      record: Omit<ICrawler, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ICrawler> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.crawlers}
        (id, tenantId, projectId, key, name, description, status,
         seeds, engine, maxDepth, maxPages, autoCrawl, scope, downloadableMimes,
         http, markdownOptions, rag, webhook, schedule, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @status,
         @seeds, @engine, @maxDepth, @maxPages, @autoCrawl, @scope, @downloadableMimes,
         @http, @markdownOptions, @rag, @webhook, @schedule, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        key: record.key,
        name: record.name,
        description: record.description ?? null,
        status: record.status,
        seeds: this.toJson(record.seeds ?? []),
        engine: record.engine,
        maxDepth: record.maxDepth,
        maxPages: record.maxPages,
        autoCrawl: record.autoCrawl ? 1 : 0,
        scope: this.toJson(record.scope ?? {}),
        downloadableMimes: this.toJson(record.downloadableMimes ?? []),
        http: this.toJson(record.http ?? {}),
        markdownOptions: this.toJson(record.markdownOptions ?? {}),
        rag: record.rag ? this.toJson(record.rag) : null,
        webhook: record.webhook ? this.toJson(record.webhook) : null,
        schedule: record.schedule ? this.toJson(record.schedule) : null,
        metadata: this.toJson(record.metadata ?? {}),
        createdBy: record.createdBy,
        updatedBy: record.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateCrawler(
      id: string,
      data: Partial<Omit<ICrawler, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<ICrawler | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const scalarFields = [
        'name', 'description', 'status', 'engine', 'updatedBy', 'projectId', 'key',
      ];
      for (const f of scalarFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      if (data.maxDepth !== undefined) { sets.push('maxDepth = @maxDepth'); params.maxDepth = data.maxDepth; }
      if (data.maxPages !== undefined) { sets.push('maxPages = @maxPages'); params.maxPages = data.maxPages; }
      if (data.autoCrawl !== undefined) { sets.push('autoCrawl = @autoCrawl'); params.autoCrawl = data.autoCrawl ? 1 : 0; }
      const jsonFields = ['seeds', 'scope', 'downloadableMimes', 'http', 'markdownOptions', 'metadata'];
      for (const f of jsonFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = this.toJson((data as Record<string, unknown>)[f] ?? {});
        }
      }
      const nullableJsonFields = ['rag', 'webhook', 'schedule'];
      for (const f of nullableJsonFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          const v = (data as Record<string, unknown>)[f];
          params[f] = v == null ? null : this.toJson(v);
        }
      }
      db.prepare(`UPDATE ${TABLES.crawlers} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findCrawlerById(id);
    }

    async deleteCrawler(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const jobs = db.prepare(
        `SELECT id FROM ${TABLES.crawlJobs} WHERE crawlerKey = (SELECT key FROM ${TABLES.crawlers} WHERE id = @id)`,
      ).all({ id }) as SqliteRow[];
      for (const j of jobs) {
        db.prepare(`DELETE FROM ${TABLES.crawlResults} WHERE jobId = @jobId`).run({ jobId: j.id });
      }
      db.prepare(
        `DELETE FROM ${TABLES.crawlJobs} WHERE crawlerKey = (SELECT key FROM ${TABLES.crawlers} WHERE id = @id)`,
      ).run({ id });
      return db.prepare(`DELETE FROM ${TABLES.crawlers} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findCrawlerById(id: string): Promise<ICrawler | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.crawlers} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapCrawler(row) : null;
    }

    async findCrawlerByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<ICrawler | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.crawlers} WHERE tenantId = @tenantId AND key = @key`;
      const params: Record<string, unknown> = { tenantId, key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapCrawler(row) : null;
    }

    async listCrawlers(
      tenantId: string,
      filters?: { projectId?: string; status?: string; search?: string },
    ): Promise<ICrawler[]> {
      const db = this.getTenantDb();
      const conds: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) { conds.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status) { conds.push('status = @status'); params.status = filters.status; }
      if (filters?.search) {
        conds.push('(name LIKE @search OR key LIKE @search)');
        params.search = this.likePattern(filters.search);
      }
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.crawlers} WHERE ${conds.join(' AND ')} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapCrawler(r));
    }

    private mapCrawler(row: SqliteRow): ICrawler {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        key: row.key as string,
        name: row.name as string,
        description: (row.description as string) ?? undefined,
        status: row.status as ICrawler['status'],
        seeds: this.parseJson(row.seeds, [] as string[]),
        engine: row.engine as ICrawler['engine'],
        maxDepth: Number(row.maxDepth) || 0,
        maxPages: Number(row.maxPages) || 0,
        autoCrawl: Number(row.autoCrawl) === 1,
        scope: this.parseJson(row.scope, {} as ICrawler['scope']),
        downloadableMimes: this.parseJson(row.downloadableMimes, [] as string[]),
        http: this.parseJson(row.http, {} as ICrawler['http']),
        markdownOptions: this.parseJson(row.markdownOptions, {} as ICrawler['markdownOptions']),
        rag: row.rag ? this.parseJson(row.rag, undefined as unknown as ICrawler['rag']) : undefined,
        webhook: row.webhook ? this.parseJson(row.webhook, undefined as unknown as ICrawler['webhook']) : undefined,
        schedule: row.schedule ? this.parseJson(row.schedule, undefined as unknown as ICrawler['schedule']) : undefined,
        metadata: this.parseJson(row.metadata, {}),
        createdBy: row.createdBy as string,
        updatedBy: (row.updatedBy as string) ?? undefined,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    // ── Crawl jobs ───────────────────────────────────────────────────
    async createCrawlJob(
      record: Omit<ICrawlJob, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ICrawlJob> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.crawlJobs}
        (id, tenantId, projectId, crawlerKey, trigger, triggerActor, planSnapshot,
         status, startedAt, endedAt, durationMs,
         pagesDiscovered, pagesProcessed, filesProcessed, errorsCount, limitReached,
         callbackUrl, errorMessage, metadata, userId, apiTokenId, actorType,
         createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @crawlerKey, @trigger, @triggerActor, @planSnapshot,
         @status, @startedAt, @endedAt, @durationMs,
         @pagesDiscovered, @pagesProcessed, @filesProcessed, @errorsCount, @limitReached,
         @callbackUrl, @errorMessage, @metadata, @userId, @apiTokenId, @actorType,
         @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        crawlerKey: record.crawlerKey ?? null,
        trigger: record.trigger,
        triggerActor: record.triggerActor,
        planSnapshot: this.toJson(record.planSnapshot ?? {}),
        status: record.status,
        startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
        endedAt: record.endedAt ? new Date(record.endedAt).toISOString() : null,
        durationMs: record.durationMs ?? null,
        pagesDiscovered: record.pagesDiscovered ?? 0,
        pagesProcessed: record.pagesProcessed ?? 0,
        filesProcessed: record.filesProcessed ?? 0,
        errorsCount: record.errorsCount ?? 0,
        limitReached: record.limitReached ? 1 : 0,
        callbackUrl: record.callbackUrl ?? null,
        errorMessage: record.errorMessage ?? null,
        metadata: this.toJson(record.metadata ?? {}),
        userId: record.userId ?? null,
        apiTokenId: record.apiTokenId ?? null,
        actorType: record.actorType ?? null,
        createdBy: record.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateCrawlJob(
      id: string,
      data: Partial<Omit<ICrawlJob, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const { sets, params } = this.buildCrawlJobSetClause(data, id, now);
      db.prepare(`UPDATE ${TABLES.crawlJobs} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findCrawlJobById(id);
    }

    async claimCrawlJob(id: string, tenantId: string, startedAt: Date): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const result = db.prepare(`
        UPDATE ${TABLES.crawlJobs} SET status = 'running', startedAt = @startedAt, updatedAt = @updatedAt
        WHERE id = @id AND tenantId = @tenantId AND status = 'queued'
      `).run({ id, tenantId, startedAt: startedAt.toISOString(), updatedAt: now });
      if (result.changes !== 1) return null;
      return this.findCrawlJobById(id);
    }

    async requestCrawlJobCancel(id: string, tenantId: string): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const now = this.now();
      // Fast path: job hasn't started yet, cancel it outright.
      const queuedResult = db.prepare(`
        UPDATE ${TABLES.crawlJobs} SET status = 'canceled', endedAt = @now, updatedAt = @now
        WHERE id = @id AND tenantId = @tenantId AND status = 'queued'
      `).run({ id, tenantId, now });
      if (queuedResult.changes === 1) return this.findCrawlJobById(id);

      // Already running (possibly on another node) — stamp the request so
      // the owning runner observes it on its next DB round trip.
      const runningResult = db.prepare(`
        UPDATE ${TABLES.crawlJobs} SET cancelRequestedAt = @now, updatedAt = @now
        WHERE id = @id AND tenantId = @tenantId AND status = 'running'
      `).run({ id, tenantId, now });
      if (runningResult.changes !== 1) return null;
      return this.findCrawlJobById(id);
    }

    async finalizeCrawlJob(
      id: string,
      tenantId: string,
      data: Partial<Omit<ICrawlJob, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const { sets, params } = this.buildCrawlJobSetClause(data, id, now);
      params.tenantId = tenantId;
      const result = db.prepare(
        `UPDATE ${TABLES.crawlJobs} SET ${sets.join(', ')} WHERE id = @id AND tenantId = @tenantId AND status = 'running'`,
      ).run(params);
      if (result.changes !== 1) return null;
      return this.findCrawlJobById(id);
    }

    private buildCrawlJobSetClause(
      data: Partial<Omit<ICrawlJob, '_id' | 'tenantId' | 'createdAt'>>,
      id: string,
      now: string,
    ): { sets: string[]; params: Record<string, unknown> } {
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const scalarFields = ['status', 'crawlerKey', 'callbackUrl', 'errorMessage', 'projectId'];
      for (const f of scalarFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      const numberFields = ['durationMs', 'pagesDiscovered', 'pagesProcessed', 'filesProcessed', 'errorsCount'];
      for (const f of numberFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      if (data.limitReached !== undefined) {
        sets.push('limitReached = @limitReached');
        params.limitReached = data.limitReached ? 1 : 0;
      }
      const dateFields: Array<'startedAt' | 'endedAt' | 'cancelRequestedAt'> = [
        'startedAt', 'endedAt', 'cancelRequestedAt',
      ];
      for (const f of dateFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          const v = (data as Record<string, unknown>)[f] as Date | string | null;
          params[f] = v ? new Date(v).toISOString() : null;
        }
      }
      if (data.planSnapshot !== undefined) {
        sets.push('planSnapshot = @planSnapshot');
        params.planSnapshot = this.toJson(data.planSnapshot);
      }
      if (data.metadata !== undefined) {
        sets.push('metadata = @metadata');
        params.metadata = this.toJson(data.metadata);
      }
      return { sets, params };
    }

    async findCrawlJobById(id: string): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.crawlJobs} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapCrawlJob(row) : null;
    }

    async listCrawlJobs(
      tenantId: string,
      filters?: { projectId?: string; crawlerKey?: string; status?: string; limit?: number },
    ): Promise<ICrawlJob[]> {
      const db = this.getTenantDb();
      const conds: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) { conds.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.crawlerKey) { conds.push('crawlerKey = @crawlerKey'); params.crawlerKey = filters.crawlerKey; }
      if (filters?.status) { conds.push('status = @status'); params.status = filters.status; }
      let sql = `SELECT * FROM ${TABLES.crawlJobs} WHERE ${conds.join(' AND ')} ORDER BY createdAt DESC`;
      if (filters?.limit && filters.limit > 0) sql += ` LIMIT ${Math.min(filters.limit, 500)}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapCrawlJob(r));
    }

    private mapCrawlJob(row: SqliteRow): ICrawlJob {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        crawlerKey: (row.crawlerKey as string) ?? undefined,
        trigger: row.trigger as ICrawlJob['trigger'],
        triggerActor: row.triggerActor as string,
        planSnapshot: this.parseJson(row.planSnapshot, {} as ICrawlJob['planSnapshot']),
        status: row.status as ICrawlJob['status'],
        startedAt: this.toDate(row.startedAt),
        endedAt: this.toDate(row.endedAt),
        durationMs: row.durationMs == null ? undefined : Number(row.durationMs),
        pagesDiscovered: Number(row.pagesDiscovered) || 0,
        pagesProcessed: Number(row.pagesProcessed) || 0,
        filesProcessed: Number(row.filesProcessed) || 0,
        errorsCount: Number(row.errorsCount) || 0,
        limitReached: Number(row.limitReached) === 1,
        cancelRequestedAt: row.cancelRequestedAt ? this.toDate(row.cancelRequestedAt) : undefined,
        callbackUrl: (row.callbackUrl as string) ?? undefined,
        errorMessage: (row.errorMessage as string) ?? undefined,
        metadata: this.parseJson(row.metadata, {}),
        userId: (row.userId as string | null) ?? undefined,
        apiTokenId: (row.apiTokenId as string | null) ?? undefined,
        actorType: (row.actorType as ICrawlJob['actorType'] | null) ?? undefined,
        createdBy: row.createdBy as string,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    // ── Crawl results ────────────────────────────────────────────────
    async createCrawlResult(
      record: Omit<ICrawlResult, '_id' | 'createdAt'>,
    ): Promise<ICrawlResult> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.crawlResults}
        (id, tenantId, projectId, jobId, crawlerKey, url, parentUrl, depth, type,
         httpStatus, contentType, title, description, bodyMarkdown, bytes,
         ragDocumentId, ragStatus, errorMessage, fetchedAt, createdAt)
        VALUES (@id, @tenantId, @projectId, @jobId, @crawlerKey, @url, @parentUrl, @depth, @type,
         @httpStatus, @contentType, @title, @description, @bodyMarkdown, @bytes,
         @ragDocumentId, @ragStatus, @errorMessage, @fetchedAt, @createdAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        jobId: record.jobId,
        crawlerKey: record.crawlerKey ?? null,
        url: record.url,
        parentUrl: record.parentUrl ?? null,
        depth: record.depth ?? 0,
        type: record.type,
        httpStatus: record.httpStatus ?? null,
        contentType: record.contentType ?? null,
        title: record.title ?? null,
        description: record.description ?? null,
        bodyMarkdown: record.bodyMarkdown ?? null,
        bytes: record.bytes ?? null,
        ragDocumentId: record.ragDocumentId ?? null,
        ragStatus: record.ragStatus ?? null,
        errorMessage: record.errorMessage ?? null,
        fetchedAt: record.fetchedAt ? new Date(record.fetchedAt).toISOString() : null,
        createdAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now) };
    }

    async listCrawlResults(
      jobId: string,
      options?: { limit?: number; skip?: number; type?: string },
    ): Promise<ICrawlResult[]> {
      const db = this.getTenantDb();
      const conds: string[] = ['jobId = @jobId'];
      const params: Record<string, unknown> = { jobId };
      if (options?.type) { conds.push('type = @type'); params.type = options.type; }
      let sql = `SELECT * FROM ${TABLES.crawlResults} WHERE ${conds.join(' AND ')} ORDER BY createdAt ASC`;
      if (options?.limit) sql += ` LIMIT ${Math.min(options.limit, 5000)}`;
      if (options?.skip) sql += ` OFFSET ${options.skip}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapCrawlResult(r));
    }

    async findCrawlResultById(id: string): Promise<ICrawlResult | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.crawlResults} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapCrawlResult(row) : null;
    }

    async countCrawlResults(jobId: string): Promise<number> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.crawlResults} WHERE jobId = @jobId`,
      ).get({ jobId }) as SqliteRow;
      return Number(row.cnt) || 0;
    }

    async deleteCrawlResultsByJob(jobId: string): Promise<number> {
      const db = this.getTenantDb();
      const info = db.prepare(
        `DELETE FROM ${TABLES.crawlResults} WHERE jobId = @jobId`,
      ).run({ jobId });
      return Number(info.changes) || 0;
    }

    private mapCrawlResult(row: SqliteRow): ICrawlResult {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        jobId: row.jobId as string,
        crawlerKey: (row.crawlerKey as string) ?? undefined,
        url: row.url as string,
        parentUrl: (row.parentUrl as string) ?? undefined,
        depth: Number(row.depth) || 0,
        type: row.type as ICrawlResult['type'],
        httpStatus: row.httpStatus == null ? undefined : Number(row.httpStatus),
        contentType: (row.contentType as string) ?? undefined,
        title: (row.title as string) ?? undefined,
        description: (row.description as string) ?? undefined,
        bodyMarkdown: (row.bodyMarkdown as string) ?? undefined,
        bytes: row.bytes == null ? undefined : Number(row.bytes),
        ragDocumentId: (row.ragDocumentId as string) ?? undefined,
        ragStatus: (row.ragStatus as ICrawlResult['ragStatus']) ?? undefined,
        errorMessage: (row.errorMessage as string) ?? undefined,
        fetchedAt: this.toDate(row.fetchedAt),
        createdAt: this.toDate(row.createdAt),
      };
    }
  };
}
