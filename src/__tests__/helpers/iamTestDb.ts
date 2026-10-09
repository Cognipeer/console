/**
 * Shared harness for the policy-engine tests: a real SQLite provider in a temp
 * dir, wired in as the `getDatabase()` of `@/lib/database`.
 *
 * Usage (the vi.mock must live in the test file, vitest hoists it there):
 *
 *   const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
 *   vi.mock('@/lib/database', async (orig) => ({ ...(await orig<...>()), getDatabase: hoisted.getDatabase }));
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';

export interface IamTestDb {
  db: SQLiteProvider;
  tenantId: string;
  tenantDbName: string;
  cleanup: () => Promise<void>;
}

export async function createIamTestDb(tenantDbName = 'tenant_iam'): Promise<IamTestDb> {
  const dir = mkdtempSync(path.join(tmpdir(), 'iam-test-'));
  const db = new SQLiteProvider(dir, 'iam_main');
  await db.connect();
  const tenant = await db.createTenant({
    companyName: 'Iam Co',
    slug: `iam-${Math.random().toString(36).slice(2, 8)}`,
    dbName: tenantDbName,
    licenseType: 'FREE',
    ownerId: 'owner-pending',
  });
  await db.switchToTenant(tenantDbName);
  return {
    db,
    tenantId: String(tenant._id),
    tenantDbName,
    cleanup: async () => {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Deterministic PRNG so a failing fuzz run can be replayed with IAM_FUZZ_SEED. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
