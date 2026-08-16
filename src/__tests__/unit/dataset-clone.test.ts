/**
 * Unit tests — `cloneDataset`.
 *
 * Cloning is what turns labeling into leverage: an analysis run labels a
 * captured corpus by segment, a reviewer corrects the labels that matter, and
 * the reviewed slice is copied into a small, stable GOLDEN SET that a suite is
 * run against on every change.
 *
 * The properties pinned here are the ones a golden set lives or dies by: the
 * right items are selected, item ids survive so runs stay comparable, the copy
 * is independent of the source, and the exact filter is recorded so the slice
 * can be reproduced.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { cloneDataset } from '@/lib/services/evaluation/service';
import type { IEvaluationDatasetItem } from '@/lib/database';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const SOURCE_ID = 'ds-source';

type ItemRecord = IEvaluationDatasetItem & { datasetId: string; position: number };

function item(id: string, overrides: Partial<IEvaluationDatasetItem> = {}): ItemRecord {
  return {
    id,
    input: [{ role: 'user', content: `question ${id}` }],
    datasetId: SOURCE_ID,
    position: 0,
    ...overrides,
  } as ItemRecord;
}

/** Items covering every axis the clone filters on. */
const ITEMS: ItemRecord[] = [
  item('reviewed-1', {
    expected: { reference: 'gold answer' },
    labels: { intent: 'billing' },
    labelMeta: { source: 'human', labeledBy: USER_ID },
    tags: ['snapshot'],
  }),
  item('reviewed-2', {
    expected: { reference: 'another gold answer' },
    labels: { intent: 'refund' },
    labelMeta: { source: 'human', labeledBy: USER_ID },
    tags: ['snapshot'],
  }),
  item('ai-labeled', {
    expected: { reference: 'guessed answer' },
    labels: { intent: 'billing' },
    labelMeta: { source: 'ai', definitionKey: 'intent-v1' },
    tags: ['snapshot'],
  }),
  item('reviewed-no-expected', {
    labels: { intent: 'billing' },
    labelMeta: { source: 'human', labeledBy: USER_ID },
    tags: ['snapshot'],
  }),
  item('unlabeled', { expected: { reference: 'x' }, tags: ['snapshot', 'raw'] }),
];

function setupDb(items: ItemRecord[] = ITEMS) {
  const db = createMockDb();
  db.findEvaluationDatasetById = vi.fn().mockResolvedValue({
    _id: SOURCE_ID,
    key: 'captured-traffic',
    name: 'Captured traffic',
    tenantId: TENANT_ID,
    projectId: 'proj-1',
  });
  // The provider applies label filters; everything else is filtered in the
  // service, so the mock only honours `label`/`labeled` — exactly as the real
  // providers do.
  db.listEvaluationDatasetItems = vi.fn().mockImplementation(
    async (_datasetId: string, options?: { skip?: number; limit?: number; label?: { key: string; value?: string }; labeled?: boolean }) => {
      let filtered = items;
      if (options?.labeled === true) filtered = filtered.filter((i) => i.labels && Object.keys(i.labels).length > 0);
      if (options?.labeled === false) filtered = filtered.filter((i) => !i.labels || Object.keys(i.labels).length === 0);
      if (options?.label) {
        const { key, value } = options.label;
        filtered = filtered.filter((i) => {
          const raw = i.labels?.[key];
          if (raw === undefined) return false;
          return value === undefined || String(raw).toLowerCase() === value.toLowerCase();
        });
      }
      const skip = options?.skip ?? 0;
      return filtered.slice(skip, skip + (options?.limit ?? filtered.length));
    },
  );
  db.findEvaluationDatasetByKey = vi.fn().mockResolvedValue(null);
  db.createEvaluationDataset = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    _id: 'ds-clone',
  }));
  (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  return db;
}

function createdItems(db: ReturnType<typeof createMockDb>): IEvaluationDatasetItem[] {
  const call = (db.createEvaluationDataset as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
  return call.items as IEvaluationDatasetItem[];
}

describe('cloneDataset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps only reviewer-confirmed items — the golden-set filter', async () => {
    // An AI labeling run is a hypothesis; a reviewer's correction is ground
    // truth. A golden set that mixes the two is not golden.
    const db = setupDb();
    const result = await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Billing golden set',
      filter: { labelSource: 'human' },
    });

    expect(createdItems(db).map((i) => i.id)).toEqual([
      'reviewed-1', 'reviewed-2', 'reviewed-no-expected',
    ]);
    expect(result.copied).toBe(3);
  });

  it('excludes items with nothing to grade against', async () => {
    // An item with no reference scores 0 for every reference-based scorer,
    // silently dragging the suite's pass rate down instead of being left out.
    const db = setupDb();
    await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Golden',
      filter: { labelSource: 'human', requireExpected: true },
    });

    expect(createdItems(db).map((i) => i.id)).toEqual(['reviewed-1', 'reviewed-2']);
  });

  it('narrows to one labeled segment', async () => {
    const db = setupDb();
    await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Billing only',
      filter: { label: { key: 'intent', value: 'billing' } },
    });

    expect(createdItems(db).map((i) => i.id)).toEqual(['reviewed-1', 'ai-labeled', 'reviewed-no-expected']);
  });

  it('combines a segment filter with the reviewed filter', async () => {
    const db = setupDb();
    await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Reviewed billing',
      filter: { label: { key: 'intent', value: 'billing' }, labelSource: 'human', requireExpected: true },
    });

    expect(createdItems(db).map((i) => i.id)).toEqual(['reviewed-1']);
  });

  it('filters on free-form tags too', async () => {
    const db = setupDb();
    await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Raw only',
      filter: { tags: ['raw'] },
    });

    expect(createdItems(db).map((i) => i.id)).toEqual(['unlabeled']);
  });

  it('preserves item ids so a clone stays traceable to its source', async () => {
    // Run-to-run comparison keys on item id; renaming items on copy would make
    // the golden set incomparable with the dataset it came from.
    const db = setupDb();
    await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Golden',
      filter: { labelSource: 'human' },
    });

    const cloned = createdItems(db);
    expect(cloned[0].id).toBe('reviewed-1');
    expect(cloned[0].input).toEqual(ITEMS[0].input);
    expect(cloned[0].expected).toEqual(ITEMS[0].expected);
    expect(cloned[0].labels).toEqual(ITEMS[0].labels);
  });

  it('stamps extra tags without dropping the item’s own', async () => {
    const db = setupDb();
    await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Golden',
      filter: { labelSource: 'human' },
      tags: ['golden'],
    });

    expect(createdItems(db)[0].tags).toEqual(['snapshot', 'golden']);
  });

  it('does not duplicate a tag the item already has', async () => {
    const db = setupDb();
    await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Golden',
      filter: { labelSource: 'human' },
      tags: ['snapshot'],
    });

    expect(createdItems(db)[0].tags).toEqual(['snapshot']);
  });

  it('records the source and the exact filter, so the slice is reproducible', async () => {
    const db = setupDb();
    const filter = { labelSource: 'human' as const, requireExpected: true };
    await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, { name: 'Golden', filter });

    const created = (db.createEvaluationDataset as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.source).toBe('imported');
    const provenance = (created.metadata as Record<string, unknown>).clonedFrom as Record<string, unknown>;
    expect(provenance.datasetId).toBe(SOURCE_ID);
    expect(provenance.datasetKey).toBe('captured-traffic');
    expect(provenance.filter).toEqual(filter);
    expect(typeof provenance.clonedAt).toBe('string');
  });

  it('honours the item limit', async () => {
    const db = setupDb();
    const result = await cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
      name: 'Golden',
      filter: { labelSource: 'human', limit: 2 },
    });

    expect(createdItems(db)).toHaveLength(2);
    expect(result.copied).toBe(2);
  });

  it('refuses to create an empty dataset', async () => {
    // Silently producing a zero-item "golden set" would make every suite that
    // used it report a perfect, meaningless pass rate.
    setupDb();
    await expect(
      cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, {
        name: 'Golden',
        filter: { label: { key: 'intent', value: 'nonexistent' } },
      }),
    ).rejects.toThrow(/No items matched/);
  });

  it('fails clearly when the source dataset is gone', async () => {
    const db = setupDb();
    db.findEvaluationDatasetById = vi.fn().mockResolvedValue(null);
    await expect(
      cloneDataset(TENANT_DB, TENANT_ID, USER_ID, SOURCE_ID, { name: 'Golden' }),
    ).rejects.toThrow(/Dataset not found/);
  });
});
