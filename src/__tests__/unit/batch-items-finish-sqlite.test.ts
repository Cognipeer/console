/**
 * Batch job items on a REAL SQLite provider: `finishReason` / `truncated` survive create, update and the row mapping.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SQLiteProvider } from '@/lib/database/sqlite.provider';

let tmpDir = '';
let db: SQLiteProvider;

const base = (index: number) => ({
  tenantId: 't1',
  batchId: 'b1',
  index,
  requestBody: { model: 'm' },
  status: 'pending' as const,
});

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-batch-items-'));
  db = new SQLiteProvider(tmpDir, 'batch_items_main');
  await db.connect();
  await db.switchToTenant('batch_items_tenant');
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('batch_job_items finishReason / truncated (sqlite)', () => {
  it('round-trips both through create', async () => {
    const [cut, done, plain] = await db.createBatchJobItems([
      { ...base(0), finishReason: 'length', truncated: true },
      { ...base(1), finishReason: 'stop', truncated: false },
      base(2),
    ]);

    expect(await db.findBatchJobItemById(String(cut._id))).toMatchObject({ finishReason: 'length', truncated: true });
    expect(await db.findBatchJobItemById(String(done._id))).toMatchObject({ finishReason: 'stop', truncated: false });
    const stored = await db.findBatchJobItemById(String(plain._id));
    expect(stored).not.toHaveProperty('finishReason');
    expect(stored).not.toHaveProperty('truncated');
  });

  it('round-trips both through update, and leaves them alone when the patch omits them', async () => {
    const [item] = await db.createBatchJobItems([base(3)]);
    const id = String(item._id);

    const updated = await db.updateBatchJobItem(id, { status: 'succeeded', finishReason: 'length', truncated: true });
    expect(updated).toMatchObject({ status: 'succeeded', finishReason: 'length', truncated: true });

    const again = await db.updateBatchJobItem(id, { errorMessage: 'later' });
    expect(again).toMatchObject({ finishReason: 'length', truncated: true });
  });
});
