/**
 * An on-prem tenant database that predates group quotas.
 *
 * `quota_policies` there has no `groupMode` column. Opening the tenant adds it
 * idempotently, the old rows read back untouched (no mode, same limits), and a
 * second open is a no-op. Nothing is migrated or rewritten.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';

const DB_NAME = 'tenant_legacy_quota';
const TENANT_ID = 'tenant-legacy';

let tmpDir: string;

function columns(): string[] {
  const raw = new Database(path.join(tmpDir, `${DB_NAME}.db`), { readonly: true });
  try {
    return (raw.prepare('PRAGMA table_info(quota_policies)').all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    raw.close();
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-legacy-quota-'));
  const legacy = new Database(path.join(tmpDir, `${DB_NAME}.db`));
  // The table exactly as it shipped before group scope: no groupMode column.
  legacy.exec(`
    CREATE TABLE quota_policies (
      id TEXT PRIMARY KEY,
      tenantId TEXT NOT NULL,
      projectId TEXT,
      scope TEXT NOT NULL,
      scopeId TEXT,
      domain TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      label TEXT,
      description TEXT,
      limits TEXT NOT NULL DEFAULT '{}',
      createdBy TEXT,
      updatedBy TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    INSERT INTO quota_policies (id, tenantId, projectId, scope, scopeId, domain, priority, enabled, label, limits, createdAt, updatedAt)
    VALUES ('legacy-1', '${TENANT_ID}', 'proj-1', 'user', 'u-1', 'llm', 50, 1, 'Legacy cap',
      '{"rateLimit":{"requests":{"perMinute":12}}}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('quota_policies on a pre-group-scope tenant database', () => {
  it('has no groupMode column to begin with', () => {
    expect(columns()).not.toContain('groupMode');
  });

  it('gains the column when the tenant is opened, and reads old rows back unchanged', async () => {
    const provider = new SQLiteProvider(tmpDir, 'legacy_main');
    await provider.connect();
    try {
      await provider.switchToTenant(DB_NAME);

      const rows = await provider.listQuotaPolicies(TENANT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        _id: 'legacy-1', scope: 'user', scopeId: 'u-1', domain: 'llm', priority: 50, enabled: true, label: 'Legacy cap',
        limits: { rateLimit: { requests: { perMinute: 12 } } },
      });
      expect(rows[0].groupMode).toBeUndefined();
      expect(await provider.listTenantWideQuotaPolicies(TENANT_ID)).toEqual([]);

      // New rows can now carry a mode, next to the old one.
      const group = await provider.createQuotaPolicy({
        tenantId: TENANT_ID, scope: 'group', scopeId: 'g-1', groupMode: 'shared', domain: 'agent',
        priority: 10, enabled: true, limits: { rateLimit: { requests: { perDay: 100 } } },
      });
      expect((await provider.listTenantWideQuotaPolicies(TENANT_ID)).map((p) => String(p._id))).toEqual([String(group._id)]);
      expect((await provider.listTenantWideQuotaPolicies(TENANT_ID))[0].groupMode).toBe('shared');
    } finally {
      await provider.disconnect();
    }
    expect(columns()).toContain('groupMode');
  });

  it('is idempotent: opening the migrated database again changes nothing', async () => {
    const before = columns();
    const provider = new SQLiteProvider(tmpDir, 'legacy_main');
    await provider.connect();
    try {
      await provider.switchToTenant(DB_NAME);
      expect((await provider.listQuotaPolicies(TENANT_ID)).map((p) => String(p._id)).sort()).toHaveLength(2);
    } finally {
      await provider.disconnect();
    }
    expect(columns()).toEqual(before);
  });
});
