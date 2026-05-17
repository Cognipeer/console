/**
 * SQLite Provider – JS Sandbox runtimes and execution logs.
 */

import type {
  IJsSandboxExecution,
  IJsSandboxRuntime,
  JsSandboxExecutionStatus,
  JsSandboxRuntimeStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function JsSandboxMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class JsSandboxOps extends Base {
    async createJsSandboxRuntime(
      runtime: Omit<IJsSandboxRuntime, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IJsSandboxRuntime> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.jsSandboxRuntimes}
        (id, tenantId, projectId, key, name, description, status, engine, libraries,
         limits, network, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @status, @engine, @libraries,
         @limits, @network, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: runtime.tenantId,
        projectId: runtime.projectId ?? null,
        key: runtime.key,
        name: runtime.name,
        description: runtime.description ?? null,
        status: runtime.status,
        engine: runtime.engine,
        libraries: this.toJson(runtime.libraries ?? []),
        limits: this.toJson(runtime.limits),
        network: this.toJson(runtime.network),
        metadata: this.toJson(runtime.metadata ?? {}),
        createdBy: runtime.createdBy,
        updatedBy: runtime.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...runtime, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateJsSandboxRuntime(
      id: string,
      data: Partial<Omit<IJsSandboxRuntime, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt'>>,
    ): Promise<IJsSandboxRuntime | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };

      const stringFields = ['name', 'description', 'status', 'engine', 'updatedBy', 'projectId'];
      for (const field of stringFields) {
        if ((data as Record<string, unknown>)[field] !== undefined) {
          sets.push(`${field} = @${field}`);
          params[field] = (data as Record<string, unknown>)[field] ?? null;
        }
      }

      const jsonFields = ['libraries', 'limits', 'network', 'metadata'];
      for (const field of jsonFields) {
        if ((data as Record<string, unknown>)[field] !== undefined) {
          sets.push(`${field} = @${field}`);
          params[field] = this.toJson((data as Record<string, unknown>)[field] ?? null);
        }
      }

      db.prepare(`UPDATE ${TABLES.jsSandboxRuntimes} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findJsSandboxRuntimeById(id);
    }

    async deleteJsSandboxRuntime(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.jsSandboxRuntimes} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findJsSandboxRuntimeById(id: string): Promise<IJsSandboxRuntime | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.jsSandboxRuntimes} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapJsSandboxRuntime(row) : null;
    }

    async findJsSandboxRuntimeByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<IJsSandboxRuntime | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.jsSandboxRuntimes} WHERE tenantId = @tenantId AND key = @key`;
      const params: Record<string, unknown> = { tenantId, key };
      if (projectId) {
        sql += ' AND projectId = @projectId';
        params.projectId = projectId;
      }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapJsSandboxRuntime(row) : null;
    }

    async listJsSandboxRuntimes(
      tenantId: string,
      filters?: { projectId?: string; status?: JsSandboxRuntimeStatus | string; search?: string },
    ): Promise<IJsSandboxRuntime[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };

      if (filters?.projectId) {
        clauses.push('projectId = @projectId');
        params.projectId = filters.projectId;
      }
      if (filters?.status) {
        clauses.push('status = @status');
        params.status = filters.status;
      }
      if (filters?.search) {
        clauses.push('(name LIKE @search OR key LIKE @search OR description LIKE @search)');
        params.search = this.likePattern(filters.search);
      }

      const rows = db.prepare(
        `SELECT * FROM ${TABLES.jsSandboxRuntimes} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((row) => this.mapJsSandboxRuntime(row));
    }

    async countJsSandboxRuntimes(tenantId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(*) as count FROM ${TABLES.jsSandboxRuntimes} WHERE tenantId = @tenantId`;
      const params: Record<string, unknown> = { tenantId };
      if (projectId) {
        sql += ' AND projectId = @projectId';
        params.projectId = projectId;
      }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return Number(row?.count ?? 0);
    }

    async createJsSandboxExecution(
      execution: Omit<IJsSandboxExecution, '_id' | 'createdAt'>,
    ): Promise<IJsSandboxExecution> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.jsSandboxExecutions}
        (id, tenantId, projectId, runtimeId, runtimeKey, executionId, status, durationMs,
         timeoutMs, memoryLimitMb, codeHash, codePreview, inputPreview, result, logs,
         errorMessage, callerType, callerTokenId, createdAt)
        VALUES (@id, @tenantId, @projectId, @runtimeId, @runtimeKey, @executionId, @status, @durationMs,
         @timeoutMs, @memoryLimitMb, @codeHash, @codePreview, @inputPreview, @result, @logs,
         @errorMessage, @callerType, @callerTokenId, @createdAt)
      `).run({
        id,
        tenantId: execution.tenantId,
        projectId: execution.projectId ?? null,
        runtimeId: execution.runtimeId,
        runtimeKey: execution.runtimeKey,
        executionId: execution.executionId,
        status: execution.status,
        durationMs: execution.durationMs,
        timeoutMs: execution.timeoutMs,
        memoryLimitMb: execution.memoryLimitMb,
        codeHash: execution.codeHash,
        codePreview: execution.codePreview,
        inputPreview: execution.inputPreview ?? null,
        result: execution.result === undefined ? null : this.toJson(execution.result),
        logs: this.toJson(execution.logs ?? { stdout: [], stderr: [] }),
        errorMessage: execution.errorMessage ?? null,
        callerType: execution.callerType,
        callerTokenId: execution.callerTokenId ?? null,
        createdAt: now,
      });

      return { ...execution, _id: id, createdAt: new Date(now) };
    }

    async findJsSandboxExecutionById(id: string): Promise<IJsSandboxExecution | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.jsSandboxExecutions} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapJsSandboxExecution(row) : null;
    }

    async listJsSandboxExecutions(
      tenantId: string,
      filters?: {
        projectId?: string;
        runtimeId?: string;
        runtimeKey?: string;
        status?: JsSandboxExecutionStatus | string;
        from?: Date;
        to?: Date;
        limit?: number;
        skip?: number;
      },
    ): Promise<IJsSandboxExecution[]> {
      const db = this.getTenantDb();
      const { clauses, params } = this.buildExecutionFilter(tenantId, filters);
      params.limit = Math.min(Math.max(filters?.limit ?? 50, 1), 200);
      params.skip = Math.max(filters?.skip ?? 0, 0);
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.jsSandboxExecutions} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC LIMIT @limit OFFSET @skip`,
      ).all(params) as SqliteRow[];
      return rows.map((row) => this.mapJsSandboxExecution(row));
    }

    async countJsSandboxExecutions(
      tenantId: string,
      filters?: {
        projectId?: string;
        runtimeId?: string;
        runtimeKey?: string;
        status?: JsSandboxExecutionStatus | string;
        from?: Date;
        to?: Date;
      },
    ): Promise<number> {
      const db = this.getTenantDb();
      const { clauses, params } = this.buildExecutionFilter(tenantId, filters);
      const row = db.prepare(
        `SELECT COUNT(*) as count FROM ${TABLES.jsSandboxExecutions} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow | undefined;
      return Number(row?.count ?? 0);
    }

    private buildExecutionFilter(
      tenantId: string,
      filters?: {
        projectId?: string;
        runtimeId?: string;
        runtimeKey?: string;
        status?: JsSandboxExecutionStatus | string;
        from?: Date;
        to?: Date;
      },
    ): { clauses: string[]; params: Record<string, unknown> } {
      const clauses: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) {
        clauses.push('projectId = @projectId');
        params.projectId = filters.projectId;
      }
      if (filters?.runtimeId) {
        clauses.push('runtimeId = @runtimeId');
        params.runtimeId = filters.runtimeId;
      }
      if (filters?.runtimeKey) {
        clauses.push('runtimeKey = @runtimeKey');
        params.runtimeKey = filters.runtimeKey;
      }
      if (filters?.status) {
        clauses.push('status = @status');
        params.status = filters.status;
      }
      if (filters?.from) {
        clauses.push('createdAt >= @from');
        params.from = filters.from.toISOString();
      }
      if (filters?.to) {
        clauses.push('createdAt <= @to');
        params.to = filters.to.toISOString();
      }
      return { clauses, params };
    }

    private mapJsSandboxRuntime(row: SqliteRow): IJsSandboxRuntime {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: row.projectId ? String(row.projectId) : undefined,
        key: String(row.key),
        name: String(row.name),
        description: row.description ? String(row.description) : undefined,
        status: String(row.status) as IJsSandboxRuntime['status'],
        engine: String(row.engine) as IJsSandboxRuntime['engine'],
        libraries: this.parseJson(row.libraries, []),
        limits: this.parseJson<IJsSandboxRuntime['limits']>(row.limits, {
          defaultTimeoutMs: 5_000,
          maxTimeoutMs: 30_000,
          memoryLimitMb: 64,
          maxCodeSizeBytes: 64 * 1024,
          maxResultSizeBytes: 512 * 1024,
          maxLogEntries: 100,
        }),
        network: this.parseJson(row.network, { enabled: false }),
        metadata: this.parseJson(row.metadata, {}),
        createdBy: String(row.createdBy),
        updatedBy: row.updatedBy ? String(row.updatedBy) : undefined,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    private mapJsSandboxExecution(row: SqliteRow): IJsSandboxExecution {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: row.projectId ? String(row.projectId) : undefined,
        runtimeId: String(row.runtimeId),
        runtimeKey: String(row.runtimeKey),
        executionId: String(row.executionId),
        status: String(row.status) as IJsSandboxExecution['status'],
        durationMs: Number(row.durationMs ?? 0),
        timeoutMs: Number(row.timeoutMs ?? 0),
        memoryLimitMb: Number(row.memoryLimitMb ?? 0),
        codeHash: String(row.codeHash),
        codePreview: String(row.codePreview),
        inputPreview: row.inputPreview ? String(row.inputPreview) : undefined,
        result: row.result ? this.parseJson(row.result, null) : undefined,
        logs: this.parseJson(row.logs, { stdout: [], stderr: [] }),
        errorMessage: row.errorMessage ? String(row.errorMessage) : undefined,
        callerType: String(row.callerType) as IJsSandboxExecution['callerType'],
        callerTokenId: row.callerTokenId ? String(row.callerTokenId) : undefined,
        createdAt: this.toDate(row.createdAt),
      };
    }
  };
}
