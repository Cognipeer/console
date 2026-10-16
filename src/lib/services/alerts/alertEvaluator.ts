/**
 * Alert evaluator — the engine that checks alert rules against live metric
 * data, tracks a per-(rule, entity) state machine and dispatches notifications.
 *
 * Called periodically by the alert scheduler for every active tenant.
 *
 * One rule yields one target (legacy metrics: the rule's scope) or many
 * (entity metrics: every agent / model / knowledge base / MCP server / tool the
 * rule covers). Each target has a state row in `alert_states`:
 *
 *   ok --breach--> pending --(forMinutes elapsed, outside cooldown)--> firing
 *   pending --recovered--> ok          firing --2 ok evaluations--> ok (resolved)
 *
 * Firing creates ONE event + incident and notifies; staying in firing never
 * creates another (optionally re-notifies), and recovery resolves them.
 */

import { getTenantDatabase } from '@/lib/database';
import type {
  AlertConditionMode,
  AlertConditionOperator,
  DatabaseProvider,
  EntityMetricCounters,
  EntityMetricType,
  IAlertEvent,
  IAlertRule,
  IAlertState,
  IIncidentContext,
  IncidentSeverity,
} from '@/lib/database';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getEntityBaselineProvider, getSloBurnEvaluator } from '@/enterprise/alert-extensions';
import { computeEntityMetric } from '@/lib/services/entityMetrics/entityMetricsQuery';
import { emptyCounters } from '@/lib/services/entityMetrics/latencyHistogram';
import { publishWebhookEvent } from '@/lib/services/webhooks/webhookService';
import { collectMetric } from './metrics';
import { aggregateEntityCounters, entityEvaluationWindow } from './metrics/entityMetricsCollector';
import { dispatchNotification } from './channels';
import type { AlertContext, AlertNotification, DispatchResult } from './channels';
import { getMetricDef, type AlertMetricDef } from './metricCatalog';
import { createModeGate, type ModeGate } from './modeAvailability';
import { IncidentService, deriveRuleSeverity } from './incidentService';
import { buildIncidentContext } from './incidentContext';
import { resolveEntityPath } from './entityLinks';
import { recordDeliveries, recordSuppressed } from './deliveryLog';
import { evaluationShapeOf } from './ruleShape';

const logger = createLogger('alert-evaluator');

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Resolved after this many consecutive ok (or no-data) evaluations. */
export const RESOLVE_AFTER_OK_EVALUATIONS = 2;
/** Upper bound of targets one rule fans out to (the busiest entities win). */
export const MAX_RULE_TARGETS = 2000;
/** Targets of one rule handled at the same time (each may wait on a slow channel). */
export const TARGET_CONCURRENCY = 8;
/**
 * Notifying actions (fire / resolve / re-notify) one rule performs per sweep. The rest wait for the
 * next tick (their state is kept so nothing is lost), so an outage hitting hundreds of entities
 * cannot hold a sweep hostage to a dead channel.
 */
export const MAX_ACTIONS_PER_RULE_SWEEP = 50;
/** Incident contexts (extra reads per fire) built per rule and sweep; later fires of a storm go without. */
export const MAX_CONTEXTS_PER_RULE_SWEEP = 10;
/** Entities with traffic over a lookback, shared by rules and sweeps (key includes the aligned window start). */
const HISTORY_CACHE_MAX = 200;
const historyCache = new Map<string, Map<string, number>>();

/** Forget the cached lookback histories (tests). */
export function __resetEvaluatorCachesForTests(): void {
  historyCache.clear();
}

/** Aggregates shared by the rules of one sweep (same project, entity type, window). */
export type AggregateMemo = Map<string, Promise<Map<string, EntityMetricCounters>>>;

/**
 * Evaluate a single condition: `actualValue <op> threshold`
 */
export function evaluateCondition(
  actual: number,
  operator: AlertConditionOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt': return actual > threshold;
    case 'lt': return actual < threshold;
    case 'gte': return actual >= threshold;
    case 'lte': return actual <= threshold;
    case 'eq': return actual === threshold;
    default: return false;
  }
}

export interface EvaluationContext {
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
  companyName: string;
}

// ── Target evaluation (pure of side effects: also used by rule preview) ─────

export interface TargetEvaluation {
  /** '' = the rule's own scope (legacy metrics). */
  entityKey: string;
  value: number | null;
  sampleCount: number;
  breached: boolean;
  /** The value cannot be judged (too few samples, undefined). */
  noData: boolean;
  baseline?: number | null;
  /** Baseline: current / baseline and robust z. */
  ratio?: number | null;
  z?: number | null;
  /** SLO burn rates. */
  burnLong?: number | null;
  burnShort?: number | null;
  insufficientData?: boolean;
}

export interface RuleEvaluation {
  entityType: EntityMetricType | null;
  targets: TargetEvaluation[];
  notes: string[];
  /** The rule's mode needs the enterprise provider or licence this deployment lacks. */
  modeUnavailable?: 'not_enterprise_build' | 'license_required';
}

export interface EvaluateRuleOptions {
  nowMs: number;
  gate: ModeGate;
  /** Keys that already have a non-ok state: they stay targets so silent entities can resolve. */
  stateKeys?: string[];
  /** Keys whose state is firing: an absence alert on them lasts until traffic returns. */
  firingKeys?: string[];
  /** Window aggregates shared with the other rules of the sweep. */
  memo?: AggregateMemo;
}

export function defaultMinSamples(mode: AlertConditionMode): number {
  if (mode === 'baseline') return 20;
  if (mode === 'slo_burn') return 50;
  return 1;
}

function ruleMode(rule: IAlertRule): AlertConditionMode {
  return rule.condition.mode ?? 'threshold';
}

function selectedKeys(rule: IAlertRule): string[] | null {
  if (rule.entity?.mode !== 'selected') return null;
  return [...new Set((rule.entity.keys ?? []).filter((key) => typeof key === 'string' && key))];
}

/** Whether a computed value can be judged at all. */
export function judgeable(def: AlertMetricDef, value: number | null, sampleCount: number, minSamples: number, mode: AlertConditionMode): boolean {
  if (value === null) return false;
  // A count metric's sample count IS its value: a floor on it would blind baseline-drop rules for
  // 1..minSamples-1 events. The baseline judges history sufficiency itself.
  if (mode === 'baseline' && def.unit === 'count') return true;
  // "Less than" and baseline-drop rules on counts must see an empty window as 0.
  if (def.zeroWhenEmpty && sampleCount === 0 && (mode === 'threshold' || mode === 'baseline')) return true;
  return sampleCount >= minSamples;
}

/**
 * Compute value + breach for every target of a rule at `nowMs`.
 * Reads metrics only; never writes.
 */
export async function evaluateRuleTargets(
  ctx: EvaluationContext,
  rule: IAlertRule,
  options: EvaluateRuleOptions,
): Promise<RuleEvaluation> {
  const mode = ruleMode(rule);
  const def = getMetricDef(rule.metric);
  const notes: string[] = [];
  if (!def) {
    return { entityType: null, targets: [], notes: [`Unknown metric "${rule.metric}"`] };
  }

  if (mode === 'baseline' || mode === 'slo_burn') {
    const availability = await options.gate.check(mode);
    if (!availability.available) {
      return {
        entityType: def.entityType ?? null,
        targets: [],
        notes: [availability.reason === 'license_required'
          ? `The ${mode} mode needs an enterprise licence`
          : `The ${mode} mode is not available in this edition`],
        modeUnavailable: availability.reason,
      };
    }
  }

  const minSamples = rule.condition.minSamples ?? defaultMinSamples(mode);

  if (def.source === 'entity' && def.entityType) {
    return evaluateEntityRule(ctx, rule, def, def.entityType, mode, minSamples, options, notes);
  }

  // Legacy: one target, the rule's scope, through its collector.
  const result = await collectMetric({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    metric: rule.metric,
    windowMinutes: rule.windowMinutes,
    scope: {
      projectId: rule.projectId,
      modelKey: rule.scope?.modelKey,
      serverKey: rule.scope?.serverKey,
      guardrailKey: rule.scope?.guardrailKey,
      ragModuleKey: rule.scope?.ragModuleKey,
      mcpServerKey: rule.scope?.mcpServerKey,
    },
  });

  let value: number | null = result.value;
  let usable = result.sampleCount >= minSamples && result.sampleCount > 0;
  if (result.sampleCount === 0 && def.zeroWhenEmpty) {
    value = 0;
    usable = true;
  }
  const breached = usable && value !== null
    && evaluateCondition(value, rule.condition.operator, rule.condition.threshold);
  return {
    entityType: null,
    targets: [{
      entityKey: '',
      value: usable ? value : null,
      sampleCount: result.sampleCount,
      breached,
      noData: !usable,
    }],
    notes,
  };
}

function aggregateShared(memo: AggregateMemo | undefined, input: Parameters<typeof aggregateEntityCounters>[0]) {
  if (!memo) return aggregateEntityCounters(input);
  const key = JSON.stringify([
    input.tenantDbName, input.tenantId, input.projectId, input.entityType, input.fromMs, input.toMs,
    input.entityKeys ? [...input.entityKeys].sort() : null,
  ]);
  let hit = memo.get(key);
  if (!hit) {
    hit = aggregateEntityCounters(input);
    memo.set(key, hit);
  }
  return hit;
}

/**
 * Requests per entity over `[fromMs - lookbackMs, fromMs)`. The history only changes when a rollup
 * bucket closes, and `fromMs` is bucket-aligned, so one read serves every sweep of that bucket.
 */
async function lookbackRequests(
  scope: { tenantDbName: string; tenantId: string; projectId: string; entityType: EntityMetricType },
  fromMs: number,
  lookbackMs: number,
  selected: string[] | null,
  memo: AggregateMemo | undefined,
): Promise<Map<string, number>> {
  const cacheKey = JSON.stringify([
    scope.tenantDbName, scope.tenantId, scope.projectId, scope.entityType, fromMs, lookbackMs, selected ? [...selected].sort() : null,
  ]);
  const cached = historyCache.get(cacheKey);
  if (cached) return cached;
  const history = await aggregateShared(memo, {
    ...scope,
    fromMs: fromMs - lookbackMs,
    toMs: fromMs,
    entityKeys: selected ?? undefined,
  });
  const requests = new Map<string, number>();
  for (const [key, counters] of history) requests.set(key, counters.requests);
  if (historyCache.size >= HISTORY_CACHE_MAX) {
    const oldest = historyCache.keys().next().value;
    if (oldest !== undefined) historyCache.delete(oldest);
  }
  historyCache.set(cacheKey, requests);
  return requests;
}

/** How far back a baseline-drop rule looks for entities that fell silent. */
const BASELINE_SILENCE_LOOKBACK_MS = 24 * HOUR_MS;

async function evaluateEntityRule(
  ctx: EvaluationContext,
  rule: IAlertRule,
  def: AlertMetricDef,
  entityType: EntityMetricType,
  mode: AlertConditionMode,
  minSamples: number,
  options: EvaluateRuleOptions,
  notes: string[],
): Promise<RuleEvaluation> {
  const { nowMs } = options;
  const { fromMs, toMs } = entityEvaluationWindow(nowMs, rule.windowMinutes);
  const selected = selectedKeys(rule);
  const scope = {
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: rule.projectId,
    entityType,
  };

  const current = await aggregateShared(options.memo, { ...scope, fromMs, toMs, entityKeys: selected ?? undefined });

  // Absence candidates: entities that normally have traffic in a window of this size.
  let candidates: Set<string> | null = null;
  const firing = new Set(options.firingKeys ?? []);
  if (mode === 'absence') {
    const absence = rule.condition.absence ?? { lookbackHours: 24, minExpectedPerWindow: 1 };
    const lookbackMs = absence.lookbackHours * HOUR_MS;
    const history = await lookbackRequests(scope, fromMs, lookbackMs, selected, options.memo);
    const windows = Math.max(lookbackMs / (rule.windowMinutes * MINUTE_MS), 1);
    candidates = new Set();
    for (const [key, requests] of history) {
      if (requests / windows >= (absence.minExpectedPerWindow ?? 1)) candidates.add(key);
    }
  }

  // A baseline "drop" must also see entities that went completely silent: they have no row in the
  // current window, so they join as zero-valued targets (like absence does).
  let silent: Set<string> | null = null;
  const baselineDirection = rule.condition.baseline?.direction;
  if (mode === 'baseline' && def.zeroWhenEmpty && baselineDirection !== 'up' && !selected) {
    const history = await lookbackRequests(scope, fromMs, BASELINE_SILENCE_LOOKBACK_MS, null, options.memo);
    silent = new Set();
    for (const [key, requests] of history) if (requests > 0 && !current.has(key)) silent.add(key);
  }

  let keys: string[];
  if (selected) {
    keys = selected;
  } else {
    // Keys that already carry a non-ok state always stay (a silent firing entity must still resolve);
    // the cap then drops the least busy of the rest.
    const pinned = new Set<string>();
    for (const key of options.stateKeys ?? []) if (key) pinned.add(key);
    const base = candidates ?? (silent ? new Set([...current.keys(), ...silent]) : current.keys());
    const rest = [...base].filter((key) => !pinned.has(key));
    rest.sort((a, b) => (current.get(b)?.requests ?? 0) - (current.get(a)?.requests ?? 0));
    keys = [...pinned, ...rest];
  }
  if (keys.length > MAX_RULE_TARGETS) {
    logger.warn(`Rule "${rule.name}" covers ${keys.length} entities; evaluating the ${MAX_RULE_TARGETS} busiest`);
    notes.push(`Only the ${MAX_RULE_TARGETS} busiest entities are evaluated`);
    keys = keys.slice(0, MAX_RULE_TARGETS);
  }

  const counters = (key: string): EntityMetricCounters => current.get(key) ?? emptyCounters();
  const targets: TargetEvaluation[] = [];

  if (mode === 'absence') {
    for (const key of keys) {
      const requests = counters(key).requests;
      targets.push({
        entityKey: key,
        value: requests,
        sampleCount: requests,
        // A firing alert stays breached while the entity is silent, whether or not its traffic has
        // aged out of the lookback: only returning traffic resolves an absence alert.
        breached: requests === 0 && (Boolean(candidates?.has(key)) || firing.has(key)),
        noData: false,
      });
    }
    return { entityType, targets, notes };
  }

  for (const key of keys) {
    const { value, sampleCount } = computeEntityMetric(rule.metric, counters(key));
    // SLO burn judges its own sample count (the evaluator reports it); the window value is for display.
    const usable = mode === 'slo_burn' ? true : judgeable(def, value, sampleCount, minSamples, mode);
    targets.push({
      entityKey: key,
      value: usable ? (value ?? null) : null,
      sampleCount,
      breached: false,
      noData: !usable,
    });
  }

  if (mode === 'threshold') {
    for (const target of targets) {
      if (target.noData || target.value === null) continue;
      target.breached = evaluateCondition(target.value, rule.condition.operator, rule.condition.threshold);
    }
  } else if (mode === 'baseline') {
    const provider = getEntityBaselineProvider();
    const config = rule.condition.baseline;
    const judged = targets.filter((target) => !target.noData);
    if (provider && config && judged.length > 0) {
      const results = await provider.evaluate({
        ...scope,
        metric: rule.metric,
        windowMinutes: rule.windowMinutes,
        nowMs,
        config,
        current: judged.map((target) => ({
          entityKey: target.entityKey,
          value: target.value,
          sampleCount: target.sampleCount,
        })),
      });
      for (const target of judged) {
        const result = results.get(target.entityKey);
        if (!result) {
          target.insufficientData = true;
          continue;
        }
        target.baseline = result.baseline;
        target.ratio = result.ratio;
        target.z = result.z;
        target.insufficientData = result.insufficientHistory;
        target.breached = !result.insufficientHistory && result.breached;
      }
    }
  } else if (mode === 'slo_burn') {
    const evaluate = getSloBurnEvaluator();
    const config = rule.condition.slo;
    if (evaluate && config && targets.length > 0) {
      const results = await evaluate({
        ...scope,
        metric: rule.metric,
        nowMs,
        config,
        entityKeys: targets.map((target) => target.entityKey),
      });
      for (const target of targets) {
        const result = results.get(target.entityKey);
        if (!result) {
          target.noData = true;
          continue;
        }
        target.burnLong = result.burnLong;
        target.burnShort = result.burnShort;
        target.sampleCount = result.sampleCount;
        target.noData = result.sampleCount < minSamples;
        target.breached = !target.noData && result.breached;
      }
    }
  }

  return { entityType, targets, notes };
}

// ── State machine (pure) ────────────────────────────────────────────────────

export type StateAction = 'none' | 'fire' | 'resolve' | 'renotify_due';

export interface StateStepInput {
  prev: IAlertState | null;
  breached: boolean;
  value: number | null;
  now: Date;
  forMinutes: number;
  cooldownMinutes: number;
  renotifyMinutes: number;
  /** Which direction is worse for the peak value ('farthest': the largest deviation from `baseline`). */
  worse: 'max' | 'min' | 'farthest';
  /** The baseline the value is judged against ('farthest' peaks). */
  baseline?: number | null;
  /**
   * The data window this evaluation judged (entity rules: the rollup bucket end). Ticks come every
   * minute but entity windows advance every 5, so ok evaluations only count once per distinct window.
   */
  windowKey?: number | null;
  /** Last firing known from before alert states existed (the cooldown of an upgraded rule). */
  seedLastFiredAt?: Date | null;
}

export interface StateStep {
  phase: IAlertState['phase'];
  phaseSince: Date;
  breachStreak: number;
  okStreak: number;
  peakValue: number | null;
  action: StateAction;
}

function worseOf(worse: 'max' | 'min' | 'farthest', a: number | null, b: number | null, baseline?: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  if (worse === 'farthest') {
    if (baseline === null || baseline === undefined) return Math.max(a, b);
    return Math.abs(b - baseline) > Math.abs(a - baseline) ? b : a;
  }
  return worse === 'max' ? Math.max(a, b) : Math.min(a, b);
}

/** The data window a stored state last judged (see StateStepInput.windowKey). */
function storedWindowKey(prev: IAlertState | null): number | null {
  const value = (prev?.detail as Record<string, unknown> | null | undefined)?.windowKey;
  return typeof value === 'number' ? value : null;
}

/**
 * One evaluation step of a target's state. No I/O: the caller performs the
 * `action` (create event + incident, notify, resolve) and persists the result.
 */
export function advanceAlertState(input: StateStepInput): StateStep {
  const { prev, breached, now } = input;
  const nowMs = now.getTime();
  const prevPhase = prev?.phase ?? 'ok';
  const prevSince = prev?.phaseSince ? new Date(prev.phaseSince) : now;

  if (breached) {
    const breachStreak = (prev?.breachStreak ?? 0) + 1;
    let phase = prevPhase;
    let phaseSince = prevSince;
    let action: StateAction = 'none';
    let peakValue = prev?.peakValue ?? null;

    if (phase === 'ok') {
      phase = 'pending';
      phaseSince = now;
    }

    if (phase === 'pending') {
      const elapsedMin = (nowMs - phaseSince.getTime()) / MINUTE_MS;
      if (elapsedMin >= input.forMinutes) {
        const lastFired = prev?.lastFiredAt
          ? new Date(prev.lastFiredAt).getTime()
          : (input.seedLastFiredAt ? input.seedLastFiredAt.getTime() : null);
        const inCooldown = lastFired !== null && nowMs - lastFired < input.cooldownMinutes * MINUTE_MS;
        if (!inCooldown) {
          phase = 'firing';
          phaseSince = now;
          action = 'fire';
          peakValue = input.value;
        }
      }
    } else if (phase === 'firing') {
      peakValue = worseOf(input.worse, peakValue, input.value, input.baseline);
      const lastNotified = prev?.lastNotifiedAt ? new Date(prev.lastNotifiedAt).getTime() : null;
      if (input.renotifyMinutes > 0 && lastNotified !== null && nowMs - lastNotified >= input.renotifyMinutes * MINUTE_MS) {
        action = 'renotify_due';
      }
    }

    return { phase, phaseSince, breachStreak, okStreak: 0, peakValue, action };
  }

  const sameWindow = input.windowKey !== undefined && input.windowKey !== null && storedWindowKey(prev) === input.windowKey;
  const okStreak = sameWindow ? Math.max(prev?.okStreak ?? 0, 1) : (prev?.okStreak ?? 0) + 1;
  if (prevPhase === 'pending') {
    return { phase: 'ok', phaseSince: now, breachStreak: 0, okStreak, peakValue: null, action: 'none' };
  }
  if (prevPhase === 'firing') {
    if (okStreak >= RESOLVE_AFTER_OK_EVALUATIONS) {
      return { phase: 'ok', phaseSince: now, breachStreak: 0, okStreak, peakValue: prev?.peakValue ?? null, action: 'resolve' };
    }
    return { phase: 'firing', phaseSince: prevSince, breachStreak: 0, okStreak, peakValue: prev?.peakValue ?? null, action: 'none' };
  }
  return { phase: 'ok', phaseSince: prevSince, breachStreak: 0, okStreak, peakValue: null, action: 'none' };
}

/** Which way a value gets worse for this rule (peak = the worst value seen while firing). */
function worseDirection(rule: IAlertRule, def: AlertMetricDef | undefined): 'max' | 'min' | 'farthest' {
  const mode = ruleMode(rule);
  if (mode === 'threshold') {
    return rule.condition.operator === 'lt' || rule.condition.operator === 'lte' ? 'min' : 'max';
  }
  if (mode === 'baseline') {
    // The breach direction is the rule's own: a spike peaks high and a drop low, whatever "good" means.
    const direction = rule.condition.baseline?.direction;
    if (direction === 'up') return 'max';
    if (direction === 'down') return 'min';
    return 'farthest';
  }
  return def?.goodDirection === 'up' ? 'min' : 'max';
}

// ── Side effects ────────────────────────────────────────────────────────────

function formatForNote(value: number | null, unit: string): string {
  if (value === null) return 'normal';
  const text = Number(value.toFixed(2)).toString();
  if (unit === '%' || unit === 'ms') return `${text}${unit}`;
  if (unit === '$') return `$${text}`;
  return text;
}

/** Absolute link to the entity's page (enterprise health page when registered, else its core page); never throws. */
async function entityUrlFor(
  runtime: RuleRuntime,
  entityType: EntityMetricType | null,
  entityKey: string,
): Promise<string | undefined> {
  if (!entityType || !entityKey) return undefined;
  const path = await resolveEntityPath(runtime.db, runtime.rule.projectId, entityType, entityKey);
  return path ? `${getConfig().app.url}${path}` : undefined;
}

interface RuleRuntime {
  ctx: EvaluationContext;
  db: DatabaseProvider;
  rule: IAlertRule;
  ruleId: string;
  def: AlertMetricDef | undefined;
  mode: AlertConditionMode;
  entityType: EntityMetricType | null;
  now: Date;
  projectName: () => Promise<string>;
  /** Incident contexts this rule may still build in this sweep. */
  contextBudget: { left: number };
  /** Rule mute: evaluation, states, events and incidents go on, channel notifications do not. */
  muted: boolean;
}

async function buildNotification(
  runtime: RuleRuntime,
  kind: AlertNotification['kind'],
  target: TargetEvaluation,
  severity: IncidentSeverity,
  firedAt: Date,
  extra: { resolvedAt?: Date | null; incidentUrl?: string; context?: IIncidentContext | null; projectName: string },
): Promise<AlertNotification> {
  const { rule, def, mode, entityType } = runtime;
  const appUrl = getConfig().app.url;
  const entityUrl = await entityUrlFor(runtime, entityType, target.entityKey);
  return {
    kind,
    rule: {
      id: runtime.ruleId,
      name: rule.name,
      module: rule.module,
      metric: rule.metric,
      metricLabel: def?.label ?? rule.metric,
      unit: def?.unit ?? '',
      mode,
      windowMinutes: rule.windowMinutes,
      ...(mode === 'threshold' ? { operator: rule.condition.operator, threshold: rule.condition.threshold } : {}),
    },
    entity: entityType && target.entityKey ? { type: entityType, key: target.entityKey } : null,
    value: target.value,
    baseline: target.baseline ?? null,
    severity,
    firedAt,
    resolvedAt: extra.resolvedAt ?? null,
    projectName: extra.projectName,
    companyName: runtime.ctx.companyName,
    dashboardUrl: `${appUrl}/dashboard/alerts/incidents`,
    ...(extra.incidentUrl ? { incidentUrl: extra.incidentUrl } : {}),
    ...(entityUrl ? { entityUrl } : {}),
    ...(extra.context ? { context: extra.context } : {}),
  };
}

function channelContext(runtime: RuleRuntime, projectName: string, incidentId?: string): AlertContext {
  const appUrl = getConfig().app.url;
  return {
    tenantDbName: runtime.ctx.tenantDbName,
    tenantId: runtime.ctx.tenantId,
    tenantSlug: runtime.ctx.tenantSlug,
    companyName: runtime.ctx.companyName,
    projectName,
    dashboardUrl: `${appUrl}/dashboard/alerts/incidents`,
    incidentUrl: incidentId ? `${appUrl}/dashboard/alerts/incidents?highlight=${incidentId}` : undefined,
    incidentId,
  };
}

function webhookData(
  runtime: RuleRuntime,
  target: TargetEvaluation,
  severity: IncidentSeverity,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const { rule } = runtime;
  return {
    ruleId: runtime.ruleId,
    ruleName: rule.name,
    metric: rule.metric,
    entityType: runtime.entityType,
    entityKey: target.entityKey || null,
    value: target.value,
    threshold: runtime.mode === 'threshold' ? rule.condition.threshold : null,
    baseline: target.baseline ?? null,
    severity,
    ...fields,
  };
}

interface FireOutcome {
  incidentId: string | null;
  eventId: string;
  severity: IncidentSeverity;
}

async function fireTarget(runtime: RuleRuntime, target: TargetEvaluation, peakValue: number | null): Promise<FireOutcome> {
  const { ctx, db, rule, mode, entityType, now } = runtime;
  const severity = deriveRuleSeverity({
    rule,
    value: target.value,
    baseline: { ratio: target.ratio ?? null, z: target.z ?? null },
    slo: { burnShort: target.burnShort ?? null },
  });
  const entityKey = target.entityKey || null;
  const metadata = {
    operator: rule.condition.operator,
    windowMinutes: rule.windowMinutes,
    mode,
    sampleCount: target.sampleCount,
    scope: rule.scope,
    ...(rule.entity ? { entity: rule.entity } : {}),
    ...(runtime.muted ? { suppressed: 'rule_muted' } : {}),
  };

  const event: Omit<IAlertEvent, '_id'> = {
    tenantId: ctx.tenantId,
    projectId: rule.projectId,
    ruleId: runtime.ruleId,
    ruleName: rule.name,
    metric: rule.metric,
    threshold: rule.condition.threshold,
    actualValue: target.value ?? 0,
    status: 'fired',
    kind: 'fired',
    channels: [],
    firedAt: now,
    entityType,
    entityKey,
    baselineValue: target.baseline ?? null,
    sampleCount: target.sampleCount,
    metadata,
  };
  const createdEvent = await db.createAlertEvent(event);
  const eventId = String(createdEvent._id);

  let context: IIncidentContext | undefined;
  try {
    if (runtime.contextBudget.left <= 0) throw new Error('context budget of this sweep used up');
    runtime.contextBudget.left -= 1;
    context = await buildIncidentContext({
      db,
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: rule.projectId,
      rule,
      entityType,
      entityKey: target.entityKey,
      windowMinutes: rule.windowMinutes,
      nowMs: now.getTime(),
    });
  } catch (error) {
    logger.warn(`No incident context for rule "${rule.name}"${entityKey ? ` [${entityKey}]` : ''}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let incidentId: string | null = null;
  try {
    const incident = await IncidentService.createIncident(ctx.tenantDbName, {
      tenantId: ctx.tenantId,
      projectId: rule.projectId,
      alertEventId: eventId,
      ruleId: runtime.ruleId,
      ruleName: rule.name,
      metric: rule.metric,
      threshold: rule.condition.threshold,
      actualValue: target.value ?? 0,
      severity,
      firedAt: now,
      metadata,
      module: rule.module,
      entityType,
      entityKey,
      baselineValue: target.baseline ?? null,
      peakValue: peakValue ?? target.value ?? null,
      context,
    });
    incidentId = String(incident._id);
  } catch (error) {
    logger.error(`Failed to create incident for rule "${rule.name}"`, {
      error: error instanceof Error ? error.message : error,
    });
  }

  const projectName = await runtime.projectName();
  const notification = await buildNotification(runtime, 'fired', target, severity, now, {
    projectName,
    context,
    incidentUrl: incidentId ? `${getConfig().app.url}/dashboard/alerts/incidents?highlight=${incidentId}` : undefined,
  });
  const deliveryBase = { tenantId: ctx.tenantId, projectId: rule.projectId, ruleId: runtime.ruleId, incidentId, eventId };
  let results: DispatchResult[] = [];
  if (runtime.muted) {
    await recordSuppressed(db, deliveryBase, 'fired', rule.channels ?? [], 'rule_muted');
  } else {
    results = await dispatchNotification(
      notification,
      rule.channels ?? [],
      channelContext(runtime, projectName, incidentId ?? undefined),
    );
    await recordDeliveries(db, deliveryBase, 'fired', results);
  }
  try {
    await db.updateAlertEvent(eventId, { channels: results });
  } catch (error) {
    logger.warn('Could not store the dispatch results on the alert event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await publishWebhookEvent({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: rule.projectId,
    type: 'alert.fired',
    data: webhookData(runtime, target, severity, { incidentId, firedAt: now.toISOString() }),
  });

  try {
    await db.updateAlertRule(runtime.ruleId, { lastTriggeredAt: now });
  } catch (error) {
    logger.warn('Could not update the rule lastTriggeredAt', { error: error instanceof Error ? error.message : String(error) });
  }

  logger.info(`FIRED: "${rule.name}"${entityKey ? ` [${entityKey}]` : ''} (${rule.metric} = ${target.value === null ? 'n/a' : target.value.toFixed(2)}) for tenant ${ctx.tenantSlug}`);
  return { incidentId, eventId, severity };
}

async function resolveTarget(runtime: RuleRuntime, target: TargetEvaluation, state: IAlertState): Promise<void> {
  const { ctx, db, rule, def, now } = runtime;
  const unit = def?.unit ?? '';
  const label = def?.label ?? rule.metric;
  const resolvedAt = now;
  const firedAt = state.firedAt ? new Date(state.firedAt) : now;

  if (state.eventId) {
    try {
      await db.updateAlertEvent(state.eventId, { status: 'resolved', resolvedAt, kind: 'resolved' });
    } catch (error) {
      logger.warn('Could not mark the alert event resolved', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (state.incidentId) {
    try {
      await IncidentService.autoResolve(
        ctx.tenantDbName,
        state.incidentId,
        `Automatically resolved: ${label} back to ${formatForNote(target.value, unit)}`,
        { lastValue: target.value, peakValue: state.peakValue ?? null },
      );
    } catch (error) {
      logger.warn('Could not auto-resolve the incident', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // The severity the incident fired with is not stored on the state; the stored incident knows it.
  let severity: IncidentSeverity = 'info';
  if (state.incidentId) {
    try {
      const incident = await db.findIncidentById(state.incidentId);
      if (incident?.severity) severity = incident.severity;
    } catch { /* keep the default */ }
  }

  if (rule.notifyOnResolve !== false) {
    const projectName = await runtime.projectName();
    const notification = await buildNotification(runtime, 'resolved', target, severity, firedAt, {
      projectName,
      resolvedAt,
      incidentUrl: state.incidentId ? `${getConfig().app.url}/dashboard/alerts/incidents?highlight=${state.incidentId}` : undefined,
    });
    const deliveryBase = { tenantId: ctx.tenantId, projectId: rule.projectId, ruleId: runtime.ruleId, incidentId: state.incidentId ?? null, eventId: state.eventId ?? null };
    if (runtime.muted) {
      await recordSuppressed(db, deliveryBase, 'resolved', rule.channels ?? [], 'rule_muted');
    } else {
      const results = await dispatchNotification(notification, rule.channels ?? [], channelContext(runtime, projectName, state.incidentId ?? undefined));
      await recordDeliveries(db, deliveryBase, 'resolved', results);
    }
  }

  await publishWebhookEvent({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: rule.projectId,
    type: 'alert.resolved',
    data: webhookData(runtime, target, severity, {
      incidentId: state.incidentId ?? null,
      firedAt: firedAt.toISOString(),
      resolvedAt: resolvedAt.toISOString(),
    }),
  });

  logger.info(`RESOLVED: "${rule.name}"${target.entityKey ? ` [${target.entityKey}]` : ''} for tenant ${ctx.tenantSlug}`);
}

/**
 * A person who acknowledged, is investigating, or already closed the incident does not want the same page again.
 * A snoozed incident is silenced for now: the attempt is logged as suppressed and the renotify clock moves on.
 */
async function renotifyTarget(runtime: RuleRuntime, target: TargetEvaluation, state: IAlertState): Promise<boolean> {
  const { db, rule, ctx } = runtime;
  let severity: IncidentSeverity = 'info';
  let snoozed = false;
  if (state.incidentId) {
    try {
      const incident = await db.findIncidentById(state.incidentId);
      if (incident && incident.status !== 'open') return false;
      if (incident?.severity) severity = incident.severity;
      snoozed = Boolean(incident?.snoozedUntil && new Date(incident.snoozedUntil).getTime() > runtime.now.getTime());
    } catch { /* keep the defaults */ }
  }
  const deliveryBase = { tenantId: ctx.tenantId, projectId: rule.projectId, ruleId: runtime.ruleId, incidentId: state.incidentId ?? null, eventId: state.eventId ?? null };
  if (runtime.muted || snoozed) {
    await recordSuppressed(db, deliveryBase, 'renotify', rule.channels ?? [], runtime.muted ? 'rule_muted' : 'incident_snoozed');
    return true;
  }
  const projectName = await runtime.projectName();
  const notification = await buildNotification(runtime, 'renotify', target, severity, state.firedAt ? new Date(state.firedAt) : runtime.now, {
    projectName,
    incidentUrl: state.incidentId ? `${getConfig().app.url}/dashboard/alerts/incidents?highlight=${state.incidentId}` : undefined,
  });
  const results = await dispatchNotification(notification, rule.channels ?? [], channelContext(runtime, projectName, state.incidentId ?? undefined));
  await recordDeliveries(db, deliveryBase, 'renotify', results);
  return true;
}

function stateDetail(target: TargetEvaluation, windowKey: number | null): Record<string, unknown> | null {
  const detail: Record<string, unknown> = {};
  if (target.insufficientData) detail.insufficientData = true;
  if (target.z !== undefined && target.z !== null) detail.z = target.z;
  if (target.ratio !== undefined && target.ratio !== null) detail.ratio = target.ratio;
  if (target.burnShort !== undefined && target.burnShort !== null) detail.burnShort = target.burnShort;
  if (target.burnLong !== undefined && target.burnLong !== null) detail.burnLong = target.burnLong;
  if (windowKey !== null) detail.windowKey = windowKey;
  return Object.keys(detail).length > 0 ? detail : null;
}

/**
 * Evaluate all active alert rules for a given tenant.
 *
 * `deadlineMs` (epoch ms) bounds the work: past it no further rule is started and no
 * further notification is sent (their targets keep their state and are handled by the next
 * sweep), so one tenant can never outlast the scheduler lock or starve the others.
 *
 * Returns how many alerts fired (new incidents) in this sweep.
 */
export async function evaluateTenantAlerts(
  ctx: EvaluationContext,
  options: { ruleFilter?: (rule: IAlertRule) => boolean | Promise<boolean>; deadlineMs?: number } = {},
): Promise<number> {
  const db = await getTenantDatabase(ctx.tenantDbName);

  // Fetch all enabled rules for this tenant
  const allRules = await db.listAlertRules(ctx.tenantId, { enabled: true });
  let rules = allRules;
  if (options.ruleFilter) {
    const filtered: typeof allRules = [];
    for (const rule of allRules) {
      if (await options.ruleFilter(rule)) filtered.push(rule);
    }
    rules = filtered;
  }
  if (rules.length === 0) return 0;

  const gate = createModeGate(ctx.tenantId);
  const memo: AggregateMemo = new Map();
  const projectNames = new Map<string, Promise<string>>();
  const projectNameFor = (projectId: string) => {
    let pending = projectNames.get(projectId);
    if (!pending) {
      pending = (async () => {
        try {
          const project = await db.findProjectById(projectId);
          if (project) return project.name;
        } catch { /* ignore */ }
        return 'Unknown Project';
      })();
      projectNames.set(projectId, pending);
    }
    return pending;
  };

  let firedCount = 0;
  const now = new Date();

  for (const rule of rules) {
    if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) {
      logger.warn(`Tenant ${ctx.tenantSlug}: evaluation budget exhausted; the remaining rules wait for the next tick`);
      break;
    }
    try {
      firedCount += await evaluateRule(ctx, db, rule, { now, gate, projectNameFor, memo, deadlineMs: options.deadlineMs });
    } catch (err) {
      logger.error(`Error evaluating rule "${rule.name}" for tenant ${ctx.tenantSlug}`, {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  return firedCount;
}

/** The rule was deleted, disabled or reshaped (its states would now mean something else) since it was loaded. */
async function ruleChangedUnderneath(db: DatabaseProvider, rule: IAlertRule, ruleId: string): Promise<boolean> {
  try {
    const current = await db.findAlertRuleById(ruleId);
    if (!current || current.enabled === false) return true;
    return evaluationShapeOf(current) !== evaluationShapeOf(rule);
  } catch {
    return false;
  }
}

/** The summary behind the derived "No data" state is rewritten only when it changed or went stale. */
const LAST_EVALUATION_REFRESH_MS = 15 * MINUTE_MS;

export function lastEvaluationDue(
  previous: IAlertRule['lastEvaluation'],
  next: { targets: number; noDataTargets: number },
  now: Date,
): boolean {
  if (!previous) return true;
  const at = new Date(previous.at).getTime();
  if (!Number.isFinite(at)) return true;
  return previous.targets !== next.targets
    || previous.noDataTargets !== next.noDataTargets
    || now.getTime() - at >= LAST_EVALUATION_REFRESH_MS;
}

async function recordLastEvaluation(
  db: DatabaseProvider,
  rule: IAlertRule,
  ruleId: string,
  targets: TargetEvaluation[],
  now: Date,
): Promise<void> {
  const summary = { targets: targets.length, noDataTargets: targets.filter((target) => target.noData).length };
  if (!lastEvaluationDue(rule.lastEvaluation, summary, now)) return;
  try {
    await db.updateAlertRule(ruleId, { lastEvaluation: { at: now, ...summary } });
  } catch (error) {
    logger.warn('Could not store the rule evaluation summary', { error: error instanceof Error ? error.message : String(error) });
  }
}

async function evaluateRule(
  ctx: EvaluationContext,
  db: DatabaseProvider,
  rule: IAlertRule,
  shared: {
    now: Date;
    gate: ModeGate;
    projectNameFor: (projectId: string) => Promise<string>;
    memo?: AggregateMemo;
    deadlineMs?: number;
  },
): Promise<number> {
  const { now } = shared;
  const ruleId = String(rule._id);
  const mode = ruleMode(rule);
  const def = getMetricDef(rule.metric);

  const states = await db.listAlertStates({ ruleId, limit: 5000 });
  const stateByKey = new Map(states.map((state) => [state.entityKey, state]));
  const nonOkKeys = states.filter((state) => state.phase !== 'ok' && state.entityKey).map((state) => state.entityKey);
  const firingKeys = states.filter((state) => state.phase === 'firing' && state.entityKey).map((state) => state.entityKey);

  const evaluation = await evaluateRuleTargets(ctx, rule, {
    nowMs: now.getTime(),
    gate: shared.gate,
    stateKeys: nonOkKeys,
    firingKeys,
    memo: shared.memo,
  });

  // The sweep may have been waiting on slower rules: do not write states of a rule that is gone or edited since.
  if (await ruleChangedUnderneath(db, rule, ruleId)) return 0;

  if (evaluation.modeUnavailable) {
    // Rule-level marker for the UI; entity states are left as they are.
    const existing = stateByKey.get('');
    const marked = existing?.detail && (existing.detail as Record<string, unknown>).licenseRequired === true;
    if (!marked) {
      await db.upsertAlertState({
        tenantId: ctx.tenantId,
        projectId: rule.projectId,
        ruleId,
        entityKey: '',
        entityType: evaluation.entityType,
        phase: 'ok',
        phaseSince: now,
        breachStreak: 0,
        okStreak: 0,
        lastValue: null,
        lastBaseline: null,
        lastSampleCount: 0,
        lastEvaluatedAt: now,
        detail: { licenseRequired: true, reason: evaluation.modeUnavailable },
      });
    }
    return 0;
  }

  // The rule works again: clear the marker.
  const marker = stateByKey.get('');
  if (marker?.detail && (marker.detail as Record<string, unknown>).licenseRequired === true) {
    await db.deleteAlertStates({ ruleId, entityKeys: [''] });
    stateByKey.delete('');
  }

  // 'selected' rules drop the states of entities that are no longer selected.
  if (def?.source === 'entity' && rule.entity?.mode === 'selected') {
    const keep = new Set(selectedKeys(rule) ?? []);
    const stale = states.map((state) => state.entityKey).filter((key) => key && !keep.has(key));
    if (stale.length > 0) await db.deleteAlertStates({ ruleId, entityKeys: stale });
  }

  const runtime: RuleRuntime = {
    ctx,
    db,
    rule,
    ruleId,
    def,
    mode,
    entityType: evaluation.entityType,
    now,
    projectName: () => shared.projectNameFor(rule.projectId),
    contextBudget: { left: MAX_CONTEXTS_PER_RULE_SWEEP },
    muted: Boolean(rule.mutedUntil) && new Date(rule.mutedUntil as Date).getTime() > now.getTime(),
  };

  const forMinutes = Math.max(0, rule.condition.forMinutes ?? 0);
  const renotifyMinutes = Math.max(0, rule.renotifyMinutes ?? 0);
  const cooldownMinutes = Math.max(0, rule.cooldownMinutes ?? 0);
  const worse = worseDirection(rule, def);
  const windowKey = def?.source === 'entity'
    ? entityEvaluationWindow(now.getTime(), rule.windowMinutes).toMs
    : null;
  // An upgraded legacy rule has no state row yet: its cooldown still runs from its last firing.
  const legacySeed = rule.lastTriggeredAt ? new Date(rule.lastTriggeredAt) : null;

  let fired = 0;
  let actions = 0;
  let deferred = 0;
  let aborted = false;
  const staleKeys: string[] = [];

  const overBudget = () =>
    actions >= MAX_ACTIONS_PER_RULE_SWEEP
    || (shared.deadlineMs !== undefined && Date.now() > shared.deadlineMs);

  const handleTarget = async (target: TargetEvaluation): Promise<void> => {
    try {
      const prev = stateByKey.get(target.entityKey) ?? null;
      const seed = !prev && target.entityKey === '' ? legacySeed : null;
      let step = advanceAlertState({
        prev,
        breached: target.breached,
        value: target.value,
        now,
        forMinutes,
        cooldownMinutes,
        renotifyMinutes,
        worse,
        baseline: target.baseline ?? null,
        windowKey,
        seedLastFiredAt: seed,
      });

      // Too many notifications for one sweep: keep the state that retries next tick, send nothing now.
      if (step.action !== 'none' && overBudget()) {
        deferred += 1;
        if (step.action === 'fire') {
          step = {
            ...step,
            phase: 'pending',
            phaseSince: prev?.phase === 'pending' && prev.phaseSince ? new Date(prev.phaseSince) : now,
            action: 'none',
          };
        } else if (step.action === 'resolve') {
          step = {
            ...step,
            phase: 'firing',
            phaseSince: prev?.phaseSince ? new Date(prev.phaseSince) : now,
            action: 'none',
          };
        } else {
          step = { ...step, action: 'none' };
        }
      }

      let incidentId = prev?.incidentId ?? null;
      let eventId = prev?.eventId ?? null;
      let firedAt = prev?.firedAt ?? null;
      let lastFiredAt = prev?.lastFiredAt ?? seed ?? null;
      let lastNotifiedAt = prev?.lastNotifiedAt ?? null;
      const phase = step.phase;
      const phaseSince = step.phaseSince;
      let peakValue = step.peakValue;
      let acted = false;

      if (step.action === 'fire') {
        actions += 1;
        acted = true;
        const outcome = await fireTarget(runtime, target, peakValue);
        incidentId = outcome.incidentId;
        eventId = outcome.eventId;
        firedAt = now;
        lastFiredAt = now;
        lastNotifiedAt = now;
        fired += 1;
      } else if (step.action === 'resolve') {
        actions += 1;
        acted = true;
        await resolveTarget(runtime, target, prev as IAlertState);
        incidentId = null;
        eventId = null;
        firedAt = null;
        peakValue = null;
      } else if (step.action === 'renotify_due') {
        actions += 1;
        acted = true;
        if (await renotifyTarget(runtime, target, prev as IAlertState)) lastNotifiedAt = now;
      }

      // A notification can take seconds: the rule may have been deleted, disabled or reshaped meanwhile.
      if (aborted) return;
      if (acted && await ruleChangedUnderneath(db, rule, ruleId)) {
        aborted = true;
        if (step.action === 'fire' && incidentId) {
          try {
            await IncidentService.addSystemNote(ctx.tenantDbName, incidentId, 'Rule changed while this alert fired; it will not resolve automatically');
          } catch { /* informational */ }
        }
        await db.deleteAlertStates({ ruleId });
        return;
      }

      // Keep the incident's worst value current while the alert keeps firing.
      if (phase === 'firing' && step.action !== 'fire' && incidentId && peakValue !== null && peakValue !== (prev?.peakValue ?? null)) {
        try {
          await db.updateIncident(incidentId, { peakValue, lastValue: target.value });
        } catch { /* informational only */ }
      }

      // A healthy entity needs a row only while its cooldown runs; afterwards the row goes.
      const cooledDown = lastFiredAt === null
        || now.getTime() - new Date(lastFiredAt).getTime() >= cooldownMinutes * MINUTE_MS;
      if (phase === 'ok' && target.entityKey !== '' && cooledDown) {
        if (prev) staleKeys.push(target.entityKey);
        return;
      }

      // Healthy entities leave no row behind; a row exists only once an entity has been non-ok.
      const wasNonOk = prev !== null && prev.phase !== 'ok';
      const persist = phase !== 'ok' || wasNonOk || target.entityKey === '';
      if (!persist) return;

      await db.upsertAlertState({
        tenantId: ctx.tenantId,
        projectId: rule.projectId,
        ruleId,
        entityKey: target.entityKey,
        entityType: evaluation.entityType,
        phase,
        phaseSince,
        breachStreak: step.breachStreak,
        okStreak: step.okStreak,
        lastValue: target.value,
        lastBaseline: target.baseline ?? null,
        lastSampleCount: target.sampleCount,
        lastEvaluatedAt: now,
        incidentId,
        eventId,
        firedAt,
        lastFiredAt,
        lastNotifiedAt,
        peakValue,
        detail: stateDetail(target, windowKey),
      });
    } catch (error) {
      logger.error(`Error handling "${rule.name}"${target.entityKey ? ` [${target.entityKey}]` : ''}`, {
        error: error instanceof Error ? error.message : error,
      });
    }
  };

  // Targets are independent; a few at a time keeps one slow channel from serialising the whole rule.
  const queue = evaluation.targets;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!aborted) {
      const index = next;
      next += 1;
      if (index >= queue.length) return;
      await handleTarget(queue[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TARGET_CONCURRENCY, queue.length) }, () => worker()));

  if (aborted) return fired;

  await recordLastEvaluation(db, rule, ruleId, queue, now);

  if (deferred > 0) {
    logger.warn(`Rule "${rule.name}": ${deferred} notification(s) deferred to the next tick`, { tenant: ctx.tenantSlug });
  }

  // Rows of entities that are healthy, out of cooldown and no longer targets are only clutter.
  const targetKeys = new Set(queue.map((target) => target.entityKey));
  for (const state of states) {
    if (state.phase !== 'ok' || !state.entityKey || targetKeys.has(state.entityKey)) continue;
    if ((state.detail as Record<string, unknown> | null | undefined)?.licenseRequired === true) continue;
    const last = state.lastFiredAt ? new Date(state.lastFiredAt).getTime() : null;
    if (last === null || now.getTime() - last >= cooldownMinutes * MINUTE_MS) staleKeys.push(state.entityKey);
  }
  for (let i = 0; i < staleKeys.length; i += 200) {
    try {
      await db.deleteAlertStates({ ruleId, entityKeys: staleKeys.slice(i, i + 200) });
    } catch (error) {
      logger.warn('Could not purge settled alert states', { error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }

  return fired;
}
