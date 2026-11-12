/**
 * Analysis entry points bind their tenant for their whole execution
 * (`runWithTenantScope`), so work for two tenants running at the same time
 * reads and writes each tenant's own database. Backed by a real SQLiteProvider.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + temp dir must be configured BEFORE getDatabase() is ever called.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-analysis-scope-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'analysis_scope_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { createDefinition, listDefinitions } from '@/lib/services/analysis/service';

const TENANTS = [
  { dbName: 'analysis_scope_tenant_a', id: 'tenant-a', names: ['A one', 'A two', 'A three'] },
  { dbName: 'analysis_scope_tenant_b', id: 'tenant-b', names: ['B one', 'B two'] },
];

beforeAll(async () => {
  reloadConfig();
  await getDatabase();
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Analysis service — two tenants at the same time', () => {
  it('keeps each tenant on its own database while their work interleaves', async () => {
    await Promise.all(
      TENANTS.flatMap((tenant) =>
        tenant.names.map((name) =>
          createDefinition(tenant.dbName, tenant.id, 'tester@example.com', {
            name,
            fieldSet: [{ key: 'intent', type: 'string' }],
          }),
        ),
      ),
    );

    // Reads of both tenants run together, with no switchToTenant in between.
    const [a, b] = await Promise.all(TENANTS.map((tenant) => listDefinitions(tenant.dbName)));

    expect(a.map((d) => d.name).sort()).toEqual([...TENANTS[0].names].sort());
    expect(b.map((d) => d.name).sort()).toEqual([...TENANTS[1].names].sort());
  });
});
