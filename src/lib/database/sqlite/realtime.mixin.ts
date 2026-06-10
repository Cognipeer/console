/**
 * SQLite Provider – Realtime (named models + session logs) mixin
 */

import type { IRealtimeModel, IRealtimeSessionLog, RealtimeSessionLogDelta } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function RealtimeMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class RealtimeOps extends Base {
    // ── Realtime models ──────────────────────────────────────────────
    async createRealtimeModel(
      record: Omit<IRealtimeModel, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRealtimeModel> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.realtimeModels}
        (id, tenantId, projectId, key, name, description, status,
         chatModelKey, instructions, temperature, maxOutputTokens,
         sttModelKey, inputAudioFormat, ttsModelKey, voice, ttsFormat,
         turnSilenceMs, turnSilenceThreshold, greeting, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @status,
         @chatModelKey, @instructions, @temperature, @maxOutputTokens,
         @sttModelKey, @inputAudioFormat, @ttsModelKey, @voice, @ttsFormat,
         @turnSilenceMs, @turnSilenceThreshold, @greeting, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        key: record.key,
        name: record.name,
        description: record.description ?? null,
        status: record.status ?? 'active',
        chatModelKey: record.chatModelKey,
        instructions: record.instructions ?? null,
        temperature: record.temperature ?? null,
        maxOutputTokens: record.maxOutputTokens ?? null,
        sttModelKey: record.sttModelKey ?? null,
        inputAudioFormat: record.inputAudioFormat ?? null,
        ttsModelKey: record.ttsModelKey ?? null,
        voice: record.voice ?? null,
        ttsFormat: record.ttsFormat ?? null,
        turnSilenceMs: record.turnSilenceMs ?? null,
        turnSilenceThreshold: record.turnSilenceThreshold ?? null,
        greeting: record.greeting ?? null,
        metadata: this.toJson(record.metadata ?? {}),
        createdBy: record.createdBy,
        updatedBy: record.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateRealtimeModel(
      id: string,
      data: Partial<Omit<IRealtimeModel, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IRealtimeModel | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      const scalarFields = [
        'projectId', 'key', 'name', 'description', 'status', 'chatModelKey',
        'instructions', 'sttModelKey', 'inputAudioFormat', 'ttsModelKey',
        'voice', 'ttsFormat', 'greeting', 'updatedBy',
      ];
      for (const f of scalarFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      const numberFields = ['temperature', 'maxOutputTokens', 'turnSilenceMs', 'turnSilenceThreshold'];
      for (const f of numberFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      if (data.metadata !== undefined) {
        sets.push('metadata = @metadata');
        params.metadata = this.toJson(data.metadata ?? {});
      }
      db.prepare(`UPDATE ${TABLES.realtimeModels} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRealtimeModelById(id);
    }

    async findRealtimeModelById(id: string): Promise<IRealtimeModel | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.realtimeModels} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapRealtimeModel(row) : null;
    }

    async findRealtimeModelByKey(key: string, projectId?: string): Promise<IRealtimeModel | null> {
      const db = this.getTenantDb();
      const conds = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId) {
        conds.push('(projectId = @projectId OR projectId IS NULL)');
        params.projectId = projectId;
      }
      const row = db
        .prepare(`SELECT * FROM ${TABLES.realtimeModels} WHERE ${conds.join(' AND ')} ORDER BY projectId IS NULL LIMIT 1`)
        .get(params) as SqliteRow | undefined;
      return row ? this.mapRealtimeModel(row) : null;
    }

    async listRealtimeModels(
      tenantId: string,
      filters?: { projectId?: string; status?: string; limit?: number },
    ): Promise<IRealtimeModel[]> {
      const db = this.getTenantDb();
      const conds = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) { conds.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status) { conds.push('status = @status'); params.status = filters.status; }
      let sql = `SELECT * FROM ${TABLES.realtimeModels} WHERE ${conds.join(' AND ')} ORDER BY createdAt DESC`;
      if (filters?.limit && filters.limit > 0) sql += ` LIMIT ${Math.min(filters.limit, 500)}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapRealtimeModel(r));
    }

    async deleteRealtimeModel(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.realtimeModels} WHERE id = @id`).run({ id }).changes === 1;
    }

    private mapRealtimeModel(row: SqliteRow): IRealtimeModel {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        key: row.key as string,
        name: row.name as string,
        description: (row.description as string) ?? undefined,
        status: row.status as IRealtimeModel['status'],
        chatModelKey: row.chatModelKey as string,
        instructions: (row.instructions as string) ?? undefined,
        temperature: row.temperature == null ? undefined : Number(row.temperature),
        maxOutputTokens: row.maxOutputTokens == null ? undefined : Number(row.maxOutputTokens),
        sttModelKey: (row.sttModelKey as string) ?? undefined,
        inputAudioFormat: (row.inputAudioFormat as string) ?? undefined,
        ttsModelKey: (row.ttsModelKey as string) ?? undefined,
        voice: (row.voice as string) ?? undefined,
        ttsFormat: (row.ttsFormat as string) ?? undefined,
        turnSilenceMs: row.turnSilenceMs == null ? undefined : Number(row.turnSilenceMs),
        turnSilenceThreshold: row.turnSilenceThreshold == null ? undefined : Number(row.turnSilenceThreshold),
        greeting: (row.greeting as string) ?? undefined,
        metadata: this.parseJson(row.metadata, {}),
        createdBy: row.createdBy as string,
        updatedBy: (row.updatedBy as string) ?? undefined,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    // ── Realtime session logs ────────────────────────────────────────
    async createRealtimeSessionLog(
      record: Omit<IRealtimeSessionLog, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRealtimeSessionLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.realtimeSessions}
        (id, tenantId, projectId, sessionId, realtimeModelKey, chatModelKey,
         transport, status, responseCount, inputAudioSeconds,
         usageInputTokens, usageOutputTokens, usageTotalTokens,
         firstTokenLatencyMs, errorMessage, clientInfo,
         startedAt, endedAt, durationMs, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @sessionId, @realtimeModelKey, @chatModelKey,
         @transport, @status, @responseCount, @inputAudioSeconds,
         @usageInputTokens, @usageOutputTokens, @usageTotalTokens,
         @firstTokenLatencyMs, @errorMessage, @clientInfo,
         @startedAt, @endedAt, @durationMs, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        sessionId: record.sessionId,
        realtimeModelKey: record.realtimeModelKey ?? null,
        chatModelKey: record.chatModelKey ?? null,
        transport: record.transport,
        status: record.status,
        responseCount: record.responseCount ?? 0,
        inputAudioSeconds: record.inputAudioSeconds ?? 0,
        usageInputTokens: record.usageInputTokens ?? 0,
        usageOutputTokens: record.usageOutputTokens ?? 0,
        usageTotalTokens: record.usageTotalTokens ?? 0,
        firstTokenLatencyMs: record.firstTokenLatencyMs ?? null,
        errorMessage: record.errorMessage ?? null,
        clientInfo: record.clientInfo ? this.toJson(record.clientInfo) : null,
        startedAt: new Date(record.startedAt).toISOString(),
        endedAt: record.endedAt ? new Date(record.endedAt).toISOString() : null,
        durationMs: record.durationMs ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateRealtimeSessionLog(
      id: string,
      data: Partial<Omit<IRealtimeSessionLog, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IRealtimeSessionLog | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      const scalarFields = ['status', 'errorMessage', 'realtimeModelKey', 'chatModelKey', 'transport'];
      for (const f of scalarFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      const numberFields = [
        'responseCount', 'inputAudioSeconds', 'usageInputTokens',
        'usageOutputTokens', 'usageTotalTokens', 'firstTokenLatencyMs', 'durationMs',
      ];
      for (const f of numberFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      if (data.clientInfo !== undefined) {
        sets.push('clientInfo = @clientInfo');
        params.clientInfo = data.clientInfo == null ? null : this.toJson(data.clientInfo);
      }
      if (data.endedAt !== undefined) {
        sets.push('endedAt = @endedAt');
        params.endedAt = data.endedAt ? new Date(data.endedAt).toISOString() : null;
      }
      db.prepare(`UPDATE ${TABLES.realtimeSessions} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRealtimeSessionLogById(id);
    }

    async incrementRealtimeSessionLog(
      id: string,
      delta: RealtimeSessionLogDelta,
    ): Promise<IRealtimeSessionLog | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      for (const [field, value] of Object.entries(delta)) {
        if (typeof value === 'number' && value !== 0) {
          sets.push(`${field} = ${field} + @${field}`);
          params[field] = value;
        }
      }
      db.prepare(`UPDATE ${TABLES.realtimeSessions} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRealtimeSessionLogById(id);
    }

    private async findRealtimeSessionLogById(id: string): Promise<IRealtimeSessionLog | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.realtimeSessions} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapRealtimeSessionLog(row) : null;
    }

    async listRealtimeSessionLogs(
      tenantId: string,
      filters?: {
        projectId?: string;
        realtimeModelKey?: string;
        transport?: string;
        status?: string;
        from?: Date;
        to?: Date;
        limit?: number;
        skip?: number;
      },
    ): Promise<IRealtimeSessionLog[]> {
      const db = this.getTenantDb();
      const conds = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) { conds.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.realtimeModelKey) { conds.push('realtimeModelKey = @realtimeModelKey'); params.realtimeModelKey = filters.realtimeModelKey; }
      if (filters?.transport) { conds.push('transport = @transport'); params.transport = filters.transport; }
      if (filters?.status) { conds.push('status = @status'); params.status = filters.status; }
      if (filters?.from) { conds.push('startedAt >= @from'); params.from = new Date(filters.from).toISOString(); }
      if (filters?.to) { conds.push('startedAt <= @to'); params.to = new Date(filters.to).toISOString(); }
      let sql = `SELECT * FROM ${TABLES.realtimeSessions} WHERE ${conds.join(' AND ')} ORDER BY startedAt DESC`;
      if (filters?.limit) sql += ` LIMIT ${Math.min(filters.limit, 1000)}`;
      if (filters?.skip) sql += ` OFFSET ${filters.skip}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapRealtimeSessionLog(r));
    }

    private mapRealtimeSessionLog(row: SqliteRow): IRealtimeSessionLog {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        sessionId: row.sessionId as string,
        realtimeModelKey: (row.realtimeModelKey as string) ?? undefined,
        chatModelKey: (row.chatModelKey as string) ?? undefined,
        transport: row.transport as IRealtimeSessionLog['transport'],
        status: row.status as IRealtimeSessionLog['status'],
        responseCount: Number(row.responseCount) || 0,
        inputAudioSeconds: Number(row.inputAudioSeconds) || 0,
        usageInputTokens: Number(row.usageInputTokens) || 0,
        usageOutputTokens: Number(row.usageOutputTokens) || 0,
        usageTotalTokens: Number(row.usageTotalTokens) || 0,
        firstTokenLatencyMs: row.firstTokenLatencyMs == null ? undefined : Number(row.firstTokenLatencyMs),
        errorMessage: (row.errorMessage as string) ?? undefined,
        clientInfo: row.clientInfo
          ? this.parseJson(row.clientInfo, undefined as unknown as Record<string, unknown>)
          : undefined,
        startedAt: this.toDate(row.startedAt) ?? new Date(0),
        endedAt: this.toDate(row.endedAt),
        durationMs: row.durationMs == null ? undefined : Number(row.durationMs),
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }
  };
}
