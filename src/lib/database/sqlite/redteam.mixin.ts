/**
 * SQLite Provider – Red-team operations mixin
 *
 * CRUD for red-team campaigns and runs (attempts + aggregate embedded as JSON).
 * Mirrors the evaluation mixin conventions (prepared statements, JSON columns,
 * row mappers).
 */

import type {
  IRedTeamCampaign,
  IRedTeamRun,
  IRedTeamRunAttempt,
  IRedTeamRunGuard,
  IRedTeamReview,
  IRedTeamAttemptResult,
  IRedTeamAggregate,
  IRedTeamCustomProbe,
  IRedTeamCustomAttempt,
  IRedTeamCustomDetectors,
  RedTeamRunStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';
import { agentRevisionFromColumn, agentVersionFromColumn, agentVersionToColumn } from './agentRevisionColumns';

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Every run column except the (potentially large) legacy embedded attempts. */
const RUN_COLUMNS_WITHOUT_ATTEMPTS =
  'id, tenantId, projectId, campaignKey, targetKind, targetRef, agentRevision, status, mode, progress, aggregate, ' +
  'attemptStore, skippedAttempts, notApplicableAttempts, warnings, workerId, leaseUntil, cancelRequested, ' +
  'cancelRequestedBy, cancelledAt, error, startedAt, finishedAt, createdBy, createdAt, updatedAt';

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** A non-string id finds nothing (the MongoDB provider does the same for a malformed one). */
function isId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0;
}

export function RedTeamMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class RedTeamOps extends Base {
    // ── Campaigns ────────────────────────────────────────────────────

    async createRedTeamCampaign(
      campaign: Omit<IRedTeamCampaign, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRedTeamCampaign> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.redTeamCampaigns}
        (id, tenantId, projectId, key, name, description, targetKind, agentKey, agentVersion, modelKey,
         probeKeys, judgeModelKey, runConfig, policy, schedule, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @targetKind, @agentKey, @agentVersion, @modelKey,
         @probeKeys, @judgeModelKey, @runConfig, @policy, @schedule, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: campaign.tenantId,
        projectId: campaign.projectId ?? null,
        key: campaign.key,
        name: campaign.name,
        description: campaign.description ?? null,
        targetKind: campaign.targetKind,
        agentKey: campaign.agentKey ?? null,
        agentVersion: agentVersionToColumn(campaign.agentVersion),
        modelKey: campaign.modelKey ?? null,
        probeKeys: this.toJson(campaign.probeKeys ?? []),
        judgeModelKey: campaign.judgeModelKey ?? null,
        runConfig: this.toJson(campaign.runConfig ?? {}),
        policy: this.toJson(campaign.policy ?? {}),
        schedule: this.toJson(campaign.schedule ?? {}),
        metadata: this.toJson(campaign.metadata ?? {}),
        createdBy: campaign.createdBy,
        updatedBy: campaign.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...campaign, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateRedTeamCampaign(
      id: string,
      data: Partial<Omit<IRedTeamCampaign, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRedTeamCampaign | null> {
      if (!isId(id)) return null;
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.targetKind !== undefined) { sets.push('targetKind = @targetKind'); params.targetKind = data.targetKind; }
      if (data.agentKey !== undefined) { sets.push('agentKey = @agentKey'); params.agentKey = data.agentKey; }
      if (data.agentVersion !== undefined) { sets.push('agentVersion = @agentVersion'); params.agentVersion = agentVersionToColumn(data.agentVersion); }
      if (data.modelKey !== undefined) { sets.push('modelKey = @modelKey'); params.modelKey = data.modelKey; }
      if (data.probeKeys !== undefined) { sets.push('probeKeys = @probeKeys'); params.probeKeys = this.toJson(data.probeKeys); }
      if (data.judgeModelKey !== undefined) { sets.push('judgeModelKey = @judgeModelKey'); params.judgeModelKey = data.judgeModelKey; }
      if (data.runConfig !== undefined) { sets.push('runConfig = @runConfig'); params.runConfig = this.toJson(data.runConfig); }
      if (data.policy !== undefined) { sets.push('policy = @policy'); params.policy = this.toJson(data.policy); }
      if (data.schedule !== undefined) { sets.push('schedule = @schedule'); params.schedule = this.toJson(data.schedule); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.redTeamCampaigns} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRedTeamCampaignById(id);
    }

    async deleteRedTeamCampaign(id: string): Promise<boolean> {
      if (!isId(id)) return false;
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.redTeamCampaigns} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findRedTeamCampaignById(id: string): Promise<IRedTeamCampaign | null> {
      if (!isId(id)) return null;
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.redTeamCampaigns} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapCampaignRow(row) : null;
    }

    async findRedTeamCampaignByKey(key: string, projectId?: string): Promise<IRedTeamCampaign | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.redTeamCampaigns} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapCampaignRow(row) : null;
    }

    async listRedTeamCampaigns(filters?: { projectId?: string; targetKind?: IRedTeamCampaign['targetKind']; search?: string }): Promise<IRedTeamCampaign[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.targetKind !== undefined) { clauses.push('targetKind = @targetKind'); params.targetKind = filters.targetKind; }
      if (filters?.search) { clauses.push(this.likeAny(['name', 'description', 'key'], '@search')); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.redTeamCampaigns} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapCampaignRow(r));
    }

    // ── Runs ─────────────────────────────────────────────────────────

    async createRedTeamRun(
      run: Omit<IRedTeamRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRedTeamRun> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.redTeamRuns}
        (id, tenantId, projectId, campaignKey, targetKind, targetRef, agentRevision, status, mode, progress,
         aggregate, attempts, attemptStore, skippedAttempts, notApplicableAttempts, warnings, workerId, leaseUntil,
         cancelRequested, cancelRequestedBy, cancelledAt, error, startedAt, finishedAt, createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @campaignKey, @targetKind, @targetRef, @agentRevision, @status, @mode, @progress,
         @aggregate, @attempts, @attemptStore, @skippedAttempts, @notApplicableAttempts, @warnings, @workerId, @leaseUntil,
         @cancelRequested, @cancelRequestedBy, @cancelledAt, @error, @startedAt, @finishedAt, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: run.tenantId,
        projectId: run.projectId ?? null,
        campaignKey: run.campaignKey,
        targetKind: run.targetKind,
        targetRef: run.targetRef ?? null,
        agentRevision: run.agentRevision ? this.toJson(run.agentRevision) : null,
        status: run.status,
        mode: run.mode,
        progress: this.toJson(run.progress ?? { total: 0, completed: 0, failed: 0 }),
        aggregate: run.aggregate !== undefined ? this.toJson(run.aggregate) : null,
        attempts: this.toJson(run.attempts ?? []),
        attemptStore: run.attemptStore ?? null,
        skippedAttempts: run.skippedAttempts ?? null,
        notApplicableAttempts: run.notApplicableAttempts ?? null,
        warnings: run.warnings ? this.toJson(run.warnings) : null,
        workerId: run.workerId ?? null,
        leaseUntil: toIso(run.leaseUntil),
        cancelRequested: run.cancelRequested === undefined ? null : this.toBoolInt(run.cancelRequested),
        cancelRequestedBy: run.cancelRequestedBy ?? null,
        cancelledAt: toIso(run.cancelledAt),
        error: run.error ?? null,
        startedAt: toIso(run.startedAt),
        finishedAt: toIso(run.finishedAt),
        createdBy: run.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return { ...run, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    /** The SET clauses (and their parameters) for a partial run update; `undefined` leaves a column alone, `null` clears it. */
    protected redTeamRunSets(
      data: Partial<Omit<IRedTeamRun, 'tenantId' | 'campaignKey' | 'createdBy'>>,
    ): { sets: string[]; params: Record<string, unknown> } {
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { updatedAt: this.now() };
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.mode !== undefined) { sets.push('mode = @mode'); params.mode = data.mode; }
      if (data.targetRef !== undefined) { sets.push('targetRef = @targetRef'); params.targetRef = data.targetRef; }
      if (data.agentRevision !== undefined) { sets.push('agentRevision = @agentRevision'); params.agentRevision = data.agentRevision ? this.toJson(data.agentRevision) : null; }
      if (data.progress !== undefined) { sets.push('progress = @progress'); params.progress = this.toJson(data.progress); }
      if (data.aggregate !== undefined) { sets.push('aggregate = @aggregate'); params.aggregate = this.toJson(data.aggregate); }
      if (data.attempts !== undefined) { sets.push('attempts = @attempts'); params.attempts = this.toJson(data.attempts); }
      if (data.attemptStore !== undefined) { sets.push('attemptStore = @attemptStore'); params.attemptStore = data.attemptStore; }
      if (data.skippedAttempts !== undefined) { sets.push('skippedAttempts = @skippedAttempts'); params.skippedAttempts = data.skippedAttempts; }
      if (data.notApplicableAttempts !== undefined) { sets.push('notApplicableAttempts = @notApplicableAttempts'); params.notApplicableAttempts = data.notApplicableAttempts; }
      if (data.warnings !== undefined) { sets.push('warnings = @warnings'); params.warnings = data.warnings ? this.toJson(data.warnings) : null; }
      if (data.workerId !== undefined) { sets.push('workerId = @workerId'); params.workerId = data.workerId; }
      if (data.leaseUntil !== undefined) { sets.push('leaseUntil = @leaseUntil'); params.leaseUntil = toIso(data.leaseUntil); }
      if (data.cancelRequested !== undefined) { sets.push('cancelRequested = @cancelRequested'); params.cancelRequested = data.cancelRequested === null ? null : this.toBoolInt(data.cancelRequested); }
      if (data.cancelRequestedBy !== undefined) { sets.push('cancelRequestedBy = @cancelRequestedBy'); params.cancelRequestedBy = data.cancelRequestedBy; }
      if (data.cancelledAt !== undefined) { sets.push('cancelledAt = @cancelledAt'); params.cancelledAt = toIso(data.cancelledAt); }
      if (data.error !== undefined) { sets.push('error = @error'); params.error = data.error; }
      if (data.startedAt !== undefined) { sets.push('startedAt = @startedAt'); params.startedAt = toIso(data.startedAt); }
      if (data.finishedAt !== undefined) { sets.push('finishedAt = @finishedAt'); params.finishedAt = toIso(data.finishedAt); }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      return { sets, params };
    }

    async updateRedTeamRun(
      id: string,
      data: Partial<Omit<IRedTeamRun, 'tenantId' | 'campaignKey' | 'createdBy'>>,
    ): Promise<IRedTeamRun | null> {
      if (!isId(id)) return null;
      const db = this.getTenantDb();
      const { sets, params } = this.redTeamRunSets(data);
      db.prepare(`UPDATE ${TABLES.redTeamRuns} SET ${sets.join(', ')} WHERE id = @id`).run({ ...params, id });
      return this.findRedTeamRunById(id);
    }

    async updateRedTeamRunIf(
      id: string,
      guard: IRedTeamRunGuard,
      data: Partial<Omit<IRedTeamRun, 'tenantId' | 'campaignKey' | 'createdBy'>>,
    ): Promise<IRedTeamRun | null> {
      if (!isId(id)) return null;
      const db = this.getTenantDb();
      const { sets, params } = this.redTeamRunSets(data);
      const where: string[] = ['id = @id'];
      const bind: Record<string, unknown> = { ...params, id };
      if (guard.status !== undefined) {
        const statuses = Array.isArray(guard.status) ? guard.status : [guard.status];
        // An empty list matches nothing (MongoDB's $in: [] does the same); `IN ()` would be a syntax error.
        if (statuses.length === 0) return null;
        const names = statuses.map((_, i) => `@guardStatus${i}`);
        statuses.forEach((status, i) => { bind[`guardStatus${i}`] = status; });
        where.push(`status IN (${names.join(', ')})`);
      }
      if (guard.workerId !== undefined) { where.push('workerId = @guardWorkerId'); bind.guardWorkerId = guard.workerId; }
      if (guard.updatedAt !== undefined) {
        // Compared as the ISO string the mixin wrote; an unparseable instant matches nothing.
        const iso = toIso(guard.updatedAt);
        if (!iso) return null;
        where.push('updatedAt = @guardUpdatedAt');
        bind.guardUpdatedAt = iso;
      }
      // One UPDATE is the whole compare-and-set: it changes a row only while every guard still holds.
      const result = db.prepare(`UPDATE ${TABLES.redTeamRuns} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(bind);
      if (result.changes === 0) return null;
      return this.findRedTeamRunById(id);
    }

    async findRedTeamRunById(id: string): Promise<IRedTeamRun | null> {
      if (!isId(id)) return null;
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.redTeamRuns} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapRedTeamRunRow(row) : null;
    }

    protected redTeamRunWhere(filters?: {
      projectId?: string;
      campaignKey?: string;
      status?: RedTeamRunStatus | RedTeamRunStatus[];
    }): { where: string; params: Record<string, unknown> } {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.campaignKey !== undefined) { clauses.push('campaignKey = @campaignKey'); params.campaignKey = filters.campaignKey; }
      if (filters?.status !== undefined) {
        const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
        if (statuses.length === 0) {
          clauses.push('0 = 1');
        } else {
          const names = statuses.map((_, i) => `@status${i}`);
          statuses.forEach((status, i) => { params[`status${i}`] = status; });
          clauses.push(`status IN (${names.join(', ')})`);
        }
      }
      return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
    }

    async listRedTeamRuns(filters?: {
      projectId?: string;
      campaignKey?: string;
      status?: RedTeamRunStatus | RedTeamRunStatus[];
      limit?: number;
      skip?: number;
      omitAttempts?: boolean;
    }): Promise<IRedTeamRun[]> {
      const db = this.getTenantDb();
      const { where, params } = this.redTeamRunWhere(filters);
      const columns = filters?.omitAttempts ? RUN_COLUMNS_WITHOUT_ATTEMPTS : '*';
      const rows = db.prepare(
        `SELECT ${columns} FROM ${TABLES.redTeamRuns} ${where} ORDER BY createdAt DESC, id DESC LIMIT @limit OFFSET @skip`,
      ).all({
        ...params,
        limit: clampInt(filters?.limit, 50, 1, 200),
        skip: clampInt(filters?.skip, 0, 0, Number.MAX_SAFE_INTEGER),
      }) as SqliteRow[];
      return rows.map((r) => this.mapRedTeamRunRow(r));
    }

    async countRedTeamRuns(filters?: {
      projectId?: string;
      campaignKey?: string;
      status?: RedTeamRunStatus | RedTeamRunStatus[];
    }): Promise<number> {
      const db = this.getTenantDb();
      const { where, params } = this.redTeamRunWhere(filters);
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLES.redTeamRuns} ${where}`).get(params) as { n: number } | undefined;
      return row?.n ?? 0;
    }

    async listStaleRedTeamRuns(params: {
      leaseExpiredBefore: Date;
      legacyUpdatedBefore: Date;
      pendingCreatedBefore: Date;
      limit?: number;
    }): Promise<IRedTeamRun[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`
        SELECT ${RUN_COLUMNS_WITHOUT_ATTEMPTS} FROM ${TABLES.redTeamRuns}
        WHERE (status = 'running' AND leaseUntil IS NOT NULL AND leaseUntil < @leaseExpiredBefore)
           OR (status = 'running' AND leaseUntil IS NULL AND updatedAt < @legacyUpdatedBefore)
           OR (status = 'pending' AND createdAt < @pendingCreatedBefore)
        ORDER BY createdAt ASC, id ASC
        LIMIT @limit
      `).all({
        leaseExpiredBefore: params.leaseExpiredBefore.toISOString(),
        legacyUpdatedBefore: params.legacyUpdatedBefore.toISOString(),
        pendingCreatedBefore: params.pendingCreatedBefore.toISOString(),
        limit: clampInt(params.limit, 50, 1, 200),
      }) as SqliteRow[];
      return rows.map((r) => this.mapRedTeamRunRow(r));
    }

    async deleteRedTeamRun(id: string): Promise<boolean> {
      if (!isId(id)) return false;
      const db = this.getTenantDb();
      const remove = db.transaction((): boolean => {
        const changes = db.prepare(`DELETE FROM ${TABLES.redTeamRuns} WHERE id = @id`).run({ id }).changes;
        db.prepare(`DELETE FROM ${TABLES.redTeamRunAttempts} WHERE runId = @id`).run({ id });
        return changes === 1;
      });
      return remove();
    }

    // ── Run attempts ─────────────────────────────────────────────────

    async upsertRedTeamRunAttempts(
      rows: Array<Omit<IRedTeamRunAttempt, '_id' | 'createdAt' | 'updatedAt'>>,
    ): Promise<void> {
      if (rows.length === 0) return;
      const db = this.getTenantDb();
      // Every column but `review` and `createdAt` is replaced on conflict: a review is set when the row is inserted
      // (a legacy embedded review) and changed afterwards only by setRedTeamRunAttemptReview.
      const statement = db.prepare(`
        INSERT INTO ${TABLES.redTeamRunAttempts}
        (id, tenantId, projectId, runId, attemptKey, seq, probeKey, attemptId, family, category, severity, outcome,
         decidedBy, confidence, transcript, signals, latencyMs, error, partial, review, kbRestricted, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @runId, @attemptKey, @seq, @probeKey, @attemptId, @family, @category, @severity, @outcome,
         @decidedBy, @confidence, @transcript, @signals, @latencyMs, @error, @partial, @review, @kbRestricted, @createdAt, @updatedAt)
        ON CONFLICT(runId, attemptKey) DO UPDATE SET
          tenantId = excluded.tenantId,
          projectId = excluded.projectId,
          seq = excluded.seq,
          probeKey = excluded.probeKey,
          attemptId = excluded.attemptId,
          family = excluded.family,
          category = excluded.category,
          severity = excluded.severity,
          outcome = excluded.outcome,
          decidedBy = excluded.decidedBy,
          confidence = excluded.confidence,
          transcript = excluded.transcript,
          signals = excluded.signals,
          latencyMs = excluded.latencyMs,
          error = excluded.error,
          partial = excluded.partial,
          kbRestricted = excluded.kbRestricted,
          updatedAt = excluded.updatedAt
      `);
      const now = this.now();
      const write = db.transaction((batch: typeof rows) => {
        for (const row of batch) {
          statement.run({
            id: this.newId(),
            tenantId: row.tenantId,
            projectId: row.projectId ?? null,
            runId: String(row.runId),
            attemptKey: row.attemptKey,
            seq: row.seq ?? 0,
            probeKey: row.probeKey,
            attemptId: row.attemptId,
            family: row.family ?? null,
            category: row.category ?? null,
            severity: row.severity ?? null,
            outcome: row.outcome,
            decidedBy: row.decidedBy ?? null,
            confidence: row.confidence ?? null,
            transcript: this.toJson(row.transcript ?? []),
            signals: this.toJson(row.signals ?? []),
            latencyMs: row.latencyMs ?? null,
            error: row.error ?? null,
            partial: row.partial === undefined ? null : this.toBoolInt(row.partial),
            review: row.review ? this.toJson(row.review) : null,
            kbRestricted: row.kbRestricted ? this.toJson(row.kbRestricted) : null,
            createdAt: now,
            updatedAt: now,
          });
        }
      });
      write(rows);
    }

    async listRedTeamRunAttempts(
      runId: string,
      opts?: { limit?: number; skip?: number },
    ): Promise<IRedTeamRunAttempt[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.redTeamRunAttempts} WHERE runId = @runId ORDER BY seq ASC, id ASC LIMIT @limit OFFSET @skip`,
      ).all({
        runId: String(runId),
        limit: clampInt(opts?.limit, 1000, 1, 1000),
        skip: clampInt(opts?.skip, 0, 0, Number.MAX_SAFE_INTEGER),
      }) as SqliteRow[];
      return rows.map((r) => this.mapRedTeamRunAttemptRow(r));
    }

    async countRedTeamRunAttempts(runId: string): Promise<number> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLES.redTeamRunAttempts} WHERE runId = @runId`).get({ runId: String(runId) }) as { n: number } | undefined;
      return row?.n ?? 0;
    }

    async findRedTeamRunAttempt(runId: string, attemptKey: string): Promise<IRedTeamRunAttempt | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.redTeamRunAttempts} WHERE runId = @runId AND attemptKey = @attemptKey`,
      ).get({ runId: String(runId), attemptKey }) as SqliteRow | undefined;
      return row ? this.mapRedTeamRunAttemptRow(row) : null;
    }

    async setRedTeamRunAttemptReview(
      runId: string,
      attemptKey: string,
      review: IRedTeamReview | null,
    ): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(
        `UPDATE ${TABLES.redTeamRunAttempts} SET review = @review, updatedAt = @updatedAt WHERE runId = @runId AND attemptKey = @attemptKey`,
      ).run({
        review: review ? this.toJson(review) : null,
        updatedAt: this.now(),
        runId: String(runId),
        attemptKey,
      });
      return result.changes === 1;
    }

    async deleteRedTeamRunAttempts(runId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.redTeamRunAttempts} WHERE runId = @runId`).run({ runId: String(runId) }).changes;
    }

    // ── Custom probes ────────────────────────────────────────────────

    async createRedTeamCustomProbe(
      probe: Omit<IRedTeamCustomProbe, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRedTeamCustomProbe> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.redTeamCustomProbes}
        (id, tenantId, projectId, key, name, description, family, category, severity,
         attempts, detectors, enabled, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @family, @category, @severity,
         @attempts, @detectors, @enabled, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: probe.tenantId,
        projectId: probe.projectId ?? null,
        key: probe.key,
        name: probe.name,
        description: probe.description ?? null,
        family: probe.family,
        category: probe.category,
        severity: probe.severity,
        attempts: this.toJson(probe.attempts ?? []),
        detectors: this.toJson(probe.detectors ?? {}),
        enabled: probe.enabled === false ? 0 : 1,
        createdBy: probe.createdBy,
        updatedBy: probe.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...probe, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateRedTeamCustomProbe(
      id: string,
      data: Partial<Omit<IRedTeamCustomProbe, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRedTeamCustomProbe | null> {
      if (!isId(id)) return null;
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.family !== undefined) { sets.push('family = @family'); params.family = data.family; }
      if (data.category !== undefined) { sets.push('category = @category'); params.category = data.category; }
      if (data.severity !== undefined) { sets.push('severity = @severity'); params.severity = data.severity; }
      if (data.attempts !== undefined) { sets.push('attempts = @attempts'); params.attempts = this.toJson(data.attempts); }
      if (data.detectors !== undefined) { sets.push('detectors = @detectors'); params.detectors = this.toJson(data.detectors); }
      if (data.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = data.enabled ? 1 : 0; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.redTeamCustomProbes} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRedTeamCustomProbeById(id);
    }

    async deleteRedTeamCustomProbe(id: string): Promise<boolean> {
      if (!isId(id)) return false;
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.redTeamCustomProbes} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findRedTeamCustomProbeById(id: string): Promise<IRedTeamCustomProbe | null> {
      if (!isId(id)) return null;
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.redTeamCustomProbes} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapCustomProbeRow(row) : null;
    }

    async findRedTeamCustomProbeByKey(key: string, projectId?: string): Promise<IRedTeamCustomProbe | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.redTeamCustomProbes} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapCustomProbeRow(row) : null;
    }

    async listRedTeamCustomProbes(filters?: { projectId?: string; search?: string }): Promise<IRedTeamCustomProbe[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.search) { clauses.push(this.likeAny(['name', 'description', 'key'], '@search')); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.redTeamCustomProbes} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapCustomProbeRow(r));
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapCustomProbeRow(r: SqliteRow): IRedTeamCustomProbe {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? '',
        family: r.family as string,
        category: r.category as string,
        severity: r.severity as IRedTeamCustomProbe['severity'],
        attempts: this.parseJson<IRedTeamCustomAttempt[]>(r.attempts, []),
        detectors: this.parseJson<IRedTeamCustomDetectors>(r.detectors, {}),
        enabled: (r.enabled as number) !== 0,
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapCampaignRow(r: SqliteRow): IRedTeamCampaign {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? undefined,
        targetKind: r.targetKind as IRedTeamCampaign['targetKind'],
        agentKey: (r.agentKey as string | null) ?? undefined,
        agentVersion: agentVersionFromColumn(r.agentVersion),
        modelKey: (r.modelKey as string | null) ?? undefined,
        probeKeys: this.parseJson<string[]>(r.probeKeys, []),
        judgeModelKey: (r.judgeModelKey as string | null) ?? undefined,
        runConfig: this.parseJson(r.runConfig, {}),
        policy: this.parseJson(r.policy, {}),
        schedule: this.parseJson<IRedTeamCampaign['schedule']>(r.schedule, undefined),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapRedTeamRunRow(r: SqliteRow): IRedTeamRun {
      const aggregate = this.parseJson<IRedTeamAggregate | null>(r.aggregate, null);
      const warnings = this.parseJson<string[] | null>(r.warnings, null);
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        campaignKey: r.campaignKey as string,
        targetKind: r.targetKind as IRedTeamRun['targetKind'],
        targetRef: (r.targetRef as string | null) ?? '',
        agentRevision: agentRevisionFromColumn(r.agentRevision),
        status: r.status as RedTeamRunStatus,
        mode: r.mode as IRedTeamRun['mode'],
        progress: this.parseJson(r.progress, { total: 0, completed: 0, failed: 0 }),
        aggregate: aggregate ?? undefined,
        // A list read that left the column out gets [] (parseJson's fallback for undefined).
        attempts: this.parseJson<IRedTeamAttemptResult[]>(r.attempts, []),
        attemptStore: (r.attemptStore as IRedTeamRun['attemptStore'] | null) ?? undefined,
        skippedAttempts: (r.skippedAttempts as number | null) ?? undefined,
        notApplicableAttempts: (r.notApplicableAttempts as number | null) ?? undefined,
        warnings: warnings ?? undefined,
        workerId: (r.workerId as string | null) ?? undefined,
        leaseUntil: this.toDate(r.leaseUntil),
        cancelRequested: r.cancelRequested === null || r.cancelRequested === undefined ? undefined : this.fromBoolInt(r.cancelRequested),
        cancelRequestedBy: (r.cancelRequestedBy as string | null) ?? undefined,
        cancelledAt: this.toDate(r.cancelledAt),
        error: (r.error as string | null) ?? undefined,
        startedAt: this.toDate(r.startedAt),
        finishedAt: this.toDate(r.finishedAt),
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapRedTeamRunAttemptRow(r: SqliteRow): IRedTeamRunAttempt {
      const review = this.parseJson<(Omit<IRedTeamReview, 'reviewedAt'> & { reviewedAt: string | Date }) | null>(r.review, null);
      const kbRestricted = this.parseJson<string[] | null>(r.kbRestricted, null);
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        runId: r.runId as string,
        attemptKey: r.attemptKey as string,
        seq: (r.seq as number) ?? 0,
        probeKey: r.probeKey as string,
        attemptId: r.attemptId as string,
        family: r.family as string,
        category: r.category as string,
        severity: r.severity as IRedTeamRunAttempt['severity'],
        outcome: r.outcome as IRedTeamRunAttempt['outcome'],
        decidedBy: r.decidedBy as string,
        confidence: (r.confidence as number) ?? 0,
        transcript: this.parseJson(r.transcript, []),
        signals: this.parseJson(r.signals, []),
        latencyMs: (r.latencyMs as number | null) ?? undefined,
        error: (r.error as string | null) ?? undefined,
        partial: r.partial === null || r.partial === undefined ? undefined : this.fromBoolInt(r.partial),
        // Reviews are stored as JSON, so the date comes back as a string.
        review: review ? { ...review, reviewedAt: new Date(review.reviewedAt) } : undefined,
        kbRestricted: kbRestricted ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
