/**
 * Integration — a PRE-HOOK-PLANE tenant database opens, migrates and reads back.
 *
 * This exists for one failure mode in particular. `base.ts` runs the whole
 * schema script BEFORE the column migrations, so a CREATE INDEX naming a
 * not-yet-added column aborts the ENTIRE schema exec and leaves every later
 * table uncreated — the shape of the 2026-07-15 incident that base.ts already
 * documents three times over. `idx_guardrail_eval_hook` names `hook`, a column
 * that only exists after migration, so it is created in applyTenantIndexes()
 * rather than in the schema. Nothing but a real legacy database proves that,
 * because on a fresh one the column is there from the start and the ordering
 * bug is invisible.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';

const DB = 'tenant_legacy_hooks';
let tmpDir: string;
let provider: SQLiteProvider;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-hookmig-'));
  const legacy = new Database(path.join(tmpDir, `${DB}.db`));
  legacy.exec(`
    CREATE TABLE guardrails (
      id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, projectId TEXT, key TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT, type TEXT NOT NULL DEFAULT 'preset',
      action TEXT NOT NULL DEFAULT 'block', enabled INTEGER NOT NULL DEFAULT 1,
      modelKey TEXT, policy TEXT DEFAULT '{}', customPrompt TEXT, metadata TEXT DEFAULT '{}',
      createdBy TEXT NOT NULL, updatedBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE guardrail_evaluation_logs (
      id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, projectId TEXT, guardrailId TEXT NOT NULL,
      guardrailKey TEXT NOT NULL, guardrailName TEXT NOT NULL, guardrailType TEXT NOT NULL,
      target TEXT NOT NULL, action TEXT NOT NULL, passed INTEGER NOT NULL DEFAULT 1,
      findings TEXT DEFAULT '[]', inputText TEXT, latencyMs INTEGER, source TEXT,
      requestId TEXT, message TEXT, createdAt TEXT NOT NULL
    );
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, projectId TEXT, key TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT, openApiSpec TEXT, tools TEXT DEFAULT '[]',
      upstreamBaseUrl TEXT, upstreamAuth TEXT DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active',
      endpointSlug TEXT NOT NULL, totalRequests INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
      createdBy TEXT NOT NULL, updatedBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
  `);
  legacy.prepare(`INSERT INTO guardrails (id,tenantId,key,name,type,action,enabled,policy,metadata,createdBy,createdAt,updatedAt)
    VALUES ('g1','t1','legacy-key','Legacy','preset','flag',1,'{"pii":{"enabled":true}}','{}','u1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  legacy.close();

  provider = new SQLiteProvider(tmpDir, 'hookmig_main');
  await provider.connect();
  await provider.switchToTenant(DB);
});

afterAll(async () => {
  await provider?.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('legacy tenant DB gains the hook-plane columns', () => {
  it('migrates guardrails / eval logs / mcp_servers and creates the hook index', async () => {
    const db = new Database(path.join(tmpDir, `${DB}.db`), { readonly: true });
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('guardrails')).toEqual(expect.arrayContaining(['hooks', 'hooksVersion', 'mode', 'target', 'failMode']));
    expect(cols('guardrail_evaluation_logs')).toEqual(expect.arrayContaining(['hook', 'decision', 'riskScore']));
    expect(cols('mcp_servers')).toEqual(expect.arrayContaining(['aegis', 'guardrail']));
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain('idx_guardrail_eval_hook');
    db.close();

    // The pre-existing row reads back as "not authored", not as an empty config.
    const found = await provider.findGuardrailByKey('legacy-key');
    expect(found?.hooks).toBeUndefined();
    expect(found?.hooksVersion).toBe(0);
    expect(found?.mode).toBe('enforce');
  });
});
