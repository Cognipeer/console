/**
 * Guardrail and word-list services under concurrent load from two tenants.
 *
 * Real SQLite provider. Every public function binds its tenant for its whole
 * body (`runWithTenantScope`), so interleaved calls for different tenants each
 * read and write their own tenant database and never the other one's. They never
 * move the shared handle (`switchToTenant`); reverting the services to a bare
 * switch fails both cases.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-guardrail-scope-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'guardrail_scope_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider } from '@/lib/database';
import {
  createGuardrail,
  getGuardrailByKey,
  listGuardrails,
} from '@/lib/services/guardrail/guardrailService';
import {
  createWordList,
  listWordLists,
  resolveCustomWordLists,
} from '@/lib/services/guardrail/wordListService';

const TENANTS = [
  { dbName: 'guardrail_scope_a', id: 'tenant-a', slug: 'scope-a' },
  { dbName: 'guardrail_scope_b', id: 'tenant-b', slug: 'scope-b' },
] as const;
const ROUNDS = 6;

let db: DatabaseProvider;

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  for (const tenant of TENANTS) {
    await db.createTenant({
      companyName: tenant.slug,
      slug: tenant.slug,
      dbName: tenant.dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
  }
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('guardrail services keep two tenants apart under concurrency', () => {
  it('writes and reads guardrails interleaved across tenants without crossing', async () => {
    const switches = vi.spyOn(db, 'switchToTenant');
    await Promise.all(
      Array.from({ length: ROUNDS }, (_, round) =>
        TENANTS.map((tenant) =>
          createGuardrail(tenant.dbName, tenant.id, 'user', {
            name: `${tenant.slug} guardrail ${round}`,
            action: 'block',
          }),
        ),
      ).flat(),
    );

    const lists = await Promise.all(
      Array.from({ length: ROUNDS }, () =>
        TENANTS.map(async (tenant) => ({ tenant, rows: await listGuardrails(tenant.dbName) })),
      ).flat(),
    );

    for (const { tenant, rows } of lists) {
      expect(rows).toHaveLength(ROUNDS);
      for (const row of rows) {
        expect(row.tenantId).toBe(tenant.id);
        expect(row.name.startsWith(tenant.slug)).toBe(true);
      }
    }

    const [aRow, bRow] = await Promise.all(
      TENANTS.map((tenant) => getGuardrailByKey(tenant.dbName, `${tenant.slug}-guardrail-0`)),
    );
    expect(aRow?.tenantId).toBe('tenant-a');
    expect(bRow?.tenantId).toBe('tenant-b');
    expect(await getGuardrailByKey(TENANTS[0].dbName, `${TENANTS[1].slug}-guardrail-0`)).toBeNull();
    expect(switches).not.toHaveBeenCalled();
  });

  it('resolves the same word-list key to each tenant\'s own words', async () => {
    const switches = vi.spyOn(db, 'switchToTenant');
    await Promise.all(
      TENANTS.map((tenant) =>
        createWordList(tenant.dbName, tenant.id, 'user', {
          name: 'shared name',
          words: [`${tenant.slug}-word`],
        }),
      ),
    );

    const resolved = await Promise.all(
      Array.from({ length: ROUNDS }, () =>
        TENANTS.map(async (tenant) => ({
          tenant,
          lists: await resolveCustomWordLists(tenant.dbName, undefined, ['shared-name']),
          summaries: await listWordLists(tenant.dbName),
        })),
      ).flat(),
    );

    for (const { tenant, lists, summaries } of resolved) {
      expect(lists).toEqual([{ key: 'shared-name', words: [`${tenant.slug}-word`] }]);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].tenantId).toBe(tenant.id);
    }
    expect(switches).not.toHaveBeenCalled();
  });
});
