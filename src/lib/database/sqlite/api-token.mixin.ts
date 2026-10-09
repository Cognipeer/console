/**
 * SQLite Provider – API Token operations mixin
 */

import type { IApiToken } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function ApiTokenMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class ApiTokenOps extends Base {

    async createApiToken(tokenData: Omit<IApiToken, '_id' | 'createdAt'>): Promise<IApiToken> {
      const db = this.getMainDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.apiTokens} (id, userId, tenantId, projectId, label, tokenHash, tokenPrefix, servicePermissions, createdBy, lastUsed, createdAt, expiresAt, allowedIpRanges)
        VALUES (@id, @userId, @tenantId, @projectId, @label, @tokenHash, @tokenPrefix, @servicePermissions, @createdBy, @lastUsed, @createdAt, @expiresAt, @allowedIpRanges)
      `).run({
        id,
        userId: tokenData.userId,
        tenantId: tokenData.tenantId,
        projectId: tokenData.projectId ?? null,
        label: tokenData.label,
        tokenHash: tokenData.tokenHash,
        tokenPrefix: tokenData.tokenPrefix,
        servicePermissions: tokenData.servicePermissions != null
          ? JSON.stringify(tokenData.servicePermissions)
          : null,
        createdBy: tokenData.createdBy ?? null,
        lastUsed: tokenData.lastUsed?.toISOString() ?? null,
        createdAt: now,
        expiresAt: tokenData.expiresAt?.toISOString() ?? null,
        // JSON array of CIDR strings; NULL = unrestricted (every pre-existing row).
        allowedIpRanges: tokenData.allowedIpRanges?.length
          ? JSON.stringify(tokenData.allowedIpRanges)
          : null,
      });

      return { ...tokenData, _id: id, createdAt: new Date(now) };
    }

    async listApiTokens(userId: string): Promise<IApiToken[]> {
      const db = this.getMainDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE userId = @userId ORDER BY createdAt DESC`)
        .all({ userId }) as SqliteRow[];
      return rows.map((r) => this.mapTokenRow(r));
    }

    async listTenantApiTokens(tenantId: string): Promise<IApiToken[]> {
      const db = this.getMainDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE tenantId = @tenantId ORDER BY createdAt DESC`)
        .all({ tenantId }) as SqliteRow[];
      return rows.map((r) => this.mapTokenRow(r));
    }

    async listProjectApiTokens(tenantId: string, projectId: string): Promise<IApiToken[]> {
      const db = this.getMainDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE tenantId = @tenantId AND projectId = @projectId ORDER BY createdAt DESC`)
        .all({ tenantId, projectId }) as SqliteRow[];
      return rows.map((r) => this.mapTokenRow(r));
    }

    async findApiTokenByHash(tokenHash: string): Promise<IApiToken | null> {
      const db = this.getMainDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE tokenHash = @tokenHash`)
        .get({ tokenHash }) as SqliteRow | undefined;
      return row ? this.mapTokenRow(row) : null;
    }

    async findApiTokenById(id: string, tenantId: string): Promise<IApiToken | null> {
      const db = this.getMainDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE id = @id AND tenantId = @tenantId`)
        .get({ id, tenantId }) as SqliteRow | undefined;
      return row ? this.mapTokenRow(row) : null;
    }

    async updateApiToken(
      id: string,
      tenantId: string,
      data: { label?: string; expiresAt?: Date | null; allowedIpRanges?: string[] | null },
    ): Promise<IApiToken | null> {
      const db = this.getMainDb();
      // Column names are fixed literals; only values are bound.
      const sets: string[] = [];
      const params: Record<string, unknown> = { id, tenantId };
      if (data.label !== undefined) {
        sets.push('label = @label');
        params.label = data.label;
      }
      if (data.expiresAt !== undefined) {
        sets.push('expiresAt = @expiresAt');
        params.expiresAt = data.expiresAt ? data.expiresAt.toISOString() : null;
      }
      if (data.allowedIpRanges !== undefined) {
        sets.push('allowedIpRanges = @allowedIpRanges');
        params.allowedIpRanges = data.allowedIpRanges?.length ? JSON.stringify(data.allowedIpRanges) : null;
      }
      if (sets.length > 0) {
        const result = db
          .prepare(`UPDATE ${TABLES.apiTokens} SET ${sets.join(', ')} WHERE id = @id AND tenantId = @tenantId`)
          .run(params);
        if (result.changes === 0) return null;
      }
      return this.findApiTokenById(id, tenantId);
    }

    async deleteApiToken(id: string, userId: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = db.prepare(`DELETE FROM ${TABLES.apiTokens} WHERE id = @id AND userId = @userId`)
        .run({ id, userId });
      return result.changes > 0;
    }

    async deleteTenantApiToken(id: string, tenantId: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = db.prepare(`DELETE FROM ${TABLES.apiTokens} WHERE id = @id AND tenantId = @tenantId`)
        .run({ id, tenantId });
      return result.changes > 0;
    }

    async deleteProjectApiToken(id: string, tenantId: string, projectId: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = db.prepare(`DELETE FROM ${TABLES.apiTokens} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .run({ id, tenantId, projectId });
      return result.changes > 0;
    }

    async updateTokenLastUsedByHash(tokenHash: string): Promise<void> {
      const db = this.getMainDb();
      db.prepare(`UPDATE ${TABLES.apiTokens} SET lastUsed = @lastUsed WHERE tokenHash = @tokenHash`)
        .run({ tokenHash, lastUsed: this.now() });
    }

    protected mapTokenRow(r: SqliteRow): IApiToken {
      return {
        _id: r.id as string,
        userId: r.userId as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        label: r.label as string,
        token: r.token as string | undefined,
        tokenHash: r.tokenHash as string | undefined,
        tokenPrefix: r.tokenPrefix as string | undefined,
        servicePermissions: r.servicePermissions
          ? JSON.parse(r.servicePermissions as string)
          : null,
        createdBy: r.createdBy as string | undefined,
        lastUsed: this.toDate(r.lastUsed),
        createdAt: this.toDate(r.createdAt),
        expiresAt: this.toDate(r.expiresAt),
        allowedIpRanges: this.parseAllowedIpRanges(r.allowedIpRanges),
      };
    }

    /**
     * The stored allowlist. NULL / empty = unrestricted. A value that is not a
     * JSON array of strings is NOT read as unrestricted: it comes back as a
     * list whose entries cannot match anything, so a damaged restriction
     * denies instead of silently unlocking the token.
     */
    protected parseAllowedIpRanges(raw: unknown): string[] | null {
      if (raw === null || raw === undefined || raw === '') return null;
      if (typeof raw !== 'string') return [String(raw)];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.length === 0 ? null : parsed.map((item) => String(item));
        return [String(parsed)];
      } catch {
        return [raw];
      }
    }
  };
}
