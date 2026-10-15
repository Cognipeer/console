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

const logger = createLogger('alert-evaluator');

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Resolved after this many consecutive ok (or no-data) evaluations. */
export const RESOLVE_AFTER_OK_EVALUATIONS = 2;
/** Upper bound of targets one rule fans out to (the busiest entities win). */
export const MAX_RULE_TARGETS = 2000;

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
}

function defaultMinSamples(mode: AlertConditionMode): number {
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
function judgeable(def: AlertMetricDef, value: number | null, sampleCount: number, minSamples: number, mode: AlertConditionMode): boolean {
  if (value === null) return false;
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

  const current = await aggregateEntityCounters({ ...scope, fromMs, toMs, entityKeys: selected ?? undefined });

  // Absence candidates: entities that normally have traffic in a window of this size.
  let candidates: Set<string> | null = null;
  if (mode === 'absence') {
    const absence = rule.condition.absence ?? { lookbackHours: 24, minExpectedPerWindow: 1 };
    const lookbackMs = absence.lookbackHours * HOUR_MS;
    const history = await aggregateEntityCounters({
      ...scope,
      fromMs: fromMs - lookbackMs,
      toMs: fromMs,
      entityKeys: selected ?? undefined,
    });
    const windows = Math.max(lookbackMs / (rule.windowMinutes * MINUTE_MS), 1);
    candidates = new Set();
    for (const [key, counters] of history) {
      if (counters.requests / windows >= (absence.minExpectedPerWindow ?? 1)) candidates.add(key);
    }
  }

  let keys: string[];
  if (selected) {
    keys = selected;
  } else {
    // Keys that already carry a non-ok state always stay (a silent firing entity must still resolve);
    // the cap then drops the least busy of the rest.
    const pinned = new Set<string>();
    for (const key of options.stateKeys ?? []) if (key) pinned.add(key);
    const rest = [...(candidates ?? current.keys())].filter((key) => !pinned.has(key));
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
        breached: Boolean(candidates?.has(key)) && requests === 0,
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
  /** Which direction is worse for the peak value. */
  worse: 'max' | 'min';
}

export interface StateStep {
  phase: IAlertState['phase'];
  phaseSince: Date;
  breachStreak: number;
  okStreak: number;
  peakValue: number | null;
  action: StateAction;
}

function worseOf(worse: 'max' | 'min', a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return worse === 'max' ? Math.max(a, b) : Math.min(a, b);
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
        const lastFired = prev?.lastFiredAt ? new Date(prev.lastFiredAt).getTime() : null;
        const inCooldown = lastFired !== null && nowMs - lastFired < input.cooldownMinutes * MINUTE_MS;
        if (!inCooldown) {
          phase = 'firing';
          phaseSince = now;
          action = 'fire';
          peakValue = input.value;
        }
      }
    } else if (phase === 'firing') {
      peakValue = worseOf(input.worse, peakValue, input.value);
      const lastNotified = prev?.lastNotifiedAt ? new Date(prev.lastNotifiedAt).getTime() : null;
      if (input.renotifyMinutes > 0 && lastNotified !== null && nowMs - lastNotified >= input.renotifyMinutes * MINUTE_MS) {
        action = 'renotify_due';
      }
    }

    return { phase, phaseSince, breachStreak, okStreak: 0, peakValue, action };
  }

  const okStreak = (prev?.okStreak ?? 0) + 1;
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
function worseDirection(rule: IAlertRule, def: AlertMetricDef | undefined): 'max' | 'min' {
  if (ruleMode(rule) === 'threshold') {
    return rule.condition.operator === 'lt' || rule.condition.operator === 'lte' ? 'min' : 'max';
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

function entityUrlFor(entityType: EntityMetricType | null, entityKey: string): string | undefined {
  if (entityType === 'agent' && entityKey) {
    return `${getConfig().app.url}/dashboard/tracing/agents/${encodeURIComponent(entityKey)}`;
  }
  return undefined;
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
}

function buildNotification(
  runtime: RuleRuntime,
  kind: AlertNotification['kind'],
  target: TargetEvaluation,
  severity: IncidentSeverity,
  firedAt: Date,
  extra: { resolvedAt?: Date | null; incidentUrl?: string; context?: IIncidentContext | null; projectName: string },
): AlertNotification {
  const { rule, def, mode, entityType } = runtime;
  const appUrl = getConfig().app.url;
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
    ...(entityUrlFor(entityType, target.entityKey) ? { entityUrl: entityUrlFor(entityType, target.entityKey) } : {}),
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
    logger.warn(`Could not build the incident context for rule "${rule.name}"`, {
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
  const notification = buildNotification(runtime, 'fired', target, severity, now, {
    projectName,
    context,
    incidentUrl: incidentId ? `${getConfig().app.url}/dashboard/alerts/incidents?highlight=${incidentId}` : undefined,
  });
  const results: DispatchResult[] = await dispatchNotification(
    notification,
    rule.channels ?? [],
    channelContext(runtime, projectName, incidentId ?? undefined),
  );
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
    const notification = buildNotification(runtime, 'resolved', target, severity, firedAt, {
      projectName,
      resolvedAt,
      incidentUrl: state.incidentId ? `${getConfig().app.url}/dashboard/alerts/incidents?highlight=${state.incidentId}` : undefined,
    });
    await dispatchNotification(notification, rule.channels ?? [], channelContext(runtime, projectName, state.incidentId ?? undefined));
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

/** A person who acknowledged, is investigating, or already closed the incident does not want the same page again. */
async function renotifySuppressed(db: DatabaseProvider, incidentId: string | null | undefined): Promise<boolean> {
  if (!incidentId) return false;
  try {
    const incident = await db.findIncidentById(incidentId);
    return Boolean(incident && incident.status !== 'open');
  } catch {
    return false;
  }
}

async function renotifyTarget(runtime: RuleRuntime, target: TargetEvaluation, state: IAlertState): Promise<boolean> {
  if (await renotifySuppressed(runtime.db, state.incidentId)) return false;
  const projectName = await runtime.projectName();
  let severity: IncidentSeverity = 'info';
  if (state.incidentId) {
    try {
      const incident = await runtime.db.findIncidentById(state.incidentId);
      if (incident?.severity) severity = incident.severity;
    } catch { /* keep the default */ }
  }
  const notification = buildNotification(runtime, 'renotify', target, severity, state.firedAt ? new Date(state.firedAt) : runtime.now, {
    projectName,
    incidentUrl: state.incidentId ? `${getConfig().app.url}/dashboard/alerts/incidents?highlight=${state.incidentId}` : undefined,
  });
  await dispatchNotification(notification, runtime.rule.channels ?? [], channelContext(runtime, projectName, state.incidentId ?? undefined));
  return true;
}

function stateDetail(target: TargetEvaluation): Record<string, unknown> | null {
  const detail: Record<string, unknown> = {};
  if (target.insufficientData) detail.insufficientData = true;
  if (target.z !== undefined && target.z !== null) detail.z = target.z;
  if (target.ratio !== undefined && target.ratio !== null) detail.ratio = target.ratio;
  if (target.burnShort !== undefined && target.burnShort !== null) detail.burnShort = target.burnShort;
  if (target.burnLong !== undefined && target.burnLong !== null) detail.burnLong = target.burnLong;
  return Object.keys(detail).length > 0 ? detail : null;
}

/**
 * Evaluate all active alert rules for a given tenant.
 *
 * Returns how many alerts fired (new incidents) in this sweep.
 */
export async function evaluateTenantAlerts(
  ctx: EvaluationContext,
  options: { ruleFilter?: (rule: IAlertRule) => boolean | Promise<boolean> } = {},
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
    try {
      firedCount += await evaluateRule(ctx, db, rule, { now, gate, projectNameFor });
    } catch (err) {
      logger.error(`Error evaluating rule "${rule.name}" for tenant ${ctx.tenantSlug}`, {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  return firedCount;
}

async function evaluateRule(
  ctx: EvaluationContext,
  db: DatabaseProvider,
  rule: IAlertRule,
  shared: { now: Date; gate: ModeGate; projectNameFor: (projectId: string) => Promise<string> },
): Promise<number> {
  const { now } = shared;
  const ruleId = String(rule._id);
  const mode = ruleMode(rule);
  const def = getMetricDef(rule.metric);

  const states = await db.listAlertStates({ ruleId, limit: 5000 });
  const stateByKey = new Map(states.map((state) => [state.entityKey, state]));
  const nonOkKeys = states.filter((state) => state.phase !== 'ok' && state.entityKey).map((state) => state.entityKey);

  const evaluation = await evaluateRuleTargets(ctx, rule, { nowMs: now.getTime(), gate: shared.gate, stateKeys: nonOkKeys });

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
  };

  const forMinutes = Math.max(0, rule.condition.forMinutes ?? 0);
  const renotifyMinutes = Math.max(0, rule.renotifyMinutes ?? 0);
  const cooldownMinutes = Math.max(0, rule.cooldownMinutes ?? 0);
  const worse = worseDirection(rule, def);
  let fired = 0;

  for (const target of evaluation.targets) {
    try {
      const prev = stateByKey.get(target.entityKey) ?? null;
      const step = advanceAlertState({
        prev,
        breached: target.breached,
        value: target.value,
        now,
        forMinutes,
        cooldownMinutes,
        renotifyMinutes,
        worse,
      });

      let incidentId = prev?.incidentId ?? null;
      let eventId = prev?.eventId ?? null;
      let firedAt = prev?.firedAt ?? null;
      let lastFiredAt = prev?.lastFiredAt ?? null;
      let lastNotifiedAt = prev?.lastNotifiedAt ?? null;
      const phase = step.phase;
      const phaseSince = step.phaseSince;
      let peakValue = step.peakValue;

      if (step.action === 'fire') {
        const outcome = await fireTarget(runtime, target, peakValue);
        incidentId = outcome.incidentId;
        eventId = outcome.eventId;
        firedAt = now;
        lastFiredAt = now;
        lastNotifiedAt = now;
        fired += 1;
      } else if (step.action === 'resolve') {
        await resolveTarget(runtime, target, prev as IAlertState);
        incidentId = null;
        eventId = null;
        firedAt = null;
        peakValue = null;
      } else if (step.action === 'renotify_due') {
        if (await renotifyTarget(runtime, target, prev as IAlertState)) lastNotifiedAt = now;
      }

      // Keep the incident's worst value current while the alert keeps firing.
      if (phase === 'firing' && step.action !== 'fire' && incidentId && peakValue !== null && peakValue !== (prev?.peakValue ?? null)) {
        try {
          await db.updateIncident(incidentId, { peakValue, lastValue: target.value });
        } catch { /* informational only */ }
      }

      // Healthy entities leave no row behind; a row exists only once an entity has been non-ok.
      const wasNonOk = prev !== null && prev.phase !== 'ok';
      const persist = step.phase !== 'ok' || wasNonOk || target.entityKey === '';
      if (!persist) continue;

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
        detail: stateDetail(target),
      });
    } catch (error) {
      logger.error(`Error handling "${rule.name}"${target.entityKey ? ` [${target.entityKey}]` : ''}`, {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return fired;
}
