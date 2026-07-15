/**
 * Regression test — opening a LEGACY tenant DB must not fail on new
 * schema-script indexes.
 *
 * 2026-07-15 incident: TENANT_SCHEMA_SQL contained
 * `CREATE INDEX ... ON model_usage_logs(tenantId, userId, ...)`, but legacy
 * tenant DBs (created before the usage-attribution feature) only gain the
 * userId column via the ensureTableColumn migration that runs AFTER the
 * schema script. The index statement aborted the whole schema exec with
 * "no such column: userId", so switchToTenant failed for every pre-existing
 * tenant (crawler-scheduler: "Error processing tenant ...").
 *
 * Rule enforced here: indexes over migration-added columns belong in
 * applyTenantIndexes (post-migration), never in TENANT_SCHEMA_SQL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';

const LEGACY_DB_NAME = 'tenant_legacy_schema';

let tmpDir: string;
let provider: SQLiteProvider;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-legacy-schema-test-'));

  // Simulate a pre-attribution tenant DB: model_usage_logs exists WITHOUT
  // the userId/apiTokenId/actorType columns (and without the new index).
  const legacy = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`));
  legacy.exec(`
    CREATE TABLE model_usage_logs (
      id TEXT PRIMARY KEY,
      tenantId TEXT NOT NULL,
      projectId TEXT,
      modelKey TEXT NOT NULL,
      modelId TEXT,
      requestId TEXT NOT NULL,
      route TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      providerRequest TEXT DEFAULT '{}',
      providerResponse TEXT DEFAULT '{}',
      errorMessage TEXT,
      latencyMs INTEGER,
      inputTokens INTEGER NOT NULL DEFAULT 0,
      outputTokens INTEGER NOT NULL DEFAULT 0,
      cachedInputTokens INTEGER DEFAULT 0,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      toolCalls INTEGER DEFAULT 0,
      cacheHit INTEGER DEFAULT 0,
      pricingSnapshot TEXT,
      routing TEXT,
      createdAt TEXT NOT NULL
    );
  `);
  legacy.close();
});

afterAll(async () => {
  await provider?.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Legacy tenant DB schema migration', () => {
  it('switchToTenant succeeds on a pre-attribution tenant DB', async () => {
    provider = new SQLiteProvider(tmpDir, 'test_main');
    await provider.connect();
    await expect(
      provider.switchToTenant(LEGACY_DB_NAME),
    ).resolves.not.toThrow();
  });

  it('adds the attribution columns via migration', () => {
    const check = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), {
      readonly: true,
    });
    const cols = check
      .prepare(`PRAGMA table_info(model_usage_logs)`)
      .all() as Array<{ name: string }>;
    check.close();
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('userId')).toBe(true);
    expect(names.has('apiTokenId')).toBe(true);
    expect(names.has('actorType')).toBe(true);
  });

  it('creates idx_model_usage_user after the column migration', () => {
    const check = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), {
      readonly: true,
    });
    const idx = check
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_model_usage_user'`,
      )
      .get();
    check.close();
    expect(idx).toBeTruthy();
  });

  it('completes the rest of the schema script (usage_daily now exists)', () => {
    // Before the fix the schema exec aborted at the bad index statement, so
    // every table declared after model_usage_logs was silently missing too.
    const check = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), {
      readonly: true,
    });
    const table = check
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_daily'`,
      )
      .get();
    check.close();
    expect(table).toBeTruthy();
  });
});
