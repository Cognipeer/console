/**
 * SQLite Provider – Agent Runs mixin (background execution)
 *
 * See docs/guide/agent-background-execution.md §6/§7/§12 for the full design.
 * Deliberately mirrors ICrawlJob's CAS patterns (`UPDATE ... WHERE status = ?`
 * + checking `changes`) but diverges on crash recovery: an orphaned agent run
 * is failed, never silently reset and re-run, because agent turns can carry
 * irreversible tool side effects that crawl jobs do not.
 */

import type { IAgentRun } from '../provider.interface';
import { AgentRunConflictError } from '../provider/errors';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

/** better-sqlite3's error code for any unique-constraint violation. */
const SQLITE_UNIQUE_CONSTRAINT_CODE = 'SQLITE_CONSTRAINT_UNIQUE';

function isSqliteUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === SQLITE_UNIQUE_CONSTRAINT_CODE
  );
}

export function AgentRunMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AgentRunOps extends Base {
    async createAgentRun(
      record: Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentRun> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      try {
        db.prepare(`
          INSERT INTO ${TABLES.agentRuns}
          (id, mode, tenantId, tenantDbName, projectId, agentKey, conversationId,
           userMessage, version, usePublished, runtimeContext,
           idempotencyKey, idempotencyRequestHash, status, errorReason,
           result, errorMessage, cancelRequestedAt, workerId, heartbeatAt,
           callbackUrl, callbackStatus, callbackAttempts,
           userId, apiTokenId, actorType,
           createdAt, startedAt, completedAt, expiresAt, updatedAt)
          VALUES (@id, @mode, @tenantId, @tenantDbName, @projectId, @agentKey, @conversationId,
           @userMessage, @version, @usePublished, @runtimeContext,
           @idempotencyKey, @idempotencyRequestHash, @status, @errorReason,
           @result, @errorMessage, @cancelRequestedAt, @workerId, @heartbeatAt,
           @callbackUrl, @callbackStatus, @callbackAttempts,
           @userId, @apiTokenId, @actorType,
           @createdAt, @startedAt, @completedAt, @expiresAt, @updatedAt)
        `).run({
          id,
          mode: record.mode,
          tenantId: record.tenantId,
          tenantDbName: record.tenantDbName,
          projectId: record.projectId,
          agentKey: record.agentKey,
          conversationId: record.conversationId,
          userMessage: record.userMessage,
          version: record.version ?? null,
          usePublished: record.usePublished === undefined ? null : (record.usePublished ? 1 : 0),
          runtimeContext: record.runtimeContext ? this.toJson(record.runtimeContext) : null,
          idempotencyKey: record.idempotencyKey ?? null,
          idempotencyRequestHash: record.idempotencyRequestHash ?? null,
          status: record.status,
          errorReason: record.errorReason ?? null,
          result: record.result !== undefined && record.result !== null ? this.toJson(record.result) : null,
          errorMessage: record.errorMessage ?? null,
          cancelRequestedAt: record.cancelRequestedAt ? new Date(record.cancelRequestedAt).toISOString() : null,
          workerId: record.workerId ?? null,
          heartbeatAt: record.heartbeatAt ? new Date(record.heartbeatAt).toISOString() : null,
          callbackUrl: record.callbackUrl ?? null,
          callbackStatus: record.callbackStatus ?? null,
          callbackAttempts: record.callbackAttempts ?? 0,
          userId: record.userId ?? null,
          apiTokenId: record.apiTokenId ?? null,
          actorType: record.actorType ?? null,
          createdAt: now,
          startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
          completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : null,
          expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
          updatedAt: now,
        });
      } catch (error) {
        if (isSqliteUniqueConstraintError(error)) {
          throw new AgentRunConflictError(record.conversationId);
        }
        throw error;
      }
      return (await this.findAgentRunByIdRaw(id))!;
    }

    async claimAgentRun(
      id: string,
      tenantId: string,
      workerId: string,
      startedAt: Date,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const startedAtIso = startedAt.toISOString();
      const result = db.prepare(`
        UPDATE ${TABLES.agentRuns}
        SET status = 'running', workerId = @workerId, startedAt = @startedAt,
            heartbeatAt = @startedAt, updatedAt = @updatedAt
        WHERE id = @id AND tenantId = @tenantId AND status = 'queued'
      `).run({
        id, tenantId, workerId, startedAt: startedAtIso, updatedAt: now,
      });
      if (result.changes !== 1) return null;
      return this.findAgentRunByIdRaw(id);
    }

    async updateAgentRunHeartbeat(
      id: string,
      workerId: string,
      heartbeatAt: Date,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const result = db.prepare(`
        UPDATE ${TABLES.agentRuns}
        SET heartbeatAt = @heartbeatAt, updatedAt = @updatedAt
        WHERE id = @id AND workerId = @workerId AND status = 'running'
      `).run({ id, workerId, heartbeatAt: heartbeatAt.toISOString(), updatedAt: now });
      if (result.changes !== 1) return null;
      return this.findAgentRunByIdRaw(id);
    }

    async requestAgentRunCancel(
      id: string,
      tenantId: string,
      projectId: string,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const now = this.now();
      // Fast path: run hasn't started yet, cancel it outright.
      const queuedResult = db.prepare(`
        UPDATE ${TABLES.agentRuns}
        SET status = 'canceled', errorReason = 'canceled_by_caller', completedAt = @now, updatedAt = @now
        WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId AND status = 'queued'
      `).run({ id, tenantId, projectId, now });
      if (queuedResult.changes === 1) return this.findAgentRunByIdRaw(id);

      // Already running (possibly on another node) — stamp the request so
      // the owning worker observes it on its next heartbeat-cadence poll.
      const runningResult = db.prepare(`
        UPDATE ${TABLES.agentRuns}
        SET cancelRequestedAt = @now, updatedAt = @now
        WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId AND status = 'running'
      `).run({ id, tenantId, projectId, now });
      if (runningResult.changes !== 1) return null;
      return this.findAgentRunByIdRaw(id);
    }

    async finalizeAgentRun(
      id: string,
      tenantId: string,
      data: Partial<Omit<IAgentRun, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const { sets, params } = this.buildAgentRunSetClause(data, id, now);
      params.tenantId = tenantId;
      const result = db.prepare(
        `UPDATE ${TABLES.agentRuns} SET ${sets.join(', ')} WHERE id = @id AND tenantId = @tenantId AND status = 'running'`,
      ).run(params);
      if (result.changes !== 1) return null;
      return this.findAgentRunByIdRaw(id);
    }

    async updateAgentRunCallback(
      id: string,
      tenantId: string,
      data: { callbackStatus: NonNullable<IAgentRun['callbackStatus']>; callbackAttempts: number },
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const result = db.prepare(`
        UPDATE ${TABLES.agentRuns}
        SET callbackStatus = @callbackStatus, callbackAttempts = @callbackAttempts, updatedAt = @updatedAt
        WHERE id = @id AND tenantId = @tenantId
      `).run({
        id,
        tenantId,
        callbackStatus: data.callbackStatus,
        callbackAttempts: data.callbackAttempts,
        updatedAt: now,
      });
      if (result.changes !== 1) return null;
      return this.findAgentRunByIdRaw(id);
    }

    private buildAgentRunSetClause(
      data: Partial<Omit<IAgentRun, '_id' | 'tenantId' | 'createdAt'>>,
      id: string,
      now: string,
    ): { sets: string[]; params: Record<string, unknown> } {
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const scalarFields = [
        'status', 'errorReason', 'errorMessage', 'workerId',
        'callbackUrl', 'callbackStatus', 'projectId',
        'idempotencyKey', 'idempotencyRequestHash',
      ];
      for (const f of scalarFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      if (data.callbackAttempts !== undefined) {
        sets.push('callbackAttempts = @callbackAttempts');
        params.callbackAttempts = data.callbackAttempts;
      }
      const dateFields: Array<'startedAt' | 'completedAt' | 'cancelRequestedAt' | 'heartbeatAt' | 'expiresAt'> = [
        'startedAt', 'completedAt', 'cancelRequestedAt', 'heartbeatAt', 'expiresAt',
      ];
      for (const f of dateFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          const v = (data as Record<string, unknown>)[f] as Date | string | null;
          params[f] = v ? new Date(v).toISOString() : null;
        }
      }
      if (data.result !== undefined) {
        sets.push('result = @result');
        params.result = data.result === null ? null : this.toJson(data.result);
      }
      return { sets, params };
    }

    async getAgentRunById(
      id: string,
      tenantId: string,
      projectId: string,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.agentRuns} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`,
      ).get({ id, tenantId, projectId }) as SqliteRow | undefined;
      return row ? this.mapAgentRun(row) : null;
    }

    async getAgentRunByIdempotencyKey(
      tenantId: string,
      projectId: string,
      idempotencyKey: string,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.agentRuns}
         WHERE tenantId = @tenantId AND projectId = @projectId AND idempotencyKey = @idempotencyKey
         ORDER BY createdAt DESC LIMIT 1`,
      ).get({ tenantId, projectId, idempotencyKey }) as SqliteRow | undefined;
      return row ? this.mapAgentRun(row) : null;
    }

    async listStaleAgentRuns(
      tenantId: string,
      heartbeatBefore: Date,
      limit?: number,
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      let sql = `
        SELECT * FROM ${TABLES.agentRuns}
        WHERE tenantId = @tenantId AND status = 'running'
          AND (heartbeatAt IS NULL OR heartbeatAt < @heartbeatBefore)
        ORDER BY heartbeatAt ASC
      `;
      const params: Record<string, unknown> = {
        tenantId,
        heartbeatBefore: heartbeatBefore.toISOString(),
      };
      if (limit && limit > 0) {
        sql += ' LIMIT @limit';
        params.limit = limit;
      }
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    async listQueuedAgentRuns(tenantId: string): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.agentRuns}
        WHERE tenantId = @tenantId AND status = 'queued'
        ORDER BY createdAt ASC
      `).all({ tenantId }) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    async deleteAgentRun(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.agentRuns} WHERE id = @id`).run({ id }).changes === 1;
    }

    async countActiveAgentRuns(tenantId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(*) AS cnt FROM ${TABLES.agentRuns} WHERE tenantId = @tenantId AND status IN ('queued', 'running')`;
      const params: Record<string, unknown> = { tenantId };
      if (projectId) {
        sql += ' AND projectId = @projectId';
        params.projectId = projectId;
      }
      const row = db.prepare(sql).get(params) as { cnt: number };
      return Number(row?.cnt ?? 0);
    }

    async cleanupAgentRunRetention(options: {
      projectId?: string;
      olderThan: Date;
      batchSize?: number;
    }): Promise<{ deletedCount: number }> {
      const db = this.getTenantDb();
      const conds: string[] = ['expiresAt IS NOT NULL', 'expiresAt < @olderThan'];
      const params: Record<string, unknown> = { olderThan: options.olderThan.toISOString() };
      if (options.projectId) {
        conds.push('projectId = @projectId');
        params.projectId = options.projectId;
      }
      const whereClause = conds.join(' AND ');
      if (options.batchSize && options.batchSize > 0) {
        const ids = db.prepare(
          `SELECT id FROM ${TABLES.agentRuns} WHERE ${whereClause} LIMIT @batchSize`,
        ).all({ ...params, batchSize: options.batchSize }) as SqliteRow[];
        if (ids.length === 0) return { deletedCount: 0 };
        const placeholders = ids.map((_, i) => `@id${i}`).join(', ');
        const idParams: Record<string, unknown> = {};
        ids.forEach((r, i) => { idParams[`id${i}`] = r.id; });
        const result = db.prepare(
          `DELETE FROM ${TABLES.agentRuns} WHERE id IN (${placeholders})`,
        ).run(idParams);
        return { deletedCount: result.changes };
      }
      const result = db.prepare(`DELETE FROM ${TABLES.agentRuns} WHERE ${whereClause}`).run(params);
      return { deletedCount: result.changes };
    }

    private async findAgentRunByIdRaw(id: string): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.agentRuns} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAgentRun(row) : null;
    }

    private mapAgentRun(row: SqliteRow): IAgentRun {
      return {
        _id: row.id as string,
        mode: row.mode as IAgentRun['mode'],
        tenantId: row.tenantId as string,
        tenantDbName: row.tenantDbName as string,
        projectId: row.projectId as string,
        agentKey: row.agentKey as string,
        conversationId: row.conversationId as string,
        userMessage: row.userMessage as string,
        version: row.version === null || row.version === undefined ? null : Number(row.version),
        usePublished: row.usePublished === null || row.usePublished === undefined ? undefined : Number(row.usePublished) === 1,
        runtimeContext: row.runtimeContext ? this.parseJson(row.runtimeContext, null as Record<string, unknown> | null) : null,
        idempotencyKey: (row.idempotencyKey as string) ?? null,
        idempotencyRequestHash: (row.idempotencyRequestHash as string) ?? null,
        status: row.status as IAgentRun['status'],
        errorReason: (row.errorReason as IAgentRun['errorReason']) ?? null,
        result: row.result ? this.parseJson(row.result, null as Record<string, unknown> | null) : null,
        errorMessage: (row.errorMessage as string) ?? null,
        cancelRequestedAt: this.toDate(row.cancelRequestedAt) ?? null,
        workerId: (row.workerId as string) ?? null,
        heartbeatAt: this.toDate(row.heartbeatAt) ?? null,
        callbackUrl: (row.callbackUrl as string) ?? null,
        callbackStatus: (row.callbackStatus as IAgentRun['callbackStatus']) ?? null,
        callbackAttempts: Number(row.callbackAttempts) || 0,
        userId: (row.userId as string) ?? undefined,
        apiTokenId: (row.apiTokenId as string) ?? undefined,
        actorType: (row.actorType as IAgentRun['actorType']) ?? undefined,
        createdAt: this.toDate(row.createdAt),
        startedAt: this.toDate(row.startedAt) ?? null,
        completedAt: this.toDate(row.completedAt) ?? null,
        expiresAt: this.toDate(row.expiresAt) ?? null,
        updatedAt: this.toDate(row.updatedAt),
      };
    }
  };
}
