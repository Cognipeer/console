import type { DatabaseProvider } from './provider.interface';

/**
 * Runs `fn` bound to the tenant database for its entire (sync + async)
 * execution, using the provider's AsyncLocalStorage-based `runWithTenant`.
 * Falls back to `switchToTenant` only for partial providers (test doubles)
 * that do not implement `runWithTenant`.
 *
 * Takes the provider as an argument and never resolves it itself, so callers
 * keep their own `getDatabase()` binding (and its test mocks). Code that has
 * no provider in hand uses `runWithTenantScope` from `@/lib/database`.
 */
export async function runInTenant<T>(
  db: DatabaseProvider,
  tenantDbName: string,
  fn: (db: DatabaseProvider) => T | Promise<T>,
): Promise<T> {
  if (typeof db.runWithTenant === 'function') {
    return db.runWithTenant(tenantDbName, () => fn(db));
  }
  await db.switchToTenant(tenantDbName);
  return fn(db);
}
