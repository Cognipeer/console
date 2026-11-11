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
import { MongoDBProviderBase, COLLECTIONS, escapeRegex } from './base';
import { definedFields } from './definedFields';
import { mongoLabelCandidates } from '../provider/labelMatch';
import { isDuplicateKeyError } from './errors';
import { assertUniqueItemIds } from '../provider/evaluationItems';

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
      const updateData = { ...definedFields(data), updatedAt: new Date() };
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
      const updateData: Record<string, unknown> = { ...definedFields(rest), updatedAt: new Date() };
      if (items !== undefined) updateData.itemCount = items.length;
      const result = await db
        .collection<IEvaluationDataset>(COLLECTIONS.evaluationDatasets)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      if (items !== undefined) {
        // Full replace of the item rows.
        await this.writeDatasetItemsReplacing(db, result, items);
      }
      return this.mapDatasetDoc(result);
    }

    async deleteEvaluationDataset(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.evaluationDatasets).deleteOne({ _id: new ObjectId(id) });
      // Cascade the item rows.
      await db.collection(COLLECTIONS.evaluationDatasetItems).deleteMany({ datasetId: id });
      return result.deletedCount === 1;
    }

    async findEvaluationDatasetById(id: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return this.mapDatasetDoc(doc as unknown as IEvaluationDataset);
    }

    async findEvaluationDatasetByKey(key: string, projectId?: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .findOne(filter);
      if (!doc) return null;
      return this.mapDatasetDoc(doc as unknown as IEvaluationDataset);
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
      const docs = await db
        .collection(COLLECTIONS.evaluationDatasets)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((doc) => this.mapDatasetDoc(doc as unknown as IEvaluationDataset));
    }

    /** Normalise a dataset document: string _id, itemCount defaulting to 0. */
    private mapDatasetDoc(doc: IEvaluationDataset & { _id?: ObjectId | string }): IEvaluationDataset {
      return { ...doc, _id: doc._id?.toString(), itemCount: doc.itemCount ?? 0 } as IEvaluationDataset;
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
     * no trace.
     */
    private async insertDatasetItems(
      db: Db,
      datasetId: string,
      tenantId: string,
      projectId: string | undefined,
      items: IEvaluationDatasetItem[],
      startPosition: number,
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
      // Stamp the count from the actual rows (the caller's optimistic $set
      // can lie if anything went sideways).
      await this.stampDatasetItemCount(db, datasetId);
    }

    async createEvaluationDatasetItems(datasetId: string, items: IEvaluationDatasetItem[]): Promise<number> {
      const db = this.getTenantDb();
      if (items.length === 0) return 0;
      assertUniqueItemIds(items);
      const parent = await this.requireDatasetHeader(db, datasetId);
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

    async listEvaluationDatasetItems(
      datasetId: string,
      options?: EvaluationDatasetItemQuery,
    ): Promise<IEvaluationDatasetItemRecord[]> {
      const db = this.getTenantDb();
      const skip = Math.max(0, options?.skip ?? 0);
      const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
      const coll = db.collection(COLLECTIONS.evaluationDatasetItems);
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
      return coll.countDocuments(itemFilter(datasetId, search, filters));
    }

    async findEvaluationDatasetItem(datasetId: string, itemId: string): Promise<IEvaluationDatasetItemRecord | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.evaluationDatasetItems)
        .findOne({ datasetId, id: itemId });
      return doc ? ({ ...doc, _id: doc._id?.toString() } as unknown as IEvaluationDatasetItemRecord) : null;
    }

    async updateEvaluationDatasetItem(
      datasetId: string,
      itemId: string,
      data: Partial<Omit<IEvaluationDatasetItem, 'id'>>,
    ): Promise<IEvaluationDatasetItemRecord | null> {
      const db = this.getTenantDb();
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
      const updateData = { ...definedFields(data), updatedAt: new Date() };
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
