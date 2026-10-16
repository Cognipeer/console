/**
 * Rule backtest: replay the last 1..7 days of the `entity_metrics` rollup
 * through the evaluator's own pieces (`computeEntityMetric`, `judgeable`,
 * `evaluateCondition`, `advanceAlertState`) and count what the rule WOULD have
 * fired. Read-only; nothing is stored or sent.
 *
 * Replayable: entity-source metrics in threshold and absence mode. Legacy
 * collectors query live tables and baseline / SLO modes call enterprise
 * providers per step, so they answer `supported: false`.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertConditionMode, EntityMetricCounters, IAlertRule, IAlertState } from '@/lib/database';
import { ENTITY_METRIC_BUCKET_MS } from '@/lib/database/provider/types.base';
import { computeEntityMetric, toCounters } from '@/lib/services/entityMetrics/entityMetricsQuery';
import { emptyCounters, mergeCounters } from '@/lib/services/entityMetrics/latencyHistogram';
import { AlertApiError } from './alertApiError';
import { validateRuleInput } from './alertService';
import { advanceAlertState, defaultMinSamples, evaluateCondition, judgeable } from './alertEvaluator';
import { getMetricDef } from './metricCatalog';
import { entityEvaluationWindow } from './metrics/entityMetricsCollector';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Entities replayed per backtest (the busiest ones when a rule covers more). */
export const BACKTEST_MAX_ENTITIES = 200;
/** Incident rows returned. */
export const BACKTEST_MAX_INCIDENTS = 200;
/** The aggregate read caps at 50 000 rows; chunks stay below it. */
const ROW_BUDGET = 45_000;
const MAX_KEYS_PER_QUERY = 500;
/** A suggestion aims at a rule that would have fired at most this often. */
const SUGGESTION_MAX_FIRES = 2;
const MAX_ABSENCE_LOOKBACK_HOURS = 24 * 7;

export type BacktestUnsupportedReason = 'legacy_metric' | 'mode_not_replayable';

export interface BacktestResult {
  supported: boolean;
  reason?: BacktestUnsupportedReason;
  message?: string;
  days?: number;
  stepMinutes?: number;
  evaluations: number;
  fires: number;
  firesPerEntity: Array<{ entityKey: string; fires: number }>;
  incidents: Array<{ entityKey: string; firedAt: string; resolvedAt?: string }>;
  suggestion?: { threshold?: number; firesAtThreshold?: number; note: string };
  notes?: string[];
}

interface Step {
  t: number;
  value: number | null;
  noData: boolean;
  /** Absence mode: the entity normally has traffic here. */
  candidate: boolean;
  requests: number;
  present: boolean;
}

interface ReplayOutcome {
  evaluations: number;
  fires: number;
  incidents: Array<{ entityKey: string; firedAt: number; resolvedAt?: number }>;
}

const EMPTY: EntityMetricCounters = emptyCounters();

function unsupported(reason: BacktestUnsupportedReason, message: string): BacktestResult {
  return { supported: false, reason, message, evaluations: 0, fires: 0, firesPerEntity: [], incidents: [] };
}

function readDays(value: unknown): number {
  const days = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new AlertApiError(400, 'invalid_days', 'days must be a whole number from 1 to 7');
  return days;
}

/** Evaluate every 5 minutes; wide windows move in a fraction of their width so a 24 h rule stays cheap. */
export function backtestStepMinutes(windowMinutes: number): number {
  if (windowMinutes <= 60) return 5;
  return Math.max(5, Math.round(windowMinutes / 12 / 5) * 5);
}

/** Pure replay of one entity's judged steps through the state machine. */
export function replayEntity(
  entityKey: string,
  steps: Step[],
  rule: {
    mode: AlertConditionMode;
    operator: IAlertRule['condition']['operator'];
    threshold: number;
    forMinutes: number;
    cooldownMinutes: number;
    selected: boolean;
  },
): ReplayOutcome {
  let prev: IAlertState | null = null;
  const out: ReplayOutcome = { evaluations: 0, fires: 0, incidents: [] };
  let open: { entityKey: string; firedAt: number; resolvedAt?: number } | null = null;
  const worse: 'max' | 'min' = rule.mode === 'absence'
    ? 'min'
    : (rule.operator === 'lt' || rule.operator === 'lte' ? 'min' : 'max');

  for (const step of steps) {
    const active = rule.selected || step.present || (prev !== null && prev.phase !== 'ok');
    if (!active) continue;
    let breached = false;
    if (rule.mode === 'absence') {
      breached = step.requests === 0 && (step.candidate || prev?.phase === 'firing');
    } else if (!step.noData && step.value !== null) {
      breached = evaluateCondition(step.value, rule.operator, rule.threshold);
    }
    // an entity with nothing to judge and no state to carry has no evaluation to count
    if (rule.mode !== 'absence' && step.noData && (prev === null || prev.phase === 'ok')) continue;
    out.evaluations += 1;

    const now = new Date(step.t);
    const next = advanceAlertState({
      prev,
      breached,
      value: rule.mode === 'absence' ? step.requests : step.value,
      now,
      forMinutes: rule.forMinutes,
      cooldownMinutes: rule.cooldownMinutes,
      renotifyMinutes: 0,
      worse,
      windowKey: step.t,
    });
    if (next.action === 'fire') {
      out.fires += 1;
      open = { entityKey, firedAt: step.t };
      out.incidents.push(open);
    } else if (next.action === 'resolve' && open) {
      open.resolvedAt = step.t;
      open = null;
    }
    prev = {
      ...(prev ?? ({} as IAlertState)),
      phase: next.phase,
      phaseSince: next.phaseSince,
      breachStreak: next.breachStreak,
      okStreak: next.okStreak,
      peakValue: next.peakValue,
      lastFiredAt: next.action === 'fire' ? now : prev?.lastFiredAt,
      lastNotifiedAt: next.action === 'fire' ? now : prev?.lastNotifiedAt,
      detail: { windowKey: step.t },
    } as IAlertState;
  }
  return out;
}

function sigRound(value: number, digits: number, up: boolean): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const scale = 10 ** (digits - 1 - Math.floor(Math.log10(Math.abs(value))));
  return (up ? Math.ceil(value * scale) : Math.floor(value * scale)) / scale;
}

export class AlertBacktestService {
  static async run(
    tenantDbName: string,
    session: { tenantId: string },
    projectId: string,
    body: { rule?: unknown; days?: unknown },
  ): Promise<BacktestResult> {
    const days = readDays(body.days ?? 7);
    const rule = validateRuleInput(body.rule, { mode: 'preview' });
    const def = getMetricDef(rule.metric);
    const mode: AlertConditionMode = rule.condition.mode ?? 'threshold';

    if (!def || def.source !== 'entity' || !def.entityType) {
      return unsupported('legacy_metric', 'Backtesting needs a per-entity metric (agents, models, knowledge bases, MCP servers, tools).');
    }
    if (mode !== 'threshold' && mode !== 'absence') {
      return unsupported('mode_not_replayable', 'Only threshold and absence rules can be backtested.');
    }

    const entityType = def.entityType;
    const db = await getTenantDatabase(tenantDbName);
    const notes: string[] = [];
    const stepMs = backtestStepMinutes(rule.windowMinutes) * MINUTE_MS;
    const windowMs = rule.windowMinutes * MINUTE_MS;
    const endMs = entityEvaluationWindow(Date.now(), 0).toMs;
    const startMs = endMs - days * DAY_MS;
    const absence = mode === 'absence'
      ? (rule.condition.absence ?? { lookbackHours: 24, minExpectedPerWindow: 1 })
      : null;
    const lookbackMs = absence ? Math.min(absence.lookbackHours, MAX_ABSENCE_LOOKBACK_HOURS) * 60 * MINUTE_MS : 0;
    const dataFrom = startMs - lookbackMs;

    // Which entities, and how busy.
    const selectedKeys = rule.entity?.mode === 'selected'
      ? [...new Set((rule.entity.keys ?? []).filter(Boolean))]
      : null;
    let keys: string[];
    if (selectedKeys) {
      keys = selectedKeys;
    } else {
      const totals = await db.aggregateEntityMetrics({
        tenantId: session.tenantId,
        projectId,
        entityType,
        fromMs: dataFrom,
        toMs: endMs,
        groupBy: ['entityKey'],
        limit: 50_000,
      });
      const ranked = totals.filter((row) => row.entityKey).sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0));
      if (ranked.length > BACKTEST_MAX_ENTITIES) notes.push(`Only the ${BACKTEST_MAX_ENTITIES} busiest entities are replayed`);
      keys = ranked.slice(0, BACKTEST_MAX_ENTITIES).map((row) => row.entityKey as string);
    }
    if (keys.length === 0) {
      return {
        supported: true, days, stepMinutes: stepMs / MINUTE_MS, evaluations: 0, fires: 0,
        firesPerEntity: [], incidents: [], notes: [...notes, 'No entity has data in this period'],
      };
    }

    const bucketCount = Math.max(1, Math.ceil((endMs - dataFrom) / ENTITY_METRIC_BUCKET_MS));
    const perQuery = Math.max(1, Math.min(MAX_KEYS_PER_QUERY, Math.floor(ROW_BUDGET / bucketCount)));
    const minSamples = rule.condition.minSamples ?? defaultMinSamples(mode);
    const series = new Map<string, Step[]>();
    let truncated = false;

    for (let offset = 0; offset < keys.length; offset += perQuery) {
      const chunk = keys.slice(offset, offset + perQuery);
      const limit = 50_000;
      const rows = await db.aggregateEntityMetrics({
        tenantId: session.tenantId,
        projectId,
        entityType,
        entityKeys: chunk,
        fromMs: dataFrom,
        toMs: endMs,
        groupBy: ['entityKey'],
        bucketMs: ENTITY_METRIC_BUCKET_MS,
        limit,
      });
      if (rows.length >= limit) truncated = true;
      const byEntity = new Map<string, Map<number, EntityMetricCounters>>();
      for (const row of rows) {
        if (!row.entityKey || row.bucketMs === undefined) continue;
        let buckets = byEntity.get(row.entityKey);
        if (!buckets) byEntity.set(row.entityKey, (buckets = new Map()));
        buckets.set(row.bucketMs, toCounters(row));
      }
      for (const key of chunk) {
        series.set(key, buildSteps(byEntity.get(key), {
          def, mode, startMs, endMs, stepMs, windowMs, minSamples, lookbackMs, absence,
        }));
      }
    }
    if (truncated) notes.push('The rollup had more data than one read returns; the newest buckets may be missing');

    const replayRule = {
      mode,
      operator: rule.condition.operator,
      threshold: rule.condition.threshold,
      forMinutes: Math.max(0, rule.condition.forMinutes ?? 0),
      cooldownMinutes: Math.max(0, rule.cooldownMinutes ?? 0),
      selected: Boolean(selectedKeys),
    };
    let evaluations = 0;
    let fires = 0;
    const firesPerEntity: Array<{ entityKey: string; fires: number }> = [];
    const incidents: ReplayOutcome['incidents'] = [];
    for (const [key, steps] of series) {
      const outcome = replayEntity(key, steps, replayRule);
      evaluations += outcome.evaluations;
      fires += outcome.fires;
      if (outcome.fires > 0) firesPerEntity.push({ entityKey: key, fires: outcome.fires });
      incidents.push(...outcome.incidents);
    }
    firesPerEntity.sort((a, b) => b.fires - a.fires || a.entityKey.localeCompare(b.entityKey));
    incidents.sort((a, b) => b.firedAt - a.firedAt);

    const result: BacktestResult = {
      supported: true,
      days,
      stepMinutes: stepMs / MINUTE_MS,
      evaluations,
      fires,
      firesPerEntity: firesPerEntity.slice(0, BACKTEST_MAX_INCIDENTS),
      incidents: incidents.slice(0, BACKTEST_MAX_INCIDENTS).map((incident) => ({
        entityKey: incident.entityKey,
        firedAt: new Date(incident.firedAt).toISOString(),
        ...(incident.resolvedAt !== undefined ? { resolvedAt: new Date(incident.resolvedAt).toISOString() } : {}),
      })),
    };
    if (incidents.length > BACKTEST_MAX_INCIDENTS) notes.push(`Showing the ${BACKTEST_MAX_INCIDENTS} latest of ${incidents.length} incidents`);
    if (notes.length > 0) result.notes = notes;

    if (mode === 'threshold' && fires > SUGGESTION_MAX_FIRES && rule.condition.operator !== 'eq') {
      const suggestion = suggestThreshold(series, replayRule, days);
      if (suggestion) result.suggestion = suggestion;
    }
    return result;
  }
}

interface StepBuild {
  def: NonNullable<ReturnType<typeof getMetricDef>>;
  mode: AlertConditionMode;
  startMs: number;
  endMs: number;
  stepMs: number;
  windowMs: number;
  minSamples: number;
  lookbackMs: number;
  absence: { lookbackHours: number; minExpectedPerWindow?: number } | null;
}

/** Window values of one entity at every evaluation step. */
function buildSteps(buckets: Map<number, EntityMetricCounters> | undefined, build: StepBuild): Step[] {
  const { def, mode, startMs, endMs, stepMs, windowMs, minSamples, lookbackMs, absence } = build;
  const steps: Step[] = [];
  const windowSum = (fromMs: number, toMs: number): { counters: EntityMetricCounters; present: boolean } => {
    let acc: EntityMetricCounters | null = null;
    if (buckets) {
      for (let t = fromMs; t < toMs; t += ENTITY_METRIC_BUCKET_MS) {
        const row = buckets.get(t);
        if (row) acc = acc ? mergeCounters(acc, row) : row;
      }
    }
    return { counters: acc ?? EMPTY, present: acc !== null };
  };
  const requestsIn = (fromMs: number, toMs: number): number => {
    let total = 0;
    if (buckets) {
      for (let t = fromMs; t < toMs; t += ENTITY_METRIC_BUCKET_MS) total += buckets.get(t)?.requests ?? 0;
    }
    return total;
  };

  for (let t = startMs + windowMs; t <= endMs; t += stepMs) {
    const { counters, present } = windowSum(t - windowMs, t);
    if (mode === 'absence') {
      const windows = Math.max(lookbackMs / windowMs, 1);
      const history = lookbackMs > 0 ? requestsIn(t - windowMs - lookbackMs, t - windowMs) : 0;
      steps.push({
        t, value: counters.requests, noData: false, requests: counters.requests, present,
        candidate: history / windows >= (absence?.minExpectedPerWindow ?? 1),
      });
      continue;
    }
    const { value, sampleCount } = computeEntityMetric(def.id, counters);
    const usable = judgeable(def, value, sampleCount, minSamples, mode);
    steps.push({
      t, value: usable ? (value ?? null) : null, noData: !usable, requests: counters.requests,
      present, candidate: false,
    });
  }
  return steps;
}

/** The mildest threshold at which the rule would have fired at most twice, with the replayed count. */
function suggestThreshold(
  series: Map<string, Step[]>,
  rule: Parameters<typeof replayEntity>[2],
  days: number,
): BacktestResult['suggestion'] | undefined {
  const upper = rule.operator === 'gt' || rule.operator === 'gte';
  const values = new Set<number>();
  for (const steps of series.values()) {
    for (const step of steps) if (!step.noData && step.value !== null) values.add(step.value);
  }
  if (values.size === 0) return undefined;
  const sorted = [...values].sort((a, b) => (upper ? a - b : b - a));

  const firesAt = (threshold: number): number => {
    let total = 0;
    for (const [key, steps] of series) total += replayEntity(key, steps, { ...rule, threshold }).fires;
    return total;
  };

  // Binary search over the observed values: fires only shrink as the bar moves away from the data.
  let lo = 0;
  let hi = sorted.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (firesAt(sorted[mid]) <= SUGGESTION_MAX_FIRES) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found === null) return undefined;
  let threshold = sorted[found];
  const pretty = sigRound(threshold, 3, upper);
  if (pretty !== threshold && firesAt(pretty) <= SUGGESTION_MAX_FIRES) threshold = pretty;
  const firesAtThreshold = firesAt(threshold);
  return {
    threshold,
    firesAtThreshold,
    note: `A threshold of ${threshold} would have fired ${firesAtThreshold} time${firesAtThreshold === 1 ? '' : 's'} in the last ${days} day${days === 1 ? '' : 's'}.`,
  };
}
