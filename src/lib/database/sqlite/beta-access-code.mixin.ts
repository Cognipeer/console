/**
 * SQLite Provider – Beta access code operations mixin
 *
 * Codes live in the MAIN database: they gate public signup, which happens
 * before any tenant exists.
 */

import type {
  BetaAccessCodeStatus,
  IBetaAccessCode,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

function normalizeBetaAccessCode(code: string): string {
  return code.trim().toUpperCase();
}

export function BetaAccessCodeMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class BetaAccessCodeOps extends Base {
    async createBetaAccessCode(
      record: { code: string; note?: string | null },
    ): Promise<IBetaAccessCode> {
      const db = this.getMainDb();
      const code = normalizeBetaAccessCode(record.code);

      db.prepare(`
        INSERT INTO ${TABLES.betaAccessCodes}
        (code, status, note, usedByEmail, usedAt, createdAt)
        VALUES (@code, 'active', @note, NULL, NULL, @createdAt)
        ON CONFLICT(code) DO NOTHING
      `).run({
        code,
        note: record.note ?? null,
        createdAt: this.now(),
      });

      const row = db
        .prepare(`SELECT * FROM ${TABLES.betaAccessCodes} WHERE code = ?`)
        .get(code) as SqliteRow;
      return this.mapBetaAccessCodeRow(row);
    }

    async findBetaAccessCode(code: string): Promise<IBetaAccessCode | null> {
      const db = this.getMainDb();
      const row = db
        .prepare(`SELECT * FROM ${TABLES.betaAccessCodes} WHERE code = ?`)
        .get(normalizeBetaAccessCode(code)) as SqliteRow | undefined;
      return row ? this.mapBetaAccessCodeRow(row) : null;
    }

    async listBetaAccessCodes(
      filters: { status?: BetaAccessCodeStatus } = {},
    ): Promise<IBetaAccessCode[]> {
      const db = this.getMainDb();
      const where = filters.status ? 'WHERE status = @status' : '';
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.betaAccessCodes}
        ${where}
        ORDER BY createdAt ASC
      `).all(filters.status ? { status: filters.status } : {}) as SqliteRow[];
      return rows.map((row) => this.mapBetaAccessCodeRow(row));
    }

    async consumeBetaAccessCode(
      code: string,
      usedBy: { email: string },
    ): Promise<boolean> {
      const db = this.getMainDb();
      const result = db.prepare(`
        UPDATE ${TABLES.betaAccessCodes}
        SET status = 'used', usedByEmail = @email, usedAt = @usedAt
        WHERE code = @code AND status = 'active'
      `).run({
        code: normalizeBetaAccessCode(code),
        email: usedBy.email,
        usedAt: new Date().toISOString(),
      });
      return result.changes > 0;
    }

    async releaseBetaAccessCode(code: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = db.prepare(`
        UPDATE ${TABLES.betaAccessCodes}
        SET status = 'active', usedByEmail = NULL, usedAt = NULL
        WHERE code = @code AND status = 'used'
      `).run({ code: normalizeBetaAccessCode(code) });
      return result.changes > 0;
    }

    // ── Row mappers ─────────────────────────────────────────────────

    private mapBetaAccessCodeRow(row: SqliteRow): IBetaAccessCode {
      return {
        code: row.code as string,
        status: row.status as BetaAccessCodeStatus,
        note: (row.note as string | null) ?? null,
        usedByEmail: (row.usedByEmail as string | null) ?? null,
        usedAt: this.toDate(row.usedAt) ?? null,
        createdAt: this.toDate(row.createdAt) ?? new Date(0),
      };
    }
  };
}
