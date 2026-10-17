/**
 * SQLite Provider – Agent Runs mixin (background execution)
 *
 * See docs/guide/agent-background-execution.md §6/§7/§12 for the full design.
 * Deliberately mirrors ICrawlJob's CAS patterns (`UPDATE ... WHERE status = ?`
 * + checking `changes`) but diverges on crash recovery: an orphaned agent run
 * is failed, never silently reset and re-run, because agent turns can carry
 * irreversible tool side effects that crawl jobs do not.
 */

import type { AgentRunClass, IAgentRun } from '../provider.interface';
import { AgentRunConflictError, AgentRunIdempotencyKeyTakenError } from '../provider/errors';
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
           userMessage, attachments, version, usePublished, runtimeContext,
           idempotencyKey, idempotencyRequestHash, status, errorReason, resumeActionIds,
           result, errorMessage, cancelRequestedAt, workerId, heartbeatAt,
           callbackUrl, callbackSecret, maxDurationMs, callbackStatus, callbackAttempts,
           userId, apiTokenId, actorType,
           runClass, notBefore, detachedAt, metadata, channel, triggerId, runTrigger,
           responseFormat, inputs, queueGeneration, lastPublishedAt, unattended, externalContent, background,
           callbackEventId, resumeTrigger, resumeUserId, resumeApiTokenId, accountableUserId, accountableTokenId,
           createdAt, startedAt, completedAt, expiresAt, updatedAt)
          VALUES (@id, @mode, @tenantId, @tenantDbName, @projectId, @agentKey, @conversationId,
           @userMessage, @attachments, @version, @usePublished, @runtimeContext,
           @idempotencyKey, @idempotencyRequestHash, @status, @errorReason, @resumeActionIds,
           @result, @errorMessage, @cancelRequestedAt, @workerId, @heartbeatAt,
           @callbackUrl, @callbackSecret, @maxDurationMs, @callbackStatus, @callbackAttempts,
           @userId, @apiTokenId, @actorType,
           @runClass, @notBefore, @detachedAt, @metadata, @channel, @triggerId, @runTrigger,
           @responseFormat, @inputs, @queueGeneration, @lastPublishedAt, @unattended, @externalContent, @background,
           @callbackEventId, @resumeTrigger, @resumeUserId, @resumeApiTokenId, @accountableUserId, @accountableTokenId,
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
          attachments: record.attachments?.length ? this.toJson(record.attachments) : null,
          version: record.version ?? null,
          usePublished: record.usePublished === undefined ? null : (record.usePublished ? 1 : 0),
          runtimeContext: record.runtimeContext ? this.toJson(record.runtimeContext) : null,
          idempotencyKey: record.idempotencyKey ?? null,
          idempotencyRequestHash: record.idempotencyRequestHash ?? null,
          status: record.status,
          errorReason: record.errorReason ?? null,
          resumeActionIds: record.resumeActionIds?.length ? this.toJson(record.resumeActionIds) : null,
          result: record.result !== undefined && record.result !== null ? this.toJson(record.result) : null,
          errorMessage: record.errorMessage ?? null,
          cancelRequestedAt: record.cancelRequestedAt ? new Date(record.cancelRequestedAt).toISOString() : null,
          workerId: record.workerId ?? null,
          heartbeatAt: record.heartbeatAt ? new Date(record.heartbeatAt).toISOString() : null,
          callbackUrl: record.callbackUrl ?? null,
          callbackSecret: record.callbackSecret ?? null,
          maxDurationMs: record.maxDurationMs ?? null,
          callbackStatus: record.callbackStatus ?? null,
          callbackAttempts: record.callbackAttempts ?? 0,
          userId: record.userId ?? null,
          apiTokenId: record.apiTokenId ?? null,
          actorType: record.actorType ?? null,
          runClass: record.runClass ?? null,
          notBefore: record.notBefore ? new Date(record.notBefore).toISOString() : null,
          detachedAt: record.detachedAt ? new Date(record.detachedAt).toISOString() : null,
          metadata: record.metadata ? this.toJson(record.metadata) : null,
          channel: record.channel ?? null,
          triggerId: record.triggerId ?? null,
          runTrigger: record.trigger ?? null,
          responseFormat: record.responseFormat ? this.toJson(record.responseFormat) : null,
          inputs: record.inputs ? this.toJson(record.inputs) : null,
          queueGeneration: record.queueGeneration ?? 1,
          lastPublishedAt: record.lastPublishedAt ? new Date(record.lastPublishedAt).toISOString() : null,
          unattended: record.unattended ? 1 : null,
          externalContent: record.externalContent ? 1 : null,
          background: record.background ? 1 : null,
          callbackEventId: record.callbackEventId ?? null,
          resumeTrigger: record.resumeTrigger ?? null,
          resumeUserId: record.resumeUserId ?? null,
          resumeApiTokenId: record.resumeApiTokenId ?? null,
          accountableUserId: record.accountableUserId ?? null,
          accountableTokenId: record.accountableTokenId ?? null,
          createdAt: now,
          startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
          completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : null,
          expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
          updatedAt: now,
        });
      } catch (error) {
        if (isSqliteUniqueConstraintError(error)) {
          // Two unique indexes can fire here — tell them apart by the columns
          // SQLite names in the message.
          if (record.idempotencyKey && /idempotencyKey/.test(String((error as Error).message))) {
            throw new AgentRunIdempotencyKeyTakenError(record.idempotencyKey);
          }
          throw new AgentRunConflictError(record.conversationId);
        }
        throw error;
      }
      return (await this.findAgentRunByIdRaw(id))!;
    }

    /** A guarded UPDATE; the row read back, or null when the guard (a CAS) matched nothing. */
    private async updateAgentRunIf(id: string, sql: string, params: Record<string, unknown>): Promise<IAgentRun | null> {
      if (this.getTenantDb().prepare(sql).run(params).changes !== 1) return null;
      return this.findAgentRunByIdRaw(id);
    }

    async claimAgentRun(
      id: string,
      tenantId: string,
      workerId: string,
      startedAt: Date,
    ): Promise<IAgentRun | null> {
      return this.updateAgentRunIf(id, `
        UPDATE ${TABLES.agentRuns}
        SET status = 'running', workerId = @workerId, startedAt = @startedAt,
            heartbeatAt = @startedAt, updatedAt = @updatedAt
        WHERE id = @id AND tenantId = @tenantId AND status = 'queued'
      `, { id, tenantId, workerId, startedAt: startedAt.toISOString(), updatedAt: this.now() });
    }

    async updateAgentRunHeartbeat(
      id: string,
      workerId: string,
      heartbeatAt: Date,
    ): Promise<IAgentRun | null> {
      return this.updateAgentRunIf(id, `
        UPDATE ${TABLES.agentRuns}
        SET heartbeatAt = @heartbeatAt, updatedAt = @updatedAt
        WHERE id = @id AND workerId = @workerId AND status = 'running'
      `, { id, workerId, heartbeatAt: heartbeatAt.toISOString(), updatedAt: this.now() });
    }

    async requestAgentRunCancel(
      id: string,
      tenantId: string,
      projectId: string,
    ): Promise<IAgentRun | null> {
      const params = { id, tenantId, projectId, now: this.now() };
      // Fast path: run hasn't started yet (queued, or scheduled for later),
      // cancel it outright.
      const canceled = await this.updateAgentRunIf(id, `
        UPDATE ${TABLES.agentRuns}
        SET status = 'canceled', errorReason = 'canceled_by_caller', completedAt = @now, updatedAt = @now
        WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId AND status IN ('queued', 'scheduled')
      `, params);
      if (canceled) return canceled;

      // Already running (possibly on another node) — stamp the request so
      // the owning worker observes it on its next heartbeat-cadence poll.
      return this.updateAgentRunIf(id, `
        UPDATE ${TABLES.agentRuns}
        SET cancelRequestedAt = @now, updatedAt = @now
        WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId AND status = 'running'
      `, params);
    }

    async finalizeAgentRun(
      id: string,
      tenantId: string,
      data: Partial<Omit<IAgentRun, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IAgentRun | null> {
      const { sets, params } = this.buildAgentRunSetClause(data, id, this.now());
      params.tenantId = tenantId;
      return this.updateAgentRunIf(
        id,
        `UPDATE ${TABLES.agentRuns} SET ${sets.join(', ')} WHERE id = @id AND tenantId = @tenantId AND status IN ('running', 'requires_action')`,
        params,
      );
    }

    async requeueAgentRunForResume(
      id: string,
      tenantId: string,
      resumeActionIds: string[],
      continuation?: { trigger: 'resume' | 'timeout'; userId?: string | null; apiTokenId?: string | null },
    ): Promise<IAgentRun | null> {
      try {
        return await this.updateAgentRunIf(id, `
          UPDATE ${TABLES.agentRuns}
          SET status = 'queued', resumeActionIds = @resumeActionIds, stopReason = NULL, result = NULL,
              errorReason = NULL, errorMessage = NULL, workerId = NULL, cancelRequestedAt = NULL,
              completedAt = NULL, updatedAt = @updatedAt,
              queueGeneration = COALESCE(queueGeneration, 1) + 1, notBefore = @updatedAt,
              resumeTrigger = @resumeTrigger, resumeUserId = @resumeUserId, resumeApiTokenId = @resumeApiTokenId
          WHERE id = @id AND tenantId = @tenantId AND status = 'requires_action'
        `, {
          id,
          tenantId,
          resumeActionIds: this.toJson(resumeActionIds),
          updatedAt: this.now(),
          resumeTrigger: continuation?.trigger ?? null,
          resumeUserId: continuation?.userId ?? null,
          resumeApiTokenId: continuation?.apiTokenId ?? null,
        });
      } catch (error) {
        // The partial unique index: another run took the conversation's slot.
        if (isSqliteUniqueConstraintError(error)) {
          const held = await this.findAgentRunByIdRaw(id);
          throw new AgentRunConflictError(held?.conversationId ?? id);
        }
        throw error;
      }
    }

    async updateAgentRunCallback(
      id: string,
      tenantId: string,
      data: { callbackStatus: NonNullable<IAgentRun['callbackStatus']>; callbackAttempts: number; callbackEventId?: string | null },
      options?: { onlyIfEventId?: string },
    ): Promise<IAgentRun | null> {
      const setEvent = data.callbackEventId !== undefined ? ', callbackEventId = @callbackEventId' : '';
      const eventGuard = options?.onlyIfEventId !== undefined ? ' AND (callbackEventId IS NULL OR callbackEventId = @onlyIfEventId)' : '';
      return this.updateAgentRunIf(id, `
        UPDATE ${TABLES.agentRuns}
        SET callbackStatus = @callbackStatus, callbackAttempts = @callbackAttempts, updatedAt = @updatedAt${setEvent}
        WHERE id = @id AND tenantId = @tenantId${eventGuard}
      `, {
        id,
        tenantId,
        callbackStatus: data.callbackStatus,
        callbackAttempts: data.callbackAttempts,
        updatedAt: this.now(),
        ...(data.callbackEventId !== undefined ? { callbackEventId: data.callbackEventId ?? null } : {}),
        ...(options?.onlyIfEventId !== undefined ? { onlyIfEventId: options.onlyIfEventId } : {}),
      });
    }

    private buildAgentRunSetClause(
      data: Partial<Omit<IAgentRun, '_id' | 'tenantId' | 'createdAt'>>,
      id: string,
      now: string,
    ): { sets: string[]; params: Record<string, unknown> } {
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const scalarFields = [
        'status', 'errorReason', 'stopReason', 'errorMessage', 'workerId',
        'callbackUrl', 'callbackSecret', 'callbackStatus', 'projectId',
        'idempotencyKey', 'idempotencyRequestHash',
        'runClass', 'channel', 'triggerId',
        'callbackEventId', 'resumeTrigger', 'resumeUserId', 'resumeApiTokenId', 'accountableUserId', 'accountableTokenId',
      ];
      for (const f of scalarFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      if (data.maxDurationMs !== undefined) {
        sets.push('maxDurationMs = @maxDurationMs');
        params.maxDurationMs = data.maxDurationMs ?? null;
      }
      if ((data as { runtimeContext?: unknown }).runtimeContext !== undefined) {
        sets.push('runtimeContext = @runtimeContext');
        const rc = (data as { runtimeContext?: unknown }).runtimeContext;
        params.runtimeContext = rc === null ? null : this.toJson(rc);
      }
      if (data.resumeActionIds !== undefined) {
        sets.push('resumeActionIds = @resumeActionIds');
        params.resumeActionIds = data.resumeActionIds?.length ? this.toJson(data.resumeActionIds) : null;
      }
      if (data.callbackAttempts !== undefined) {
        sets.push('callbackAttempts = @callbackAttempts');
        params.callbackAttempts = data.callbackAttempts;
      }
      if (data.queueGeneration !== undefined) {
        sets.push('queueGeneration = @queueGeneration');
        params.queueGeneration = data.queueGeneration ?? null;
      }
      if (data.trigger !== undefined) {
        sets.push('runTrigger = @runTrigger');
        params.runTrigger = data.trigger ?? null;
      }
      for (const f of ['metadata', 'responseFormat', 'inputs'] as const) {
        if (data[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = data[f] === null ? null : this.toJson(data[f]);
        }
      }
      const dateFields: Array<'startedAt' | 'completedAt' | 'cancelRequestedAt' | 'heartbeatAt' | 'expiresAt' | 'notBefore' | 'detachedAt' | 'lastPublishedAt'> = [
        'startedAt', 'completedAt', 'cancelRequestedAt', 'heartbeatAt', 'expiresAt', 'notBefore', 'detachedAt', 'lastPublishedAt',
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
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.agentRuns}
        WHERE tenantId = @tenantId AND status = 'running'
          AND (heartbeatAt IS NULL OR heartbeatAt < @heartbeatBefore)
        ORDER BY heartbeatAt ASC
      `).all({ tenantId, heartbeatBefore: heartbeatBefore.toISOString() }) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    async listQueuedAgentRuns(
      tenantId: string,
      options?: { createdBefore?: Date; limit?: number },
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      // Deferred rows are published by their dispatcher, never by the requeue sweep.
      let sql = `SELECT * FROM ${TABLES.agentRuns} WHERE tenantId = @tenantId AND status = 'queued' AND COALESCE(runClass, 'default') <> 'deferred'`;
      const params: Record<string, unknown> = { tenantId };
      if (options?.createdBefore) {
        sql += ' AND createdAt < @createdBefore';
        params.createdBefore = options.createdBefore.toISOString();
      }
      sql += ' ORDER BY createdAt ASC';
      if (options?.limit && options.limit > 0) {
        sql += ' LIMIT @limit';
        params.limit = options.limit;
      }
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    async listAgentRunsWithUndeliveredCallbacks(
      tenantId: string,
      options: { updatedBefore: Date; maxAttempts: number; limit?: number },
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.agentRuns}
        WHERE tenantId = @tenantId AND callbackUrl IS NOT NULL
          AND callbackStatus IN ('pending', 'failed') AND COALESCE(callbackAttempts, 0) < @maxAttempts
          AND status IN ('succeeded', 'failed', 'canceled', 'requires_action')
          AND updatedAt < @updatedBefore
        ORDER BY updatedAt ASC LIMIT @limit
      `).all({
        tenantId,
        maxAttempts: options.maxAttempts,
        updatedBefore: options.updatedBefore.toISOString(),
        limit: options.limit && options.limit > 0 ? options.limit : 100,
      }) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    async listAgentRuns(filter: {
      tenantId: string;
      projectId: string;
      agentKey?: string;
      conversationId?: string;
      status?: IAgentRun['status'][];
      mode?: IAgentRun['mode'] | IAgentRun['mode'][];
      excludeModes?: IAgentRun['mode'][];
      runClass?: AgentRunClass;
      triggerId?: string;
      channel?: NonNullable<IAgentRun['channel']>;
      trigger?: NonNullable<IAgentRun['trigger']>;
      metadata?: Record<string, string>;
      createdAfter?: Date;
      createdBefore?: Date;
      cursor?: string;
      userId?: string;
      limit?: number;
    }): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const conds = ['tenantId = @tenantId', 'projectId = @projectId'];
      const params: Record<string, unknown> = { tenantId: filter.tenantId, projectId: filter.projectId };
      if (filter.agentKey) { conds.push('agentKey = @agentKey'); params.agentKey = filter.agentKey; }
      if (filter.conversationId) { conds.push('conversationId = @conversationId'); params.conversationId = filter.conversationId; }
      if (filter.triggerId) { conds.push('triggerId = @triggerId'); params.triggerId = filter.triggerId; }
      if (filter.channel) { conds.push('channel = @channel'); params.channel = filter.channel; }
      if (filter.trigger) { conds.push('runTrigger = @runTrigger'); params.runTrigger = filter.trigger; }
      if (filter.userId) { conds.push('userId = @userId'); params.userId = filter.userId; }
      if (filter.runClass) conds.push(this.runClassCondition(filter.runClass));
      const inList = (column: string, prefix: string, values: string[], negate = false) => {
        const keys = values.map((value, i) => { params[`${prefix}${i}`] = value; return `@${prefix}${i}`; });
        conds.push(`${column} ${negate ? 'NOT IN' : 'IN'} (${keys.join(', ')})`);
      };
      const modes = filter.mode === undefined ? [] : Array.isArray(filter.mode) ? filter.mode : [filter.mode];
      if (modes.length > 0) inList('mode', 'mode', modes);
      if (filter.excludeModes && filter.excludeModes.length > 0) inList('mode', 'xmode', filter.excludeModes, true);
      if (filter.status && filter.status.length > 0) inList('status', 'status', filter.status);
      Object.entries(filter.metadata ?? {}).forEach(([key, value], i) => {
        conds.push(`json_extract(metadata, @mkey${i}) = @mval${i}`);
        params[`mkey${i}`] = `$."${key.replace(/["\\]/g, '')}"`;
        params[`mval${i}`] = value;
      });
      if (filter.createdAfter) { conds.push('createdAt > @createdAfter'); params.createdAfter = filter.createdAfter.toISOString(); }
      if (filter.createdBefore) { conds.push('createdAt < @createdBefore'); params.createdBefore = filter.createdBefore.toISOString(); }
      if (filter.cursor) {
        // rowid is insertion order, which keeps ties on createdAt newest-first (ids are random).
        const cursorRow = db.prepare(
          `SELECT createdAt, rowid AS rid FROM ${TABLES.agentRuns} WHERE id = @cursor AND tenantId = @tenantId AND projectId = @projectId`,
        ).get({ cursor: filter.cursor, tenantId: filter.tenantId, projectId: filter.projectId }) as { createdAt: string; rid: number } | undefined;
        // An unknown cursor ends the listing instead of restarting it.
        if (!cursorRow) return [];
        conds.push('(createdAt < @cursorCreatedAt OR (createdAt = @cursorCreatedAt AND rowid < @cursorRid))');
        params.cursorCreatedAt = cursorRow.createdAt;
        params.cursorRid = cursorRow.rid;
      }
      params.limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000);
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.agentRuns} WHERE ${conds.join(' AND ')} ORDER BY createdAt DESC, rowid DESC LIMIT @limit`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    /** `default` also matches rows with no class (every row from before run classes). */
    private runClassCondition(runClass: AgentRunClass): string {
      return runClass === 'default' ? "COALESCE(runClass, 'default') = 'default'" : `runClass = '${runClass}'`;
    }

    async listDueScheduledAgentRuns(tenantId: string, now: Date, limit: number): Promise<IAgentRun[]> {
      const rows = this.getTenantDb().prepare(`
        SELECT * FROM ${TABLES.agentRuns}
        WHERE tenantId = @tenantId AND status = 'scheduled' AND notBefore <= @now
        ORDER BY notBefore ASC, rowid ASC LIMIT @limit
      `).all({ tenantId, now: now.toISOString(), limit: Math.max(limit, 1) }) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    async promoteScheduledAgentRun(runId: string, tenantId: string): Promise<IAgentRun | null> {
      try {
        // The partial unique index takes the conversation's slot as the row turns active.
        return await this.updateAgentRunIf(runId, `
          UPDATE ${TABLES.agentRuns} SET status = 'queued', updatedAt = @updatedAt
          WHERE id = @id AND tenantId = @tenantId AND status = 'scheduled'
        `, { id: runId, tenantId, updatedAt: this.now() });
      } catch (error) {
        if (isSqliteUniqueConstraintError(error)) {
          const held = await this.findAgentRunByIdRaw(runId);
          throw new AgentRunConflictError(held?.conversationId ?? runId);
        }
        throw error;
      }
    }

    async listQueuedDeferredAgentRuns(
      tenantId: string,
      options: { limit: number; dueBefore: Date },
    ): Promise<IAgentRun[]> {
      const rows = this.getTenantDb().prepare(`
        SELECT * FROM ${TABLES.agentRuns}
        WHERE tenantId = @tenantId AND status = 'queued' AND runClass = 'deferred'
          AND (notBefore IS NULL OR notBefore <= @dueBefore)
        ORDER BY createdAt ASC, rowid ASC LIMIT @limit
      `).all({ tenantId, dueBefore: options.dueBefore.toISOString(), limit: Math.max(options.limit, 1) }) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    async listExpiredWaitingAgentRuns(
      tenantId: string,
      options: { dueBefore: Date; limit: number },
    ): Promise<IAgentRun[]> {
      // The due moment is `notBefore`, else `createdAt` (a run that was never scheduled).
      const rows = this.getTenantDb().prepare(`
        SELECT * FROM ${TABLES.agentRuns}
        WHERE tenantId = @tenantId
          AND (status = 'scheduled' OR (status = 'queued' AND runClass = 'deferred'))
          AND COALESCE(notBefore, createdAt) < @dueBefore
        ORDER BY createdAt ASC, rowid ASC LIMIT @limit
      `).all({ tenantId, dueBefore: options.dueBefore.toISOString(), limit: Math.max(options.limit, 1) }) as SqliteRow[];
      return rows.map((r) => this.mapAgentRun(r));
    }

    async expireWaitingAgentRun(runId: string, tenantId: string, errorMessage: string, expiresAt?: Date): Promise<IAgentRun | null> {
      // Leaving `queued` frees the partial unique index slot with the row update.
      const now = this.now();
      return this.updateAgentRunIf(runId, `
        UPDATE ${TABLES.agentRuns}
        SET status = 'failed', errorReason = 'expired', errorMessage = @errorMessage, stopReason = 'error',
            completedAt = @now, updatedAt = @now${expiresAt ? ', expiresAt = @expiresAt' : ''}
        WHERE id = @id AND tenantId = @tenantId AND status IN ('queued', 'scheduled')
      `, { id: runId, tenantId, errorMessage, now, ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) });
    }

    async markAgentRunDetached(runId: string, tenantId: string, at: Date): Promise<IAgentRun | null> {
      return this.updateAgentRunIf(runId, `
        UPDATE ${TABLES.agentRuns} SET detachedAt = @at, updatedAt = @updatedAt
        WHERE id = @id AND tenantId = @tenantId AND status = 'running'
      `, { id: runId, tenantId, at: at.toISOString(), updatedAt: this.now() });
    }

    async markAgentRunPublished(runId: string, tenantId: string, at: Date): Promise<IAgentRun | null> {
      return this.updateAgentRunIf(runId, `
        UPDATE ${TABLES.agentRuns} SET lastPublishedAt = @at, updatedAt = @updatedAt
        WHERE id = @id AND tenantId = @tenantId
      `, { id: runId, tenantId, at: at.toISOString(), updatedAt: this.now() });
    }

    async deleteAgentRun(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.agentRuns} WHERE id = @id`).run({ id }).changes === 1;
    }

    async countActiveAgentRuns(
      tenantId: string,
      projectId?: string,
      opts?: { mode?: IAgentRun['mode']; runClass?: AgentRunClass },
    ): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(*) AS cnt FROM ${TABLES.agentRuns} WHERE tenantId = @tenantId AND status IN ('queued', 'running')`;
      const params: Record<string, unknown> = { tenantId };
      if (opts?.mode) {
        sql += ' AND mode = @mode';
        params.mode = opts.mode;
      }
      if (opts?.runClass) sql += ` AND ${this.runClassCondition(opts.runClass)}`;
      if (projectId) {
        sql += ' AND projectId = @projectId';
        params.projectId = projectId;
      }
      const row = db.prepare(sql).get(params) as { cnt: number };
      return Number(row?.cnt ?? 0);
    }

    async countAgentRunsByStatus(
      tenantId: string,
      opts: { statuses: IAgentRun['status'][]; runClass?: AgentRunClass; projectId?: string },
    ): Promise<Record<string, number>> {
      const result: Record<string, number> = Object.fromEntries(opts.statuses.map((status) => [status, 0]));
      if (opts.statuses.length === 0) return result;
      const params: Record<string, unknown> = { tenantId };
      const keys = opts.statuses.map((status, i) => { params[`status${i}`] = status; return `@status${i}`; });
      let sql = `SELECT status, COUNT(*) AS cnt FROM ${TABLES.agentRuns} WHERE tenantId = @tenantId AND status IN (${keys.join(', ')})`;
      if (opts.projectId) { sql += ' AND projectId = @projectId'; params.projectId = opts.projectId; }
      if (opts.runClass) sql += ` AND ${this.runClassCondition(opts.runClass)}`;
      sql += ' GROUP BY status';
      for (const row of this.getTenantDb().prepare(sql).all(params) as Array<{ status: string; cnt: number }>) {
        result[row.status] = Number(row.cnt);
      }
      return result;
    }

    async cleanupAgentRunRetention(options: {
      olderThan: Date;
      batchSize?: number;
    }): Promise<{ deletedCount: number }> {
      const db = this.getTenantDb();
      // Active, scheduled and paused rows are never retention's to delete, whatever expiresAt says.
      const conds = ['expiresAt IS NOT NULL', 'expiresAt < @olderThan', "status NOT IN ('queued', 'running', 'scheduled', 'requires_action')"];
      const params: Record<string, unknown> = { olderThan: options.olderThan.toISOString() };
      const whereClause = conds.join(' AND ');
      const batched = Boolean(options.batchSize && options.batchSize > 0);
      const sql = batched
        ? `DELETE FROM ${TABLES.agentRuns} WHERE id IN (SELECT id FROM ${TABLES.agentRuns} WHERE ${whereClause} LIMIT @batchSize)`
        : `DELETE FROM ${TABLES.agentRuns} WHERE ${whereClause}`;
      return { deletedCount: db.prepare(sql).run(batched ? { ...params, batchSize: options.batchSize } : params).changes };
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
        attachments: row.attachments ? this.parseJson(row.attachments, [] as string[]) : null,
        version: row.version === null || row.version === undefined ? null : Number(row.version),
        usePublished: row.usePublished === null || row.usePublished === undefined ? undefined : Number(row.usePublished) === 1,
        runtimeContext: row.runtimeContext ? this.parseJson(row.runtimeContext, null as Record<string, unknown> | null) : null,
        idempotencyKey: (row.idempotencyKey as string) ?? null,
        idempotencyRequestHash: (row.idempotencyRequestHash as string) ?? null,
        status: row.status as IAgentRun['status'],
        errorReason: (row.errorReason as IAgentRun['errorReason']) ?? null,
        stopReason: (row.stopReason as IAgentRun['stopReason']) ?? null,
        resumeActionIds: row.resumeActionIds ? this.parseJson(row.resumeActionIds, [] as string[]) : null,
        result: row.result ? this.parseJson(row.result, null as Record<string, unknown> | null) : null,
        errorMessage: (row.errorMessage as string) ?? null,
        cancelRequestedAt: this.toDate(row.cancelRequestedAt) ?? null,
        workerId: (row.workerId as string) ?? null,
        heartbeatAt: this.toDate(row.heartbeatAt) ?? null,
        callbackUrl: (row.callbackUrl as string) ?? null,
        callbackSecret: (row.callbackSecret as string) ?? null,
        maxDurationMs: row.maxDurationMs === null || row.maxDurationMs === undefined ? null : Number(row.maxDurationMs),
        callbackStatus: (row.callbackStatus as IAgentRun['callbackStatus']) ?? null,
        callbackAttempts: Number(row.callbackAttempts) || 0,
        userId: (row.userId as string) ?? undefined,
        apiTokenId: (row.apiTokenId as string) ?? undefined,
        actorType: (row.actorType as IAgentRun['actorType']) ?? undefined,
        runClass: (row.runClass as IAgentRun['runClass']) ?? undefined,
        notBefore: this.toDate(row.notBefore) ?? null,
        detachedAt: this.toDate(row.detachedAt) ?? null,
        metadata: row.metadata ? this.parseJson(row.metadata, null as Record<string, string> | null) : null,
        channel: (row.channel as IAgentRun['channel']) ?? null,
        triggerId: (row.triggerId as string) ?? null,
        trigger: (row.runTrigger as IAgentRun['trigger']) ?? null,
        responseFormat: row.responseFormat ? this.parseJson(row.responseFormat, null as IAgentRun['responseFormat']) : null,
        inputs: row.inputs ? this.parseJson(row.inputs, null as Record<string, unknown> | null) : null,
        queueGeneration: row.queueGeneration === null || row.queueGeneration === undefined ? undefined : Number(row.queueGeneration),
        lastPublishedAt: this.toDate(row.lastPublishedAt) ?? null,
        ...(Number(row.unattended) === 1 ? { unattended: true } : {}),
        ...(Number(row.externalContent) === 1 ? { externalContent: true } : {}),
        ...(Number(row.background) === 1 ? { background: true } : {}),
        callbackEventId: (row.callbackEventId as string) ?? null,
        resumeTrigger: (row.resumeTrigger as IAgentRun['resumeTrigger']) ?? null,
        resumeUserId: (row.resumeUserId as string) ?? null,
        resumeApiTokenId: (row.resumeApiTokenId as string) ?? null,
        accountableUserId: (row.accountableUserId as string) ?? null,
        accountableTokenId: (row.accountableTokenId as string) ?? null,
        createdAt: this.toDate(row.createdAt),
        startedAt: this.toDate(row.startedAt) ?? null,
        completedAt: this.toDate(row.completedAt) ?? null,
        expiresAt: this.toDate(row.expiresAt) ?? null,
        updatedAt: this.toDate(row.updatedAt),
      };
    }
  };
}
