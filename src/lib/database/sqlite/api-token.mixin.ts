/**
 * SQLite Provider – API Token operations mixin
 */

import type { IApiToken } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function ApiTokenMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class ApiTokenOps extends Base {

    async createApiToken(tokenData: Omit<IApiToken, '_id' | 'createdAt'>): Promise<IApiToken> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.apiTokens} (id, userId, tenantId, projectId, label, token, lastUsed, createdAt, expiresAt)
        VALUES (@id, @userId, @tenantId, @projectId, @label, @token, @lastUsed, @createdAt, @expiresAt)
      `).run({
        id,
        userId: tokenData.userId,
        tenantId: tokenData.tenantId,
        projectId: tokenData.projectId ?? null,
        label: tokenData.label,
        token: tokenData.token,
        lastUsed: tokenData.lastUsed?.toISOString() ?? null,
        createdAt: now,
        expiresAt: tokenData.expiresAt?.toISOString() ?? null,
      });

      return { ...tokenData, _id: id, createdAt: new Date(now) };
    }

    async listApiTokens(userId: string): Promise<IApiToken[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE userId = @userId ORDER BY createdAt DESC`)
        .all({ userId }) as SqliteRow[];
      return rows.map((r) => this.mapTokenRow(r));
    }

    async listTenantApiTokens(tenantId: string): Promise<IApiToken[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE tenantId = @tenantId ORDER BY createdAt DESC`)
        .all({ tenantId }) as SqliteRow[];
      return rows.map((r) => this.mapTokenRow(r));
    }

    async listProjectApiTokens(tenantId: string, projectId: string): Promise<IApiToken[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE tenantId = @tenantId AND projectId = @projectId ORDER BY createdAt DESC`)
        .all({ tenantId, projectId }) as SqliteRow[];
      return rows.map((r) => this.mapTokenRow(r));
    }

    async findApiTokenByToken(token: string): Promise<IApiToken | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE token = @token`)
        .get({ token }) as SqliteRow | undefined;
      return row ? this.mapTokenRow(row) : null;
    }

    async deleteApiToken(id: string, userId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(`DELETE FROM ${TABLES.apiTokens} WHERE id = @id AND userId = @userId`)
        .run({ id, userId });
      return result.changes > 0;
    }

    async deleteTenantApiToken(id: string, tenantId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(`DELETE FROM ${TABLES.apiTokens} WHERE id = @id AND tenantId = @tenantId`)
        .run({ id, tenantId });
      return result.changes > 0;
    }

    async deleteProjectApiToken(id: string, tenantId: string, projectId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(`DELETE FROM ${TABLES.apiTokens} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .run({ id, tenantId, projectId });
      return result.changes > 0;
    }

    async updateTokenLastUsed(token: string): Promise<void> {
      const db = this.getTenantDb();
      db.prepare(`UPDATE ${TABLES.apiTokens} SET lastUsed = @lastUsed WHERE token = @token`)
        .run({ token, lastUsed: this.now() });
    }

    protected mapTokenRow(r: SqliteRow): IApiToken {
      return {
        _id: r.id as string,
        userId: r.userId as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        label: r.label as string,
        token: r.token as string,
        lastUsed: this.toDate(r.lastUsed),
        createdAt: this.toDate(r.createdAt),
        expiresAt: this.toDate(r.expiresAt),
      };
    }
  };
}
