/**
 * SQLite Provider – Tenant operations mixin
 */

import type { ITenant, ITenantUserDirectoryEntry } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function TenantMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class TenantOps extends Base {
    // ── Cross-tenant user directory (main DB) ────────────────────────

    async registerUserInDirectory(entry: ITenantUserDirectoryEntry): Promise<void> {
      const db = this.getMainDb();
      const now = this.now();
      const normalizedEmail = this.normalizeEmail(entry.email);

      db.prepare(`
        INSERT INTO ${TABLES.tenantUserDirectory} (email, tenantId, tenantSlug, tenantDbName, tenantCompanyName, createdAt, updatedAt)
        VALUES (@email, @tenantId, @tenantSlug, @tenantDbName, @tenantCompanyName, @createdAt, @updatedAt)
        ON CONFLICT(email, tenantId) DO UPDATE SET
          tenantSlug = @tenantSlug,
          tenantDbName = @tenantDbName,
          tenantCompanyName = @tenantCompanyName,
          updatedAt = @updatedAt
      `).run({
        email: normalizedEmail,
        tenantId: entry.tenantId,
        tenantSlug: entry.tenantSlug,
        tenantDbName: entry.tenantDbName,
        tenantCompanyName: entry.tenantCompanyName,
        createdAt: now,
        updatedAt: now,
      });
    }

    async unregisterUserFromDirectory(email: string, tenantId: string): Promise<void> {
      const db = this.getMainDb();
      db.prepare(`DELETE FROM ${TABLES.tenantUserDirectory} WHERE email = @email AND tenantId = @tenantId`)
        .run({ email: this.normalizeEmail(email), tenantId });
    }

    async listTenantsForUser(email: string): Promise<ITenantUserDirectoryEntry[]> {
      const db = this.getMainDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.tenantUserDirectory} WHERE email = @email`)
        .all({ email: this.normalizeEmail(email) }) as SqliteRow[];

      return rows.map((r) => ({
        email: r.email as string,
        tenantId: r.tenantId as string,
        tenantSlug: r.tenantSlug as string,
        tenantDbName: r.tenantDbName as string,
        tenantCompanyName: r.tenantCompanyName as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      }));
    }

    // ── Tenant CRUD (main DB) ────────────────────────────────────────

    async createTenant(
      tenantData: Omit<ITenant, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ITenant> {
      const db = this.getMainDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.tenants} (id, companyName, slug, dbName, licenseType, ownerId, createdAt, updatedAt)
        VALUES (@id, @companyName, @slug, @dbName, @licenseType, @ownerId, @createdAt, @updatedAt)
      `).run({
        id,
        companyName: tenantData.companyName,
        slug: tenantData.slug,
        dbName: tenantData.dbName,
        licenseType: tenantData.licenseType,
        ownerId: tenantData.ownerId ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return {
        ...tenantData,
        _id: id,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };
    }

    async findTenantBySlug(slug: string): Promise<ITenant | null> {
      const db = this.getMainDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.tenants} WHERE slug = @slug`)
        .get({ slug }) as SqliteRow | undefined;
      return row ? this.mapTenantRow(row) : null;
    }

    async findTenantById(id: string): Promise<ITenant | null> {
      const db = this.getMainDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.tenants} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      return row ? this.mapTenantRow(row) : null;
    }

    async listTenants(): Promise<ITenant[]> {
      const db = this.getMainDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.tenants}`).all() as SqliteRow[];
      return rows.map((r) => this.mapTenantRow(r));
    }

    async updateTenant(id: string, data: Partial<ITenant>): Promise<ITenant | null> {
      const db = this.getMainDb();
      const now = this.now();

      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.companyName !== undefined) { sets.push('companyName = @companyName'); params.companyName = data.companyName; }
      if (data.slug !== undefined) { sets.push('slug = @slug'); params.slug = data.slug; }
      if (data.dbName !== undefined) { sets.push('dbName = @dbName'); params.dbName = data.dbName; }
      if (data.licenseType !== undefined) { sets.push('licenseType = @licenseType'); params.licenseType = data.licenseType; }
      if (data.ownerId !== undefined) { sets.push('ownerId = @ownerId'); params.ownerId = data.ownerId; }

      db.prepare(`UPDATE ${TABLES.tenants} SET ${sets.join(', ')} WHERE id = @id`).run(params);

      return this.findTenantById(id);
    }

    protected mapTenantRow(r: SqliteRow): ITenant {
      return {
        _id: r.id as string,
        companyName: r.companyName as string,
        slug: r.slug as string,
        dbName: r.dbName as string,
        licenseType: r.licenseType as string,
        ownerId: r.ownerId as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
