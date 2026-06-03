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
  IAnalysisConversation,
  IAnalysisTranscriptMessage,
  IAnalysisRun,
  IAnalysisItemResult,
  IAnalysisRunAggregate,
  AnalysisConversationSource,
  AnalysisRunStatus,
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
         modes, extractionModelKey, judgeModelKey, runConfig, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @fieldSet, @extractionInstructions,
         @modes, @extractionModelKey, @judgeModelKey, @runConfig, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
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
        runConfig: this.toJson(definition.runConfig ?? {}),
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
      if (data.runConfig !== undefined) { sets.push('runConfig = @runConfig'); params.runConfig = this.toJson(data.runConfig); }
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
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
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
        (id, tenantId, projectId, key, name, description, transcript, source, metadata,
         occurredAt, referenceFields, extractedFields, lastAnalyzedAt, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @transcript, @source, @metadata,
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

    async listAnalysisConversations(filters?: { projectId?: string; source?: AnalysisConversationSource; search?: string; limit?: number; skip?: number }): Promise<IAnalysisConversation[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.source !== undefined) { clauses.push('source = @source'); params.source = filters.source; }
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
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
        (id, tenantId, projectId, definitionKey, status, mode, progress, aggregate, items,
         error, startedAt, finishedAt, createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @definitionKey, @status, @mode, @progress, @aggregate, @items,
         @error, @startedAt, @finishedAt, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: run.tenantId,
        projectId: run.projectId ?? null,
        definitionKey: run.definitionKey,
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
        runConfig: this.parseJson(r.runConfig, {}),
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
