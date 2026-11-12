/**
 * Job-side services (analysis, crawler, OCR jobs, batch) bind their tenant for
 * their whole execution (`runWithTenantScope`). Backed by a real SQLiteProvider.
 *
 * Two properties pin that, both deterministic:
 *  - the services never move the shared handle (`switchToTenant`), which work
 *    for another tenant running at the same time could overwrite between a
 *    switch and a query;
 *  - each call lands in its own tenant even when it runs inside an enclosing
 *    scope bound to the other tenant.
 * Reverting any of these services to `getDatabase()` + `switchToTenant()` fails
 * both cases.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + temp dir must be configured BEFORE getDatabase() is ever called.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-analysis-scope-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'analysis_scope_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider } from '@/lib/database';
import { createDefinition, getDefinition, listDefinitions } from '@/lib/services/analysis/service';
import { createCrawler, listCrawlers } from '@/lib/services/crawler/crawlerService';
import { listOcrJobs } from '@/lib/services/ocrJobs/ocrJobService';
import { listBatches } from '@/lib/services/batch/batchService';

interface Tenant {
  dbName: string;
  id: string;
  names: string[];
}

/** A fresh pair of tenants per case, so each case starts from empty databases. */
function tenantsFor(tag: string): [Tenant, Tenant] {
  return [
    { dbName: `analysis_scope_${tag}_a`, id: `tenant-${tag}-a`, names: ['A one', 'A two', 'A three'] },
    { dbName: `analysis_scope_${tag}_b`, id: `tenant-${tag}-b`, names: ['B one', 'B two'] },
  ];
}

let db: DatabaseProvider;

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function work(tenant: Tenant) {
  const created = await Promise.all(
    tenant.names.map((name) =>
      createDefinition(tenant.dbName, tenant.id, 'tester@example.com', {
        name,
        fieldSet: [{ key: 'intent', type: 'string' }],
        modes: {},
      }),
    ),
  );
  await createCrawler(
    { tenantDbName: tenant.dbName, tenantId: tenant.id },
    { name: `${tenant.id} crawler`, key: `${tenant.id}-crawler`, createdBy: 'tester@example.com' },
  );

  const [definitions, first, crawlers, ocrJobs, batches] = await Promise.all([
    listDefinitions(tenant.dbName),
    getDefinition(tenant.dbName, created[0].id),
    listCrawlers({ tenantDbName: tenant.dbName, tenantId: tenant.id }),
    listOcrJobs({ tenantDbName: tenant.dbName, tenantId: tenant.id, userId: 'tester' }),
    listBatches({ tenantDbName: tenant.dbName, tenantId: tenant.id }),
  ]);
  return { definitions, first, crawlers, ocrJobs, batches };
}

function expectOwnData(tenant: Tenant, result: Awaited<ReturnType<typeof work>>) {
  expect(result.definitions.map((d) => d.name).sort()).toEqual([...tenant.names].sort());
  expect(result.first?.name).toBe(tenant.names[0]);
  expect(result.crawlers.map((c) => c.key)).toEqual([`${tenant.id}-crawler`]);
  expect(result.ocrJobs).toEqual([]);
  expect(result.batches).toEqual([]);
}

/** Runs `fn` inside a scope bound to `tenantDbName` (the caller's ambient tenant). */
function enclosing<T>(tenantDbName: string, fn: () => Promise<T>): Promise<T> {
  if (typeof db.runWithTenant !== 'function') throw new Error('provider has no runWithTenant');
  return db.runWithTenant(tenantDbName, fn);
}

describe('Job-side services — two tenants at the same time', () => {
  it('keeps each tenant on its own database while their work interleaves, without moving the shared handle', async () => {
    const [a, b] = tenantsFor('interleaved');
    const switches = vi.spyOn(db, 'switchToTenant');

    const [ra, rb] = await Promise.all([work(a), work(b)]);

    expect(switches).not.toHaveBeenCalled();
    expectOwnData(a, ra);
    expectOwnData(b, rb);
  });

  it('lands each call in its own tenant inside an enclosing scope bound to the other tenant', async () => {
    const [a, b] = tenantsFor('enclosed');
    const switches = vi.spyOn(db, 'switchToTenant');

    const [ra, rb] = await Promise.all([
      enclosing(b.dbName, () => work(a)),
      enclosing(a.dbName, () => work(b)),
    ]);

    expect(switches).not.toHaveBeenCalled();
    expectOwnData(a, ra);
    expectOwnData(b, rb);
  });
});
