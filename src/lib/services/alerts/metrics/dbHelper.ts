/**
 * DB-agnostic helper for alert metric collectors.
 *
 * Provides a unified interface for running aggregate queries against
 * either MongoDB or SQLite tenant databases.
 */

import { getConfig } from '@/lib/core/config';
import type { DatabaseProvider } from '@/lib/database';
import type { Db } from 'mongodb';

type SqliteDb = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

export type RawDb =
  | { type: 'mongodb'; db: Db }
  | { type: 'sqlite'; db: SqliteDb };

/**
 * Extract the raw underlying database handle from a DatabaseProvider.
 *
 * At runtime both providers expose a protected `getTenantDb()` method
 * that returns the provider-specific database handle.
 */
export function getRawDb(provider: DatabaseProvider): RawDb | null {
  const dbType = getConfig().database.provider;
  try {
    const raw = (provider as unknown as { getTenantDb(): unknown }).getTenantDb();
    if (!raw) return null;

    if (dbType === 'mongodb') {
      return { type: 'mongodb', db: raw as Db };
    }

    return { type: 'sqlite', db: raw as SqliteDb };
  } catch {
    return null;
  }
}
