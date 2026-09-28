/**
 * The `engine` column added to `pii_policies` for the PII engine selector
 * (`PiiEngine` — see its own doc comment in types.domain.ts), driven against
 * a REAL SQLite provider rather than a mocked mixin — the thing worth
 * proving is that `ensureTableColumn`'s migration, the INSERT/UPDATE column
 * lists, and `mapPiiPolicyRow` all agree on the same column, including the
 * pre-existing-row case (absent = 'regex', never a stored empty string).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SQLiteProvider } from '@/lib/database/sqlite.provider';

const TENANT_DB = 'pii_engine_sqlite_test';

let tmpDir = '';
let db: SQLiteProvider;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-pii-engine-sqlite-'));
  db = new SQLiteProvider(tmpDir, 'pii_engine_main');
  await db.connect();
  await db.switchToTenant(TENANT_DB);
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('pii_policies · engine column', () => {
  it('round-trips an explicit engine through create/read', async () => {
    const created = await db.createPiiPolicy({
      tenantId: 't1',
      key: 'cognipeer-policy',
      name: 'Cognipeer policy',
      defaultAction: 'detect',
      engine: 'cognipeer',
      categories: { email: true },
      customPatterns: [],
      languages: [],
      enabled: true,
      createdBy: 'u1',
    });
    expect(created.engine).toBe('cognipeer');

    const fetched = await db.findPiiPolicyById(String(created._id));
    expect(fetched?.engine).toBe('cognipeer');
  });

  it('defaults to undefined (not an empty string) when engine is omitted — callers treat that as "regex"', async () => {
    const created = await db.createPiiPolicy({
      tenantId: 't1',
      key: 'no-engine-policy',
      name: 'No engine specified',
      defaultAction: 'detect',
      categories: {},
      customPatterns: [],
      languages: [],
      enabled: true,
      createdBy: 'u1',
    });
    expect(created.engine).toBeUndefined();

    const fetched = await db.findPiiPolicyById(String(created._id));
    expect(fetched?.engine).toBeUndefined();
  });

  it('updatePiiPolicy changes the stored engine', async () => {
    const created = await db.createPiiPolicy({
      tenantId: 't1',
      key: 'switchable-policy',
      name: 'Switchable',
      defaultAction: 'detect',
      engine: 'regex',
      categories: {},
      customPatterns: [],
      languages: [],
      enabled: true,
      createdBy: 'u1',
    });

    const updated = await db.updatePiiPolicy(String(created._id), { engine: 'cognipeer', updatedBy: 'u1' });
    expect(updated?.engine).toBe('cognipeer');

    const fetched = await db.findPiiPolicyById(String(created._id));
    expect(fetched?.engine).toBe('cognipeer');
  });
});
