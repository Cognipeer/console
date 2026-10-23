/**
 * SQLite Provider – Analysis operations mixin
 *
 * CRUD for analysis definitions, conversations, and runs (nested structures
 * embedded as JSON). Mirrors the evaluation mixin conventions (prepared
 * statements, JSON columns, row mappers).
 */

import type {
  IAnalysisDefinition,
  IAnalysisFieldDef,
  IAnalysisModes,
  IAnalysisSource,
  IAnalysisReviewSettings,
  IAnalysisConversation,
  IAnalysisTranscriptMessage,
  IAnalysisRun,
  IAnalysisItemResult,
  IAnalysisRunAggregate,
  IAnalysisRunTarget,
  AnalysisConversationSource,
  AnalysisRunStatus,
  IAnalysisResult,
  IAnalysisResultReview,
  IAnalysisDecision,
  AnalysisResultFilter,
  AnalysisResultSourceKind,
  AnalysisReviewReason,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function AnalysisMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AnalysisOps extends Base {
    // ── Definitions ──────────────────────────────────────────────────

    async createAnalysisDefinition(
      definition: Omit<IAnalysisDefinition, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAnalysisDefinition> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.analysisDefinitions}
        (id, tenantId, projectId, key, name, description, fieldSet, extractionInstructions,
         modes, extractionModelKey, judgeModelKey, decisionModelKey, source, review, runConfig, schedule, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @fieldSet, @extractionInstructions,
         @modes, @extractionModelKey, @judgeModelKey, @decisionModelKey, @source, @review, @runConfig, @schedule, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: definition.tenantId,
        projectId: definition.projectId ?? null,
        key: definition.key,
        name: definition.name,
        description: definition.description ?? null,
        fieldSet: this.toJson(definition.fieldSet ?? []),
        extractionInstructions: definition.extractionInstructions ?? null,
        modes: this.toJson(definition.modes ?? {}),
        extractionModelKey: definition.extractionModelKey ?? null,
        judgeModelKey: definition.judgeModelKey ?? null,
        decisionModelKey: definition.decisionModelKey ?? null,
        source: definition.source ? this.toJson(definition.source) : null,
        review: definition.review ? this.toJson(definition.review) : null,
        runConfig: this.toJson(definition.runConfig ?? {}),
        schedule: definition.schedule ? this.toJson(definition.schedule) : null,
        metadata: this.toJson(definition.metadata ?? {}),
        createdBy: definition.createdBy,
        updatedBy: definition.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...definition, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateAnalysisDefinition(
      id: string,
      data: Partial<Omit<IAnalysisDefinition, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IAnalysisDefinition | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.fieldSet !== undefined) { sets.push('fieldSet = @fieldSet'); params.fieldSet = this.toJson(data.fieldSet); }
      if (data.extractionInstructions !== undefined) { sets.push('extractionInstructions = @extractionInstructions'); params.extractionInstructions = data.extractionInstructions; }
      if (data.modes !== undefined) { sets.push('modes = @modes'); params.modes = this.toJson(data.modes); }
      if (data.extractionModelKey !== undefined) { sets.push('extractionModelKey = @extractionModelKey'); params.extractionModelKey = data.extractionModelKey; }
      if (data.judgeModelKey !== undefined) { sets.push('judgeModelKey = @judgeModelKey'); params.judgeModelKey = data.judgeModelKey; }
      // A present-but-undefined key clears the decision model, as the Mongo $set does.
      if ('decisionModelKey' in data) { sets.push('decisionModelKey = @decisionModelKey'); params.decisionModelKey = data.decisionModelKey || null; }
      if (data.source !== undefined) { sets.push('source = @source'); params.source = data.source ? this.toJson(data.source) : null; }
      if (data.review !== undefined) { sets.push('review = @review'); params.review = data.review ? this.toJson(data.review) : null; }
      if (data.runConfig !== undefined) { sets.push('runConfig = @runConfig'); params.runConfig = this.toJson(data.runConfig); }
      if (data.schedule !== undefined) { sets.push('schedule = @schedule'); params.schedule = data.schedule ? this.toJson(data.schedule) : null; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.analysisDefinitions} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findAnalysisDefinitionById(id);
    }

    async deleteAnalysisDefinition(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.analysisDefinitions} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findAnalysisDefinitionById(id: string): Promise<IAnalysisDefinition | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.analysisDefinitions} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAnalysisDefinitionRow(row) : null;
    }

    async findAnalysisDefinitionByKey(key: string, projectId?: string): Promise<IAnalysisDefinition | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.analysisDefinitions} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapAnalysisDefinitionRow(row) : null;
    }

    async listAnalysisDefinitions(filters?: { projectId?: string; search?: string }): Promise<IAnalysisDefinition[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.search) { clauses.push(this.likeAny(['name', 'description', 'key'], '@search')); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.analysisDefinitions} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapAnalysisDefinitionRow(r));
    }

    // ── Conversations ────────────────────────────────────────────────

    async createAnalysisConversation(
      conversation: Omit<IAnalysisConversation, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAnalysisConversation> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.analysisConversations}
        (id, tenantId, projectId, key, name, description, transcript, source, tags, metadata,
         occurredAt, referenceFields, extractedFields, lastAnalyzedAt, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @transcript, @source, @tags, @metadata,
         @occurredAt, @referenceFields, @extractedFields, @lastAnalyzedAt, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: conversation.tenantId,
        projectId: conversation.projectId ?? null,
        key: conversation.key,
        name: conversation.name ?? null,
        description: conversation.description ?? null,
        transcript: this.toJson(conversation.transcript ?? []),
        source: conversation.source,
        tags: this.toJson(conversation.tags ?? []),
        metadata: this.toJson(conversation.metadata ?? {}),
        occurredAt: toIso(conversation.occurredAt),
        referenceFields: conversation.referenceFields !== undefined ? this.toJson(conversation.referenceFields) : null,
        extractedFields: conversation.extractedFields !== undefined ? this.toJson(conversation.extractedFields) : null,
        lastAnalyzedAt: toIso(conversation.lastAnalyzedAt),
        createdBy: conversation.createdBy,
        updatedBy: conversation.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...conversation, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateAnalysisConversation(
      id: string,
      data: Partial<Omit<IAnalysisConversation, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IAnalysisConversation | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.transcript !== undefined) { sets.push('transcript = @transcript'); params.transcript = this.toJson(data.transcript); }
      if (data.source !== undefined) { sets.push('source = @source'); params.source = data.source; }
      if (data.tags !== undefined) { sets.push('tags = @tags'); params.tags = this.toJson(data.tags ?? []); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.occurredAt !== undefined) { sets.push('occurredAt = @occurredAt'); params.occurredAt = toIso(data.occurredAt); }
      if (data.referenceFields !== undefined) { sets.push('referenceFields = @referenceFields'); params.referenceFields = this.toJson(data.referenceFields); }
      if (data.extractedFields !== undefined) { sets.push('extractedFields = @extractedFields'); params.extractedFields = this.toJson(data.extractedFields); }
      if (data.lastAnalyzedAt !== undefined) { sets.push('lastAnalyzedAt = @lastAnalyzedAt'); params.lastAnalyzedAt = toIso(data.lastAnalyzedAt); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.analysisConversations} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findAnalysisConversationById(id);
    }

    async deleteAnalysisConversation(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.analysisConversations} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findAnalysisConversationById(id: string): Promise<IAnalysisConversation | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.analysisConversations} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAnalysisConversationRow(row) : null;
    }

    async findAnalysisConversationByKey(key: string, projectId?: string): Promise<IAnalysisConversation | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.analysisConversations} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapAnalysisConversationRow(row) : null;
    }

    async listAnalysisConversations(filters?: { projectId?: string; source?: AnalysisConversationSource; tag?: string; search?: string; limit?: number; skip?: number }): Promise<IAnalysisConversation[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.source !== undefined) { clauses.push('source = @source'); params.source = filters.source; }
      // tags stored as a JSON array string; match the quoted token (exact tag).
      // JSON.stringify('a') === '"a"', so the LIKE pattern becomes %"a"%.
      if (filters?.tag) { clauses.push(this.likeAny(['tags'], '@tag')); params.tag = this.likePattern(JSON.stringify(filters.tag)); }
      if (filters?.search) { clauses.push(this.likeAny(['name', 'description', 'key'], '@search')); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters?.limit ?? 100;
      const skip = filters?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.analysisConversations} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapAnalysisConversationRow(r));
    }

    // ── Runs ─────────────────────────────────────────────────────────

    async createAnalysisRun(
      run: Omit<IAnalysisRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAnalysisRun> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.analysisRuns}
        (id, tenantId, projectId, definitionKey, target, status, mode, progress, aggregate, items,
         error, startedAt, finishedAt, createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @definitionKey, @target, @status, @mode, @progress, @aggregate, @items,
         @error, @startedAt, @finishedAt, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: run.tenantId,
        projectId: run.projectId ?? null,
        definitionKey: run.definitionKey,
        target: run.target !== undefined ? this.toJson(run.target) : null,
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

    async updateAnalysisRun(
      id: string,
      data: Partial<Omit<IAnalysisRun, 'tenantId' | 'definitionKey' | 'createdBy'>>,
    ): Promise<IAnalysisRun | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.target !== undefined) { sets.push('target = @target'); params.target = this.toJson(data.target); }
      if (data.mode !== undefined) { sets.push('mode = @mode'); params.mode = data.mode; }
      if (data.progress !== undefined) { sets.push('progress = @progress'); params.progress = this.toJson(data.progress); }
      if (data.aggregate !== undefined) { sets.push('aggregate = @aggregate'); params.aggregate = this.toJson(data.aggregate); }
      if (data.items !== undefined) { sets.push('items = @items'); params.items = this.toJson(data.items); }
      if (data.error !== undefined) { sets.push('error = @error'); params.error = data.error; }
      if (data.startedAt !== undefined) { sets.push('startedAt = @startedAt'); params.startedAt = toIso(data.startedAt); }
      if (data.finishedAt !== undefined) { sets.push('finishedAt = @finishedAt'); params.finishedAt = toIso(data.finishedAt); }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.analysisRuns} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findAnalysisRunById(id);
    }

    async findAnalysisRunById(id: string): Promise<IAnalysisRun | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.analysisRuns} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAnalysisRunRow(row) : null;
    }

    async listAnalysisRuns(filters?: { projectId?: string; definitionKey?: string; status?: AnalysisRunStatus; limit?: number; skip?: number }): Promise<IAnalysisRun[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.definitionKey !== undefined) { clauses.push('definitionKey = @definitionKey'); params.definitionKey = filters.definitionKey; }
      if (filters?.status !== undefined) { clauses.push('status = @status'); params.status = filters.status; }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters?.limit ?? 50;
      const skip = filters?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.analysisRuns} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapAnalysisRunRow(r));
    }

    // ── Results (latest analysis per source, with its review) ───────────

    async upsertAnalysisResult(
      result: Omit<IAnalysisResult, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAnalysisResult> {
      const db = this.getTenantDb();
      const now = this.now();
      const projectId = result.projectId ?? '';
      // createdAt and id only count on insert: the conflict branch leaves them alone.
      db.prepare(`
        INSERT INTO ${TABLES.analysisResults}
        (id, tenantId, projectId, definitionKey, sourceKind, sourceId, title, agentKey, ownerId, sourceVersion,
         runId, decisions, extractedFields, judge, accuracy, rationale, needsReview, reviewReason, minConfidence,
         review, analyzedAt, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @definitionKey, @sourceKind, @sourceId, @title, @agentKey, @ownerId, @sourceVersion,
         @runId, @decisions, @extractedFields, @judge, @accuracy, @rationale, @needsReview, @reviewReason, @minConfidence,
         @review, @analyzedAt, @createdAt, @updatedAt)
        ON CONFLICT(projectId, definitionKey, sourceKind, sourceId) DO UPDATE SET
          tenantId = excluded.tenantId,
          title = excluded.title,
          agentKey = excluded.agentKey,
          ownerId = excluded.ownerId,
          sourceVersion = excluded.sourceVersion,
          runId = excluded.runId,
          decisions = excluded.decisions,
          extractedFields = excluded.extractedFields,
          judge = excluded.judge,
          accuracy = excluded.accuracy,
          rationale = excluded.rationale,
          needsReview = excluded.needsReview,
          reviewReason = excluded.reviewReason,
          minConfidence = excluded.minConfidence,
          review = excluded.review,
          analyzedAt = excluded.analyzedAt,
          updatedAt = excluded.updatedAt
      `).run({
        id: this.newId(),
        tenantId: result.tenantId,
        projectId,
        definitionKey: result.definitionKey,
        sourceKind: result.sourceKind,
        sourceId: result.sourceId,
        title: result.title ?? null,
        agentKey: result.agentKey ?? null,
        ownerId: result.ownerId ?? null,
        sourceVersion: result.sourceVersion ? this.toJson(result.sourceVersion) : null,
        runId: result.runId,
        decisions: this.toJson(result.decisions ?? {}),
        extractedFields: this.toJson(result.extractedFields ?? {}),
        judge: result.judge ? this.toJson(result.judge) : null,
        accuracy: result.accuracy ? this.toJson(result.accuracy) : null,
        rationale: result.rationale ?? null,
        needsReview: this.toBoolInt(result.needsReview),
        reviewReason: result.reviewReason ?? null,
        minConfidence: result.minConfidence,
        review: result.review ? this.toJson(result.review) : null,
        analyzedAt: toIso(result.analyzedAt) ?? now,
        createdAt: now,
        updatedAt: now,
      });
      const row = db.prepare(`
        SELECT * FROM ${TABLES.analysisResults}
        WHERE projectId = @projectId AND definitionKey = @definitionKey AND sourceKind = @sourceKind AND sourceId = @sourceId
      `).get({ projectId, definitionKey: result.definitionKey, sourceKind: result.sourceKind, sourceId: result.sourceId }) as SqliteRow;
      return this.mapAnalysisResultRow(row);
    }

    async findAnalysisResultById(id: string): Promise<IAnalysisResult | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${TABLES.analysisResults} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAnalysisResultRow(row) : null;
    }

    async listAnalysisResults(
      filters: AnalysisResultFilter & { sort?: 'recent' | 'confidence'; limit?: number; skip?: number },
    ): Promise<IAnalysisResult[]> {
      const built = this.buildAnalysisResultWhere(filters);
      if (!built) return [];
      const limit = Math.min(5000, Math.max(1, Math.floor(filters.limit ?? 50)));
      const skip = Math.max(0, Math.floor(filters.skip ?? 0));
      // id breaks ties so paging is stable.
      const order = filters.sort === 'confidence'
        ? 'minConfidence ASC, analyzedAt DESC, id DESC'
        : 'analyzedAt DESC, id DESC';
      const rows = this.getTenantDb().prepare(`
        SELECT * FROM ${TABLES.analysisResults}
        WHERE ${built.where}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${skip}
      `).all(built.params) as SqliteRow[];
      return rows.map((r) => this.mapAnalysisResultRow(r));
    }

    async countAnalysisResults(filters: AnalysisResultFilter): Promise<number> {
      const built = this.buildAnalysisResultWhere(filters);
      if (!built) return 0;
      const row = this.getTenantDb().prepare(
        `SELECT COUNT(*) AS n FROM ${TABLES.analysisResults} WHERE ${built.where}`,
      ).get(built.params) as SqliteRow;
      return Number(row.n ?? 0);
    }

    async updateAnalysisResultReview(id: string, review: IAnalysisResultReview): Promise<IAnalysisResult | null> {
      const db = this.getTenantDb();
      const changes = db.prepare(`
        UPDATE ${TABLES.analysisResults}
        SET review = @review, needsReview = 0, updatedAt = @updatedAt
        WHERE id = @id
      `).run({ id, review: this.toJson(review), updatedAt: this.now() }).changes;
      if (changes === 0) return null;
      return this.findAnalysisResultById(id);
    }

    async deleteAnalysisResultsForDefinition(projectId: string, definitionKey: string): Promise<number> {
      return this.getTenantDb().prepare(
        `DELETE FROM ${TABLES.analysisResults} WHERE projectId = @projectId AND definitionKey = @definitionKey`,
      ).run({ projectId: projectId ?? '', definitionKey }).changes;
    }

    /** WHERE clause for result filters; null when a narrowing list is empty (matches nothing). */
    private buildAnalysisResultWhere(filters: AnalysisResultFilter): { where: string; params: Record<string, unknown> } | null {
      if (filters.sourceIds && filters.sourceIds.length === 0) return null;
      const conditions: string[] = ['projectId = @projectId'];
      const params: Record<string, unknown> = { projectId: filters.projectId ?? '' };
      if (filters.definitionKey) { conditions.push('definitionKey = @definitionKey'); params.definitionKey = filters.definitionKey; }
      if (filters.sourceKind) { conditions.push('sourceKind = @sourceKind'); params.sourceKind = filters.sourceKind; }
      if (filters.sourceIds) {
        const names = filters.sourceIds.slice(0, 500).map((id, i) => { params[`sourceId${i}`] = id; return `@sourceId${i}`; });
        conditions.push(`sourceId IN (${names.join(', ')})`);
      }
      if (filters.needsReview !== undefined) { conditions.push('needsReview = @needsReview'); params.needsReview = this.toBoolInt(filters.needsReview); }
      if (filters.reviewed !== undefined) conditions.push(filters.reviewed ? 'review IS NOT NULL' : 'review IS NULL');
      if (filters.viewer) {
        // Restricts agent sessions only; other kinds stay visible.
        params.viewerUser = filters.viewer.userId;
        const names = filters.viewer.agentKeys.slice(0, 500).map((key, i) => { params[`viewerKey${i}`] = key; return `@viewerKey${i}`; });
        conditions.push(`(sourceKind != 'agent_session' OR ownerId = @viewerUser${names.length ? ` OR agentKey IN (${names.join(', ')})` : ''})`);
      }
      return { where: conditions.join(' AND '), params };
    }

    protected mapAnalysisResultRow(r: SqliteRow): IAnalysisResult {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? '',
        definitionKey: r.definitionKey as string,
        sourceKind: r.sourceKind as AnalysisResultSourceKind,
        sourceId: r.sourceId as string,
        title: (r.title as string | null) ?? undefined,
        agentKey: (r.agentKey as string | null) ?? undefined,
        ownerId: (r.ownerId as string | null) ?? undefined,
        sourceVersion: r.sourceVersion ? this.parseJson<IAnalysisResult['sourceVersion']>(r.sourceVersion, undefined) : undefined,
        runId: r.runId as string,
        decisions: this.parseJson<Record<string, IAnalysisDecision>>(r.decisions, {}),
        extractedFields: this.parseJson<Record<string, unknown>>(r.extractedFields, {}),
        judge: r.judge ? this.parseJson<IAnalysisResult['judge']>(r.judge, undefined) : undefined,
        accuracy: r.accuracy ? this.parseJson<IAnalysisResult['accuracy']>(r.accuracy, undefined) : undefined,
        rationale: (r.rationale as string | null) ?? undefined,
        needsReview: this.fromBoolInt(r.needsReview),
        reviewReason: (r.reviewReason as AnalysisReviewReason | null) ?? undefined,
        minConfidence: Number(r.minConfidence ?? 1),
        review: r.review ? this.parseJson<IAnalysisResultReview | null>(r.review, null) : null,
        analyzedAt: this.toDate(r.analyzedAt) as Date,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapAnalysisDefinitionRow(r: SqliteRow): IAnalysisDefinition {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? undefined,
        fieldSet: this.parseJson<IAnalysisFieldDef[]>(r.fieldSet, []),
        extractionInstructions: (r.extractionInstructions as string | null) ?? undefined,
        modes: this.parseJson<IAnalysisModes>(r.modes, {}),
        extractionModelKey: (r.extractionModelKey as string | null) ?? undefined,
        judgeModelKey: (r.judgeModelKey as string | null) ?? undefined,
        decisionModelKey: (r.decisionModelKey as string | null) || undefined,
        source: r.source ? this.parseJson<IAnalysisSource>(r.source, { kind: 'conversations' }) : undefined,
        review: r.review ? this.parseJson<IAnalysisReviewSettings>(r.review, {}) : undefined,
        runConfig: this.parseJson(r.runConfig, {}),
        schedule: r.schedule ? this.parseJson<{ cron: string; enabled: boolean }>(r.schedule, { cron: '', enabled: false }) : undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapAnalysisConversationRow(r: SqliteRow): IAnalysisConversation {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: (r.name as string | null) ?? undefined,
        description: (r.description as string | null) ?? undefined,
        transcript: this.parseJson<IAnalysisTranscriptMessage[]>(r.transcript, []),
        source: r.source as AnalysisConversationSource,
        tags: this.parseJson<string[]>(r.tags, []),
        metadata: this.parseJson(r.metadata, {}),
        occurredAt: r.occurredAt ? this.toDate(r.occurredAt) : undefined,
        referenceFields: r.referenceFields ? this.parseJson<Record<string, unknown>>(r.referenceFields, {}) : undefined,
        extractedFields: r.extractedFields ? this.parseJson<Record<string, unknown>>(r.extractedFields, {}) : undefined,
        lastAnalyzedAt: r.lastAnalyzedAt ? this.toDate(r.lastAnalyzedAt) : undefined,
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapAnalysisRunRow(r: SqliteRow): IAnalysisRun {
      const aggregate = this.parseJson<IAnalysisRunAggregate | null>(r.aggregate, null);
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        definitionKey: r.definitionKey as string,
        target: r.target ? this.parseJson<IAnalysisRunTarget | undefined>(r.target, undefined) : undefined,
        status: r.status as AnalysisRunStatus,
        mode: r.mode as IAnalysisRun['mode'],
        progress: this.parseJson(r.progress, { total: 0, completed: 0, failed: 0 }),
        aggregate: aggregate ?? undefined,
        items: this.parseJson<IAnalysisItemResult[]>(r.items, []),
        error: (r.error as string | null) ?? undefined,
        startedAt: r.startedAt ? this.toDate(r.startedAt) : undefined,
        finishedAt: r.finishedAt ? this.toDate(r.finishedAt) : undefined,
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
