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
  EvaluationDatasetItemQuery,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';
import { definedFields } from './definedFields';
import { toObjectId } from './objectIds';
import { assertMetadataPatchKeys, pickEvaluationItemFields } from '../provider/evaluationItemFields';
import { hasAnyLabel, matchesLabel, mongoLabelCandidates } from '../provider/labelMatch';

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

/** Search + label filtering for the legacy embedded-items read path. */
function legacyItemMatches(item: IEvaluationDatasetItem, options?: EvaluationDatasetItemQuery): boolean {
  if (options?.search && !itemMatchesSearch(item, options.search)) return false;
  if (options?.labeled !== undefined && hasAnyLabel(item.labels) !== options.labeled) return false;
  if (options?.label && !matchesLabel(item.labels, options.label.key, options.label.value)) return false;
  return true;
}

/** Mongo filter for one dataset's items, optionally narrowed by search/labels. */
function itemFilter(
  datasetId: string,
  search?: string,
  filters?: Pick<EvaluationDatasetItemQuery, 'label' | 'labeled'>,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { datasetId };
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ id: rx }, { tags: rx }, { 'input.content': rx }];
  }
  // Label filters (see labelMatch.ts): a queried text value is matched against
  // every typed form it could have been stored as.
  if (filters?.labeled === true) filter.labels = { $exists: true, $nin: [null, {}] };
  if (filters?.labeled === false) {
    filter.$and = [{ $or: [{ labels: { $exists: false } }, { labels: null }, { labels: {} }] }];
  }
  if (filters?.label) {
    const path = `labels.${filters.label.key}`;
    filter[path] = filters.label.value === undefined
      ? { $exists: true }
      : { $in: mongoLabelCandidates(filters.label.value) };
  }
  return filter;
}

/**
 * Status filter shared by the run list/count methods. `status` and `statuses`
 * intersect when both are given; an empty `statuses` array is ignored (no
 * filter) so a caller that built the list from optional input does not
 * accidentally match nothing.
 */
function runStatusFilter(filters?: {
  status?: EvaluationRunStatus;
  statuses?: EvaluationRunStatus[];
}): { $in: EvaluationRunStatus[] } | undefined {
  let allowed = filters?.statuses && filters.statuses.length > 0 ? filters.statuses : undefined;
  if (filters?.status !== undefined) {
    allowed = allowed ? allowed.filter((s) => s === filters.status) : [filters.status];
  }
  return allowed ? { $in: allowed } : undefined;
}

/** Normalise a run document read with a string `_id`; `items` defaults to []. */
function mapRunDoc(doc: unknown): IEvaluationRun {
  const d = doc as IEvaluationRun & { _id?: ObjectId | string };
  return { ...d, _id: d._id?.toString(), items: d.items ?? [] } as IEvaluationRun;
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
      const oid = toObjectId(id);
      if (!oid) return null;
      const updateData = { ...definedFields(data), updatedAt: new Date() };
      const result = await db
        .collection<IEvaluationTarget>(COLLECTIONS.evaluationTargets)
        .findOneAndUpdate({ _id: oid }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IEvaluationTarget;
    }

    async deleteEvaluationTarget(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return false;
      const result = await db.collection(COLLECTIONS.evaluationTargets).deleteOne({ _id: oid });
      return result.deletedCount === 1;
    }

    async findEvaluationTargetById(id: string): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return null;
      const doc = await db.collection(COLLECTIONS.evaluationTargets).findOne({ _id: oid });
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
      const oid = toObjectId(id);
      if (!oid) return null;
      const { items, ...rest } = data;
      // Reject a bad payload BEFORE the header is touched: a failed replace
      // must not leave a renamed header over the old items.
      if (items !== undefined) assertUniqueItemIds(items);
      const updateData: Record<string, unknown> = { ...definedFields(rest), updatedAt: new Date() };
      if (items !== undefined) updateData.itemCount = items.length;
      const result = await db
        .collection<IEvaluationDataset>(COLLECTIONS.evaluationDatasets)
        .findOneAndUpdate({ _id: oid }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      if (items !== undefined) {
        // Full replace, mirroring the old embedded-array semantics. Also
        // clears any legacy embedded array still on the document.
        try {
          await this.writeDatasetItemsReplacing(db, result, items);
        } catch (error) {
          // The optimistic itemCount above would lie about the restored rows.
          await this.stampDatasetItemCount(db, id).catch(() => {});
          throw error;
        }
      }
      return this.mapDatasetDoc(result);
    }

    async deleteEvaluationDataset(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return false;
      const result = await db.collection(COLLECTIONS.evaluationDatasets).deleteOne({ _id: oid });
      // Cascade the item rows; a dataset that never migrated has none.
      await db.collection(COLLECTIONS.evaluationDatasetItems).deleteMany({ datasetId: id });
      return result.deletedCount === 1;
    }

    async findEvaluationDatasetById(id: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return null;
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .findOne({ _id: oid }, { projection: { items: 0 } });
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
        // Only whitelisted item fields are copied (unknown keys are dropped),
        // and system fields come LAST so nothing on the item can override the
        // row's parent linkage or ordering.
        return {
          ...pickEvaluationItemFields(item),
          id: item.id,
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
      const oid = toObjectId(datasetId);
      if (!oid) return;
      const count = await db
        .collection(COLLECTIONS.evaluationDatasetItems)
        .countDocuments({ datasetId });
      await db.collection(COLLECTIONS.evaluationDatasets).updateOne(
        { _id: oid },
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
      const itemColl = db.collection(COLLECTIONS.evaluationDatasetItems);
      // Mongo has no multi-collection transaction here, so the old rows are
      // held in memory while the new ones are written: if the insert fails
      // after the delete, the old rows are put back - a failed replace must
      // never leave the dataset empty. (insertDatasetItems already removes
      // its own partial prefix.)
      const previous = await itemColl.find({ datasetId }).toArray();
      await itemColl.deleteMany({ datasetId });
      try {
        await this.insertDatasetItems(db, datasetId, dataset.tenantId, dataset.projectId, items, 0);
      } catch (error) {
        if (previous.length > 0) {
          try {
            // ordered:false + duplicates ignored: rows a concurrent writer
            // already re-created are left as they are.
            await itemColl.insertMany(previous, { ordered: false });
          } catch (restoreError) {
            const writeErrors = (restoreError as { writeErrors?: Array<{ code?: number }> }).writeErrors;
            const onlyDuplicates =
              isDuplicateKeyError(restoreError)
              || (Array.isArray(writeErrors)
                && writeErrors.length > 0
                && writeErrors.every((e) => e?.code === 11000 || e?.code === 11001));
            if (!onlyDuplicates) throw restoreError;
          }
        }
        throw error;
      }
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
      options?: EvaluationDatasetItemQuery,
    ): Promise<IEvaluationDatasetItemRecord[]> {
      const db = this.getTenantDb();
      const skip = Math.max(0, options?.skip ?? 0);
      const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
      const coll = db.collection(COLLECTIONS.evaluationDatasetItems);
      if (!(await this.hasDatasetItemRows(db, datasetId))) {
        // Legacy dataset — serve a slice of the embedded array read-only.
        const legacy = await this.readLegacyEmbeddedItems(db, datasetId);
        if (!legacy) return [];
        const filtered = legacy.items.filter((item) => legacyItemMatches(item, options));
        return filtered.slice(skip, skip + limit).map((item, i) => ({
          ...item,
          datasetId,
          tenantId: legacy.tenantId,
          projectId: legacy.projectId,
          position: skip + i,
        }));
      }
      const docs = await coll
        .find(itemFilter(datasetId, options?.search, options))
        // `id` tiebreak keeps the order total even if positions ever collide.
        .sort({ position: 1, id: 1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      return docs.map((doc) => ({ ...doc, _id: doc._id?.toString() })) as unknown as IEvaluationDatasetItemRecord[];
    }

    async countEvaluationDatasetItems(
      datasetId: string,
      search?: string,
      filters?: Omit<EvaluationDatasetItemQuery, 'skip' | 'limit' | 'search'>,
    ): Promise<number> {
      const db = this.getTenantDb();
      const coll = db.collection(COLLECTIONS.evaluationDatasetItems);
      if (await this.hasDatasetItemRows(db, datasetId)) {
        return coll.countDocuments(itemFilter(datasetId, search, filters));
      }
      const filtering = !!search || !!filters?.label || filters?.labeled !== undefined;
      if (!filtering) return this.legacyEmbeddedItemCount(db, datasetId);
      const legacy = await this.readLegacyEmbeddedItems(db, datasetId);
      if (!legacy) return 0;
      return legacy.items.filter((item) => legacyItemMatches(item, { ...filters, search })).length;
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
      // Whitelist: an update can only touch the item's own fields - never
      // system fields, and never arbitrary keys.
      const updateData: Record<string, unknown> = { ...pickEvaluationItemFields(data), updatedAt: new Date() };
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
      const datasetOid = toObjectId(datasetId);
      if (datasetOid) {
        await db.collection(COLLECTIONS.evaluationDatasets).updateOne(
          { _id: datasetOid },
          { $set: { updatedAt: new Date() } },
        );
      }
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
      const oid = toObjectId(id);
      if (!oid) return null;
      const updateData = { ...definedFields(data), updatedAt: new Date() };
      const result = await db
        .collection<IEvaluationSuite>(COLLECTIONS.evaluationSuites)
        .findOneAndUpdate({ _id: oid }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IEvaluationSuite;
    }

    async deleteEvaluationSuite(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return false;
      const result = await db.collection(COLLECTIONS.evaluationSuites).deleteOne({ _id: oid });
      return result.deletedCount === 1;
    }

    async findEvaluationSuiteById(id: string): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return null;
      const doc = await db.collection(COLLECTIONS.evaluationSuites).findOne({ _id: oid });
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
      // Defined keys only: the driver would store an explicit `undefined` as
      // `null`, and readers should see "absent" for fields never set.
      const doc = { ...definedFields(run), createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.evaluationRuns).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() } as unknown as IEvaluationRun;
    }

    async updateEvaluationRun(
      id: string,
      data: Partial<Omit<IEvaluationRun, 'tenantId' | 'suiteKey' | 'createdBy'>>,
    ): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return null;
      const updateData: Record<string, unknown> = { ...definedFields(data), updatedAt: new Date() };
      const result = await db
        .collection<IEvaluationRun>(COLLECTIONS.evaluationRuns)
        .findOneAndUpdate({ _id: oid }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IEvaluationRun;
    }

    async findEvaluationRunById(id: string): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return null;
      const doc = await db.collection(COLLECTIONS.evaluationRuns).findOne({ _id: oid });
      return doc as unknown as IEvaluationRun | null;
    }

    /** Filter shared by list / summaries / count. */
    private runListFilter(filters?: {
      projectId?: string;
      suiteKey?: string;
      status?: EvaluationRunStatus;
      statuses?: EvaluationRunStatus[];
    }): Record<string, unknown> {
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.suiteKey !== undefined) filter.suiteKey = filters.suiteKey;
      const status = runStatusFilter(filters);
      if (status) filter.status = status;
      return filter;
    }

    async listEvaluationRuns(filters?: {
      projectId?: string;
      suiteKey?: string;
      status?: EvaluationRunStatus;
      statuses?: EvaluationRunStatus[];
      limit?: number;
      skip?: number;
    }): Promise<IEvaluationRun[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.evaluationRuns)
        .find(this.runListFilter(filters))
        // `_id` tiebreak: newest-first stays total (and pages stay stable)
        // when two runs share a createdAt millisecond.
        .sort({ createdAt: -1, _id: -1 })
        .skip(filters?.skip ?? 0)
        .limit(filters?.limit ?? 50)
        .toArray();
      return docs as unknown as IEvaluationRun[];
    }

    async listEvaluationRunSummaries(filters: {
      projectId?: string;
      suiteKey?: string;
      status?: EvaluationRunStatus;
      statuses?: EvaluationRunStatus[];
      limit?: number;
      skip?: number;
    }): Promise<IEvaluationRun[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.evaluationRuns)
        .find(this.runListFilter(filters), { projection: { items: 0 } })
        .sort({ createdAt: -1, _id: -1 })
        .skip(filters?.skip ?? 0)
        .limit(filters?.limit ?? 50)
        .toArray();
      return docs.map(mapRunDoc);
    }

    async countEvaluationRuns(filters: {
      projectId?: string;
      suiteKey?: string;
      status?: EvaluationRunStatus;
      statuses?: EvaluationRunStatus[];
    }): Promise<number> {
      const db = this.getTenantDb();
      return db.collection(COLLECTIONS.evaluationRuns).countDocuments(this.runListFilter(filters));
    }

    async listEvaluationRunsByStatus(
      statuses: EvaluationRunStatus[],
      opts?: { createdBefore?: Date; limit?: number },
    ): Promise<IEvaluationRun[]> {
      if (statuses.length === 0) return [];
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { status: { $in: statuses } };
      if (opts?.createdBefore) filter.createdAt = { $lt: opts.createdBefore };
      const docs = await db
        .collection(COLLECTIONS.evaluationRuns)
        .find(filter, { projection: { items: 0 } })
        .sort({ createdAt: 1, _id: 1 })
        .limit(Math.max(1, Math.min(opts?.limit ?? 1000, 5000)))
        .toArray();
      return docs.map(mapRunDoc);
    }

    // ── Run lifecycle (conditional updates: the filter carries the guard) ──

    async claimEvaluationRun(id: string, startedAt: Date): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return null;
      // CAS on status: of two workers racing for the same run only one matches.
      const result = await db
        .collection<IEvaluationRun>(COLLECTIONS.evaluationRuns)
        .findOneAndUpdate(
          { _id: oid, status: 'pending' } as Record<string, unknown>,
          { $set: { status: 'running', startedAt, heartbeatAt: startedAt, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IEvaluationRun;
    }

    async touchEvaluationRun(id: string, at: Date): Promise<boolean> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return false;
      const result = await db
        .collection(COLLECTIONS.evaluationRuns)
        .updateOne({ _id: oid, status: 'running' }, { $set: { heartbeatAt: at } });
      return result.matchedCount === 1;
    }

    async requestEvaluationRunCancel(id: string, at: Date): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return null;
      const coll = db.collection<IEvaluationRun>(COLLECTIONS.evaluationRuns);
      const now = new Date();
      // pending -> cancelled. Each transition is its own conditional update, so
      // a run that moved on between the two attempts is simply caught by the
      // next one (or falls through to "already finished").
      const cancelled = await coll.findOneAndUpdate(
        { _id: oid, status: 'pending' } as Record<string, unknown>,
        { $set: { status: 'cancelled', finishedAt: at, error: 'Cancelled before it started', updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (cancelled) return { ...cancelled, _id: cancelled._id?.toString() } as IEvaluationRun;
      const requested = await coll.findOneAndUpdate(
        { _id: oid, status: 'running' } as Record<string, unknown>,
        { $set: { cancelRequestedAt: at, updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (requested) return { ...requested, _id: requested._id?.toString() } as IEvaluationRun;
      const current = await coll.findOne({ _id: oid } as Record<string, unknown>);
      return current ? ({ ...current, _id: current._id?.toString() } as IEvaluationRun) : null;
    }

    async failStaleEvaluationRuns(heartbeatBefore: Date, message: string): Promise<number> {
      const db = this.getTenantDb();
      const now = new Date();
      // `heartbeatAt ?? startedAt ?? createdAt` older than the cutoff, expressed
      // in the FILTER so a heartbeat that lands meanwhile wins the race.
      const result = await db.collection(COLLECTIONS.evaluationRuns).updateMany(
        {
          status: 'running',
          $or: [
            { heartbeatAt: { $lt: heartbeatBefore } },
            { heartbeatAt: null, startedAt: { $lt: heartbeatBefore } },
            { heartbeatAt: null, startedAt: null, createdAt: { $lt: heartbeatBefore } },
          ],
        },
        { $set: { status: 'failed', error: message, finishedAt: now, updatedAt: now } },
      );
      return result.modifiedCount;
    }

    // ── Dataset metadata (atomic per-block patch) ───────────────────

    async patchEvaluationDatasetMetadata(
      id: string,
      patch: Record<string, unknown>,
      opts?: { unlessParityStatusIn?: string[] },
    ): Promise<IEvaluationDataset | null> {
      assertMetadataPatchKeys(patch);
      const db = this.getTenantDb();
      const oid = toObjectId(id);
      if (!oid) return null;
      const set: Record<string, unknown> = { updatedAt: new Date() };
      const unset: Record<string, 1> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) unset[`metadata.${key}`] = 1;
        else set[`metadata.${key}`] = value;
      }
      const coll = db.collection<IEvaluationDataset>(COLLECTIONS.evaluationDatasets);
      // `$set metadata.x` fails on a document whose metadata is null (the
      // undefined->null trap); normalise that first. No-op for healthy docs.
      await coll.updateOne({ _id: oid, metadata: null } as Record<string, unknown>, { $set: { metadata: {} } });
      const filter: Record<string, unknown> = { _id: oid };
      if (opts?.unlessParityStatusIn && opts.unlessParityStatusIn.length > 0) {
        // $nin also matches a missing field: "absent or not in the list".
        filter['metadata.parity.status'] = { $nin: opts.unlessParityStatusIn };
      }
      const result = await coll.findOneAndUpdate(
        filter,
        { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
        { returnDocument: 'after', projection: { items: 0 } },
      );
      if (!result) return null;
      return this.withResolvedItemCount(db, this.mapDatasetDoc(result));
    }
  };
}
