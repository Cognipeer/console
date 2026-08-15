/**
 * Cost service — observed-model spend overview + external pricing catalog.
 *
 * "Observed models" are every distinct model that appears in the `usage_daily`
 * rollup for the models service — gateway-served (source 'api') and
 * observability-derived (source 'tracing') alike. Each one resolves to:
 *   - 'hub'      — a Model Hub model (priced by the hub),
 *   - 'external' — priced via the tenant's external pricing catalog,
 *   - 'unpriced' — usage recorded with cost 0; the Cost page prompts the user
 *                  to enter a reference price, which prices INGESTS FROM THEN
 *                  ON (recorded history is not rewritten).
 */

import { getDatabase } from '@/lib/database';
import type { IExternalModelPricing, IExternalPricingVersion, IModelPricing } from '@/lib/database';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { toUtcDay } from '@/lib/services/usage/usageBreakdown';

export interface CostContext {
  tenantDbName: string;
  tenantId: string;
  /** undefined = tenant-wide ("total") scope: usage across all projects. */
  projectId?: string;
}

export type ObservedModelStatus = 'hub' | 'external' | 'unpriced';

export interface ObservedModelEntry {
  /** usage_daily refKey: hub model key, or raw trace model name. */
  modelKey: string;
  /** Display name: hub model name, catalog modelName, or the raw key. */
  modelName: string;
  status: ObservedModelStatus;
  providerKey?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Spend split by usage_daily source ('api' | 'tracing' | ...). */
  costBySource: Record<string, number>;
  /** Trace model-call count (units.modelCalls) where available. */
  modelCalls: number;
  /** Current pricing applied at ingest, when the model is priced. */
  pricing?: IModelPricing;
}

export interface ObservedModelCosts {
  fromDay?: string;
  toDay?: string;
  totals: {
    requests: number;
    totalTokens: number;
    costUsd: number;
    /** Token volume recorded with no pricing — the "you are blind here" number. */
    unpricedTokens: number;
    unpricedModels: number;
  };
  entries: ObservedModelEntry[];
}

const MAX_ROLLUP_ROWS = 20_000;

export interface AgentCostModelSplit {
  modelKey: string;
  status: ObservedModelStatus;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

export interface AgentCostEntry {
  /** Tracing agentName; '' = usage without agent attribution (gateway calls). */
  agentKey: string;
  requests: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Per-model composition, cost descending. */
  models: AgentCostModelSplit[];
  /** True when any of the agent's models is unpriced — its cost reads low. */
  hasUnpricedUsage: boolean;
}

export interface AgentCosts {
  fromDay?: string;
  toDay?: string;
  totals: { requests: number; totalTokens: number; costUsd: number };
  entries: AgentCostEntry[];
}

/**
 * Group models-service rollup rows by agent (agentKey dimension), with a
 * per-model split inside each agent. Feeds the Cost → Agents view; the data
 * arrives via trace ingestion, so an agent shows up here as soon as it
 * reports traces — whether or not its model calls went through the gateway.
 */
export async function getAgentCosts(
  ctx: CostContext,
  options: { from?: Date; to?: Date } = {},
): Promise<AgentCosts> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const fromDay = options.from ? toUtcDay(options.from) : undefined;
  const toDay = options.to ? toUtcDay(options.to) : undefined;

  const [rows, models, externalEntries] = await Promise.all([
    db.listUsageDaily({
      projectId: ctx.projectId,
      service: 'models',
      fromDay,
      toDay,
      limit: MAX_ROLLUP_ROWS,
    }),
    db.listModels({ projectId: ctx.projectId }),
    db.listExternalModelPricing(ctx.projectId),
  ]);

  const hubKeys = new Set(models.map((model) => model.key.toLowerCase()));
  const externalNames = new Set(externalEntries.map((entry) => entry.normalizedName));
  const statusOf = (modelKey: string): ObservedModelStatus => {
    const lookup = modelKey.toLowerCase();
    if (hubKeys.has(lookup)) return 'hub';
    if (externalNames.has(lookup)) return 'external';
    return 'unpriced';
  };

  const byAgent = new Map<string, AgentCostEntry & { modelMap: Map<string, AgentCostModelSplit> }>();
  const totals = { requests: 0, totalTokens: 0, costUsd: 0 };

  for (const row of rows) {
    const agentKey = row.agentKey ?? '';
    let entry = byAgent.get(agentKey);
    if (!entry) {
      entry = {
        agentKey,
        requests: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        models: [],
        hasUnpricedUsage: false,
        modelMap: new Map(),
      };
      byAgent.set(agentKey, entry);
    }

    entry.requests += row.requests ?? 0;
    entry.modelCalls += row.units?.modelCalls ?? 0;
    entry.inputTokens += row.inputTokens ?? 0;
    entry.outputTokens += row.outputTokens ?? 0;
    entry.totalTokens += row.totalTokens ?? 0;
    entry.costUsd += row.costUsd ?? 0;

    const modelKey = row.refKey ?? '';
    if (modelKey) {
      let split = entry.modelMap.get(modelKey);
      if (!split) {
        split = { modelKey, status: statusOf(modelKey), requests: 0, totalTokens: 0, costUsd: 0 };
        entry.modelMap.set(modelKey, split);
        if (split.status === 'unpriced') entry.hasUnpricedUsage = true;
      }
      split.requests += row.requests ?? 0;
      split.totalTokens += row.totalTokens ?? 0;
      split.costUsd += row.costUsd ?? 0;
    }

    totals.requests += row.requests ?? 0;
    totals.totalTokens += row.totalTokens ?? 0;
    totals.costUsd += row.costUsd ?? 0;
  }

  const entries = [...byAgent.values()]
    .map(({ modelMap, ...entry }) => ({
      ...entry,
      models: [...modelMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  return { fromDay, toDay, totals, entries };
}

/**
 * Group models-service rollup rows by model and resolve each model's pricing
 * status against the Model Hub and the external pricing catalog.
 */
export async function getObservedModelCosts(
  ctx: CostContext,
  options: { from?: Date; to?: Date } = {},
): Promise<ObservedModelCosts> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const fromDay = options.from ? toUtcDay(options.from) : undefined;
  const toDay = options.to ? toUtcDay(options.to) : undefined;

  const [rows, models, externalEntries] = await Promise.all([
    db.listUsageDaily({
      projectId: ctx.projectId,
      service: 'models',
      fromDay,
      toDay,
      limit: MAX_ROLLUP_ROWS,
    }),
    db.listModels({ projectId: ctx.projectId }),
    db.listExternalModelPricing(ctx.projectId),
  ]);

  const hubByKey = new Map(models.map((model) => [model.key.toLowerCase(), model]));
  // Project-scoped catalog entries win over tenant-wide ('') ones.
  const externalByName = new Map(
    externalEntries
      .sort((a, b) => (a.projectId === '' ? -1 : 1) - (b.projectId === '' ? -1 : 1))
      .map((entry) => [entry.normalizedName, entry]),
  );

  const byModel = new Map<string, ObservedModelEntry>();
  for (const row of rows) {
    const modelKey = row.refKey ?? '';
    if (!modelKey) continue;
    const lookup = modelKey.toLowerCase();

    let entry = byModel.get(lookup);
    if (!entry) {
      const hubModel = hubByKey.get(lookup);
      const external = externalByName.get(lookup);
      entry = {
        modelKey,
        modelName: hubModel?.name ?? external?.modelName ?? modelKey,
        status: hubModel ? 'hub' : external ? 'external' : 'unpriced',
        providerKey: hubModel?.providerKey,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costBySource: {},
        modelCalls: 0,
        pricing: hubModel?.pricing ?? external?.pricing,
      };
      byModel.set(lookup, entry);
    }

    entry.requests += row.requests ?? 0;
    entry.inputTokens += row.inputTokens ?? 0;
    entry.outputTokens += row.outputTokens ?? 0;
    entry.cachedInputTokens += row.cachedInputTokens ?? 0;
    entry.totalTokens += row.totalTokens ?? 0;
    entry.costUsd += row.costUsd ?? 0;
    entry.modelCalls += row.units?.modelCalls ?? 0;
    const source = row.source || 'unknown';
    entry.costBySource[source] = (entry.costBySource[source] ?? 0) + (row.costUsd ?? 0);
  }

  const entries = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  const totals = entries.reduce(
    (acc, entry) => {
      acc.requests += entry.requests;
      acc.totalTokens += entry.totalTokens;
      acc.costUsd += entry.costUsd;
      if (entry.status === 'unpriced') {
        acc.unpricedTokens += entry.totalTokens;
        acc.unpricedModels += 1;
      }
      return acc;
    },
    { requests: 0, totalTokens: 0, costUsd: 0, unpricedTokens: 0, unpricedModels: 0 },
  );

  return { fromDay, toDay, totals, entries };
}

function assertValidRate(value: unknown, field: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`\`${field}\` must be a non-negative number`);
  }
  return parsed;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Price effective on `day`: the version with the latest `effectiveFrom` <=
 * day ('' matches every day). Entries created before versioning shipped have
 * no versions — their single `pricing` applies to all days. Returns undefined
 * when every version starts after `day` (price unknown for that day).
 */
export function resolveExternalPricingForDay(
  entry: Pick<IExternalModelPricing, 'pricing' | 'versions'>,
  day: string,
): IModelPricing | undefined {
  const versions = entry.versions;
  if (!versions || versions.length === 0) return entry.pricing;
  let match: IExternalPricingVersion | undefined;
  for (const version of versions) {
    if (version.effectiveFrom <= day && (!match || version.effectiveFrom >= match.effectiveFrom)) {
      match = version;
    }
  }
  return match?.pricing;
}

/**
 * Upsert one external pricing entry. `effectiveFrom` dates the price (omitted
 * = since the beginning); prior versions are preserved so past days keep
 * resolving to the price valid back then. Rejects names that collide with a
 * Model Hub key — hub pricing always wins for those, so a catalog entry would
 * be dead weight that confuses the ingest resolution.
 */
export async function upsertExternalPricing(
  ctx: CostContext,
  input: {
    modelName: string;
    pricing: IModelPricing;
    /** UTC day 'YYYY-MM-DD' the price takes effect; omitted = epoch (''). */
    effectiveFrom?: string;
    /** Store tenant-wide ('') so every project resolves it. */
    tenantWide?: boolean;
    updatedBy?: string;
  },
): Promise<IExternalModelPricing> {
  const modelName = input.modelName?.trim();
  if (!modelName) throw new Error('`modelName` is required');
  if (input.effectiveFrom !== undefined && !DAY_RE.test(input.effectiveFrom)) {
    throw new Error('`effectiveFrom` must be a UTC day: YYYY-MM-DD');
  }

  const pricing: IModelPricing = {
    currency: input.pricing?.currency || 'USD',
    inputTokenPer1M: assertValidRate(input.pricing?.inputTokenPer1M, 'pricing.inputTokenPer1M'),
    outputTokenPer1M: assertValidRate(input.pricing?.outputTokenPer1M, 'pricing.outputTokenPer1M'),
    cachedTokenPer1M: assertValidRate(input.pricing?.cachedTokenPer1M, 'pricing.cachedTokenPer1M'),
  };

  const targetProjectId = input.tenantWide ? '' : ctx.projectId ?? '';

  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  // Tenant-wide entries apply to every project, so collide against all hub
  // models; project entries only against that project's hub.
  const hubMatch = (await db.listModels({ projectId: targetProjectId || undefined }))
    .find((model) => model.key.toLowerCase() === modelName.toLowerCase());
  if (hubMatch) {
    throw new Error(`"${modelName}" is a Model Hub model — edit its pricing in the Model Hub`);
  }

  const normalized = modelName.toLowerCase();
  const existing = (await db.listExternalModelPricing(targetProjectId))
    .find((entry) => entry.normalizedName === normalized && (entry.projectId ?? '') === targetProjectId);

  // Seed pre-versioning entries with their single price as the epoch version
  // so history survives the first dated update.
  const versions: IExternalPricingVersion[] = existing
    ? [...(existing.versions ?? [{
        effectiveFrom: '',
        pricing: existing.pricing,
        updatedBy: existing.updatedBy,
        updatedAt: existing.updatedAt,
      }])]
    : [];

  const effectiveFrom = input.effectiveFrom ?? '';
  const nextVersions = versions.filter((version) => version.effectiveFrom !== effectiveFrom);
  nextVersions.push({ effectiveFrom, pricing, updatedBy: input.updatedBy, updatedAt: new Date() });
  nextVersions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  const current =
    resolveExternalPricingForDay({ pricing, versions: nextVersions }, toUtcDay(new Date()))
    ?? pricing;

  return db.upsertExternalModelPricing({
    tenantId: ctx.tenantId,
    projectId: targetProjectId,
    modelName,
    pricing: current,
    versions: nextVersions,
    updatedBy: input.updatedBy,
  });
}

export async function deleteExternalPricing(
  ctx: CostContext,
  modelName: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  return db.deleteExternalModelPricing(modelName, ctx.projectId);
}

export async function listExternalPricing(
  ctx: CostContext,
): Promise<IExternalModelPricing[]> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  return db.listExternalModelPricing(ctx.projectId);
}

// ── Pricing catalog ───────────────────────────────────────────────────────

export interface PricingCatalogEntry {
  /** Hub model key or raw trace model name. */
  modelKey: string;
  modelName: string;
  status: ObservedModelStatus;
  providerKey?: string;
  /** For external entries: whether the entry is project-scoped or tenant-wide. */
  entryScope?: 'project' | 'tenant';
  /** Price effective today (hub pricing for hub models). */
  pricing?: IModelPricing;
  /** Effective-dated history (external entries only). */
  versions?: IExternalPricingVersion[];
  /** True when the model appeared in usage within the requested range. */
  observed: boolean;
  requests: number;
  totalTokens: number;
  costUsd: number;
  modelCalls: number;
  lastUsedDay?: string;
}

export interface PricingCatalog {
  fromDay?: string;
  toDay?: string;
  totals: { models: number; hub: number; external: number; unpriced: number };
  entries: PricingCatalogEntry[];
}

/**
 * Unified pricing catalog for the Pricing page: every Model Hub model in
 * scope, every external pricing entry, and every model observed in usage in
 * the range — merged case-insensitively. With `ctx.projectId` undefined the
 * catalog covers all projects ("total" scope).
 */
export async function getPricingCatalog(
  ctx: CostContext,
  options: { from?: Date; to?: Date } = {},
): Promise<PricingCatalog> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const fromDay = options.from ? toUtcDay(options.from) : undefined;
  const toDay = options.to ? toUtcDay(options.to) : undefined;

  const [rows, models, externalEntries] = await Promise.all([
    db.listUsageDaily({
      projectId: ctx.projectId,
      service: 'models',
      fromDay,
      toDay,
      limit: MAX_ROLLUP_ROWS,
    }),
    db.listModels({ projectId: ctx.projectId }),
    db.listExternalModelPricing(ctx.projectId),
  ]);

  const today = toUtcDay(new Date());
  const byKey = new Map<string, PricingCatalogEntry>();

  const ensure = (modelKey: string): PricingCatalogEntry => {
    const lookup = modelKey.toLowerCase();
    let entry = byKey.get(lookup);
    if (!entry) {
      entry = {
        modelKey,
        modelName: modelKey,
        status: 'unpriced',
        observed: false,
        requests: 0,
        totalTokens: 0,
        costUsd: 0,
        modelCalls: 0,
      };
      byKey.set(lookup, entry);
    }
    return entry;
  };

  for (const model of models) {
    const entry = ensure(model.key);
    entry.modelKey = model.key;
    entry.modelName = model.name;
    entry.status = 'hub';
    entry.providerKey = model.providerKey;
    entry.pricing = model.pricing;
  }

  // Project-scoped entries override tenant-wide ones for the same name.
  const externalSorted = [...externalEntries]
    .sort((a, b) => ((a.projectId ?? '') === '' ? -1 : 1) - ((b.projectId ?? '') === '' ? -1 : 1));
  for (const external of externalSorted) {
    const entry = ensure(external.modelName);
    if (entry.status === 'hub') continue; // hub always wins
    entry.modelName = external.modelName;
    entry.status = 'external';
    entry.entryScope = (external.projectId ?? '') === '' ? 'tenant' : 'project';
    entry.pricing = resolveExternalPricingForDay(external, today) ?? external.pricing;
    entry.versions = external.versions
      ?? [{ effectiveFrom: '', pricing: external.pricing, updatedBy: external.updatedBy, updatedAt: external.updatedAt }];
  }

  for (const row of rows) {
    const modelKey = row.refKey ?? '';
    if (!modelKey) continue;
    const entry = ensure(modelKey);
    entry.observed = true;
    entry.requests += row.requests ?? 0;
    entry.totalTokens += row.totalTokens ?? 0;
    entry.costUsd += row.costUsd ?? 0;
    entry.modelCalls += row.units?.modelCalls ?? 0;
    if (!entry.lastUsedDay || row.day > entry.lastUsedDay) entry.lastUsedDay = row.day;
  }

  const entries = [...byKey.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens
      || a.modelName.localeCompare(b.modelName),
  );
  const totals = entries.reduce(
    (acc, entry) => {
      acc.models += 1;
      if (entry.status === 'hub') acc.hub += 1;
      else if (entry.status === 'external') acc.external += 1;
      else acc.unpriced += 1;
      return acc;
    },
    { models: 0, hub: 0, external: 0, unpriced: 0 },
  );

  return { fromDay, toDay, totals, entries };
}

// ── Retroactive repricing ───────────────────────────────────────────────

export interface RepriceResult {
  modelName: string;
  fromDay?: string;
  toDay?: string;
  rowsScanned: number;
  rowsUpdated: number;
  costBefore: number;
  costAfter: number;
}

/**
 * Recompute recorded `usage_daily` spend for one externally priced model
 * using the price effective on each row's day. Rows keep their cost when no
 * version covers their day (price unknown ≠ free). Hub models are rejected —
 * their historical spend was computed from hub pricing at ingest.
 */
export async function repriceExternalModelUsage(
  ctx: CostContext,
  input: { modelName: string; from?: Date; to?: Date },
): Promise<RepriceResult> {
  const modelName = input.modelName?.trim();
  if (!modelName) throw new Error('`modelName` is required');
  const normalized = modelName.toLowerCase();

  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const fromDay = input.from ? toUtcDay(input.from) : undefined;
  const toDay = input.to ? toUtcDay(input.to) : undefined;

  const [rows, models, externalEntries] = await Promise.all([
    db.listUsageDaily({
      projectId: ctx.projectId,
      service: 'models',
      fromDay,
      toDay,
      limit: MAX_ROLLUP_ROWS,
    }),
    db.listModels({ projectId: ctx.projectId }),
    db.listExternalModelPricing(ctx.projectId),
  ]);

  if (models.some((model) => model.key.toLowerCase() === normalized)) {
    throw new Error(`"${modelName}" is a Model Hub model — its recorded spend is not repriceable here`);
  }

  const candidates = externalEntries.filter((entry) => entry.normalizedName === normalized);
  if (candidates.length === 0) {
    throw new Error(`No pricing entry found for "${modelName}" — add pricing first`);
  }
  const byProject = new Map(candidates.map((entry) => [entry.projectId ?? '', entry]));

  const updates: Array<{ id: string; costUsd: number }> = [];
  let rowsScanned = 0;
  let costBefore = 0;
  let costAfter = 0;

  for (const row of rows) {
    if ((row.refKey ?? '').toLowerCase() !== normalized) continue;
    rowsScanned += 1;
    costBefore += row.costUsd ?? 0;

    const entry = byProject.get(row.projectId) ?? byProject.get('');
    const pricing = entry ? resolveExternalPricingForDay(entry, row.day) : undefined;
    if (!pricing) {
      costAfter += row.costUsd ?? 0;
      continue;
    }

    const nextCost = calculateCost(pricing, {
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cachedInputTokens: row.cachedInputTokens ?? 0,
    }).totalCost;
    costAfter += nextCost;

    if (row._id && Math.abs(nextCost - (row.costUsd ?? 0)) > 1e-9) {
      updates.push({ id: String(row._id), costUsd: nextCost });
    }
  }

  const rowsUpdated = updates.length > 0 ? await db.setUsageDailyCost(updates) : 0;

  return { modelName, fromDay, toDay, rowsScanned, rowsUpdated, costBefore, costAfter };
}

// ── Spend reports ──────────────────────────────────────────────────────

export type ReportGranularity = 'daily' | 'weekly' | 'monthly';

export interface CostReportBucket {
  /** 'YYYY-MM-DD' (daily / week's Monday) or 'YYYY-MM' (monthly). */
  bucket: string;
  requests: number;
  errors: number;
  totalTokens: number;
  costUsd: number;
}

export interface CostReport {
  granularity: ReportGranularity;
  fromDay?: string;
  toDay?: string;
  totals: { requests: number; totalTokens: number; costUsd: number };
  series: CostReportBucket[];
  topModels: Array<{ modelKey: string; requests: number; totalTokens: number; costUsd: number }>;
  topAgents: Array<{ agentKey: string; requests: number; totalTokens: number; costUsd: number }>;
}

/** Monday of the ISO week containing the UTC day. */
function weekBucketOf(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const isoDow = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - isoDow);
  return date.toISOString().slice(0, 10);
}

function bucketOf(day: string, granularity: ReportGranularity): string {
  if (granularity === 'monthly') return day.slice(0, 7);
  if (granularity === 'weekly') return weekBucketOf(day);
  return day;
}

const TOP_LIMIT = 10;

/**
 * Model-service spend aggregated into daily / weekly / monthly buckets, with
 * top models and agents for the range. Scope follows `ctx.projectId`
 * (undefined = all projects).
 */
export async function getCostReport(
  ctx: CostContext,
  options: { granularity?: ReportGranularity; from?: Date; to?: Date } = {},
): Promise<CostReport> {
  const granularity: ReportGranularity = options.granularity ?? 'daily';
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const fromDay = options.from ? toUtcDay(options.from) : undefined;
  const toDay = options.to ? toUtcDay(options.to) : undefined;

  const rows = await db.listUsageDaily({
    projectId: ctx.projectId,
    service: 'models',
    fromDay,
    toDay,
    limit: MAX_ROLLUP_ROWS,
  });

  const buckets = new Map<string, CostReportBucket>();
  const byModel = new Map<string, { modelKey: string; requests: number; totalTokens: number; costUsd: number }>();
  const byAgent = new Map<string, { agentKey: string; requests: number; totalTokens: number; costUsd: number }>();
  const totals = { requests: 0, totalTokens: 0, costUsd: 0 };

  for (const row of rows) {
    const key = bucketOf(row.day, granularity);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { bucket: key, requests: 0, errors: 0, totalTokens: 0, costUsd: 0 };
      buckets.set(key, bucket);
    }
    bucket.requests += row.requests ?? 0;
    bucket.errors += row.errors ?? 0;
    bucket.totalTokens += row.totalTokens ?? 0;
    bucket.costUsd += row.costUsd ?? 0;

    totals.requests += row.requests ?? 0;
    totals.totalTokens += row.totalTokens ?? 0;
    totals.costUsd += row.costUsd ?? 0;

    const modelKey = row.refKey ?? '';
    if (modelKey) {
      let model = byModel.get(modelKey.toLowerCase());
      if (!model) {
        model = { modelKey, requests: 0, totalTokens: 0, costUsd: 0 };
        byModel.set(modelKey.toLowerCase(), model);
      }
      model.requests += row.requests ?? 0;
      model.totalTokens += row.totalTokens ?? 0;
      model.costUsd += row.costUsd ?? 0;
    }

    const agentKey = row.agentKey ?? '';
    if (agentKey) {
      let agent = byAgent.get(agentKey);
      if (!agent) {
        agent = { agentKey, requests: 0, totalTokens: 0, costUsd: 0 };
        byAgent.set(agentKey, agent);
      }
      agent.requests += row.requests ?? 0;
      agent.totalTokens += row.totalTokens ?? 0;
      agent.costUsd += row.costUsd ?? 0;
    }
  }

  const rank = <T extends { costUsd: number; totalTokens: number }>(items: T[]): T[] =>
    items.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens).slice(0, TOP_LIMIT);

  return {
    granularity,
    fromDay,
    toDay,
    totals,
    series: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    topModels: rank([...byModel.values()]),
    topAgents: rank([...byAgent.values()]),
  };
}
