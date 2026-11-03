/**
 * `models.piiProtection` against a REAL SQLite provider: the column migration,
 * the INSERT/UPDATE lists and the row mapper agree, and null turns it off.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SQLiteProvider } from '@/lib/database/sqlite.provider';

let tmpDir = '';
let db: SQLiteProvider;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-model-pii-'));
  db = new SQLiteProvider(tmpDir, 'model_pii_main');
  await db.connect();
  await db.switchToTenant('model_pii_tenant');
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const base = {
  tenantId: 't1', projectId: 'p1', name: 'M', providerKey: 'prov', providerDriver: 'openai',
  category: 'llm' as const, modelId: 'gpt-4o', settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
};

describe('models · piiProtection column', () => {
  it('is absent on a model that never set it', async () => {
    const created = await db.createModel({ ...base, key: 'plain' });
    expect((await db.findModelByKey('plain', 'p1'))?.piiProtection ?? undefined).toBeUndefined();
    expect(created.piiProtection ?? undefined).toBeUndefined();
  });

  it('round-trips through create, update and back off with null', async () => {
    const created = await db.createModel({ ...base, key: 'protected', piiProtection: { policyKey: 'tc-only' } });
    expect((await db.findModelByKey('protected', 'p1'))?.piiProtection).toEqual({ policyKey: 'tc-only' });

    await db.updateModel(String(created._id), { piiProtection: { policyKey: 'other' } });
    expect((await db.findModelByKey('protected', 'p1'))?.piiProtection).toEqual({ policyKey: 'other' });

    await db.updateModel(String(created._id), { piiProtection: null });
    expect((await db.findModelByKey('protected', 'p1'))?.piiProtection ?? undefined).toBeUndefined();
  });
});
