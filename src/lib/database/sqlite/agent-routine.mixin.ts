/**
 * SQLite Provider – Agent routines mixin
 *
 * The trigger is one JSON column (`triggerSpec`; TRIGGER is an SQL keyword),
 * its dates as ISO strings. `nextFireAt` is its own column: the scheduler's
 * `(enabled, nextFireAt)` index reads it.
 */

import type { AgentRoutineTrigger, IAgentRoutine } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

type RoutinePatch = Partial<Omit<IAgentRoutine, '_id' | 'tenantId' | 'projectId' | 'agentKey' | 'createdAt' | 'createdBy'>>;

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

export function AgentRoutineMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AgentRoutineOps extends Base {
    private routineColumns(record: RoutinePatch): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      if (record.name !== undefined) out.name = record.name;
      if (record.description !== undefined) out.description = record.description ?? null;
      if (record.enabled !== undefined) out.enabled = this.toBoolInt(record.enabled);
      if (record.trigger !== undefined) {
        const trigger = record.trigger;
        out.triggerSpec = this.toJson(trigger.type === 'once' ? { ...trigger, runAt: iso(trigger.runAt) } : trigger);
      }
      if (record.prompt !== undefined) out.prompt = record.prompt;
      if (record.version !== undefined) out.version = record.version ?? null;
      if (record.runClass !== undefined) out.runClass = record.runClass;
      for (const key of ['inputs', 'metadata', 'callback', 'responseFormat'] as const) {
        if (record[key] !== undefined) out[key] = record[key] === null ? null : this.toJson(record[key]);
      }
      for (const key of ['nextFireAt', 'lastFireAt'] as const) {
        if (record[key] !== undefined) out[key] = iso(record[key]);
      }
      for (const key of ['lastRunId', 'lastStatus', 'lastError', 'updatedBy'] as const) {
        if (record[key] !== undefined) out[key] = record[key] ?? null;
      }
      return out;
    }

    async createAgentRoutine(record: Omit<IAgentRoutine, '_id' | 'createdAt' | 'updatedAt'>): Promise<IAgentRoutine> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      const columns: Record<string, unknown> = {
        id,
        tenantId: record.tenantId,
        projectId: record.projectId,
        agentKey: record.agentKey,
        createdBy: record.createdBy,
        createdAt: now,
        updatedAt: now,
        // Defaults for the optional columns a new routine leaves out.
        description: null, version: null, inputs: null, metadata: null, callback: null, responseFormat: null,
        nextFireAt: null, lastFireAt: null, lastRunId: null, lastStatus: null, lastError: null, updatedBy: null,
        ...this.routineColumns(record),
      };
      const names = Object.keys(columns);
      db.prepare(
        `INSERT INTO ${TABLES.agentRoutines} (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`,
      ).run(columns);
      return (await this.findAgentRoutineRaw(id))!;
    }

    private async findAgentRoutineRaw(id: string): Promise<IAgentRoutine | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${TABLES.agentRoutines} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAgentRoutine(row) : null;
    }

    async getAgentRoutine(id: string, tenantId: string, projectId: string): Promise<IAgentRoutine | null> {
      const row = this.getTenantDb()
        .prepare(`SELECT * FROM ${TABLES.agentRoutines} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .get({ id, tenantId, projectId }) as SqliteRow | undefined;
      return row ? this.mapAgentRoutine(row) : null;
    }

    async listAgentRoutines(filter: { tenantId: string; projectId: string; agentKey?: string }): Promise<IAgentRoutine[]> {
      const params: Record<string, unknown> = { tenantId: filter.tenantId, projectId: filter.projectId };
      let sql = `SELECT * FROM ${TABLES.agentRoutines} WHERE tenantId = @tenantId AND projectId = @projectId`;
      if (filter.agentKey) {
        sql += ' AND agentKey = @agentKey';
        params.agentKey = filter.agentKey;
      }
      const rows = this.getTenantDb().prepare(`${sql} ORDER BY createdAt ASC, rowid ASC`).all(params) as SqliteRow[];
      return rows.map((row) => this.mapAgentRoutine(row));
    }

    async updateAgentRoutine(id: string, tenantId: string, projectId: string, patch: RoutinePatch): Promise<IAgentRoutine | null> {
      const columns = { ...this.routineColumns(patch), updatedAt: this.now() };
      const sets = Object.keys(columns).map((name) => `${name} = @${name}`);
      const res = this.getTenantDb()
        .prepare(`UPDATE ${TABLES.agentRoutines} SET ${sets.join(', ')} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .run({ ...columns, id, tenantId, projectId });
      return res.changes === 1 ? this.findAgentRoutineRaw(id) : null;
    }

    async deleteAgentRoutine(id: string, tenantId: string, projectId: string): Promise<boolean> {
      return this.getTenantDb()
        .prepare(`DELETE FROM ${TABLES.agentRoutines} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .run({ id, tenantId, projectId }).changes === 1;
    }

    async deleteAgentRoutinesForAgent(tenantId: string, projectId: string, agentKey: string): Promise<number> {
      return this.getTenantDb()
        .prepare(`DELETE FROM ${TABLES.agentRoutines} WHERE tenantId = @tenantId AND projectId = @projectId AND agentKey = @agentKey`)
        .run({ tenantId, projectId, agentKey }).changes;
    }

    async listDueRoutines(now: Date, limit: number): Promise<IAgentRoutine[]> {
      const rows = this.getTenantDb()
        .prepare(`
          SELECT * FROM ${TABLES.agentRoutines}
          WHERE enabled = 1 AND nextFireAt IS NOT NULL AND nextFireAt <= @now
          ORDER BY nextFireAt ASC LIMIT @limit
        `)
        .all({ now: now.toISOString(), limit: Math.max(1, limit) }) as SqliteRow[];
      return rows.map((row) => this.mapAgentRoutine(row));
    }

    async advanceRoutineNextFire(id: string, from: Date, next: Date | null): Promise<boolean> {
      return this.getTenantDb()
        .prepare(`UPDATE ${TABLES.agentRoutines} SET nextFireAt = @next, updatedAt = @updatedAt WHERE id = @id AND nextFireAt = @from`)
        .run({ id, from: from.toISOString(), next: iso(next), updatedAt: this.now() }).changes === 1;
    }

    async setRoutineFireResult(
      id: string,
      result: { fireAt: Date; status: 'started' | 'failed'; runId?: string | null; error?: string | null },
    ): Promise<boolean> {
      // A failed fire started no run: the last run stays the one that did.
      const runIdSet = result.status === 'started' ? ', lastRunId = @runId' : '';
      return this.getTenantDb()
        .prepare(`
          UPDATE ${TABLES.agentRoutines}
          SET lastFireAt = @fireAt, lastStatus = @status, lastError = @error${runIdSet}
          WHERE id = @id AND (lastFireAt IS NULL OR lastFireAt <= @fireAt)
        `)
        .run({
          id,
          fireAt: result.fireAt.toISOString(),
          status: result.status,
          error: result.status === 'failed' ? result.error ?? null : null,
          ...(runIdSet ? { runId: result.runId ?? null } : {}),
        }).changes === 1;
    }

    private mapAgentRoutine(row: SqliteRow): IAgentRoutine {
      const spec = this.parseJson<Record<string, unknown>>(row.triggerSpec, { type: 'manual' });
      const trigger = (spec.type === 'once'
        ? { type: 'once', runAt: new Date(String(spec.runAt)) }
        : spec) as AgentRoutineTrigger;
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: row.projectId as string,
        agentKey: row.agentKey as string,
        name: row.name as string,
        description: (row.description as string) ?? null,
        enabled: this.fromBoolInt(row.enabled),
        trigger,
        prompt: (row.prompt as string) ?? '',
        inputs: row.inputs ? this.parseJson(row.inputs, null as Record<string, unknown> | null) : null,
        version: row.version === null || row.version === undefined ? null : Number(row.version),
        runClass: (row.runClass as IAgentRoutine['runClass']) ?? 'default',
        metadata: row.metadata ? this.parseJson(row.metadata, null as Record<string, string> | null) : null,
        callback: row.callback ? this.parseJson(row.callback, null as IAgentRoutine['callback']) : null,
        responseFormat: row.responseFormat ? this.parseJson(row.responseFormat, null as IAgentRoutine['responseFormat']) : null,
        nextFireAt: this.toDate(row.nextFireAt) ?? null,
        lastFireAt: this.toDate(row.lastFireAt) ?? null,
        lastRunId: (row.lastRunId as string) ?? null,
        lastStatus: (row.lastStatus as IAgentRoutine['lastStatus']) ?? null,
        lastError: (row.lastError as string) ?? null,
        createdBy: row.createdBy as string,
        updatedBy: (row.updatedBy as string) ?? null,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }
  };
}
