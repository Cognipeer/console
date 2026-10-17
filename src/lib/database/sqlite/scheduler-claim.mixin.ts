/**
 * SQLite Provider – scheduler claims mixin
 *
 * Exactly-once primitive for replicated schedulers: the claim key is the
 * PRIMARY KEY, so the DATABASE decides the single winner.
 */

import type { Constructor } from './types';
import { SQLiteProviderBase, TABLES } from './base';

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function SchedulerClaimMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class SchedulerClaimOps extends Base {
    async claimSchedulerSlot(key: string, expiresAt: Date): Promise<boolean> {
      const db = this.getTenantDb();
      try {
        db.prepare(
          `INSERT INTO ${TABLES.schedulerClaims} (key, created_at, expires_at) VALUES (@key, @createdAt, @expiresAt)`,
        ).run({ key, createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString() });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    }

    async cleanupSchedulerClaims(olderThan: Date): Promise<number> {
      const db = this.getTenantDb();
      const res = db
        .prepare(`DELETE FROM ${TABLES.schedulerClaims} WHERE expires_at < @olderThan`)
        .run({ olderThan: olderThan.toISOString() });
      return res.changes;
    }
  };
}
