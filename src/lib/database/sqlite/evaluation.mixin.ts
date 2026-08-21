/**
 * SQLite Provider – Evaluation operations mixin
 *
 * CRUD for evaluation targets, datasets, suites, and runs (result items +
 * aggregate embedded as JSON). Mirrors the guardrail mixin conventions
 * (prepared statements, JSON columns, row mappers).
 *
 * Dataset items live in their own `evaluation_dataset_items` table (one row
 * per item, ordered by `position`) — mirroring the MongoDB provider. Dataset
 * writes still accept an inline `items` array (create inserts, update
 * replaces) and maintain the denormalised `itemCount`; rows created before
 * the split keep their JSON `items` column until the first item write
 * migrates them, and the item read methods serve that legacy column
 * transparently in the meantime.
 */

import type {
  IEvaluationTarget,
  IEvaluationDataset,
  IEvaluationDatasetItem,
  IEvaluationDatasetItemRecord,
  IEvaluationSuite,
  IEvaluationScorerConfig,
  IEvaluationRun,
  IEvaluationRunItem,
  IEvaluationRunAggregate,
  EvaluationTargetKind,
  EvaluationDatasetSource,
  EvaluationRunStatus,
  EvaluationDatasetItemQuery,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';
import {
  hasAnyLabel,
  labelJsonPath,
  labelValueCandidates,
  matchesLabel,
} from '../provider/labelMatch';

/** True when the error is a SQLite UNIQUE-constraint violation. */
function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed');
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
 * ids — sanitize before migrating under the unique (datasetId, itemId)
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

/**
 * Field-scoped item-search clause: matches the item id, per-message `content`
 * values and per-tag values via JSON1 — the same semantics as
 * itemMatchesSearch and the MongoDB provider, instead of LIKE-ing raw JSON
 * text (which would match keys/escapes like "role":"user").
 */
function itemSearchClause(table: string): string {
  return `(itemId LIKE @search ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM json_each(${table}.input) je WHERE COALESCE(json_extract(je.value, '$.content'), '') LIKE @search ESCAPE '\\')
    OR EXISTS (SELECT 1 FROM json_each(COALESCE(${table}.tags, '[]')) jt WHERE jt.value LIKE @search ESCAPE '\\'))`;
}

/**
 * Label filter clauses (see labelMatch.ts for the shared semantics). The label
 * KEY is passed as a bound json_extract path rather than interpolated, and
 * values are compared in canonical lowercase text form so a JSON boolean
 * (json_extract → 1/0) still matches a `true`/`false` query.
 */
function labelClauses(
  table: string,
  filters: { label?: { key: string; value?: string }; labeled?: boolean },
): { clauses: string[]; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const nonEmpty = `(${table}.labels IS NOT NULL AND ${table}.labels != '' AND ${table}.labels != '{}')`;
  if (filters.labeled === true) clauses.push(nonEmpty);
  if (filters.labeled === false) clauses.push(`NOT ${nonEmpty}`);
  if (filters.label) {
    params.labelPath = labelJsonPath(filters.label.key);
    if (filters.label.value === undefined) {
      clauses.push(`json_extract(${table}.labels, @labelPath) IS NOT NULL`);
    } else {
      const [primary, alias] = labelValueCandidates(filters.label.value);
      params.labelValue = primary;
      params.labelValueAlias = alias ?? primary;
      clauses.push(
        `LOWER(CAST(json_extract(${table}.labels, @labelPath) AS TEXT)) IN (@labelValue, @labelValueAlias)`,
      );
    }
  }
  return { clauses, params };
}

function toIso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function EvaluationMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class EvaluationOps extends Base {
    // ── Targets ──────────────────────────────────────────────────────

    async createEvaluationTarget(
      target: Omit<IEvaluationTarget, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationTarget> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.evaluationTargets}
        (id, tenantId, projectId, key, name, description, kind, agentKey, modelKey,
         ragModuleKey, retrievalTopK, retrievalMinScore,
         external, systemPrompt, promptKey, promptVersion, responseFormat, maxTokens, defaultParams, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @kind, @agentKey, @modelKey,
         @ragModuleKey, @retrievalTopK, @retrievalMinScore,
         @external, @systemPrompt, @promptKey, @promptVersion, @responseFormat, @maxTokens, @defaultParams, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: target.tenantId,
        projectId: target.projectId ?? null,
        key: target.key,
        name: target.name,
        description: target.description ?? null,
        kind: target.kind,
        agentKey: target.agentKey ?? null,
        modelKey: target.modelKey ?? null,
        ragModuleKey: target.ragModuleKey ?? null,
        retrievalTopK: target.retrievalTopK ?? null,
        retrievalMinScore: target.retrievalMinScore ?? null,
        external: target.external ? this.toJson(target.external) : null,
        systemPrompt: target.systemPrompt ?? null,
        promptKey: target.promptKey ?? null,
        promptVersion: target.promptVersion ?? null,
        responseFormat: target.responseFormat ? this.toJson(target.responseFormat) : null,
        maxTokens: target.maxTokens ?? null,
        defaultParams: this.toJson(target.defaultParams ?? {}),
        metadata: this.toJson(target.metadata ?? {}),
        createdBy: target.createdBy,
        updatedBy: target.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...target, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateEvaluationTarget(
      id: string,
      data: Partial<Omit<IEvaluationTarget, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.kind !== undefined) { sets.push('kind = @kind'); params.kind = data.kind; }
      if (data.agentKey !== undefined) { sets.push('agentKey = @agentKey'); params.agentKey = data.agentKey; }
      if (data.modelKey !== undefined) { sets.push('modelKey = @modelKey'); params.modelKey = data.modelKey; }
      if (data.ragModuleKey !== undefined) { sets.push('ragModuleKey = @ragModuleKey'); params.ragModuleKey = data.ragModuleKey ?? null; }
      if (data.retrievalTopK !== undefined) { sets.push('retrievalTopK = @retrievalTopK'); params.retrievalTopK = data.retrievalTopK ?? null; }
      if (data.retrievalMinScore !== undefined) { sets.push('retrievalMinScore = @retrievalMinScore'); params.retrievalMinScore = data.retrievalMinScore ?? null; }
      if (data.external !== undefined) { sets.push('external = @external'); params.external = data.external ? this.toJson(data.external) : null; }
      if (data.systemPrompt !== undefined) { sets.push('systemPrompt = @systemPrompt'); params.systemPrompt = data.systemPrompt ?? null; }
      if (data.promptKey !== undefined) { sets.push('promptKey = @promptKey'); params.promptKey = data.promptKey ?? null; }
      if (data.promptVersion !== undefined) { sets.push('promptVersion = @promptVersion'); params.promptVersion = data.promptVersion ?? null; }
      if (data.responseFormat !== undefined) { sets.push('responseFormat = @responseFormat'); params.responseFormat = data.responseFormat ? this.toJson(data.responseFormat) : null; }
      if (data.maxTokens !== undefined) { sets.push('maxTokens = @maxTokens'); params.maxTokens = data.maxTokens ?? null; }
      if (data.defaultParams !== undefined) { sets.push('defaultParams = @defaultParams'); params.defaultParams = this.toJson(data.defaultParams); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.evaluationTargets} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findEvaluationTargetById(id);
    }

    async deleteEvaluationTarget(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.evaluationTargets} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findEvaluationTargetById(id: string): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationTargets} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapTargetRow(row) : null;
    }

    async findEvaluationTargetByKey(key: string, projectId?: string): Promise<IEvaluationTarget | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationTargets} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapTargetRow(row) : null;
    }

    async listEvaluationTargets(filters?: { projectId?: string; kind?: EvaluationTargetKind; search?: string }): Promise<IEvaluationTarget[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.kind !== undefined) { clauses.push('kind = @kind'); params.kind = filters.kind; }
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.evaluationTargets} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapTargetRow(r));
    }

    // ── Datasets ─────────────────────────────────────────────────────

    async createEvaluationDataset(
      dataset: Omit<IEvaluationDataset, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationDataset> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      const { items, ...meta } = dataset;
      if (items && items.length > 0) assertUniqueItemIds(items);
      // One transaction: a failed item insert must roll the header back too
      // (a half-created dataset would squat on the key with a lying count).
      const createAll = db.transaction(() => {
        db.prepare(`
          INSERT INTO ${TABLES.evaluationDatasets}
          (id, tenantId, projectId, key, name, description, source, items, itemCount, metadata,
           createdBy, updatedBy, createdAt, updatedAt)
          VALUES (@id, @tenantId, @projectId, @key, @name, @description, @source, '[]', @itemCount, @metadata,
           @createdBy, @updatedBy, @createdAt, @updatedAt)
        `).run({
          id,
          tenantId: meta.tenantId,
          projectId: meta.projectId ?? null,
          key: meta.key,
          name: meta.name,
          description: meta.description ?? null,
          source: meta.source,
          itemCount: items?.length ?? 0,
          metadata: this.toJson(meta.metadata ?? {}),
          createdBy: meta.createdBy,
          updatedBy: meta.updatedBy ?? null,
          createdAt: now,
          updatedAt: now,
        });
        if (items && items.length > 0) {
          this.insertDatasetItemRows(id, meta.tenantId, meta.projectId, items, 0);
        }
      });
      createAll();
      return { ...meta, itemCount: items?.length ?? 0, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateEvaluationDataset(
      id: string,
      data: Partial<Omit<IEvaluationDataset, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const { items, ...rest } = data;
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (rest.name !== undefined) { sets.push('name = @name'); params.name = rest.name; }
      if (rest.description !== undefined) { sets.push('description = @description'); params.description = rest.description; }
      if (rest.source !== undefined) { sets.push('source = @source'); params.source = rest.source; }
      if (rest.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(rest.metadata); }
      if (rest.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = rest.updatedBy; }
      if (rest.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = rest.projectId; }
      if (items !== undefined) {
        // Full replace mirroring the old embedded semantics; also clears the
        // legacy JSON column. Duplicate ids in the payload are rejected
        // BEFORE anything is touched, and the whole replace runs in ONE
        // transaction — a failed insert must never leave the dataset emptied.
        assertUniqueItemIds(items);
        sets.push("items = '[]'", 'itemCount = @itemCount');
        params.itemCount = items.length;
        const header = this.getDatasetHeader(id);
        const applyUpdate = db.transaction(() => {
          db.prepare(`UPDATE ${TABLES.evaluationDatasets} SET ${sets.join(', ')} WHERE id = @id`).run(params);
          if (header) {
            db.prepare(`DELETE FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @id`).run({ id });
            this.insertDatasetItemRows(id, header.tenantId, header.projectId, items, 0);
          }
        });
        applyUpdate();
        return this.findEvaluationDatasetById(id);
      }
      db.prepare(`UPDATE ${TABLES.evaluationDatasets} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findEvaluationDatasetById(id);
    }

    async deleteEvaluationDataset(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const deleted = db.prepare(`DELETE FROM ${TABLES.evaluationDatasets} WHERE id = @id`).run({ id }).changes === 1;
      db.prepare(`DELETE FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @id`).run({ id });
      return deleted;
    }

    async findEvaluationDatasetById(id: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationDatasets} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapDatasetRow(row) : null;
    }

    async findEvaluationDatasetByKey(key: string, projectId?: string): Promise<IEvaluationDataset | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationDatasets} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapDatasetRow(row) : null;
    }

    async listEvaluationDatasets(filters?: { projectId?: string; source?: EvaluationDatasetSource; search?: string }): Promise<IEvaluationDataset[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.source !== undefined) { clauses.push('source = @source'); params.source = filters.source; }
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.evaluationDatasets} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapDatasetRow(r));
    }

    // ── Dataset items (separate table) ───────────────────────────────

    /** Dataset header (tenant/project) or null. */
    private getDatasetHeader(datasetId: string): { tenantId: string; projectId?: string } | null {
      const db = this.getTenantDb();
      const row = db
        .prepare(`SELECT tenantId, projectId FROM ${TABLES.evaluationDatasets} WHERE id = @datasetId`)
        .get({ datasetId }) as SqliteRow | undefined;
      if (!row) return null;
      return { tenantId: row.tenantId as string, projectId: (row.projectId as string | null) ?? undefined };
    }

    /** Bulk insert item rows at consecutive positions, inside a transaction.
     *  `orIgnore` (legacy migration) skips rows whose itemId already exists
     *  instead of failing — never overwriting post-split rows. */
    private insertDatasetItemRows(
      datasetId: string,
      tenantId: string,
      projectId: string | undefined,
      items: IEvaluationDatasetItem[],
      startPosition: number,
      opts?: { orIgnore?: boolean },
    ): void {
      if (items.length === 0) return;
      const db = this.getTenantDb();
      const stmt = db.prepare(`
        INSERT ${opts?.orIgnore ? 'OR IGNORE ' : ''}INTO ${TABLES.evaluationDatasetItems}
        (id, tenantId, projectId, datasetId, itemId, position, input, expected, tools, toolResults, responseFormat, tags,
         labels, labelMeta, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @datasetId, @itemId, @position, @input, @expected, @tools, @toolResults, @responseFormat, @tags,
         @labels, @labelMeta, @createdAt, @updatedAt)
      `);
      const now = this.now();
      const insertAll = db.transaction((rows: IEvaluationDatasetItem[]) => {
        rows.forEach((item, i) => {
          stmt.run({
            id: this.newId(),
            tenantId,
            projectId: projectId ?? null,
            datasetId,
            itemId: item.id,
            position: startPosition + i,
            input: this.toJson(item.input ?? []),
            expected: item.expected !== undefined ? this.toJson(item.expected) : null,
            tools: item.tools !== undefined ? this.toJson(item.tools) : null,
            toolResults: item.toolResults !== undefined ? this.toJson(item.toolResults) : null,
            responseFormat: item.responseFormat !== undefined ? this.toJson(item.responseFormat) : null,
            tags: item.tags !== undefined ? this.toJson(item.tags) : null,
            labels: item.labels !== undefined ? this.toJson(item.labels) : null,
            labelMeta: item.labelMeta !== undefined ? this.toJson(item.labelMeta) : null,
            createdAt: now,
            updatedAt: now,
          });
        });
      });
      try {
        insertAll(items);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new Error('A dataset item with one of the given ids already exists');
        }
        throw error;
      }
    }

    /** Parse the legacy embedded JSON column (null when empty/absent). */
    private readLegacyItemColumn(datasetId: string): IEvaluationDatasetItem[] | null {
      const db = this.getTenantDb();
      const row = db
        .prepare(`SELECT items FROM ${TABLES.evaluationDatasets} WHERE id = @datasetId`)
        .get({ datasetId }) as SqliteRow | undefined;
      if (!row) return null;
      const items = this.parseJson<IEvaluationDatasetItem[]>(row.items, []);
      return items.length > 0 ? items : null;
    }

    /**
     * Idempotent, NON-destructive legacy migration: copy the embedded JSON
     * array into the item table (rows that already exist — from a crashed
     * earlier attempt or written post-split — are skipped via INSERT OR
     * IGNORE, never overwritten), then clear the column and stamp the real
     * row count, all in one transaction. Legacy ids are sanitized first (the
     * old storage never enforced uniqueness). Empty legacy rows (itemCount
     * still NULL) just get their count stamped.
     */
    private migrateLegacyItemColumn(datasetId: string): void {
      const db = this.getTenantDb();
      const row = db
        .prepare(`SELECT items, itemCount, tenantId, projectId FROM ${TABLES.evaluationDatasets} WHERE id = @datasetId`)
        .get({ datasetId }) as SqliteRow | undefined;
      if (!row) return;
      const legacy = this.parseJson<IEvaluationDatasetItem[]>(row.items, []);
      const alreadyStamped = typeof row.itemCount === 'number';
      if (legacy.length === 0 && alreadyStamped) return; // migrated / post-split
      const tenantId = row.tenantId as string;
      const projectId = (row.projectId as string | null) ?? undefined;
      const migrate = db.transaction(() => {
        if (legacy.length > 0) {
          this.insertDatasetItemRows(
            datasetId,
            tenantId,
            projectId,
            sanitizeLegacyItemIds(legacy),
            0,
            { orIgnore: true },
          );
        }
        const count = db
          .prepare(`SELECT COUNT(*) AS n FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @datasetId`)
          .get({ datasetId }) as SqliteRow;
        db.prepare(
          `UPDATE ${TABLES.evaluationDatasets} SET items = '[]', itemCount = @itemCount, updatedAt = @updatedAt WHERE id = @datasetId`,
        ).run({ datasetId, itemCount: Number(count.n ?? 0), updatedAt: this.now() });
      });
      migrate();
    }

    /** Recount item rows and stamp the parent row's itemCount. */
    private stampDatasetItemCount(datasetId: string): void {
      const db = this.getTenantDb();
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @datasetId`)
        .get({ datasetId }) as SqliteRow;
      db.prepare(
        `UPDATE ${TABLES.evaluationDatasets} SET itemCount = @itemCount, updatedAt = @updatedAt WHERE id = @datasetId`,
      ).run({ datasetId, itemCount: Number(row.n ?? 0), updatedAt: this.now() });
    }

    async createEvaluationDatasetItems(datasetId: string, items: IEvaluationDatasetItem[]): Promise<number> {
      if (items.length === 0) return 0;
      assertUniqueItemIds(items);
      const header = this.getDatasetHeader(datasetId);
      if (!header) throw new Error(`Evaluation dataset "${datasetId}" not found`);
      this.migrateLegacyItemColumn(datasetId);
      const db = this.getTenantDb();
      const append = db.transaction(() => {
        const last = db
          .prepare(`SELECT MAX(position) AS p FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @datasetId`)
          .get({ datasetId }) as SqliteRow;
        const start = typeof last.p === 'number' ? (last.p as number) + 1 : 0;
        this.insertDatasetItemRows(datasetId, header.tenantId, header.projectId, items, start);
      });
      append();
      this.stampDatasetItemCount(datasetId);
      return items.length;
    }

    async replaceEvaluationDatasetItems(datasetId: string, items: IEvaluationDatasetItem[]): Promise<number> {
      assertUniqueItemIds(items);
      const header = this.getDatasetHeader(datasetId);
      if (!header) throw new Error(`Evaluation dataset "${datasetId}" not found`);
      const db = this.getTenantDb();
      // One transaction: the DELETE must never commit without its INSERTs.
      const replaceAll = db.transaction(() => {
        db.prepare(`DELETE FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @datasetId`).run({ datasetId });
        this.insertDatasetItemRows(datasetId, header.tenantId, header.projectId, items, 0);
        db.prepare(
          `UPDATE ${TABLES.evaluationDatasets} SET items = '[]', itemCount = @itemCount, updatedAt = @updatedAt WHERE id = @datasetId`,
        ).run({ datasetId, itemCount: items.length, updatedAt: this.now() });
      });
      replaceAll();
      return items.length;
    }

    /** Table-backed rows exist for this dataset? (legacy datasets: none) */
    private hasDatasetItemRows(datasetId: string): boolean {
      const db = this.getTenantDb();
      return !!db
        .prepare(`SELECT 1 FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @datasetId LIMIT 1`)
        .get({ datasetId });
    }

    async listEvaluationDatasetItems(
      datasetId: string,
      options?: EvaluationDatasetItemQuery,
    ): Promise<IEvaluationDatasetItemRecord[]> {
      const db = this.getTenantDb();
      const skip = Math.max(0, options?.skip ?? 0);
      const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
      if (this.hasDatasetItemRows(datasetId)) {
        const clauses = ['datasetId = @datasetId'];
        const params: Record<string, unknown> = { datasetId };
        if (options?.search) {
          clauses.push(itemSearchClause(TABLES.evaluationDatasetItems));
          params.search = this.likePattern(options.search);
        }
        const labels = labelClauses(TABLES.evaluationDatasetItems, options ?? {});
        clauses.push(...labels.clauses);
        Object.assign(params, labels.params);
        // itemId tiebreak keeps the order total even if positions collide.
        const rows = db
          .prepare(
            `SELECT * FROM ${TABLES.evaluationDatasetItems} WHERE ${clauses.join(' AND ')} ORDER BY position ASC, itemId ASC LIMIT ${limit} OFFSET ${skip}`,
          )
          .all(params) as SqliteRow[];
        return rows.map((r) => this.mapDatasetItemRow(r));
      }
      // Legacy dataset — serve a slice of the embedded JSON column.
      const legacy = this.readLegacyItemColumn(datasetId);
      if (!legacy) return [];
      const header = this.getDatasetHeader(datasetId);
      if (!header) return [];
      const filtered = legacy.filter((item) => legacyItemMatches(item, options));
      return filtered.slice(skip, skip + limit).map((item, i) => ({
        ...item,
        datasetId,
        tenantId: header.tenantId,
        projectId: header.projectId,
        position: skip + i,
      }));
    }

    async countEvaluationDatasetItems(
      datasetId: string,
      search?: string,
      filters?: Omit<EvaluationDatasetItemQuery, 'skip' | 'limit' | 'search'>,
    ): Promise<number> {
      const db = this.getTenantDb();
      if (this.hasDatasetItemRows(datasetId)) {
        const clauses = ['datasetId = @datasetId'];
        const params: Record<string, unknown> = { datasetId };
        if (search) {
          clauses.push(itemSearchClause(TABLES.evaluationDatasetItems));
          params.search = this.likePattern(search);
        }
        const labels = labelClauses(TABLES.evaluationDatasetItems, filters ?? {});
        clauses.push(...labels.clauses);
        Object.assign(params, labels.params);
        const row = db
          .prepare(`SELECT COUNT(*) AS n FROM ${TABLES.evaluationDatasetItems} WHERE ${clauses.join(' AND ')}`)
          .get(params) as SqliteRow;
        return Number(row.n ?? 0);
      }
      const legacy = this.readLegacyItemColumn(datasetId) ?? [];
      return legacy.filter((item) => legacyItemMatches(item, { ...filters, search })).length;
    }

    async findEvaluationDatasetItem(datasetId: string, itemId: string): Promise<IEvaluationDatasetItemRecord | null> {
      const db = this.getTenantDb();
      const row = db
        .prepare(`SELECT * FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @datasetId AND itemId = @itemId`)
        .get({ datasetId, itemId }) as SqliteRow | undefined;
      if (row) return this.mapDatasetItemRow(row);
      const legacy = this.readLegacyItemColumn(datasetId);
      if (!legacy) return null;
      const index = legacy.findIndex((item) => item.id === itemId);
      if (index < 0) return null;
      const header = this.getDatasetHeader(datasetId);
      if (!header) return null;
      return { ...legacy[index], datasetId, tenantId: header.tenantId, projectId: header.projectId, position: index };
    }

    async updateEvaluationDatasetItem(
      datasetId: string,
      itemId: string,
      data: Partial<Omit<IEvaluationDatasetItem, 'id'>>,
    ): Promise<IEvaluationDatasetItemRecord | null> {
      this.migrateLegacyItemColumn(datasetId);
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { datasetId, itemId, updatedAt: this.now() };
      if (data.input !== undefined) { sets.push('input = @input'); params.input = this.toJson(data.input); }
      if (data.expected !== undefined) { sets.push('expected = @expected'); params.expected = data.expected !== null ? this.toJson(data.expected) : null; }
      if (data.tools !== undefined) { sets.push('tools = @tools'); params.tools = data.tools !== null ? this.toJson(data.tools) : null; }
      if (data.toolResults !== undefined) { sets.push('toolResults = @toolResults'); params.toolResults = data.toolResults !== null ? this.toJson(data.toolResults) : null; }
      if (data.responseFormat !== undefined) { sets.push('responseFormat = @responseFormat'); params.responseFormat = data.responseFormat !== null ? this.toJson(data.responseFormat) : null; }
      if (data.tags !== undefined) { sets.push('tags = @tags'); params.tags = data.tags !== null ? this.toJson(data.tags) : null; }
      if (data.labels !== undefined) { sets.push('labels = @labels'); params.labels = data.labels !== null ? this.toJson(data.labels) : null; }
      if (data.labelMeta !== undefined) { sets.push('labelMeta = @labelMeta'); params.labelMeta = data.labelMeta !== null ? this.toJson(data.labelMeta) : null; }
      const changed = db
        .prepare(`UPDATE ${TABLES.evaluationDatasetItems} SET ${sets.join(', ')} WHERE datasetId = @datasetId AND itemId = @itemId`)
        .run(params).changes;
      if (changed !== 1) return null;
      db.prepare(`UPDATE ${TABLES.evaluationDatasets} SET updatedAt = @updatedAt WHERE id = @datasetId`)
        .run({ datasetId, updatedAt: this.now() });
      return this.findEvaluationDatasetItem(datasetId, itemId);
    }

    async deleteEvaluationDatasetItem(datasetId: string, itemId: string): Promise<boolean> {
      this.migrateLegacyItemColumn(datasetId);
      const db = this.getTenantDb();
      const deleted = db
        .prepare(`DELETE FROM ${TABLES.evaluationDatasetItems} WHERE datasetId = @datasetId AND itemId = @itemId`)
        .run({ datasetId, itemId }).changes === 1;
      if (deleted) this.stampDatasetItemCount(datasetId);
      return deleted;
    }

    // ── Suites ───────────────────────────────────────────────────────

    async createEvaluationSuite(
      suite: Omit<IEvaluationSuite, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationSuite> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.evaluationSuites}
        (id, tenantId, projectId, key, name, description, targetKey, datasetKey, scorers,
         judgeModelKey, embeddingModelKey, runConfig, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @targetKey, @datasetKey, @scorers,
         @judgeModelKey, @embeddingModelKey, @runConfig, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: suite.tenantId,
        projectId: suite.projectId ?? null,
        key: suite.key,
        name: suite.name,
        description: suite.description ?? null,
        targetKey: suite.targetKey,
        datasetKey: suite.datasetKey,
        scorers: this.toJson(suite.scorers ?? []),
        judgeModelKey: suite.judgeModelKey ?? null,
        embeddingModelKey: suite.embeddingModelKey ?? null,
        runConfig: this.toJson(suite.runConfig ?? {}),
        metadata: this.toJson(suite.metadata ?? {}),
        createdBy: suite.createdBy,
        updatedBy: suite.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...suite, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateEvaluationSuite(
      id: string,
      data: Partial<Omit<IEvaluationSuite, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.targetKey !== undefined) { sets.push('targetKey = @targetKey'); params.targetKey = data.targetKey; }
      if (data.datasetKey !== undefined) { sets.push('datasetKey = @datasetKey'); params.datasetKey = data.datasetKey; }
      if (data.scorers !== undefined) { sets.push('scorers = @scorers'); params.scorers = this.toJson(data.scorers); }
      if (data.judgeModelKey !== undefined) { sets.push('judgeModelKey = @judgeModelKey'); params.judgeModelKey = data.judgeModelKey; }
      if (data.embeddingModelKey !== undefined) { sets.push('embeddingModelKey = @embeddingModelKey'); params.embeddingModelKey = data.embeddingModelKey; }
      if (data.runConfig !== undefined) { sets.push('runConfig = @runConfig'); params.runConfig = this.toJson(data.runConfig); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.evaluationSuites} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findEvaluationSuiteById(id);
    }

    async deleteEvaluationSuite(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.evaluationSuites} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findEvaluationSuiteById(id: string): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationSuites} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapSuiteRow(row) : null;
    }

    async findEvaluationSuiteByKey(key: string, projectId?: string): Promise<IEvaluationSuite | null> {
      const db = this.getTenantDb();
      const clauses = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationSuites} WHERE ${clauses.join(' AND ')}`).get(params) as SqliteRow | undefined;
      return row ? this.mapSuiteRow(row) : null;
    }

    async listEvaluationSuites(filters?: { projectId?: string; targetKey?: string; datasetKey?: string; search?: string }): Promise<IEvaluationSuite[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.targetKey !== undefined) { clauses.push('targetKey = @targetKey'); params.targetKey = filters.targetKey; }
      if (filters?.datasetKey !== undefined) { clauses.push('datasetKey = @datasetKey'); params.datasetKey = filters.datasetKey; }
      if (filters?.search) { clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)'); params.search = this.likePattern(filters.search); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.evaluationSuites} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapSuiteRow(r));
    }

    // ── Runs ─────────────────────────────────────────────────────────

    async createEvaluationRun(
      run: Omit<IEvaluationRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IEvaluationRun> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.evaluationRuns}
        (id, tenantId, projectId, suiteKey, targetKey, datasetKey, status, mode, progress,
         aggregate, items, error, startedAt, finishedAt, createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @suiteKey, @targetKey, @datasetKey, @status, @mode, @progress,
         @aggregate, @items, @error, @startedAt, @finishedAt, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: run.tenantId,
        projectId: run.projectId ?? null,
        suiteKey: run.suiteKey,
        targetKey: run.targetKey,
        datasetKey: run.datasetKey,
        status: run.status,
        mode: run.mode,
        progress: this.toJson(run.progress ?? { total: 0, completed: 0, failed: 0 }),
        aggregate: run.aggregate !== undefined ? this.toJson(run.aggregate) : null,
        items: this.toJson(run.items ?? []),
        error: run.error ?? null,
        startedAt: toIso(run.startedAt),
        finishedAt: toIso(run.finishedAt),
        createdBy: run.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return { ...run, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateEvaluationRun(
      id: string,
      data: Partial<Omit<IEvaluationRun, 'tenantId' | 'suiteKey' | 'createdBy'>>,
    ): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.mode !== undefined) { sets.push('mode = @mode'); params.mode = data.mode; }
      if (data.progress !== undefined) { sets.push('progress = @progress'); params.progress = this.toJson(data.progress); }
      if (data.aggregate !== undefined) { sets.push('aggregate = @aggregate'); params.aggregate = this.toJson(data.aggregate); }
      if (data.items !== undefined) { sets.push('items = @items'); params.items = this.toJson(data.items); }
      if (data.error !== undefined) { sets.push('error = @error'); params.error = data.error; }
      if (data.startedAt !== undefined) { sets.push('startedAt = @startedAt'); params.startedAt = toIso(data.startedAt); }
      if (data.finishedAt !== undefined) { sets.push('finishedAt = @finishedAt'); params.finishedAt = toIso(data.finishedAt); }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      db.prepare(`UPDATE ${TABLES.evaluationRuns} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findEvaluationRunById(id);
    }

    async findEvaluationRunById(id: string): Promise<IEvaluationRun | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.evaluationRuns} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapEvaluationRunRow(row) : null;
    }

    async listEvaluationRuns(filters?: { projectId?: string; suiteKey?: string; status?: EvaluationRunStatus; limit?: number; skip?: number }): Promise<IEvaluationRun[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.suiteKey !== undefined) { clauses.push('suiteKey = @suiteKey'); params.suiteKey = filters.suiteKey; }
      if (filters?.status !== undefined) { clauses.push('status = @status'); params.status = filters.status; }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters?.limit ?? 50;
      const skip = filters?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.evaluationRuns} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapEvaluationRunRow(r));
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapTargetRow(r: SqliteRow): IEvaluationTarget {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? undefined,
        kind: r.kind as EvaluationTargetKind,
        agentKey: (r.agentKey as string | null) ?? undefined,
        modelKey: (r.modelKey as string | null) ?? undefined,
        ragModuleKey: (r.ragModuleKey as string | null) ?? undefined,
        retrievalTopK: (r.retrievalTopK as number | null) ?? undefined,
        retrievalMinScore: (r.retrievalMinScore as number | null) ?? undefined,
        external: this.parseJson(r.external, undefined as IEvaluationTarget['external']),
        systemPrompt: (r.systemPrompt as string | null) ?? undefined,
        promptKey: (r.promptKey as string | null) ?? undefined,
        promptVersion: (r.promptVersion as number | null) ?? undefined,
        responseFormat: this.parseJson(r.responseFormat, undefined as Record<string, unknown> | undefined),
        maxTokens: (r.maxTokens as number | null) ?? undefined,
        defaultParams: this.parseJson(r.defaultParams, {}),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapDatasetRow(r: SqliteRow): IEvaluationDataset {
      // Legacy rows keep their embedded JSON until migrated — the count comes
      // from parsing it, but the array itself is never surfaced.
      const itemCount =
        typeof r.itemCount === 'number'
          ? (r.itemCount as number)
          : this.parseJson<IEvaluationDatasetItem[]>(r.items, []).length;
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? undefined,
        source: r.source as EvaluationDatasetSource,
        itemCount,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapDatasetItemRow(r: SqliteRow): IEvaluationDatasetItemRecord {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        datasetId: r.datasetId as string,
        id: r.itemId as string,
        position: Number(r.position ?? 0),
        input: this.parseJson<IEvaluationDatasetItem['input']>(r.input, []),
        expected: this.parseJson<IEvaluationDatasetItem['expected']>(r.expected, undefined),
        tools: this.parseJson<IEvaluationDatasetItem['tools']>(r.tools, undefined),
        toolResults: this.parseJson<IEvaluationDatasetItem['toolResults']>(r.toolResults, undefined),
        responseFormat: this.parseJson<IEvaluationDatasetItem['responseFormat']>(r.responseFormat, undefined),
        tags: this.parseJson<string[] | undefined>(r.tags, undefined),
        labels: this.parseJson<Record<string, unknown> | undefined>(r.labels, undefined),
        labelMeta: this.parseJson<IEvaluationDatasetItem['labelMeta']>(r.labelMeta, undefined),
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapSuiteRow(r: SqliteRow): IEvaluationSuite {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? undefined,
        targetKey: r.targetKey as string,
        datasetKey: r.datasetKey as string,
        scorers: this.parseJson<IEvaluationScorerConfig[]>(r.scorers, []),
        judgeModelKey: (r.judgeModelKey as string | null) ?? undefined,
        embeddingModelKey: (r.embeddingModelKey as string | null) ?? undefined,
        runConfig: this.parseJson(r.runConfig, {}),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapEvaluationRunRow(r: SqliteRow): IEvaluationRun {
      const aggregate = this.parseJson<IEvaluationRunAggregate | null>(r.aggregate, null);
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null) ?? undefined,
        suiteKey: r.suiteKey as string,
        targetKey: r.targetKey as string,
        datasetKey: r.datasetKey as string,
        status: r.status as EvaluationRunStatus,
        mode: r.mode as IEvaluationRun['mode'],
        progress: this.parseJson(r.progress, { total: 0, completed: 0, failed: 0 }),
        aggregate: aggregate ?? undefined,
        items: this.parseJson<IEvaluationRunItem[]>(r.items, []),
        error: (r.error as string | null) ?? undefined,
        startedAt: this.toDate(r.startedAt),
        finishedAt: this.toDate(r.finishedAt),
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
