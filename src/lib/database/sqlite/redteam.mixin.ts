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
  IRedTeamAttemptResult,
  IRedTeamAggregate,
  RedTeamRunStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
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
        (id, tenantId, projectId, key, name, description, targetKind, agentKey, modelKey,
         probeKeys, judgeModelKey, runConfig, policy, schedule, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @targetKind, @agentKey, @modelKey,
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
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.targetKind !== undefined) { sets.push('targetKind = @targetKind'); params.targetKind = data.targetKind; }
      if (data.agentKey !== undefined) { sets.push('agentKey = @agentKey'); params.agentKey = data.agentKey; }
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
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.redTeamCampaigns} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findRedTeamCampaignById(id: string): Promise<IRedTeamCampaign | null> {
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
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
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
        (id, tenantId, projectId, campaignKey, targetKind, targetRef, status, mode, progress,
         aggregate, attempts, error, startedAt, finishedAt, createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @campaignKey, @targetKind, @targetRef, @status, @mode, @progress,
         @aggregate, @attempts, @error, @startedAt, @finishedAt, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: run.tenantId,
        projectId: run.projectId ?? null,
        campaignKey: run.campaignKey,
        targetKind: run.targetKind,
        targetRef: run.targetRef ?? null,
        status: run.status,
        mode: run.mode,
        progress: this.toJson(run.progress ?? { total: 0, completed: 0, failed: 0 }),
        aggregate: run.aggregate !== undefined ? this.toJson(run.aggregate) : null,
        attempts: this.toJson(run.attempts ?? []),
        error: run.error ?? null,
        startedAt: toIso(run.startedAt),
        finishedAt: toIso(run.finishedAt),
        createdBy: run.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return { ...run, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateRedTeamRun(
      id: string,
      data: Partial<Omit<IRedTeamRun, 'tenantId' | 'campaignKey' | 'createdBy'>>,
    ): Promise<IRedTeamRun | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.mode !== undefined) { sets.push('mode = @mode'); params.mode = data.mode; }
      if (data.targetRef !== undefined) { sets.push('targetRef = @targetRef'); params.targetRef = data.targetRef; }
      if (data.progress !== undefined) { sets.push('progress = @progress'); params.progress = this.toJson(data.progress); }
      if (data.aggregate !== undefined) { sets.push('aggregate = @aggregate'); params.aggregate = this.toJson(data.aggregate); }
      if (data.attempts !== undefined) { sets.push('attempts = @attempts'); params.attempts = this.toJson(data.attempts); }
      if (data.error !== undefined) { sets.push('error = @error'); params.error = data.error; }
      if (data.startedAt !== undefined) { sets.push('startedAt = @startedAt'); params.startedAt = toIso(data.startedAt); }
      if (data.finishedAt !== undefined) { sets.push('finishedAt = @finishedAt'); params.finishedAt = toIso(data.finishedAt); }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.redTeamRuns} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRedTeamRunById(id);
    }

    async findRedTeamRunById(id: string): Promise<IRedTeamRun | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.redTeamRuns} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapRedTeamRunRow(row) : null;
    }

    async listRedTeamRuns(filters?: { projectId?: string; campaignKey?: string; status?: RedTeamRunStatus; limit?: number; skip?: number }): Promise<IRedTeamRun[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.campaignKey !== undefined) { clauses.push('campaignKey = @campaignKey'); params.campaignKey = filters.campaignKey; }
      if (filters?.status !== undefined) { clauses.push('status = @status'); params.status = filters.status; }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters?.limit ?? 50;
      const skip = filters?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.redTeamRuns} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapRedTeamRunRow(r));
    }

    // ── Row mappers ──────────────────────────────────────────────────

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
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        campaignKey: r.campaignKey as string,
        targetKind: r.targetKind as IRedTeamRun['targetKind'],
        targetRef: (r.targetRef as string | null) ?? '',
        status: r.status as RedTeamRunStatus,
        mode: r.mode as IRedTeamRun['mode'],
        progress: this.parseJson(r.progress, { total: 0, completed: 0, failed: 0 }),
        aggregate: aggregate ?? undefined,
        attempts: this.parseJson<IRedTeamAttemptResult[]>(r.attempts, []),
        error: (r.error as string | null) ?? undefined,
        startedAt: this.toDate(r.startedAt),
        finishedAt: this.toDate(r.finishedAt),
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
