/**
 * MongoDB Provider – Evaluation operations mixin
 *
 * CRUD for evaluation targets, datasets, suites, and runs. Documents store
 * nested structures natively (no JSON stringification). Mirrors the guardrail
 * mixin conventions.
 *
 * Dataset items live in their OWN collection (`evaluation_dataset_items`,
 * one document per item, ordered by `position`) — embedding them on the
 * dataset document capped whole datasets at one 16MB document and shipped
 * every item on every read. The dataset write methods still ACCEPT an inline
 * `items` array (create inserts, update replaces) so existing writers keep
 * working unchanged, and `itemCount` is maintained on the dataset document.
 * Legacy documents whose items are still embedded are served transparently
 * by the item read methods and migrated (idempotently) on the first item
 * write.
 */

import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import type {
  IEvaluationTarget,
  IEvaluationDataset,
  IEvaluationDatasetItem,
  IEvaluationDatasetItemRecord,
  IEvaluationSuite,
  IEvaluationRun,
  EvaluationTargetKind,
  EvaluationDatasetSource,
  EvaluationRunStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

/** True when the error is a Mongo duplicate-key violation (code 11000). */
function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 11000 || code === 11001;
}

/** Escape a user-supplied search string for use inside a $regex. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Throw the sanctioned duplicate error when a payload repeats an item id. */
function assertUniqueItemIds(items: IEvaluationDatasetItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`A dataset item with one of the given ids already exists: "${item.id}"`);
    }
    seen.add(item.id);
  }
}

/**
 * Legacy embedded arrays were never uniqueness-checked and items could lack
 * ids entirely — sanitize before migrating under the unique (datasetId, id)
 * index: missing ids are filled positionally, duplicates get a deterministic
 * numeric suffix. Nothing is dropped, so itemCount stays truthful.
 */
function sanitizeLegacyItemIds(items: IEvaluationDatasetItem[]): IEvaluationDatasetItem[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const base = typeof item?.id === 'string' && item.id.trim() !== '' ? item.id : `item-${index + 1}`;
    let id = base;
    for (let n = 2; seen.has(id); n += 1) id = `${base}-${n}`;
    seen.add(id);
    return id === item?.id ? item : { ...item, id };
  });
}

/** Case-insensitive substring match over an item's id / input / tags. */
function itemMatchesSearch(item: IEvaluationDatasetItem, search: string): boolean {
  const needle = search.toLowerCase();
  if (item.id.toLowerCase().includes(needle)) return true;
  if ((item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))) return true;
  return (item.input ?? []).some((m) => (m.content ?? '').toLowerCase().includes(needle));
}

/** Mongo filter for one dataset's items, optionally narrowed by search. */
function itemFilter(datasetId: string, search?: string): Record<string, unknown> {
  if (!search) return { datasetId };
  const rx = { $regex: escapeRegex(search), $options: 'i' };
  return { datasetId, $or: [{ id: rx }, { tags: rx }, { 'input.content': rx }] };
}

export function EvaluationMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class EvaluationOps extends Base {
    // ── Targets ──────────────────────────────────────────────────────

    async createEvaluationTarget(
      target: Omit<IEvaluationTarget, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationTarget> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...target, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.evaluationTargets).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateEvaluationTarget(
      id: string,
      data: Partial<Omit<IEvaluationTarget, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IEvaluationTarget>(COLLECTIONS.evaluationTargets)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IEvaluationTarget;
    }

    async deleteEvaluationTarget(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.evaluationTargets).deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findEvaluationTargetById(id: string): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.evaluationTargets).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IEvaluationTarget | null;
    }

    async findEvaluationTargetByKey(key: string, projectId?: string): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db.collection(COLLECTIONS.evaluationTargets).findOne(filter);
      return doc as unknown as IEvaluationTarget | null;
    }

    async listEvaluationTargets(filters?: { projectId?: string; kind?: EvaluationTargetKind; search?: string }): Promise<IEvaluationTarget[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.kind !== undefined) filter.kind = filters.kind;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db.collection(COLLECTIONS.evaluationTargets).find(filter).sort({ createdAt: -1 }).toArray();
      return docs as unknown as IEvaluationTarget[];
    }

    // ── Datasets ─────────────────────────────────────────────────────

    async createEvaluationDataset(
      dataset: Omit<IEvaluationDataset, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationDataset> {
      const db = this.getTenantDb();
      const now = new Date();
      // Inline items are routed to the item collection — the dataset document
      // itself never stores them (only the denormalised count). Duplicate ids
      // are rejected BEFORE the header is inserted (no ghost datasets).
      const { items, ...meta } = dataset;
      if (items && items.length > 0) assertUniqueItemIds(items);
      const doc = { ...meta, itemCount: items?.length ?? 0, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.evaluationDatasets).insertOne(doc);
      const datasetId = result.insertedId.toString();
      if (items && items.length > 0) {
        try {
          await this.insertDatasetItems(db, datasetId, dataset.tenantId, dataset.projectId, items, 0);
        } catch (error) {
          // Roll the header back — a dataset that claims items it doesn't
          // have would also permanently squat on the key.
          await db.collection(COLLECTIONS.evaluationDatasets)
            .deleteOne({ _id: result.insertedId })
            .catch(() => {});
          throw error;
        }
      }
      return { ...doc, _id: datasetId };
    }

    async updateEvaluationDataset(
      id: string,
      data: Partial<Omit<IEvaluationDataset, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const { items, ...rest } = data;
      const updateData: Record<string, unknown> = { ...rest, updatedAt: new Date() };
      delete updateData._id;
      if (items !== undefined) updateData.itemCount = items.length;
      const result = await db
        .collection<IEvaluationDataset>(COLLECTIONS.evaluationDatasets)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      if (items !== undefined) {
        // Full replace, mirroring the old embedded-array semantics. Also
        // clears any legacy embedded array still on the document.
        await this.writeDatasetItemsReplacing(db, result, items);
      }
      return this.mapDatasetDoc(result);
    }

    async deleteEvaluationDataset(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.evaluationDatasets).deleteOne({ _id: new ObjectId(id) });
      // Cascade the item rows; a dataset that never migrated has none.
      await db.collection(COLLECTIONS.evaluationDatasetItems).deleteMany({ datasetId: id });
      return result.deletedCount === 1;
    }

    async findEvaluationDatasetById(id: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .findOne({ _id: new ObjectId(id) }, { projection: { items: 0 } });
      if (!doc) return null;
      return this.withResolvedItemCount(db, this.mapDatasetDoc(doc as unknown as IEvaluationDataset));
    }

    async findEvaluationDatasetByKey(key: string, projectId?: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .findOne(filter, { projection: { items: 0 } });
      if (!doc) return null;
      return this.withResolvedItemCount(db, this.mapDatasetDoc(doc as unknown as IEvaluationDataset));
    }

    async listEvaluationDatasets(filters?: { projectId?: string; source?: EvaluationDatasetSource; search?: string }): Promise<IEvaluationDataset[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.source !== undefined) filter.source = filters.source;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      // Legacy documents may still embed multi-megabyte item arrays — never
      // ship those on a list. Their itemCount is derived server-side from the
      // array size; only the number crosses the wire.
      const docs = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .aggregate([
          { $match: filter },
          { $sort: { createdAt: -1 } },
          { $addFields: { legacyItemCount: { $size: { $ifNull: ['$items', []] } } } },
          { $project: { items: 0 } },
        ])
        .toArray();
      return docs.map((doc) => this.mapDatasetDoc(doc as unknown as IEvaluationDataset & { legacyItemCount?: number }));
    }

    /** Normalise a dataset document: string _id, itemCount fallback, no items. */
    private mapDatasetDoc(
      doc: IEvaluationDataset & { _id?: ObjectId | string; legacyItemCount?: number },
    ): IEvaluationDataset {
      const { items, legacyItemCount, ...rest } = doc;
      return {
        ...rest,
        _id: doc._id?.toString(),
        // Keep undefined when nothing is known (legacy doc read with items
        // projected out) so withResolvedItemCount knows to resolve it.
        itemCount: doc.itemCount ?? legacyItemCount ?? (Array.isArray(items) ? items.length : undefined),
      } as IEvaluationDataset;
    }

    /**
     * A document without `itemCount` predates the item-collection split, so
     * its items are still embedded; resolve the count with a $size pipeline
     * (only the number is transferred, never the array).
     */
    private async withResolvedItemCount(db: Db, dataset: IEvaluationDataset): Promise<IEvaluationDataset> {
      if (typeof dataset.itemCount === 'number') return dataset;
      const legacy = await this.legacyEmbeddedItemCount(db, String(dataset._id));
      return { ...dataset, itemCount: legacy };
    }

    /** Embedded-array length of a legacy dataset document (0 when absent). */
    private async legacyEmbeddedItemCount(db: Db, datasetId: string): Promise<number> {
      if (!ObjectId.isValid(datasetId)) return 0;
      const rows = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .aggregate([
          { $match: { _id: new ObjectId(datasetId) } },
          { $project: { n: { $size: { $ifNull: ['$items', []] } } } },
        ])
        .toArray();
      const n = rows[0]?.n;
      return typeof n === 'number' ? n : 0;
    }

    // ── Dataset items (separate collection) ─────────────────────────

    /** Per-tenant-DB memo so index creation runs once per process. */
    private evalItemIndexesReady = new Set<string>();
    private evalItemIndexInit = new Map<string, Promise<void>>();

    /**
     * Indexes are ensured on the WRITE path (not only the boot manifest)
     * because the boot-time tenant index pass is existence-guarded — a
     * collection created after the tenant's first bind would stay unindexed
     * until the next process restart, and the unique (datasetId, id) guard
     * must hold from the very first insert.
     */
    private async ensureDatasetItemIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.evalItemIndexesReady.has(dbName)) return;
      const existing = this.evalItemIndexInit.get(dbName);
      if (existing) {
        await existing;
        return;
      }
      const coll = db.collection(COLLECTIONS.evaluationDatasetItems);
      const setup = Promise.all([
        coll.createIndex({ datasetId: 1, position: 1 }, { name: 'idx_dataset_position' }),
        coll.createIndex({ datasetId: 1, id: 1 }, { name: 'uniq_dataset_itemId', unique: true }),
      ])
        .then(() => {
          this.evalItemIndexesReady.add(dbName);
        })
        .finally(() => {
          this.evalItemIndexInit.delete(dbName);
        });
      this.evalItemIndexInit.set(dbName, setup);
      await setup;
    }

    /** Dataset header (tenant/project) or throw — item writes need both. */
    private async requireDatasetHeader(
      db: Db,
      datasetId: string,
    ): Promise<{ tenantId: string; projectId?: string }> {
      const notFound = () => new Error(`Evaluation dataset "${datasetId}" not found`);
      if (!ObjectId.isValid(datasetId)) throw notFound();
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .findOne({ _id: new ObjectId(datasetId) }, { projection: { tenantId: 1, projectId: 1 } });
      if (!doc) throw notFound();
      return doc as unknown as { tenantId: string; projectId?: string };
    }

    /**
     * Low-level bulk insert of item rows at consecutive positions.
     *
     * Atomicity: on a duplicate-id failure the batch's OWN committed prefix
     * is rolled back (rows are identified by pre-assigned _ids, so nothing
     * else can be touched) — an append/replace either fully lands or leaves
     * no trace. With `ignoreDuplicates` (legacy migration) rows that already
     * exist are skipped instead: the migration never overwrites rows written
     * after the split (e.g. an item edited post-migration).
     */
    private async insertDatasetItems(
      db: Db,
      datasetId: string,
      tenantId: string,
      projectId: string | undefined,
      items: IEvaluationDatasetItem[],
      startPosition: number,
      opts?: { ignoreDuplicates?: boolean },
    ): Promise<void> {
      if (items.length === 0) return;
      await this.ensureDatasetItemIndexes(db);
      const now = new Date();
      const docs = items.map((item, i) => {
        // System fields LAST so a hostile/extra field on the item can never
        // override the row's parent linkage or ordering.
        const rest = { ...(item as IEvaluationDatasetItem & { _id?: unknown }) };
        delete rest._id;
        return {
          ...rest,
          _id: new ObjectId(),
          datasetId,
          tenantId,
          ...(projectId !== undefined ? { projectId } : {}),
          position: startPosition + i,
          createdAt: now,
          updatedAt: now,
        };
      });
      const coll = db.collection(COLLECTIONS.evaluationDatasetItems);
      if (opts?.ignoreDuplicates) {
        try {
          await coll.insertMany(docs, { ordered: false });
        } catch (error) {
          const writeErrors = (error as { writeErrors?: Array<{ code?: number }> }).writeErrors;
          const onlyDuplicates =
            isDuplicateKeyError(error)
            || (Array.isArray(writeErrors)
              && writeErrors.length > 0
              && writeErrors.every((e) => e?.code === 11000 || e?.code === 11001));
          if (!onlyDuplicates) throw error;
        }
        return;
      }
      try {
        await coll.insertMany(docs);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          // Ordered insert commits the prefix before the offender — remove it
          // so the batch is all-or-nothing (mirrors the SQLite transaction).
          await coll.deleteMany({ _id: { $in: docs.map((d) => d._id) } }).catch(() => {});
          throw new Error('A dataset item with one of the given ids already exists');
        }
        throw error;
      }
    }

    /**
     * Idempotent, NON-destructive legacy migration: if the dataset document
     * still embeds an `items` array, copy it into the item collection
     * (duplicate rows — e.g. from a crashed earlier attempt, or rows already
     * written post-split by a concurrent writer — are skipped, never
     * overwritten), then clear the embedded array and stamp the real row
     * count. Legacy ids are sanitized first (old storage never enforced
     * uniqueness). No-op for migrated/new datasets; an empty embedded array
     * migrates too (stamps itemCount so reads stop probing $size forever).
     */
    private async migrateLegacyEmbeddedItems(db: Db, datasetId: string): Promise<void> {
      if (!ObjectId.isValid(datasetId)) return;
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .findOne(
          { _id: new ObjectId(datasetId) },
          { projection: { items: 1, tenantId: 1, projectId: 1 } },
        );
      const embedded = (doc as { items?: unknown } | null)?.items;
      if (!doc || !Array.isArray(embedded)) return;
      if (embedded.length > 0) {
        await this.insertDatasetItems(
          db,
          datasetId,
          (doc as unknown as { tenantId: string }).tenantId,
          (doc as unknown as { projectId?: string }).projectId,
          sanitizeLegacyItemIds(embedded as IEvaluationDatasetItem[]),
          0,
          { ignoreDuplicates: true },
        );
      }
      await db.collection(COLLECTIONS.evaluationDatasets).updateOne(
        { _id: new ObjectId(datasetId) },
        { $unset: { items: 1 } },
      );
      await this.stampDatasetItemCount(db, datasetId);
    }

    /** Recount item rows and stamp the parent document's itemCount. */
    private async stampDatasetItemCount(db: Db, datasetId: string): Promise<void> {
      const count = await db
        .collection(COLLECTIONS.evaluationDatasetItems)
        .countDocuments({ datasetId });
      await db.collection(COLLECTIONS.evaluationDatasets).updateOne(
        { _id: new ObjectId(datasetId) },
        { $set: { itemCount: count, updatedAt: new Date() } },
      );
    }

    /** Full replace shared by updateEvaluationDataset + the public replace.
     *  Duplicate ids inside the payload are rejected BEFORE anything is
     *  deleted — a replace must never destroy data and then fail. */
    private async writeDatasetItemsReplacing(
      db: Db,
      dataset: IEvaluationDataset & { _id?: ObjectId | string },
      items: IEvaluationDatasetItem[],
    ): Promise<void> {
      assertUniqueItemIds(items);
      const datasetId = String(dataset._id);
      await this.ensureDatasetItemIndexes(db);
      await db.collection(COLLECTIONS.evaluationDatasetItems).deleteMany({ datasetId });
      await this.insertDatasetItems(db, datasetId, dataset.tenantId, dataset.projectId, items, 0);
      // Clear any legacy embedded array and stamp the count from the actual
      // rows (the caller's optimistic $set can lie if anything went sideways).
      await db.collection(COLLECTIONS.evaluationDatasets).updateOne(
        { _id: new ObjectId(datasetId) },
        { $unset: { items: 1 } },
      );
      await this.stampDatasetItemCount(db, datasetId);
    }

    /** Legacy read helper: embedded items + parent header, or null. */
    private async readLegacyEmbeddedItems(
      db: Db,
      datasetId: string,
    ): Promise<{ items: IEvaluationDatasetItem[]; tenantId: string; projectId?: string } | null> {
      if (!ObjectId.isValid(datasetId)) return null;
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .findOne(
          { _id: new ObjectId(datasetId) },
          { projection: { items: 1, tenantId: 1, projectId: 1 } },
        );
      const items = (doc as { items?: unknown } | null)?.items;
      if (!doc || !Array.isArray(items) || items.length === 0) return null;
      return {
        items: items as IEvaluationDatasetItem[],
        tenantId: (doc as unknown as { tenantId: string }).tenantId,
        projectId: (doc as unknown as { projectId?: string }).projectId,
      };
    }

    async createEvaluationDatasetItems(datasetId: string, items: IEvaluationDatasetItem[]): Promise<number> {
      const db = this.getTenantDb();
      if (items.length === 0) return 0;
      assertUniqueItemIds(items);
      const parent = await this.requireDatasetHeader(db, datasetId);
      await this.migrateLegacyEmbeddedItems(db, datasetId);
      const coll = db.collection(COLLECTIONS.evaluationDatasetItems);
      const last = await coll
        .find({ datasetId })
        .sort({ position: -1 })
        .limit(1)
        .project({ position: 1 })
        .toArray();
      const start = typeof last[0]?.position === 'number' ? (last[0].position as number) + 1 : 0;
      await this.insertDatasetItems(db, datasetId, parent.tenantId, parent.projectId, items, start);
      await this.stampDatasetItemCount(db, datasetId);
      return items.length;
    }

    async replaceEvaluationDatasetItems(datasetId: string, items: IEvaluationDatasetItem[]): Promise<number> {
      const db = this.getTenantDb();
      const parent = await this.requireDatasetHeader(db, datasetId);
      await this.writeDatasetItemsReplacing(
        db,
        { _id: datasetId, tenantId: parent.tenantId, projectId: parent.projectId } as IEvaluationDataset,
        items,
      );
      return items.length;
    }

    /** O(1) existence probe (mirrors the SQLite side) — the legacy-branch
     *  decision must not pay a full countDocuments per page on Cosmos. */
    private async hasDatasetItemRows(db: Db, datasetId: string): Promise<boolean> {
      const row = await db
        .collection(COLLECTIONS.evaluationDatasetItems)
        .findOne({ datasetId }, { projection: { _id: 1 } });
      return row !== null;
    }

    async listEvaluationDatasetItems(
      datasetId: string,
      options?: { skip?: number; limit?: number; search?: string },
    ): Promise<IEvaluationDatasetItemRecord[]> {
      const db = this.getTenantDb();
      const skip = Math.max(0, options?.skip ?? 0);
      const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
      const coll = db.collection(COLLECTIONS.evaluationDatasetItems);
      if (!(await this.hasDatasetItemRows(db, datasetId))) {
        // Legacy dataset — serve a slice of the embedded array read-only.
        const legacy = await this.readLegacyEmbeddedItems(db, datasetId);
        if (!legacy) return [];
        const filtered = options?.search
          ? legacy.items.filter((item) => itemMatchesSearch(item, options.search as string))
          : legacy.items;
        return filtered.slice(skip, skip + limit).map((item, i) => ({
          ...item,
          datasetId,
          tenantId: legacy.tenantId,
          projectId: legacy.projectId,
          position: skip + i,
        }));
      }
      const docs = await coll
        .find(itemFilter(datasetId, options?.search))
        // `id` tiebreak keeps the order total even if positions ever collide.
        .sort({ position: 1, id: 1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      return docs.map((doc) => ({ ...doc, _id: doc._id?.toString() })) as unknown as IEvaluationDatasetItemRecord[];
    }

    async countEvaluationDatasetItems(datasetId: string, search?: string): Promise<number> {
      const db = this.getTenantDb();
      const coll = db.collection(COLLECTIONS.evaluationDatasetItems);
      if (await this.hasDatasetItemRows(db, datasetId)) {
        return coll.countDocuments(itemFilter(datasetId, search));
      }
      if (!search) return this.legacyEmbeddedItemCount(db, datasetId);
      const legacy = await this.readLegacyEmbeddedItems(db, datasetId);
      if (!legacy) return 0;
      return legacy.items.filter((item) => itemMatchesSearch(item, search)).length;
    }

    async findEvaluationDatasetItem(datasetId: string, itemId: string): Promise<IEvaluationDatasetItemRecord | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasetItems)
        .findOne({ datasetId, id: itemId });
      if (doc) return { ...doc, _id: doc._id?.toString() } as unknown as IEvaluationDatasetItemRecord;
      const legacy = await this.readLegacyEmbeddedItems(db, datasetId);
      if (!legacy) return null;
      const index = legacy.items.findIndex((item) => item.id === itemId);
      if (index < 0) return null;
      return {
        ...legacy.items[index],
        datasetId,
        tenantId: legacy.tenantId,
        projectId: legacy.projectId,
        position: index,
      };
    }

    async updateEvaluationDatasetItem(
      datasetId: string,
      itemId: string,
      data: Partial<Omit<IEvaluationDatasetItem, 'id'>>,
    ): Promise<IEvaluationDatasetItemRecord | null> {
      const db = this.getTenantDb();
      await this.migrateLegacyEmbeddedItems(db, datasetId);
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      // Never let an update move the row or rewrite system fields.
      for (const key of ['_id', 'id', 'datasetId', 'tenantId', 'projectId', 'position', 'createdAt']) {
        delete updateData[key];
      }
      // `null` means "clear this optional field" (expected/tools/…): $unset
      // instead of persisting a literal null.
      const unset: Record<string, 1> = {};
      for (const [key, value] of Object.entries(updateData)) {
        if (value === null) {
          unset[key] = 1;
          delete updateData[key];
        }
      }
      const result = await db
        .collection<IEvaluationDatasetItemRecord>(COLLECTIONS.evaluationDatasetItems)
        .findOneAndUpdate(
          { datasetId, id: itemId },
          { $set: updateData, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      await db.collection(COLLECTIONS.evaluationDatasets).updateOne(
        { _id: new ObjectId(datasetId) },
        { $set: { updatedAt: new Date() } },
      );
      return { ...result, _id: result._id?.toString() } as IEvaluationDatasetItemRecord;
    }

    async deleteEvaluationDatasetItem(datasetId: string, itemId: string): Promise<boolean> {
      const db = this.getTenantDb();
      await this.migrateLegacyEmbeddedItems(db, datasetId);
      const result = await db
        .collection(COLLECTIONS.evaluationDatasetItems)
        .deleteOne({ datasetId, id: itemId });
      if (result.deletedCount !== 1) return false;
      await this.stampDatasetItemCount(db, datasetId);
      return true;
    }

    // ── Suites ───────────────────────────────────────────────────────

    async createEvaluationSuite(
      suite: Omit<IEvaluationSuite, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationSuite> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...suite, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.evaluationSuites).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateEvaluationSuite(
      id: string,
      data: Partial<Omit<IEvaluationSuite, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IEvaluationSuite>(COLLECTIONS.evaluationSuites)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IEvaluationSuite;
    }

    async deleteEvaluationSuite(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.evaluationSuites).deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findEvaluationSuiteById(id: string): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.evaluationSuites).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IEvaluationSuite | null;
    }

    async findEvaluationSuiteByKey(key: string, projectId?: string): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db.collection(COLLECTIONS.evaluationSuites).findOne(filter);
      return doc as unknown as IEvaluationSuite | null;
    }

    async listEvaluationSuites(filters?: { projectId?: string; targetKey?: string; datasetKey?: string; search?: string }): Promise<IEvaluationSuite[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.targetKey !== undefined) filter.targetKey = filters.targetKey;
      if (filters?.datasetKey !== undefined) filter.datasetKey = filters.datasetKey;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db.collection(COLLECTIONS.evaluationSuites).find(filter).sort({ createdAt: -1 }).toArray();
      return docs as unknown as IEvaluationSuite[];
    }

    // ── Runs ─────────────────────────────────────────────────────────

    async createEvaluationRun(
      run: Omit<IEvaluationRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationRun> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...run, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.evaluationRuns).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateEvaluationRun(
      id: string,
      data: Partial<Omit<IEvaluationRun, 'tenantId' | 'suiteKey' | 'createdBy'>>,
    ): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IEvaluationRun>(COLLECTIONS.evaluationRuns)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IEvaluationRun;
    }

    async findEvaluationRunById(id: string): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.evaluationRuns).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IEvaluationRun | null;
    }

    async listEvaluationRuns(filters?: { projectId?: string; suiteKey?: string; status?: EvaluationRunStatus; limit?: number; skip?: number }): Promise<IEvaluationRun[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.suiteKey !== undefined) filter.suiteKey = filters.suiteKey;
      if (filters?.status !== undefined) filter.status = filters.status;
      const docs = await db
        .collection(COLLECTIONS.evaluationRuns)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(filters?.skip ?? 0)
        .limit(filters?.limit ?? 50)
        .toArray();
      return docs as unknown as IEvaluationRun[];
    }
  };
}
