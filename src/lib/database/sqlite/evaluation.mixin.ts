/**
 * SQLite Provider – Evaluation operations mixin
 *
 * CRUD for evaluation targets, datasets (items embedded as JSON), suites, and
 * runs (result items + aggregate embedded as JSON). Mirrors the guardrail
 * mixin conventions (prepared statements, JSON columns, row mappers).
 */

import type {
  IEvaluationTarget,
  IEvaluationDataset,
  IEvaluationDatasetItem,
  IEvaluationSuite,
  IEvaluationScorerConfig,
  IEvaluationRun,
  IEvaluationRunItem,
  IEvaluationRunAggregate,
  EvaluationTargetKind,
  EvaluationDatasetSource,
  EvaluationRunStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function EvaluationMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class EvaluationOps extends Base {
    // ── Targets ──────────────────────────────────────────────────────

    async createEvaluationTarget(
      target: Omit<IEvaluationTarget, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationTarget> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.evaluationTargets}
        (id, tenantId, projectId, key, name, description, kind, agentKey, modelKey,
         external, defaultParams, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @kind, @agentKey, @modelKey,
         @external, @defaultParams, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: target.tenantId,
        projectId: target.projectId ?? null,
        key: target.key,
        name: target.name,
        description: target.description ?? null,
        kind: target.kind,
        agentKey: target.agentKey ?? null,
        modelKey: target.modelKey ?? null,
        external: target.external ? this.toJson(target.external) : null,
        defaultParams: this.toJson(target.defaultParams ?? {}),
        metadata: this.toJson(target.metadata ?? {}),
        createdBy: target.createdBy,
        updatedBy: target.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...target, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateEvaluationTarget(
      id: string,
      data: Partial<Omit<IEvaluationTarget, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.kind !== undefined) { sets.push('kind = @kind'); params.kind = data.kind; }
      if (data.agentKey !== undefined) { sets.push('agentKey = @agentKey'); params.agentKey = data.agentKey; }
      if (data.modelKey !== undefined) { sets.push('modelKey = @modelKey'); params.modelKey = data.modelKey; }
      if (data.external !== undefined) { sets.push('external = @external'); params.external = data.external ? this.toJson(data.external) : null; }
      if (data.defaultParams !== undefined) { sets.push('defaultParams = @defaultParams'); params.defaultParams = this.toJson(data.defaultParams); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.evaluationTargets} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findEvaluationTargetById(id);
    }

    async deleteEvaluationTarget(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.evaluationTargets} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findEvaluationTargetById(id: string): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationTargets} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapTargetRow(row) : null;
    }

    async findEvaluationTargetByKey(key: string, projectId?: string): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationTargets} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapTargetRow(row) : null;
    }

    async listEvaluationTargets(filters?: { projectId?: string; kind?: EvaluationTargetKind; search?: string }): Promise<IEvaluationTarget[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.kind !== undefined) { clauses.push('kind = @kind'); params.kind = filters.kind; }
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.evaluationTargets} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapTargetRow(r));
    }

    // ── Datasets ─────────────────────────────────────────────────────

    async createEvaluationDataset(
      dataset: Omit<IEvaluationDataset, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationDataset> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.evaluationDatasets}
        (id, tenantId, projectId, key, name, description, source, items, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @source, @items, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: dataset.tenantId,
        projectId: dataset.projectId ?? null,
        key: dataset.key,
        name: dataset.name,
        description: dataset.description ?? null,
        source: dataset.source,
        items: this.toJson(dataset.items ?? []),
        metadata: this.toJson(dataset.metadata ?? {}),
        createdBy: dataset.createdBy,
        updatedBy: dataset.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...dataset, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateEvaluationDataset(
      id: string,
      data: Partial<Omit<IEvaluationDataset, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.source !== undefined) { sets.push('source = @source'); params.source = data.source; }
      if (data.items !== undefined) { sets.push('items = @items'); params.items = this.toJson(data.items); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.evaluationDatasets} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findEvaluationDatasetById(id);
    }

    async deleteEvaluationDataset(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.evaluationDatasets} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findEvaluationDatasetById(id: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationDatasets} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapDatasetRow(row) : null;
    }

    async findEvaluationDatasetByKey(key: string, projectId?: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationDatasets} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapDatasetRow(row) : null;
    }

    async listEvaluationDatasets(filters?: { projectId?: string; source?: EvaluationDatasetSource; search?: string }): Promise<IEvaluationDataset[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.source !== undefined) { clauses.push('source = @source'); params.source = filters.source; }
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.evaluationDatasets} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapDatasetRow(r));
    }

    // ── Suites ───────────────────────────────────────────────────────

    async createEvaluationSuite(
      suite: Omit<IEvaluationSuite, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationSuite> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.evaluationSuites}
        (id, tenantId, projectId, key, name, description, targetKey, datasetKey, scorers,
         judgeModelKey, runConfig, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @targetKey, @datasetKey, @scorers,
         @judgeModelKey, @runConfig, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: suite.tenantId,
        projectId: suite.projectId ?? null,
        key: suite.key,
        name: suite.name,
        description: suite.description ?? null,
        targetKey: suite.targetKey,
        datasetKey: suite.datasetKey,
        scorers: this.toJson(suite.scorers ?? []),
        judgeModelKey: suite.judgeModelKey ?? null,
        runConfig: this.toJson(suite.runConfig ?? {}),
        metadata: this.toJson(suite.metadata ?? {}),
        createdBy: suite.createdBy,
        updatedBy: suite.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...suite, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateEvaluationSuite(
      id: string,
      data: Partial<Omit<IEvaluationSuite, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.targetKey !== undefined) { sets.push('targetKey = @targetKey'); params.targetKey = data.targetKey; }
      if (data.datasetKey !== undefined) { sets.push('datasetKey = @datasetKey'); params.datasetKey = data.datasetKey; }
      if (data.scorers !== undefined) { sets.push('scorers = @scorers'); params.scorers = this.toJson(data.scorers); }
      if (data.judgeModelKey !== undefined) { sets.push('judgeModelKey = @judgeModelKey'); params.judgeModelKey = data.judgeModelKey; }
      if (data.runConfig !== undefined) { sets.push('runConfig = @runConfig'); params.runConfig = this.toJson(data.runConfig); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.evaluationSuites} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findEvaluationSuiteById(id);
    }

    async deleteEvaluationSuite(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.evaluationSuites} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findEvaluationSuiteById(id: string): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationSuites} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapSuiteRow(row) : null;
    }

    async findEvaluationSuiteByKey(key: string, projectId?: string): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationSuites} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapSuiteRow(row) : null;
    }

    async listEvaluationSuites(filters?: { projectId?: string; targetKey?: string; datasetKey?: string; search?: string }): Promise<IEvaluationSuite[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.targetKey !== undefined) { clauses.push('targetKey = @targetKey'); params.targetKey = filters.targetKey; }
      if (filters?.datasetKey !== undefined) { clauses.push('datasetKey = @datasetKey'); params.datasetKey = filters.datasetKey; }
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.evaluationSuites} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapSuiteRow(r));
    }

    // ── Runs ─────────────────────────────────────────────────────────

    async createEvaluationRun(
      run: Omit<IEvaluationRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationRun> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.evaluationRuns}
        (id, tenantId, projectId, suiteKey, targetKey, datasetKey, status, mode, progress,
         aggregate, items, error, startedAt, finishedAt, createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @suiteKey, @targetKey, @datasetKey, @status, @mode, @progress,
         @aggregate, @items, @error, @startedAt, @finishedAt, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: run.tenantId,
        projectId: run.projectId ?? null,
        suiteKey: run.suiteKey,
        targetKey: run.targetKey,
        datasetKey: run.datasetKey,
        status: run.status,
        mode: run.mode,
        progress: this.toJson(run.progress ?? { total: 0, completed: 0, failed: 0 }),
        aggregate: run.aggregate !== undefined ? this.toJson(run.aggregate) : null,
        items: this.toJson(run.items ?? []),
        error: run.error ?? null,
        startedAt: toIso(run.startedAt),
        finishedAt: toIso(run.finishedAt),
        createdBy: run.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return { ...run, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateEvaluationRun(
      id: string,
      data: Partial<Omit<IEvaluationRun, 'tenantId' | 'suiteKey' | 'createdBy'>>,
    ): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.mode !== undefined) { sets.push('mode = @mode'); params.mode = data.mode; }
      if (data.progress !== undefined) { sets.push('progress = @progress'); params.progress = this.toJson(data.progress); }
      if (data.aggregate !== undefined) { sets.push('aggregate = @aggregate'); params.aggregate = this.toJson(data.aggregate); }
      if (data.items !== undefined) { sets.push('items = @items'); params.items = this.toJson(data.items); }
      if (data.error !== undefined) { sets.push('error = @error'); params.error = data.error; }
      if (data.startedAt !== undefined) { sets.push('startedAt = @startedAt'); params.startedAt = toIso(data.startedAt); }
      if (data.finishedAt !== undefined) { sets.push('finishedAt = @finishedAt'); params.finishedAt = toIso(data.finishedAt); }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.evaluationRuns} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findEvaluationRunById(id);
    }

    async findEvaluationRunById(id: string): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationRuns} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapEvaluationRunRow(row) : null;
    }

    async listEvaluationRuns(filters?: { projectId?: string; suiteKey?: string; status?: EvaluationRunStatus; limit?: number; skip?: number }): Promise<IEvaluationRun[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.suiteKey !== undefined) { clauses.push('suiteKey = @suiteKey'); params.suiteKey = filters.suiteKey; }
      if (filters?.status !== undefined) { clauses.push('status = @status'); params.status = filters.status; }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters?.limit ?? 50;
      const skip = filters?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.evaluationRuns} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapEvaluationRunRow(r));
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapTargetRow(r: SqliteRow): IEvaluationTarget {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? undefined,
        kind: r.kind as EvaluationTargetKind,
        agentKey: (r.agentKey as string | null) ?? undefined,
        modelKey: (r.modelKey as string | null) ?? undefined,
        external: this.parseJson(r.external, undefined as IEvaluationTarget['external']),
        defaultParams: this.parseJson(r.defaultParams, {}),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapDatasetRow(r: SqliteRow): IEvaluationDataset {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? undefined,
        source: r.source as EvaluationDatasetSource,
        items: this.parseJson<IEvaluationDatasetItem[]>(r.items, []),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapSuiteRow(r: SqliteRow): IEvaluationSuite {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? undefined,
        targetKey: r.targetKey as string,
        datasetKey: r.datasetKey as string,
        scorers: this.parseJson<IEvaluationScorerConfig[]>(r.scorers, []),
        judgeModelKey: (r.judgeModelKey as string | null) ?? undefined,
        runConfig: this.parseJson(r.runConfig, {}),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapEvaluationRunRow(r: SqliteRow): IEvaluationRun {
      const aggregate = this.parseJson<IEvaluationRunAggregate | null>(r.aggregate, null);
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        suiteKey: r.suiteKey as string,
        targetKey: r.targetKey as string,
        datasetKey: r.datasetKey as string,
        status: r.status as EvaluationRunStatus,
        mode: r.mode as IEvaluationRun['mode'],
        progress: this.parseJson(r.progress, { total: 0, completed: 0, failed: 0 }),
        aggregate: aggregate ?? undefined,
        items: this.parseJson<IEvaluationRunItem[]>(r.items, []),
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
