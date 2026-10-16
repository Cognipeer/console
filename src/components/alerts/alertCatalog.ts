/**
 * Client view of the alert metric catalog. Pure (no React, no fetch): every alerts
 * screen derives metric labels, units, modules and operator symbols from here.
 *
 * The catalog itself is the server's single source of truth: `GET /alerts/rules`
 * serves it as `meta.catalog` and a screen that has the response builds its catalog
 * from that. Screens that never call the rules endpoint (incident detail, history,
 * the overview card) start from the same list bundled with the build
 * (`DEFAULT_ALERT_CATALOG`: `metricCatalog.ts` only imports types, so it is safe in
 * a client bundle), so a metric is never shown as a raw id.
 */

import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';
import type {
  AlertConditionDto,
  AlertConditionMode,
  AlertMetricDef,
  AlertModule,
  AlertRuleDto,
  EntityMetricType,
} from './alertTypes';

export type TFn = (key: string, values?: Record<string, string | number | undefined | null>) => string;

export interface AlertCatalog {
  metrics: AlertMetricDef[];
  byId: Map<string, AlertMetricDef>;
}

export function createAlertCatalog(defs?: AlertMetricDef[] | null): AlertCatalog {
  const metrics = defs && defs.length > 0 ? defs : ALERT_METRIC_CATALOG;
  return { metrics, byId: new Map(metrics.map((def) => [def.id as string, def])) };
}

export const DEFAULT_ALERT_CATALOG: AlertCatalog = createAlertCatalog(ALERT_METRIC_CATALOG);

// ── Modules ─────────────────────────────────────────────────────────────────

/** Display order. `aegis` is the retired spelling of guardrails and never listed. */
export const MODULE_ORDER: AlertModule[] = [
  'agents',
  'models',
  'rag',
  'mcp',
  'tools',
  'guardrails',
  'inference',
  'evaluation',
  'analysis',
  'redteam',
  'ai-app-gateway',
];

export const MODULE_COLORS: Record<string, string> = {
  agents: 'violet',
  models: 'blue',
  rag: 'indigo',
  mcp: 'cyan',
  tools: 'orange',
  guardrails: 'grape',
  inference: 'teal',
  evaluation: 'green',
  analysis: 'lime',
  redteam: 'red',
  'ai-app-gateway': 'indigo',
};

/** A rule filed under a retired module keeps firing; it is displayed under its successor. */
const LEGACY_MODULE_ALIASES: Record<string, AlertModule> = { aegis: 'guardrails' };

/** Modules whose rules can only be authored by the enterprise build. */
export const ENTERPRISE_MODULES: AlertModule[] = ['ai-app-gateway'];

const METRIC_PREFIX_MODULES: Array<[string, AlertModule]> = [
  ['agent_', 'agents'],
  ['model_', 'models'],
  ['kb_', 'rag'],
  ['mcp_server_', 'mcp'],
  ['tool_', 'tools'],
  ['guardrail_', 'guardrails'],
  ['aegis_', 'guardrails'],
  ['rag_', 'rag'],
  ['mcp_', 'mcp'],
  ['evaluation_', 'evaluation'],
  ['analysis_', 'analysis'],
  ['redteam_', 'redteam'],
  ['appgw_', 'ai-app-gateway'],
];

export function normalizeModule(module: string | undefined | null): AlertModule | undefined {
  if (!module) return undefined;
  return LEGACY_MODULE_ALIASES[module] ?? (module as AlertModule);
}

/**
 * The module of a rule, incident or event. A stored module wins; otherwise the
 * catalog entry of the metric; otherwise a prefix guess for ids the catalog does
 * not know (a newer server than this bundle), defaulting to `models`.
 */
export function inferModule(
  catalog: AlertCatalog,
  metric: string | undefined | null,
  storedModule?: string | null,
): AlertModule {
  const stored = normalizeModule(storedModule);
  if (stored) return stored;
  if (!metric) return 'models';
  const def = catalog.byId.get(metric);
  if (def) return normalizeModule(def.module) ?? 'models';
  for (const [prefix, module] of METRIC_PREFIX_MODULES) {
    if (metric.startsWith(prefix)) return module;
  }
  return 'models';
}

export function moduleLabel(module: string | undefined | null, t: TFn): string {
  const normalized = normalizeModule(module);
  if (!normalized) return '—';
  return lookup(t, `modules.${normalized}`) ?? normalized;
}

export function moduleColor(module: string | undefined | null): string {
  const normalized = normalizeModule(module);
  return (normalized && MODULE_COLORS[normalized]) || 'gray';
}

/** Modules a rule can be authored under, in display order, from the server's `validModules` (or the catalog). */
export function authorableModules(catalog: AlertCatalog, validModules?: string[] | null): AlertModule[] {
  const allowed = new Set<string>(validModules && validModules.length > 0 ? validModules : catalog.metrics.map((def) => def.module));
  const listed = MODULE_ORDER.filter((module) => allowed.has(module));
  const extra = [...allowed].filter((module) => !MODULE_ORDER.includes(module as AlertModule) && !LEGACY_MODULE_ALIASES[module]);
  return [...listed, ...(extra as AlertModule[])];
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export function getDef(catalog: AlertCatalog, metric: string | undefined | null): AlertMetricDef | undefined {
  return metric ? catalog.byId.get(metric) : undefined;
}

/**
 * Metrics offered for a module. Legacy duplicates (`hiddenForNewRules`) are left
 * out unless `keep` names the one a rule being edited already uses.
 */
export function metricsForModule(catalog: AlertCatalog, module: string, keep?: string | null): AlertMetricDef[] {
  const normalized = normalizeModule(module);
  return catalog.metrics.filter(
    (def) => normalizeModule(def.module) === normalized && (!def.hiddenForNewRules || def.id === keep),
  );
}

/** Translated metric label: `alerts.metrics.<id>`, then the catalog's English label, then the raw id. */
export function metricLabel(catalog: AlertCatalog, metric: string | undefined | null, t: TFn): string {
  if (!metric) return '—';
  return lookup(t, `metrics.${metric}`) ?? catalog.byId.get(metric)?.label ?? metric;
}

export function metricUnit(catalog: AlertCatalog, metric: string | undefined | null): AlertMetricDef['unit'] {
  return (metric && catalog.byId.get(metric)?.unit) || '';
}

export function isEntityMetric(def: AlertMetricDef | undefined | null): boolean {
  return Boolean(def && def.source === 'entity' && def.entityType);
}

export function isEnterpriseMetric(def: AlertMetricDef | undefined | null): boolean {
  return Boolean(def && ENTERPRISE_MODULES.includes(def.module));
}

// ── Operators, values ───────────────────────────────────────────────────────

export const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  eq: '=',
};

export const OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const;

export function operatorSymbol(operator: string | undefined | null): string {
  return (operator && OPERATOR_SYMBOLS[operator]) || '>';
}

/** A metric value with its unit: `12.34%`, `1,250 ms`, `$0.0412`, `42`. */
export function formatMetricValue(
  value: number | null | undefined,
  unit: string | undefined | null,
  locale?: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const digits = (max: number, min = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: max, minimumFractionDigits: min }).format(value);
  switch (unit) {
    case '%':
      return `${digits(2)}%`;
    case 'ms':
      return `${digits(0)} ms`;
    case '$':
      return `$${Math.abs(value) < 1 ? digits(4, 2) : digits(2, 2)}`;
    case 'score':
      return digits(2);
    default:
      return Math.abs(value) >= 100 ? digits(0) : digits(2);
  }
}

export function formatMinutes(minutes: number, t: TFn): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return t('duration.days', { count: minutes / 1440 });
  if (minutes >= 60 && minutes % 60 === 0) return t('duration.hours', { count: minutes / 60 });
  return t('duration.minutes', { count: minutes });
}

/** Elapsed time between two instants (open-ended → now) as a short `2h 5m` style string. */
export function formatDurationBetween(fromIso: string | null | undefined, toIso?: string | null, now = Date.now()): string {
  if (!fromIso) return '—';
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return '—';
  const toParsed = toIso ? Date.parse(toIso) : now;
  const to = Number.isNaN(toParsed) ? now : toParsed;
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

// ── Entities, targets, conditions ───────────────────────────────────────────

export const ENTITY_TYPES: EntityMetricType[] = ['agent', 'model', 'kb', 'mcp', 'tool'];

export function entityTypeLabel(entityType: string | undefined | null, t: TFn, plural = false): string {
  if (!entityType) return '—';
  return lookup(t, `${plural ? 'entityTypesPlural' : 'entityTypes'}.${entityType}`) ?? entityType;
}

/** Where an entity's own health page lives (only agents have one in the core build). */
export function entityHref(entityType: string | undefined | null, entityKey: string | undefined | null): string | null {
  if (!entityKey) return null;
  if (entityType === 'agent') return `/dashboard/tracing/agents/${encodeURIComponent(entityKey)}`;
  return null;
}

/** The entity an incident or event is about: top-level fields, then the legacy `metadata.scope`. */
export function entityOf(row: {
  entityType?: string | null;
  entityKey?: string | null;
  metadata?: Record<string, unknown>;
}): { type: string | null; key: string } | null {
  if (row.entityKey) return { type: row.entityType ?? null, key: row.entityKey };
  const scope = row.metadata?.scope as Record<string, string> | undefined;
  if (!scope) return null;
  const key = scope.modelKey ?? scope.serverKey ?? scope.guardrailKey ?? scope.ragModuleKey ?? scope.mcpServerKey;
  if (!key) return null;
  const type = scope.modelKey ? 'model' : scope.ragModuleKey ? 'kb' : scope.mcpServerKey ? 'mcp' : null;
  return { type, key };
}

export interface TargetSummary {
  kind: 'all' | 'selected' | 'scope' | 'project';
  label: string;
  keys: string[];
}

const SCOPE_KEYS = ['modelKey', 'serverKey', 'guardrailKey', 'ragModuleKey', 'mcpServerKey'] as const;

export function summarizeTarget(rule: Pick<AlertRuleDto, 'entity' | 'scope'>, t: TFn): TargetSummary {
  const entity = rule.entity;
  if (entity) {
    if (entity.mode === 'selected' && entity.keys && entity.keys.length > 0) {
      const [first, second] = entity.keys;
      const rest = entity.keys.length - 2;
      const label = entity.keys.length <= 2
        ? entity.keys.join(', ')
        : t('target.selectedMore', { first, second, count: rest });
      return { kind: 'selected', label, keys: entity.keys };
    }
    return { kind: 'all', label: t('target.all', { type: entityTypeLabel(entity.entityType, t, true) }), keys: [] };
  }
  const scope = rule.scope ?? {};
  const parts = SCOPE_KEYS.filter((key) => scope[key]).map((key) => t(`target.scope.${key}`, { value: scope[key] }));
  if (parts.length > 0) return { kind: 'scope', label: parts.join(', '), keys: [] };
  return { kind: 'project', label: t('target.project'), keys: [] };
}

export function conditionMode(condition: Pick<AlertConditionDto, 'mode'> | undefined | null): AlertConditionMode {
  return condition?.mode ?? 'threshold';
}

export const MODE_COLORS: Record<AlertConditionMode, string> = {
  threshold: 'dark',
  baseline: 'violet',
  absence: 'orange',
  slo_burn: 'red',
};

/** One-line description of a rule's condition for a list row. */
export function summarizeCondition(
  rule: Pick<AlertRuleDto, 'condition' | 'metric' | 'windowMinutes'>,
  catalog: AlertCatalog,
  t: TFn,
  locale?: string,
): string {
  const condition = rule.condition;
  const mode = conditionMode(condition);
  const window = formatMinutes(rule.windowMinutes, t);
  switch (mode) {
    case 'baseline': {
      const baseline = condition.baseline;
      const key = baseline?.direction === 'down' ? 'condition.baselineDown' : baseline?.direction === 'both' ? 'condition.baselineBoth' : 'condition.baselineUp';
      return `${t(key, { ratio: baseline?.minRatio ?? 2, days: baseline?.lookbackDays ?? 14 })} · ${window}`;
    }
    case 'absence':
      return `${t('condition.absence', { hours: condition.absence?.lookbackHours ?? 24 })} · ${window}`;
    case 'slo_burn':
      return `${t('condition.sloBurn', { burn: condition.slo?.burnRate ?? 14.4, objective: condition.slo?.objectivePct ?? 99 })} · ${window}`;
    default:
      return `${operatorSymbol(condition?.operator)} ${formatMetricValue(condition?.threshold, metricUnit(catalog, rule.metric), locale)} · ${window}`;
  }
}

export type RuleStateView =
  | { kind: 'paused' }
  | { kind: 'blocked'; reason?: string }
  | { kind: 'counts'; firing: number; pending: number; ok: number };

/**
 * What the rules list shows in a rule's state cell. A rule whose condition type is unavailable
 * (no enterprise build, lapsed licence) is not evaluated at all, so it must not read as "OK".
 * The server keeps that marker out of the per-rule state counts, hence the mode availability here.
 */
export function ruleStateView(
  rule: Pick<AlertRuleDto, 'enabled' | 'condition'>,
  counts: { firing: number; pending: number; ok: number } | undefined,
  modes: Partial<Record<AlertConditionMode, { available: boolean; reason?: string }>> | undefined,
): RuleStateView {
  if (!rule.enabled) return { kind: 'paused' };
  const availability = modes?.[conditionMode(rule.condition)];
  if (availability && availability.available === false) return { kind: 'blocked', reason: availability.reason };
  return { kind: 'counts', firing: counts?.firing ?? 0, pending: counts?.pending ?? 0, ok: counts?.ok ?? 0 };
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * `t` prints the dotted key (namespace included) for a missing message; a key that
 * resolves is a translation. Returns undefined for the missing case so callers can
 * fall back to a catalog label.
 */
function lookup(t: TFn, key: string): string | undefined {
  const value = t(key);
  if (!value || value === key || value.endsWith(`.${key}`)) return undefined;
  return value;
}
