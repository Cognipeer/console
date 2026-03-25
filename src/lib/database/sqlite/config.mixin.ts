/**
 * SQLite Provider – Config (Secret/Configuration Management) operations mixin
 *
 * Two-level hierarchy: ConfigGroup → ConfigItem
 * Includes audit logs for tenant-scoped configuration management.
 */

import type {
  IConfigGroup,
  IConfigItem,
  IConfigAuditLog,
  ConfigValueType,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function ConfigMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class ConfigOps extends Base {
    // ── Config Group operations ──────────────────────────────────────

    async createConfigGroup(
      group: Omit<IConfigGroup, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IConfigGroup> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.configGroups}
        (id, tenantId, projectId, key, name, description,
         tags, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description,
         @tags, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: group.tenantId,
        projectId: group.projectId ?? null,
        key: group.key,
        name: group.name,
        description: group.description ?? null,
        tags: this.toJson(group.tags ?? []),
        metadata: this.toJson(group.metadata ?? {}),
        createdBy: group.createdBy,
        updatedBy: group.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return {
        ...group,
        _id: id,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      } as IConfigGroup;
    }

    async updateConfigGroup(
      id: string,
      data: Partial<Omit<IConfigGroup, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IConfigGroup | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.tags !== undefined) { sets.push('tags = @tags'); params.tags = this.toJson(data.tags); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(
        `UPDATE ${TABLES.configGroups} SET ${sets.join(', ')} WHERE id = @id`,
      ).run(params);

      const row = db.prepare(
        `SELECT * FROM ${TABLES.configGroups} WHERE id = @id`,
      ).get({ id }) as SqliteRow | undefined;
      if (!row) return null;
      return this.mapConfigGroupRow(row);
    }

    async deleteConfigGroup(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(
        `DELETE FROM ${TABLES.configGroups} WHERE id = @id`,
      ).run({ id });
      return result.changes === 1;
    }

    async findConfigGroupById(id: string): Promise<IConfigGroup | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.configGroups} WHERE id = @id`,
      ).get({ id }) as SqliteRow | undefined;
      if (!row) return null;
      return this.mapConfigGroupRow(row);
    }

    async findConfigGroupByKey(key: string, projectId?: string): Promise<IConfigGroup | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.configGroups} WHERE key = @key`;
      const params: Record<string, unknown> = { key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      if (!row) return null;
      return this.mapConfigGroupRow(row);
    }

    async listConfigGroups(filters?: {
      projectId?: string;
      tags?: string[];
      search?: string;
    }): Promise<IConfigGroup[]> {
      const db = this.getTenantDb();
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId) { conditions.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.search) {
        conditions.push('(name LIKE @search OR key LIKE @search OR description LIKE @search)');
        params.search = `%${filters.search}%`;
      }

      let sql = `SELECT * FROM ${TABLES.configGroups}`;
      if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
      sql += ' ORDER BY key ASC';

      let rows = db.prepare(sql).all(params) as SqliteRow[];

      if (filters?.tags && filters.tags.length > 0) {
        rows = rows.filter((r) => {
          const rowTags = this.parseJson<string[]>(r.tags, []);
          return filters.tags!.every((t) => rowTags.includes(t));
        });
      }

      return rows.map((r) => this.mapConfigGroupRow(r));
    }

    async countConfigGroups(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(*) as cnt FROM ${TABLES.configGroups}`;
      const params: Record<string, unknown> = {};
      if (projectId) { sql += ' WHERE projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as { cnt: number };
      return row.cnt;
    }

    // ── Config Item operations ───────────────────────────────────────

    async createConfigItem(
      item: Omit<IConfigItem, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IConfigItem> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.configItems}
        (id, tenantId, projectId, groupId, key, name, description,
         value, valueType, isSecret, tags,
         version, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @groupId, @key, @name, @description,
         @value, @valueType, @isSecret, @tags,
         @version, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: item.tenantId,
        projectId: item.projectId ?? null,
        groupId: item.groupId,
        key: item.key,
        name: item.name,
        description: item.description ?? null,
        value: item.value,
        valueType: item.valueType,
        isSecret: item.isSecret ? 1 : 0,
        tags: this.toJson(item.tags ?? []),
        version: item.version,
        metadata: this.toJson(item.metadata ?? {}),
        createdBy: item.createdBy,
        updatedBy: item.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return {
        ...item,
        _id: id,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      } as IConfigItem;
    }

    async updateConfigItem(
      id: string,
      data: Partial<Omit<IConfigItem, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IConfigItem | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.value !== undefined) { sets.push('value = @value'); params.value = data.value; }
      if (data.valueType !== undefined) { sets.push('valueType = @valueType'); params.valueType = data.valueType; }
      if (data.isSecret !== undefined) { sets.push('isSecret = @isSecret'); params.isSecret = data.isSecret ? 1 : 0; }
      if (data.tags !== undefined) { sets.push('tags = @tags'); params.tags = this.toJson(data.tags); }
      if (data.version !== undefined) { sets.push('version = @version'); params.version = data.version; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(
        `UPDATE ${TABLES.configItems} SET ${sets.join(', ')} WHERE id = @id`,
      ).run(params);

      const row = db.prepare(
        `SELECT * FROM ${TABLES.configItems} WHERE id = @id`,
      ).get({ id }) as SqliteRow | undefined;
      if (!row) return null;
      return this.mapConfigItemRow(row);
    }

    async deleteConfigItem(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(
        `DELETE FROM ${TABLES.configItems} WHERE id = @id`,
      ).run({ id });
      return result.changes === 1;
    }

    async deleteConfigItemsByGroupId(groupId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = db.prepare(
        `DELETE FROM ${TABLES.configItems} WHERE groupId = @groupId`,
      ).run({ groupId });
      return result.changes;
    }

    async findConfigItemById(id: string): Promise<IConfigItem | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.configItems} WHERE id = @id`,
      ).get({ id }) as SqliteRow | undefined;
      if (!row) return null;
      return this.mapConfigItemRow(row);
    }

    async findConfigItemByKey(
      key: string,
      projectId?: string,
    ): Promise<IConfigItem | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.configItems} WHERE key = @key`;
      const params: Record<string, unknown> = { key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      if (!row) return null;
      return this.mapConfigItemRow(row);
    }

    async listConfigItems(filters?: {
      projectId?: string;
      groupId?: string;
      isSecret?: boolean;
      tags?: string[];
      search?: string;
    }): Promise<IConfigItem[]> {
      const db = this.getTenantDb();
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId) { conditions.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.groupId) { conditions.push('groupId = @groupId'); params.groupId = filters.groupId; }
      if (filters?.isSecret !== undefined) { conditions.push('isSecret = @isSecret'); params.isSecret = filters.isSecret ? 1 : 0; }
      if (filters?.search) {
        conditions.push('(name LIKE @search OR key LIKE @search OR description LIKE @search)');
        params.search = `%${filters.search}%`;
      }

      let sql = `SELECT * FROM ${TABLES.configItems}`;
      if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
      sql += ' ORDER BY key ASC';

      let rows = db.prepare(sql).all(params) as SqliteRow[];

      if (filters?.tags && filters.tags.length > 0) {
        rows = rows.filter((r) => {
          const rowTags = this.parseJson<string[]>(r.tags, []);
          return filters.tags!.every((t) => rowTags.includes(t));
        });
      }

      return rows.map((r) => this.mapConfigItemRow(r));
    }

    async countConfigItems(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(*) as cnt FROM ${TABLES.configItems}`;
      const params: Record<string, unknown> = {};
      if (projectId) { sql += ' WHERE projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as { cnt: number };
      return row.cnt;
    }

    // ── Config Audit Log operations ──────────────────────────────────

    async createConfigAuditLog(
      log: Omit<IConfigAuditLog, '_id' | 'createdAt'>,
    ): Promise<IConfigAuditLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.configAuditLogs}
        (id, tenantId, projectId, configKey, action,
         previousValue, newValue, version,
         performedBy, ipAddress, userAgent, metadata, createdAt)
        VALUES (@id, @tenantId, @projectId, @configKey, @action,
         @previousValue, @newValue, @version,
         @performedBy, @ipAddress, @userAgent, @metadata, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        configKey: log.configKey,
        action: log.action,
        previousValue: log.previousValue ?? null,
        newValue: log.newValue ?? null,
        version: log.version ?? null,
        performedBy: log.performedBy,
        ipAddress: log.ipAddress ?? null,
        userAgent: log.userAgent ?? null,
        metadata: this.toJson(log.metadata ?? {}),
        createdAt: now,
      });

      return {
        ...log,
        _id: id,
        createdAt: new Date(now),
      } as IConfigAuditLog;
    }

    async listConfigAuditLogs(
      configKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    ): Promise<IConfigAuditLog[]> {
      const db = this.getTenantDb();
      const conditions: string[] = ['configKey = @configKey'];
      const params: Record<string, unknown> = { configKey };

      if (options?.from) {
        conditions.push('createdAt >= @from');
        params.from = options.from.toISOString();
      }
      if (options?.to) {
        conditions.push('createdAt <= @to');
        params.to = options.to.toISOString();
      }

      let sql = `SELECT * FROM ${TABLES.configAuditLogs} WHERE ${conditions.join(' AND ')} ORDER BY createdAt DESC`;
      if (options?.limit) sql += ` LIMIT ${options.limit}`;
      if (options?.skip) sql += ` OFFSET ${options.skip}`;

      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapConfigAuditLogRow(r));
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapConfigGroupRow(r: SqliteRow): IConfigGroup {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        tags: this.parseJson<string[]>(r.tags, []),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapConfigItemRow(r: SqliteRow): IConfigItem {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        groupId: r.groupId as string,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        value: r.value as string,
        valueType: r.valueType as ConfigValueType,
        isSecret: !!(r.isSecret as number),
        tags: this.parseJson<string[]>(r.tags, []),
        version: r.version as number,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapConfigAuditLogRow(r: SqliteRow): IConfigAuditLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        configKey: r.configKey as string,
        action: r.action as IConfigAuditLog['action'],
        previousValue: r.previousValue as string | undefined,
        newValue: r.newValue as string | undefined,
        version: r.version as number | undefined,
        performedBy: r.performedBy as string,
        ipAddress: r.ipAddress as string | undefined,
        userAgent: r.userAgent as string | undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
