/**
 * SQLite Provider – Browsers, Browser sessions & events mixin
 */

import type {
  IBrowser,
  IBrowserFlow,
  IBrowserFlowRun,
  IBrowserSession,
  IBrowserSessionEvent,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function BrowserMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class BrowserOps extends Base {
    // ── Browsers (parent profiles) ───────────────────────────────────
    async createBrowser(
      record: Omit<IBrowser, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IBrowser> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.browsers}
        (id, tenantId, projectId, key, name, description, status,
         artifactBucketKey, defaultSessionConfig, defaultModelKey, defaultRunOptions,
         storageStateEnc, storageStateMeta,
         metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @status,
         @artifactBucketKey, @defaultSessionConfig, @defaultModelKey, @defaultRunOptions,
         @storageStateEnc, @storageStateMeta,
         @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        key: record.key,
        name: record.name,
        description: record.description ?? null,
        status: record.status,
        artifactBucketKey: record.artifactBucketKey ?? null,
        defaultSessionConfig: this.toJson(record.defaultSessionConfig ?? {}),
        defaultModelKey: record.defaultModelKey ?? null,
        defaultRunOptions: this.toJson(record.defaultRunOptions ?? {}),
        storageStateEnc: record.storageStateEnc ?? null,
        storageStateMeta: record.storageStateMeta ? this.toJson(record.storageStateMeta) : null,
        metadata: this.toJson(record.metadata ?? {}),
        createdBy: record.createdBy,
        updatedBy: record.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateBrowser(
      id: string,
      data: Partial<Omit<IBrowser, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IBrowser | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const map: Record<string, (v: unknown) => unknown> = {
        name: (v) => v,
        description: (v) => v,
        status: (v) => v,
        artifactBucketKey: (v) => v,
        defaultModelKey: (v) => v,
        updatedBy: (v) => v,
        projectId: (v) => v,
        key: (v) => v,
        storageStateEnc: (v) => v ?? null,
        defaultSessionConfig: (v) => this.toJson(v ?? {}),
        defaultRunOptions: (v) => this.toJson(v ?? {}),
        storageStateMeta: (v) => (v ? this.toJson(v) : null),
        metadata: (v) => this.toJson(v ?? {}),
      };
      for (const [k, transform] of Object.entries(map)) {
        if ((data as Record<string, unknown>)[k] !== undefined) {
          sets.push(`${k} = @${k}`);
          params[k] = transform((data as Record<string, unknown>)[k]);
        }
      }
      db.prepare(`UPDATE ${TABLES.browsers} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findBrowserById(id);
    }

    async deleteBrowser(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.browsers} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findBrowserById(id: string): Promise<IBrowser | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.browsers} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapBrowser(row) : null;
    }

    async findBrowserByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<IBrowser | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.browsers} WHERE tenantId = @tenantId AND key = @key`;
      const params: Record<string, unknown> = { tenantId, key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapBrowser(row) : null;
    }

    async listBrowsers(
      tenantId: string,
      filters?: { projectId?: string; status?: string; search?: string },
    ): Promise<IBrowser[]> {
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
        `SELECT * FROM ${TABLES.browsers} WHERE ${conds.join(' AND ')} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapBrowser(r));
    }

    private mapBrowser(row: SqliteRow): IBrowser {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        key: row.key as string,
        name: row.name as string,
        description: (row.description as string) ?? undefined,
        status: row.status as IBrowser['status'],
        artifactBucketKey: (row.artifactBucketKey as string) ?? undefined,
        defaultSessionConfig: this.parseJson(row.defaultSessionConfig, {}),
        defaultModelKey: (row.defaultModelKey as string) ?? undefined,
        defaultRunOptions: this.parseJson(row.defaultRunOptions, {}),
        storageStateEnc: (row.storageStateEnc as string) ?? undefined,
        storageStateMeta: row.storageStateMeta
          ? this.parseJson(row.storageStateMeta, undefined as unknown as IBrowser['storageStateMeta'])
          : undefined,
        metadata: this.parseJson(row.metadata, {}),
        createdBy: row.createdBy as string,
        updatedBy: (row.updatedBy as string) ?? undefined,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    // ── Browser Sessions ─────────────────────────────────────────────
    async createBrowserSession(
      record: Omit<IBrowserSession, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IBrowserSession> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.browserSessions}
        (id, tenantId, projectId, browserId, sessionKey, name, agentId, agentKey, status,
         config, currentUrl, pageTitle, lastActivityAt, lastScreenshot, artifactBucketKey,
         startedAt, endedAt, errorMessage, eventCount, metadata, userId, apiTokenId, actorType,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @browserId, @sessionKey, @name, @agentId, @agentKey, @status,
         @config, @currentUrl, @pageTitle, @lastActivityAt, @lastScreenshot, @artifactBucketKey,
         @startedAt, @endedAt, @errorMessage, @eventCount, @metadata, @userId, @apiTokenId, @actorType,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        browserId: record.browserId,
        sessionKey: record.sessionKey,
        name: record.name ?? null,
        agentId: record.agentId ?? null,
        agentKey: record.agentKey ?? null,
        status: record.status,
        config: this.toJson(record.config ?? {}),
        currentUrl: record.currentUrl ?? null,
        pageTitle: record.pageTitle ?? null,
        lastActivityAt: record.lastActivityAt ? new Date(record.lastActivityAt).toISOString() : null,
        lastScreenshot: record.lastScreenshot ? this.toJson(record.lastScreenshot) : null,
        artifactBucketKey: record.artifactBucketKey ?? null,
        startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
        endedAt: record.endedAt ? new Date(record.endedAt).toISOString() : null,
        errorMessage: record.errorMessage ?? null,
        eventCount: record.eventCount ?? 0,
        metadata: this.toJson(record.metadata ?? {}),
        userId: record.userId ?? null,
        apiTokenId: record.apiTokenId ?? null,
        actorType: record.actorType ?? null,
        createdBy: record.createdBy,
        updatedBy: record.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateBrowserSession(
      id: string,
      data: Partial<Omit<IBrowserSession, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IBrowserSession | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const stringFields = [
        'sessionKey', 'name', 'agentId', 'agentKey', 'status', 'currentUrl', 'pageTitle',
        'artifactBucketKey', 'errorMessage', 'updatedBy', 'projectId', 'browserId',
      ];
      for (const f of stringFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      const dateFields: Array<'lastActivityAt' | 'startedAt' | 'endedAt'> = ['lastActivityAt', 'startedAt', 'endedAt'];
      for (const f of dateFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          const v = (data as Record<string, unknown>)[f] as Date | string | null;
          params[f] = v ? new Date(v).toISOString() : null;
        }
      }
      const jsonFields = ['config', 'metadata', 'lastScreenshot'];
      for (const f of jsonFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = this.toJson((data as Record<string, unknown>)[f] ?? null);
        }
      }
      if (data.eventCount !== undefined) {
        sets.push('eventCount = @eventCount');
        params.eventCount = data.eventCount;
      }
      db.prepare(`UPDATE ${TABLES.browserSessions} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findBrowserSessionById(id);
    }

    async deleteBrowserSession(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.browserSessionEvents} WHERE sessionId = @id`).run({ id });
      return db.prepare(`DELETE FROM ${TABLES.browserSessions} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findBrowserSessionById(id: string): Promise<IBrowserSession | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.browserSessions} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapBrowserSession(row) : null;
    }

    async findBrowserSessionByKey(
      tenantId: string,
      sessionKey: string,
      projectId?: string,
    ): Promise<IBrowserSession | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.browserSessions} WHERE tenantId = @tenantId AND sessionKey = @sessionKey`;
      const params: Record<string, unknown> = { tenantId, sessionKey };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapBrowserSession(row) : null;
    }

    async listBrowserSessions(
      tenantId: string,
      filters?: {
        projectId?: string;
        browserId?: string;
        agentId?: string;
        status?: string;
        search?: string;
        createdFrom?: Date;
        createdTo?: Date;
        limit?: number;
      },
    ): Promise<IBrowserSession[]> {
      const db = this.getTenantDb();
      const conds: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) { conds.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.browserId) { conds.push('browserId = @browserId'); params.browserId = filters.browserId; }
      if (filters?.agentId) { conds.push('agentId = @agentId'); params.agentId = filters.agentId; }
      if (filters?.status) { conds.push('status = @status'); params.status = filters.status; }
      if (filters?.search) {
        conds.push('(name LIKE @search OR sessionKey LIKE @search)');
        params.search = this.likePattern(filters.search);
      }
      // `createdAt` is stored as an ISO-8601 string, which sorts and compares
      // lexicographically in the same order as the instants it represents —
      // so a plain string range is correct here, not a coincidence.
      if (filters?.createdFrom) {
        conds.push('createdAt >= @createdFrom');
        params.createdFrom = filters.createdFrom.toISOString();
      }
      if (filters?.createdTo) {
        conds.push('createdAt <= @createdTo');
        params.createdTo = filters.createdTo.toISOString();
      }
      let sql = `SELECT * FROM ${TABLES.browserSessions} WHERE ${conds.join(' AND ')} ORDER BY createdAt DESC`;
      if (filters?.limit && filters.limit > 0) sql += ` LIMIT ${Math.min(filters.limit, 1000)}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapBrowserSession(r));
    }

    private mapBrowserSession(row: SqliteRow): IBrowserSession {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        browserId: row.browserId as string,
        sessionKey: row.sessionKey as string,
        name: (row.name as string) ?? undefined,
        agentId: (row.agentId as string) ?? undefined,
        agentKey: (row.agentKey as string) ?? undefined,
        status: row.status as IBrowserSession['status'],
        config: this.parseJson(row.config, {}),
        currentUrl: (row.currentUrl as string) ?? undefined,
        pageTitle: (row.pageTitle as string) ?? undefined,
        lastActivityAt: this.toDate(row.lastActivityAt),
        lastScreenshot: this.parseJson(row.lastScreenshot, undefined as unknown as IBrowserSession['lastScreenshot']),
        artifactBucketKey: (row.artifactBucketKey as string) ?? undefined,
        startedAt: this.toDate(row.startedAt),
        endedAt: this.toDate(row.endedAt),
        errorMessage: (row.errorMessage as string) ?? undefined,
        eventCount: Number(row.eventCount) || 0,
        metadata: this.parseJson(row.metadata, {}),
        userId: (row.userId as string | null) ?? undefined,
        apiTokenId: (row.apiTokenId as string | null) ?? undefined,
        actorType: (row.actorType as IBrowserSession['actorType'] | null) ?? undefined,
        createdBy: row.createdBy as string,
        updatedBy: (row.updatedBy as string) ?? undefined,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    // ── Browser Session Events ───────────────────────────────────────
    async createBrowserSessionEvent(
      record: Omit<IBrowserSessionEvent, '_id' | 'createdAt'>,
    ): Promise<IBrowserSessionEvent> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.browserSessionEvents}
        (id, tenantId, projectId, sessionId, sequence, type, status, url, selector, ref,
         durationMs, artifact, data, errorMessage, createdAt)
        VALUES (@id, @tenantId, @projectId, @sessionId, @sequence, @type, @status, @url,
         @selector, @ref, @durationMs, @artifact, @data, @errorMessage, @createdAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        sessionId: record.sessionId,
        sequence: record.sequence,
        type: record.type,
        status: record.status ?? null,
        url: record.url ?? null,
        selector: record.selector ?? null,
        ref: record.ref ?? null,
        durationMs: record.durationMs ?? null,
        artifact: record.artifact ? this.toJson(record.artifact) : null,
        data: record.data ? this.toJson(record.data) : null,
        errorMessage: record.errorMessage ?? null,
        createdAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now) };
    }

    async listBrowserSessionEvents(
      sessionId: string,
      options?: { limit?: number; skip?: number },
    ): Promise<IBrowserSessionEvent[]> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.browserSessionEvents} WHERE sessionId = @sessionId ORDER BY sequence ASC`;
      if (options?.limit) sql += ` LIMIT ${Math.min(options.limit, 5000)}`;
      if (options?.skip) sql += ` OFFSET ${options.skip}`;
      const rows = db.prepare(sql).all({ sessionId }) as SqliteRow[];
      return rows.map((row) => ({
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        sessionId: row.sessionId as string,
        sequence: Number(row.sequence) || 0,
        type: row.type as IBrowserSessionEvent['type'],
        status: (row.status as IBrowserSessionEvent['status']) ?? undefined,
        url: (row.url as string) ?? undefined,
        selector: (row.selector as string) ?? undefined,
        ref: (row.ref as string) ?? undefined,
        durationMs: row.durationMs == null ? undefined : Number(row.durationMs),
        artifact: this.parseJson(row.artifact, undefined as unknown as IBrowserSessionEvent['artifact']),
        data: this.parseJson(row.data, undefined as unknown as IBrowserSessionEvent['data']),
        errorMessage: (row.errorMessage as string) ?? undefined,
        createdAt: this.toDate(row.createdAt),
      }));
    }

    async countBrowserSessionEvents(sessionId: string): Promise<number> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.browserSessionEvents} WHERE sessionId = @sessionId`,
      ).get({ sessionId }) as SqliteRow;
      return Number(row.cnt) || 0;
    }

    // ── Browser Flows ────────────────────────────────────────────────

    private mapBrowserFlow(row: SqliteRow): IBrowserFlow {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        key: row.key as string,
        name: row.name as string,
        description: (row.description as string) ?? undefined,
        status: row.status as IBrowserFlow['status'],
        browserId: row.browserId as string,
        inputs: this.parseJson(row.inputs, [] as IBrowserFlow['inputs']),
        steps: this.parseJson(row.steps, [] as IBrowserFlow['steps']) ?? [],
        sessionConfig: this.parseJson(
          row.sessionConfig,
          undefined as unknown as IBrowserFlow['sessionConfig'],
        ),
        recordedFromSessionId: (row.recordedFromSessionId as string) ?? undefined,
        version: Number(row.version) || 1,
        lastRun: this.parseJson(row.lastRun, undefined as unknown as IBrowserFlow['lastRun']),
        metadata: this.parseJson(row.metadata, {} as Record<string, unknown>),
        createdBy: row.createdBy as string,
        updatedBy: (row.updatedBy as string) ?? undefined,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    async createBrowserFlow(
      record: Omit<IBrowserFlow, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IBrowserFlow> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.browserFlows}
        (id, tenantId, projectId, key, name, description, status, browserId, inputs, steps,
         sessionConfig, recordedFromSessionId, version, lastRun, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @status, @browserId,
         @inputs, @steps, @sessionConfig, @recordedFromSessionId, @version, @lastRun, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        key: record.key,
        name: record.name,
        description: record.description ?? null,
        status: record.status,
        browserId: record.browserId,
        inputs: this.toJson(record.inputs ?? []),
        steps: this.toJson(record.steps ?? []),
        sessionConfig: record.sessionConfig ? this.toJson(record.sessionConfig) : null,
        recordedFromSessionId: record.recordedFromSessionId ?? null,
        version: record.version ?? 1,
        lastRun: record.lastRun ? this.toJson(record.lastRun) : null,
        metadata: this.toJson(record.metadata ?? {}),
        createdBy: record.createdBy,
        updatedBy: record.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateBrowserFlow(
      id: string,
      data: Partial<Omit<IBrowserFlow, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IBrowserFlow | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const map: Record<string, (v: unknown) => unknown> = {
        key: (v) => v,
        name: (v) => v,
        description: (v) => v,
        status: (v) => v,
        browserId: (v) => v,
        recordedFromSessionId: (v) => v,
        version: (v) => v,
        updatedBy: (v) => v,
        projectId: (v) => v,
        inputs: (v) => this.toJson(v ?? []),
        steps: (v) => this.toJson(v ?? []),
        sessionConfig: (v) => (v ? this.toJson(v) : null),
        lastRun: (v) => (v ? this.toJson(v) : null),
        metadata: (v) => this.toJson(v ?? {}),
      };
      for (const [k, transform] of Object.entries(map)) {
        if ((data as Record<string, unknown>)[k] !== undefined) {
          sets.push(`${k} = @${k}`);
          params[k] = transform((data as Record<string, unknown>)[k]);
        }
      }
      db.prepare(`UPDATE ${TABLES.browserFlows} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findBrowserFlowById(id);
    }

    async deleteBrowserFlow(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      // Runs are meaningless without their flow, and nothing else references
      // them — drop the history in the same call rather than orphaning it.
      db.prepare(`DELETE FROM ${TABLES.browserFlowRuns} WHERE flowId = @id`).run({ id });
      const result = db.prepare(`DELETE FROM ${TABLES.browserFlows} WHERE id = @id`).run({ id });
      return result.changes > 0;
    }

    async findBrowserFlowById(id: string): Promise<IBrowserFlow | null> {
      const db = this.getTenantDb();
      const row = db
        .prepare(`SELECT * FROM ${TABLES.browserFlows} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      return row ? this.mapBrowserFlow(row) : null;
    }

    async findBrowserFlowByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<IBrowserFlow | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.browserFlows} WHERE tenantId = @tenantId AND key = @key`;
      const params: Record<string, unknown> = { tenantId, key };
      if (projectId) {
        sql += ' AND projectId = @projectId';
        params.projectId = projectId;
      }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapBrowserFlow(row) : null;
    }

    async listBrowserFlows(
      tenantId: string,
      filters?: {
        projectId?: string;
        status?: string;
        browserId?: string;
        search?: string;
      },
    ): Promise<IBrowserFlow[]> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.browserFlows} WHERE tenantId = @tenantId`;
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) {
        sql += ' AND projectId = @projectId';
        params.projectId = filters.projectId;
      }
      if (filters?.status) {
        sql += ' AND status = @status';
        params.status = filters.status;
      }
      if (filters?.browserId) {
        sql += ' AND browserId = @browserId';
        params.browserId = filters.browserId;
      }
      if (filters?.search) {
        sql += ' AND (name LIKE @search OR key LIKE @search OR description LIKE @search)';
        params.search = `%${filters.search}%`;
      }
      sql += ' ORDER BY updatedAt DESC';
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((row) => this.mapBrowserFlow(row));
    }

    // ── Browser Flow Runs ────────────────────────────────────────────

    private mapBrowserFlowRun(row: SqliteRow): IBrowserFlowRun {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        flowId: row.flowId as string,
        flowKey: row.flowKey as string,
        flowVersion: Number(row.flowVersion) || 1,
        status: row.status as IBrowserFlowRun['status'],
        trigger: row.trigger as IBrowserFlowRun['trigger'],
        sessionId: (row.sessionId as string) ?? undefined,
        sessionKey: (row.sessionKey as string) ?? undefined,
        inputs: this.parseJson(row.inputs, {} as Record<string, unknown>),
        stepResults: this.parseJson(row.stepResults, [] as IBrowserFlowRun['stepResults']),
        outputs: this.parseJson(row.outputs, {} as Record<string, unknown>),
        startedAt: row.startedAt ? this.toDate(row.startedAt) : undefined,
        endedAt: row.endedAt ? this.toDate(row.endedAt) : undefined,
        durationMs: row.durationMs == null ? undefined : Number(row.durationMs),
        errorMessage: (row.errorMessage as string) ?? undefined,
        failedStepIndex: row.failedStepIndex == null ? undefined : Number(row.failedStepIndex),
        createdBy: row.createdBy as string,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    async createBrowserFlowRun(
      record: Omit<IBrowserFlowRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IBrowserFlowRun> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.browserFlowRuns}
        (id, tenantId, projectId, flowId, flowKey, flowVersion, status, trigger,
         sessionId, sessionKey, inputs, stepResults, outputs, startedAt, endedAt,
         durationMs, errorMessage, failedStepIndex, createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @flowId, @flowKey, @flowVersion, @status, @trigger,
         @sessionId, @sessionKey, @inputs, @stepResults, @outputs, @startedAt, @endedAt,
         @durationMs, @errorMessage, @failedStepIndex, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        flowId: record.flowId,
        flowKey: record.flowKey,
        flowVersion: record.flowVersion,
        status: record.status,
        trigger: record.trigger,
        sessionId: record.sessionId ?? null,
        sessionKey: record.sessionKey ?? null,
        inputs: this.toJson(record.inputs ?? {}),
        stepResults: this.toJson(record.stepResults ?? []),
        outputs: this.toJson(record.outputs ?? {}),
        startedAt: record.startedAt ? record.startedAt.toISOString() : null,
        endedAt: record.endedAt ? record.endedAt.toISOString() : null,
        durationMs: record.durationMs ?? null,
        errorMessage: record.errorMessage ?? null,
        failedStepIndex: record.failedStepIndex ?? null,
        createdBy: record.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateBrowserFlowRun(
      id: string,
      data: Partial<Omit<IBrowserFlowRun, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IBrowserFlowRun | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const map: Record<string, (v: unknown) => unknown> = {
        status: (v) => v,
        sessionId: (v) => v,
        sessionKey: (v) => v,
        durationMs: (v) => v,
        errorMessage: (v) => v,
        failedStepIndex: (v) => v,
        inputs: (v) => this.toJson(v ?? {}),
        stepResults: (v) => this.toJson(v ?? []),
        outputs: (v) => this.toJson(v ?? {}),
        startedAt: (v) => (v instanceof Date ? v.toISOString() : v),
        endedAt: (v) => (v instanceof Date ? v.toISOString() : v),
      };
      for (const [k, transform] of Object.entries(map)) {
        if ((data as Record<string, unknown>)[k] !== undefined) {
          sets.push(`${k} = @${k}`);
          params[k] = transform((data as Record<string, unknown>)[k]);
        }
      }
      db.prepare(`UPDATE ${TABLES.browserFlowRuns} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findBrowserFlowRunById(id);
    }

    async findBrowserFlowRunById(id: string): Promise<IBrowserFlowRun | null> {
      const db = this.getTenantDb();
      const row = db
        .prepare(`SELECT * FROM ${TABLES.browserFlowRuns} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      return row ? this.mapBrowserFlowRun(row) : null;
    }

    async listBrowserFlowRuns(
      tenantId: string,
      filters?: {
        projectId?: string;
        flowId?: string;
        status?: string;
        limit?: number;
        skip?: number;
      },
    ): Promise<IBrowserFlowRun[]> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.browserFlowRuns} WHERE tenantId = @tenantId`;
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) {
        sql += ' AND projectId = @projectId';
        params.projectId = filters.projectId;
      }
      if (filters?.flowId) {
        sql += ' AND flowId = @flowId';
        params.flowId = filters.flowId;
      }
      if (filters?.status) {
        sql += ' AND status = @status';
        params.status = filters.status;
      }
      sql += ' ORDER BY createdAt DESC';
      sql += ` LIMIT ${Math.min(filters?.limit && filters.limit > 0 ? filters.limit : 100, 1000)}`;
      if (filters?.skip) sql += ` OFFSET ${filters.skip}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((row) => this.mapBrowserFlowRun(row));
    }
  };
}
