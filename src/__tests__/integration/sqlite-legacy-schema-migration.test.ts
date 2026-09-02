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
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';

const LEGACY_DB_NAME = 'tenant_legacy_schema';
const LEGACY_MODEL_ID = 'legacy-model-1';
const LEGACY_PROJECT_ID = 'project-legacy';

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

  // 2026-08-28: the SAME bug recurred with vector_migration_logs.attempt.
  // Simulate a tenant DB whose vector_migration_logs predates that column, so
  // an index over it in TENANT_SCHEMA_SQL would abort the script again.
  legacy.exec(`
    CREATE TABLE vector_migration_logs (
      id TEXT PRIMARY KEY,
      tenantId TEXT NOT NULL,
      projectId TEXT,
      migrationKey TEXT NOT NULL,
      batchIndex INTEGER NOT NULL,
      vectorIds TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      migratedCount INTEGER NOT NULL DEFAULT 0,
      failedCount INTEGER NOT NULL DEFAULT 0,
      errorMessage TEXT,
      durationMs INTEGER,
      createdAt TEXT NOT NULL
    );
  `);
  // 2026-09-01: the multi-guardrail binding added `models.guardrails`. Legacy
  // tenant DBs only gain it via ensureTableColumn, and the column's NULL is the
  // "never authored" sentinel that keeps a pre-existing model falling back to
  // inputGuardrailKey/outputGuardrailKey. Simulate a pre-column `models` table
  // carrying one legacy-bound row, so the migration AND that fallback are
  // guarded permanently rather than by a one-off manual policy.
  legacy.exec(`
    CREATE TABLE models (
      id TEXT PRIMARY KEY,
      tenantId TEXT NOT NULL,
      projectId TEXT,
      name TEXT NOT NULL,
      description TEXT,
      key TEXT NOT NULL,
      providerKey TEXT NOT NULL,
      providerDriver TEXT NOT NULL DEFAULT '',
      provider TEXT,
      category TEXT NOT NULL DEFAULT 'llm',
      modelId TEXT NOT NULL,
      isMultimodal INTEGER DEFAULT 0,
      supportsToolCalls INTEGER DEFAULT 0,
      settings TEXT DEFAULT '{}',
      pricing TEXT DEFAULT '{}',
      semanticCache TEXT,
      inputGuardrailKey TEXT,
      outputGuardrailKey TEXT,
      metadata TEXT DEFAULT '{}',
      createdBy TEXT,
      updatedBy TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  legacy
    .prepare(
      `INSERT INTO models (id, tenantId, projectId, name, key, providerKey, providerDriver,
                           category, modelId, inputGuardrailKey, outputGuardrailKey,
                           createdAt, updatedAt)
       VALUES (@id, @tenantId, @projectId, @name, @key, @providerKey, @providerDriver,
               @category, @modelId, @inputGuardrailKey, @outputGuardrailKey,
               @createdAt, @updatedAt)`,
    )
    .run({
      id: LEGACY_MODEL_ID,
      tenantId: 'tenant-legacy',
      projectId: LEGACY_PROJECT_ID,
      name: 'Legacy bound model',
      key: 'legacy-bound-model',
      providerKey: 'openai',
      providerDriver: 'openai',
      category: 'llm',
      modelId: 'gpt-4o-mini',
      inputGuardrailKey: 'legacy-input-guardrail',
      outputGuardrailKey: 'legacy-output-guardrail',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

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
    const policy = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), {
      readonly: true,
    });
    const cols = policy
      .prepare(`PRAGMA table_info(model_usage_logs)`)
      .all() as Array<{ name: string }>;
    policy.close();
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('userId')).toBe(true);
    expect(names.has('apiTokenId')).toBe(true);
    expect(names.has('actorType')).toBe(true);
  });

  it('creates idx_model_usage_user after the column migration', () => {
    const policy = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), {
      readonly: true,
    });
    const idx = policy
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_model_usage_user'`,
      )
      .get();
    policy.close();
    expect(idx).toBeTruthy();
  });

  it('creates idx_vml_migrationKey_attempt after the column migration', () => {
    // Second occurrence of the same class of bug (2026-08-28): this index sat
    // in TENANT_SCHEMA_SQL over vector_migration_logs.attempt, which legacy DBs
    // only gain via ensureTableColumn. Every tenant open failed with
    // "no such column: attempt", visible as scheduler errors across the app.
    const policy = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), {
      readonly: true,
    });
    const cols = policy
      .prepare(`PRAGMA table_info(vector_migration_logs)`)
      .all() as Array<{ name: string }>;
    const idx = policy
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_vml_migrationKey_attempt'`,
      )
      .get();
    policy.close();
    expect(cols.some((c) => c.name === 'attempt')).toBe(true);
    expect(idx).toBeTruthy();
  });

  it('adds models.guardrails via migration, with no DEFAULT', () => {
    const policy = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), {
      readonly: true,
    });
    const cols = policy
      .prepare(`PRAGMA table_info(models)`)
      .all() as Array<{ name: string; dflt_value: string | null }>;
    policy.close();
    const guardrails = cols.find((c) => c.name === 'guardrails');
    expect(guardrails).toBeTruthy();
    // A DEFAULT '[]' would tell every pre-existing model "authored, bound to
    // nothing" and disarm its legacy keys on upgrade. NULL is the sentinel.
    expect(guardrails?.dflt_value ?? null).toBeNull();
  });

  it('reads a pre-column model back as guardrails: undefined, legacy keys intact', async () => {
    const model = await provider.findModelById(LEGACY_MODEL_ID, LEGACY_PROJECT_ID);
    expect(model).toBeTruthy();
    // `undefined`, never `[]`: resolveBindings reads undefined as "fall back to
    // the two legacy columns" and `[]` as "authored, bound to nothing".
    expect(model?.guardrails).toBeUndefined();
    expect(model?.inputGuardrailKey).toBe('legacy-input-guardrail');
    expect(model?.outputGuardrailKey).toBe('legacy-output-guardrail');
  });

  it('resolves the migrated legacy row exactly as it did before the column existed', async () => {
    const model = await provider.findModelById(LEGACY_MODEL_ID, LEGACY_PROJECT_ID);
    expect(resolveBindings(model!, 'input.pre')).toEqual(['legacy-input-guardrail']);
    expect(resolveBindings(model!, 'output.pre')).toEqual(['legacy-output-guardrail']);
    expect(resolveBindings(model!, 'output.stream.delta')).toEqual(['legacy-output-guardrail']);
    // Nothing legacy binds to the tool hooks — a row written before the hook
    // plane never opted into tool enforcement.
    expect(resolveBindings(model!, 'tool.pre')).toEqual([]);
    expect(resolveBindings(model!, 'tool.post')).toEqual([]);
  });

  it('writes and reads back a binding list on the migrated row', async () => {
    const updated = await provider.updateModel(LEGACY_MODEL_ID, {
      guardrails: [
        { key: 'pii', hooks: ['input.pre'] },
        { key: 'tool-policy', hooks: ['tool.pre', 'tool.post'] },
      ],
    });
    expect(updated?.guardrails).toHaveLength(2);
    // Re-read from the DB, not the update's return value: the mapper is one of
    // the four whitelist sites a new column has to reach.
    const reread = await provider.findModelById(LEGACY_MODEL_ID, LEGACY_PROJECT_ID);
    expect(reread?.guardrails).toEqual([
      { key: 'pii', hooks: ['input.pre'] },
      { key: 'tool-policy', hooks: ['tool.pre', 'tool.post'] },
    ]);
    // The list is authoritative: the still-populated legacy columns are ignored.
    expect(reread?.inputGuardrailKey).toBe('legacy-input-guardrail');
    expect(resolveBindings(reread!, 'output.pre')).toEqual([]);
    expect(resolveBindings(reread!, 'tool.pre')).toEqual(['tool-policy']);
  });

  it('completes the rest of the schema script (usage_daily now exists)', () => {
    // Before the fix the schema exec aborted at the bad index statement, so
    // every table declared after model_usage_logs was silently missing too.
    const policy = new Database(path.join(tmpDir, `${LEGACY_DB_NAME}.db`), {
      readonly: true,
    });
    const table = policy
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_daily'`,
      )
      .get();
    policy.close();
    expect(table).toBeTruthy();
  });
});
