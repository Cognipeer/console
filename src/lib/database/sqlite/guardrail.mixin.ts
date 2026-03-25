/**
 * SQLite Provider – Guardrail operations mixin
 *
 * Includes guardrail CRUD, evaluation logs listing, and aggregation.
 */

import type { IGuardrail, IGuardrailEvaluationLog, GuardrailType } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function GuardrailMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class GuardrailOps extends Base {
    // ── Guardrail CRUD ───────────────────────────────────────────────

    async createGuardrail(
      guardrail: Omit<IGuardrail, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGuardrail> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.guardrails}
        (id, tenantId, projectId, key, name, description, type, target, action, enabled,
         modelKey, policy, customPrompt, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @type, @target, @action, @enabled,
         @modelKey, @policy, @customPrompt, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: guardrail.tenantId,
        projectId: guardrail.projectId ?? null,
        key: guardrail.key,
        name: guardrail.name,
        description: guardrail.description ?? null,
        type: guardrail.type,
        target: guardrail.target,
        action: guardrail.action,
        enabled: this.toBoolInt(guardrail.enabled),
        modelKey: guardrail.modelKey ?? null,
        policy: this.toJson(guardrail.policy ?? {}),
        customPrompt: guardrail.customPrompt ?? null,
        metadata: this.toJson(guardrail.metadata ?? {}),
        createdBy: guardrail.createdBy,
        updatedBy: guardrail.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...guardrail, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateGuardrail(
      id: string,
      data: Partial<Omit<IGuardrail, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IGuardrail | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.type !== undefined) { sets.push('type = @type'); params.type = data.type; }
      if (data.target !== undefined) { sets.push('target = @target'); params.target = data.target; }
      if (data.action !== undefined) { sets.push('action = @action'); params.action = data.action; }
      if (data.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = this.toBoolInt(data.enabled); }
      if (data.modelKey !== undefined) { sets.push('modelKey = @modelKey'); params.modelKey = data.modelKey; }
      if (data.policy !== undefined) { sets.push('policy = @policy'); params.policy = this.toJson(data.policy); }
      if (data.customPrompt !== undefined) { sets.push('customPrompt = @customPrompt'); params.customPrompt = data.customPrompt; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.guardrails} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findGuardrailById(id);
    }

    async deleteGuardrail(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.guardrails} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findGuardrailById(id: string): Promise<IGuardrail | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.guardrails} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapGuardrailRow(row) : null;
    }

    async findGuardrailByKey(key: string, projectId?: string): Promise<IGuardrail | null> {
      const db = this.getTenantDb();
      const clauses: string[] = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(
        `SELECT * FROM ${TABLES.guardrails} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow | undefined;
      return row ? this.mapGuardrailRow(row) : null;
    }

    async listGuardrails(filters?: {
      projectId?: string;
      type?: GuardrailType;
      enabled?: boolean;
      search?: string;
    }): Promise<IGuardrail[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.type !== undefined) { clauses.push('type = @type'); params.type = filters.type; }
      if (filters?.enabled !== undefined) { clauses.push('enabled = @enabled'); params.enabled = this.toBoolInt(filters.enabled); }
      if (filters?.search) {
        clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)');
        params.search = this.likePattern(filters.search);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.guardrails} ${where} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapGuardrailRow(r));
    }

    // ── Guardrail evaluation logs ────────────────────────────────────

    async listGuardrailEvaluationLogs(
      guardrailId: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date; passed?: boolean },
    ) {
      const db = this.getTenantDb();
      const clauses: string[] = ['guardrailId = @guardrailId'];
      const params: Record<string, unknown> = { guardrailId };
      if (options?.passed !== undefined) { clauses.push('passed = @passed'); params.passed = this.toBoolInt(options.passed); }
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.guardrailEvalLogs} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapEvalRow(r));
    }

    async aggregateGuardrailEvaluations(
      guardrailId: string,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    ) {
      const db = this.getTenantDb();
      const clauses: string[] = ['guardrailId = @guardrailId'];
      const params: Record<string, unknown> = { guardrailId };
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }
      const where = `WHERE ${clauses.join(' AND ')}`;

      // Totals
      const totalsRow = db.prepare(`
        SELECT
          COUNT(*) as totalEvaluations,
          SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passedCount,
          SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failedCount,
          AVG(latencyMs) as avgLatencyMs
        FROM ${TABLES.guardrailEvalLogs} ${where}
      `).get(params) as SqliteRow;

      const totalEvaluations = (totalsRow.totalEvaluations as number) || 0;
      const passedCount = (totalsRow.passedCount as number) || 0;
      const failedCount = (totalsRow.failedCount as number) || 0;
      const avgLatencyMs = totalsRow.avgLatencyMs as number | null;

      // Findings aggregation – parse JSON findings from failed logs
      const failedRows = db.prepare(
        `SELECT findings FROM ${TABLES.guardrailEvalLogs} ${where} AND passed = 0`,
      ).all(params) as SqliteRow[];

      const findingsByType: Record<string, number> = {};
      const findingsBySeverity: Record<string, number> = {};
      for (const row of failedRows) {
        const findings = this.parseJson<Array<{ type?: string; severity?: string }>>(row.findings, []);
        for (const f of findings) {
          if (f.type) findingsByType[f.type] = (findingsByType[f.type] || 0) + 1;
          if (f.severity) findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
        }
      }

      // Timeseries
      const groupBy = options?.groupBy || 'day';
      let dateFormat: string;
      if (groupBy === 'hour') dateFormat = '%Y-%m-%dT%H:00';
      else if (groupBy === 'month') dateFormat = '%Y-%m';
      else dateFormat = '%Y-%m-%d';

      const tsRows = db.prepare(`
        SELECT strftime('${dateFormat}', createdAt) as period,
          COUNT(*) as total,
          SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
          SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failed
        FROM ${TABLES.guardrailEvalLogs} ${where}
        GROUP BY period ORDER BY period ASC
      `).all(params) as SqliteRow[];

      const timeseries = tsRows.map((r) => ({
        period: r.period as string,
        total: r.total as number,
        passed: r.passed as number,
        failed: r.failed as number,
      }));

      return {
        guardrailId,
        totalEvaluations,
        passedCount,
        failedCount,
        passRate: totalEvaluations > 0 ? Math.round((passedCount / totalEvaluations) * 100) : 0,
        avgLatencyMs,
        findingsByType,
        findingsBySeverity,
        timeseries,
      };
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapGuardrailRow(r: SqliteRow): IGuardrail {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        type: r.type as IGuardrail['type'],
        target: r.target as IGuardrail['target'],
        action: r.action as IGuardrail['action'],
        enabled: this.fromBoolInt(r.enabled),
        modelKey: r.modelKey as string | undefined,
        policy: this.parseJson(r.policy, undefined),
        customPrompt: r.customPrompt as string | undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapEvalRow(r: SqliteRow): IGuardrailEvaluationLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        guardrailId: r.guardrailId as string,
        guardrailKey: r.guardrailKey as string,
        guardrailName: r.guardrailName as string,
        guardrailType: r.guardrailType as string,
        target: r.target as string,
        action: r.action as string,
        passed: this.fromBoolInt(r.passed),
        findings: this.parseJson(r.findings, []),
        inputText: r.inputText as string | undefined,
        latencyMs: r.latencyMs as number | undefined,
        source: r.source as string | undefined,
        requestId: r.requestId as string | undefined,
        message: r.message as string | undefined,
        createdAt: this.toDate(r.createdAt),
      } as IGuardrailEvaluationLog;
    }
  };
}
