/**
 * Pure half of the alert rule form: form values, defaults, the request body, the
 * checks that gate "Save", and the sentence that describes the rule. No React.
 */

import { ENTITY_LATENCY_BUCKET_UPPER_MS } from '@/lib/database/provider/types.base';
import {
  entityTypeLabel,
  formatMetricValue,
  formatMinutes,
  getDef,
  inferModule,
  isEntityMetric,
  metricLabel,
  metricsForModule,
  metricUnit,
  operatorSymbol,
  type AlertCatalog,
  type TFn,
} from './alertCatalog';
import type {
  AlertConditionMode,
  AlertConditionOperator,
  AlertMetricDef,
  AlertRuleDto,
  AlertRuleSeverity,
  EntityMetricType,
} from './alertTypes';
import {
  channelsFromStored,
  libraryRefsFromStored,
  libraryRefToInput,
  channelsToInput,
  newChannelItem,
  validateChannels,
  type ChannelItem,
  type LibraryRef,
} from './channelItems';

/** A NumberInput yields a number, or '' once cleared. */
export type Num = number | string;

export type BaselinePreset = 'sensitive' | 'balanced' | 'calm' | 'custom';
export type ScopeField = 'modelKey' | 'serverKey' | 'guardrailKey' | 'ragModuleKey' | 'mcpServerKey';

export const SCOPE_FIELD_BY_MODULE: Record<string, ScopeField | undefined> = {
  models: 'modelKey',
  inference: 'serverKey',
  guardrails: 'guardrailKey',
  rag: 'ragModuleKey',
  mcp: 'mcpServerKey',
};

export const SCOPE_FIELDS: ScopeField[] = ['modelKey', 'serverKey', 'guardrailKey', 'ragModuleKey', 'mcpServerKey'];

/** Histogram bounds a latency SLO can be measured against (the server rejects any other value). */
export const SLO_LATENCY_BOUNDS_MS: readonly number[] = ENTITY_LATENCY_BUCKET_UPPER_MS;
export const DEFAULT_SLO_LATENCY_MS = 2000;

export const COOLDOWN_MINUTES = [0, 15, 30, 60, 120, 360, 1440];
export const RENOTIFY_MINUTES = [0, 15, 30, 60, 120, 240, 720, 1440];
export const DEFAULT_WINDOWS = [5, 15, 30, 60, 120, 240, 1440];
export const MAX_ENTITY_KEYS = 50;
export const MAX_NAME_LENGTH = 120;

interface BaselineParams {
  minRatio: number;
  minZ: number;
  minDelta: number;
  lookbackDays: number;
  seasonality: 'daily' | 'weekly' | 'trailing';
}

/** Sensitivity of a baseline-relative rule. `balanced` is the server default. */
export const BASELINE_PRESETS: Record<Exclude<BaselinePreset, 'custom'>, BaselineParams> = {
  sensitive: { minRatio: 1.5, minZ: 2, minDelta: 0, lookbackDays: 14, seasonality: 'daily' },
  balanced: { minRatio: 2, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily' },
  calm: { minRatio: 3, minZ: 4, minDelta: 0, lookbackDays: 14, seasonality: 'daily' },
};

export interface RuleFormValues {
  name: string;
  description: string;
  module: string;
  metric: string;
  entityMode: 'all' | 'selected';
  entityKeys: string[];
  modelKey: string;
  serverKey: string;
  guardrailKey: string;
  ragModuleKey: string;
  mcpServerKey: string;
  mode: AlertConditionMode;
  operator: AlertConditionOperator;
  threshold: Num;
  windowMinutes: string;
  forMinutes: Num;
  minSamples: Num;
  baselinePreset: BaselinePreset;
  baselineDirection: 'up' | 'down' | 'both';
  baselineMinRatio: Num;
  baselineMinZ: Num;
  baselineMinDelta: Num;
  baselineLookbackDays: Num;
  baselineSeasonality: 'daily' | 'weekly' | 'trailing';
  absenceLookbackHours: Num;
  absenceMinExpected: Num;
  sloObjectivePct: Num;
  sloWindowDays: Num;
  sloBurnRate: Num;
  sloLongWindow: Num;
  sloShortWindow: Num;
  sloLatencyThresholdMs: string;
  severity: AlertRuleSeverity;
  notifyOnResolve: boolean;
  renotifyMinutes: string;
  cooldownMinutes: string;
  channels: ChannelItem[];
  /** References to tenant channel library entries; they count as channels next to the inline ones. */
  libraryRefs: LibraryRef[];
  /** Optional http(s) link to the runbook of this rule. */
  runbookUrl: string;
  enabled: boolean;
}

export const DEFAULT_MODULE = 'agents';
export const DEFAULT_METRIC = 'agent_error_rate';

/** Rise is the bad direction for a metric whose good direction is "down" (and vice versa). */
export function badDirection(def: AlertMetricDef | undefined): 'up' | 'down' {
  return def?.goodDirection === 'up' ? 'down' : 'up';
}

export function defaultValues(catalog: AlertCatalog): RuleFormValues {
  const def = getDef(catalog, DEFAULT_METRIC);
  return {
    name: '',
    description: '',
    module: DEFAULT_MODULE,
    metric: DEFAULT_METRIC,
    entityMode: 'all',
    entityKeys: [],
    modelKey: '',
    serverKey: '',
    guardrailKey: '',
    ragModuleKey: '',
    mcpServerKey: '',
    mode: 'threshold',
    operator: 'gt',
    threshold: 5,
    windowMinutes: '15',
    forMinutes: 0,
    minSamples: '',
    baselinePreset: 'balanced',
    baselineDirection: badDirection(def),
    baselineMinRatio: BASELINE_PRESETS.balanced.minRatio,
    baselineMinZ: BASELINE_PRESETS.balanced.minZ,
    baselineMinDelta: BASELINE_PRESETS.balanced.minDelta,
    baselineLookbackDays: BASELINE_PRESETS.balanced.lookbackDays,
    baselineSeasonality: BASELINE_PRESETS.balanced.seasonality,
    absenceLookbackHours: 24,
    absenceMinExpected: 1,
    sloObjectivePct: 99,
    sloWindowDays: 30,
    sloBurnRate: 14.4,
    sloLongWindow: 60,
    sloShortWindow: 5,
    sloLatencyThresholdMs: String(DEFAULT_SLO_LATENCY_MS),
    severity: 'auto',
    notifyOnResolve: true,
    renotifyMinutes: '0',
    cooldownMinutes: '60',
    channels: [newChannelItem('email')],
    libraryRefs: [],
    runbookUrl: '',
    enabled: true,
  };
}

function presetOf(baseline: NonNullable<AlertRuleDto['condition']['baseline']>): BaselinePreset {
  for (const [name, preset] of Object.entries(BASELINE_PRESETS) as Array<[Exclude<BaselinePreset, 'custom'>, BaselineParams]>) {
    if (
      preset.minRatio === baseline.minRatio &&
      preset.minZ === baseline.minZ &&
      preset.minDelta === baseline.minDelta &&
      preset.lookbackDays === baseline.lookbackDays &&
      preset.seasonality === baseline.seasonality
    ) {
      return name;
    }
  }
  return 'custom';
}

/**
 * Form values from a stored rule, a deep-link prefill, or nothing. Missing pieces
 * fall back to the defaults, so a partial prefill (`{ module, metric }`) is enough.
 */
export function valuesFromRule(
  initial: Partial<AlertRuleDto> | Record<string, unknown> | undefined | null,
  catalog: AlertCatalog,
): RuleFormValues {
  const base = defaultValues(catalog);
  if (!initial) return base;
  const rule = initial as Partial<AlertRuleDto>;

  const metric = typeof rule.metric === 'string' && rule.metric ? rule.metric : undefined;
  const moduleId = inferModule(catalog, metric, rule.module) ?? DEFAULT_MODULE;
  const resolvedMetric = metric ?? metricsForModule(catalog, moduleId)[0]?.id ?? base.metric;
  const def = getDef(catalog, resolvedMetric);

  const values: RuleFormValues = {
    ...base,
    name: typeof rule.name === 'string' ? rule.name : '',
    description: typeof rule.description === 'string' ? rule.description : '',
    module: metric || rule.module ? moduleId : base.module,
    metric: resolvedMetric,
    enabled: rule.enabled ?? true,
    windowMinutes: String(rule.windowMinutes || 15),
    cooldownMinutes: String(rule.cooldownMinutes ?? 60),
    severity: rule.severity ?? 'auto',
    notifyOnResolve: rule.notifyOnResolve ?? true,
    renotifyMinutes: String(rule.renotifyMinutes ?? 0),
    baselineDirection: badDirection(def),
    sloLatencyThresholdMs: String(DEFAULT_SLO_LATENCY_MS),
  };

  const scope = rule.scope ?? {};
  for (const field of SCOPE_FIELDS) values[field] = scope[field] ?? '';

  if (rule.entity && isEntityMetric(def)) {
    values.entityMode = rule.entity.mode === 'selected' ? 'selected' : 'all';
    values.entityKeys = rule.entity.mode === 'selected' ? [...(rule.entity.keys ?? [])] : [];
  }

  const condition = rule.condition;
  if (condition) {
    values.mode = condition.mode ?? 'threshold';
    values.operator = condition.operator ?? 'gt';
    values.threshold = typeof condition.threshold === 'number' ? condition.threshold : base.threshold;
    values.forMinutes = condition.forMinutes ?? 0;
    values.minSamples = condition.minSamples ?? '';
    if (condition.baseline) {
      values.baselinePreset = presetOf(condition.baseline);
      values.baselineDirection = condition.baseline.direction;
      values.baselineMinRatio = condition.baseline.minRatio;
      values.baselineMinZ = condition.baseline.minZ;
      values.baselineMinDelta = condition.baseline.minDelta;
      values.baselineLookbackDays = condition.baseline.lookbackDays;
      values.baselineSeasonality = condition.baseline.seasonality;
    }
    if (condition.absence) {
      values.absenceLookbackHours = condition.absence.lookbackHours;
      values.absenceMinExpected = condition.absence.minExpectedPerWindow;
    }
    if (condition.slo) {
      values.sloObjectivePct = condition.slo.objectivePct;
      values.sloWindowDays = condition.slo.windowDays;
      values.sloBurnRate = condition.slo.burnRate;
      values.sloLongWindow = condition.slo.longWindowMinutes;
      values.sloShortWindow = condition.slo.shortWindowMinutes;
      if (condition.slo.latencyThresholdMs !== undefined) values.sloLatencyThresholdMs = String(condition.slo.latencyThresholdMs);
    }
  }

  if (Array.isArray(rule.channels)) {
    values.channels = channelsFromStored(rule.channels);
    values.libraryRefs = libraryRefsFromStored(rule.channels);
    // A rule that is only library references starts with no inline channel (not the default email one).
  }
  if (typeof rule.runbookUrl === 'string') values.runbookUrl = rule.runbookUrl;
  return values;
}

export interface PrefillParams {
  module?: string | null;
  metric?: string | null;
  entityType?: string | null;
  entityKey?: string | null;
}

/**
 * Prefill for a new rule from deep-link parameters
 * (`?create=1&module=agents&metric=agent_error_rate&entityType=agent&entityKey=<name>`).
 * Unknown metrics are ignored; an entity is only applied to an entity metric of that type.
 */
export function prefillFromParams(params: PrefillParams, catalog: AlertCatalog): Partial<AlertRuleDto> {
  const metric = params.metric && getDef(catalog, params.metric) ? params.metric : undefined;
  const def = getDef(catalog, metric);
  const prefill: Partial<AlertRuleDto> = {};
  if (metric) {
    prefill.metric = metric;
    prefill.module = inferModule(catalog, metric, params.module);
  } else if (params.module) {
    prefill.module = inferModule(catalog, undefined, params.module);
  }
  const entityKey = params.entityKey?.trim();
  if (entityKey && isEntityMetric(def) && def?.entityType && (!params.entityType || params.entityType === def.entityType)) {
    prefill.entity = { entityType: def.entityType, mode: 'selected', keys: [entityKey.slice(0, 200)] };
  }
  return prefill;
}

/**
 * Seed of the create form for a copy of a rule. A stored channel's secret cannot be read back, so only email channels
 * (plain recipients) and library references (no secret of their own) carry over; `droppedChannels` counts the ones
 * that did not.
 */
export function duplicateRuleSeed(rule: AlertRuleDto, name: string): { seed: Partial<AlertRuleDto>; droppedChannels: number } {
  // Email channels (plain recipients) and library references carry over; inline secrets cannot be read back.
  const channels = (rule.channels ?? [])
    .filter((channel) => channel.type === 'email' || (channel.type === 'library' && channel.libraryId))
    .map((channel) =>
      channel.type === 'library'
        ? { type: channel.type, libraryId: channel.libraryId }
        : {
            type: channel.type,
            recipients: [...(channel.recipients ?? [])],
            ...(channel.audience === 'project_admins' ? { audience: channel.audience } : {}),
          },
    );
  return {
    seed: {
      name,
      description: rule.description,
      module: rule.module,
      metric: rule.metric,
      condition: rule.condition,
      windowMinutes: rule.windowMinutes,
      cooldownMinutes: rule.cooldownMinutes,
      scope: rule.scope,
      entity: rule.entity,
      severity: rule.severity,
      notifyOnResolve: rule.notifyOnResolve,
      renotifyMinutes: rule.renotifyMinutes,
      enabled: rule.enabled,
      runbookUrl: rule.runbookUrl,
      channels,
    },
    droppedChannels: (rule.channels ?? []).length - channels.length,
  };
}

/** Values after the metric changed: keep what still applies, reset what no longer does. */
export function applyMetricChange(values: RuleFormValues, metric: string, catalog: AlertCatalog): RuleFormValues {
  const def = getDef(catalog, metric);
  const next: RuleFormValues = { ...values, metric };
  if (def && !def.modes.includes(values.mode)) next.mode = 'threshold';
  if (!isEntityMetric(def)) {
    next.entityMode = 'all';
    next.entityKeys = [];
  }
  next.baselineDirection = badDirection(def);
  return next;
}

/** Values after the module changed: first offered metric, target cleared. */
export function applyModuleChange(values: RuleFormValues, module: string, catalog: AlertCatalog): RuleFormValues {
  const first = metricsForModule(catalog, module)[0]?.id ?? values.metric;
  const next = applyMetricChange({ ...values, module }, first, catalog);
  next.entityMode = 'all';
  next.entityKeys = [];
  for (const field of SCOPE_FIELDS) next[field] = '';
  return next;
}

export function applyBaselinePreset(values: RuleFormValues, preset: BaselinePreset): RuleFormValues {
  if (preset === 'custom') return { ...values, baselinePreset: 'custom' };
  const params = BASELINE_PRESETS[preset];
  return {
    ...values,
    baselinePreset: preset,
    baselineMinRatio: params.minRatio,
    baselineMinZ: params.minZ,
    baselineMinDelta: params.minDelta,
    baselineLookbackDays: params.lookbackDays,
    baselineSeasonality: params.seasonality,
  };
}

// ── Request body ────────────────────────────────────────────────────────────

function toNumber(value: Num, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = Number(value);
  return value.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
}

function isBlank(value: Num): boolean {
  return value === '' || (typeof value === 'string' && value.trim() === '') || (typeof value === 'number' && !Number.isFinite(value));
}

export interface PayloadOptions {
  catalog: AlertCatalog;
  /** An edit clears what is empty (the server keeps what is left out). */
  isEdit: boolean;
  /** A preview needs neither a name nor channels. */
  preview?: boolean;
  /** An edit that left the channel list as it was. A stored rule with no channels (a legacy row) then saves without one. */
  channelsUnchanged?: boolean;
}

/** The form's cooldown as the server reads it (`cooldownMinutes`). */
function cooldownMinutesOf(values: Pick<RuleFormValues, 'cooldownMinutes'>): number {
  return Number.parseInt(values.cooldownMinutes, 10) || 0;
}

export function buildRulePayload(values: RuleFormValues, options: PayloadOptions): Record<string, unknown> {
  const { catalog, isEdit, preview, channelsUnchanged } = options;
  const def = getDef(catalog, values.metric);
  const entityRule = isEntityMetric(def);
  const mode = values.mode;

  const condition: Record<string, unknown> = {
    mode,
    forMinutes: Math.trunc(toNumber(values.forMinutes, 0)),
  };
  if (!isBlank(values.minSamples)) condition.minSamples = Math.trunc(toNumber(values.minSamples, 1));
  if (mode === 'threshold') {
    condition.operator = values.operator;
    condition.threshold = toNumber(values.threshold, 0);
  }
  if (mode === 'baseline') {
    condition.baseline = {
      direction: values.baselineDirection,
      minRatio: toNumber(values.baselineMinRatio, 2),
      minZ: toNumber(values.baselineMinZ, 3),
      minDelta: toNumber(values.baselineMinDelta, 0),
      lookbackDays: Math.trunc(toNumber(values.baselineLookbackDays, 14)),
      seasonality: values.baselineSeasonality,
    };
  }
  if (mode === 'absence') {
    condition.absence = {
      lookbackHours: Math.trunc(toNumber(values.absenceLookbackHours, 24)),
      minExpectedPerWindow: toNumber(values.absenceMinExpected, 1),
    };
  }
  if (mode === 'slo_burn') {
    condition.slo = {
      objectivePct: toNumber(values.sloObjectivePct, 99),
      windowDays: Math.trunc(toNumber(values.sloWindowDays, 30)),
      burnRate: toNumber(values.sloBurnRate, 14.4),
      longWindowMinutes: Math.trunc(toNumber(values.sloLongWindow, 60)),
      shortWindowMinutes: Math.trunc(toNumber(values.sloShortWindow, 5)),
      ...(values.metric.includes('_p95_') ? { latencyThresholdMs: Number(values.sloLatencyThresholdMs) } : {}),
    };
  }

  const body: Record<string, unknown> = {
    module: values.module,
    metric: values.metric,
    condition,
    windowMinutes: Number.parseInt(values.windowMinutes, 10),
  };

  // Target. Entity metrics carry an entity scope; legacy ones a per-service scope.
  if (entityRule && def?.entityType) {
    body.entity =
      values.entityMode === 'selected'
        ? { entityType: def.entityType, mode: 'selected', keys: values.entityKeys }
        : { entityType: def.entityType, mode: 'all' };
    if (isEdit) body.scope = {};
  } else {
    const field = SCOPE_FIELD_BY_MODULE[values.module];
    const scope: Record<string, string> = {};
    if (field && values[field].trim()) scope[field] = values[field].trim();
    if (isEdit) {
      body.scope = scope;
      body.entity = null;
    } else if (Object.keys(scope).length > 0) {
      body.scope = scope;
    }
  }

  if (preview) return body;

  body.name = values.name.trim();
  const description = values.description.trim();
  // An edit sends '' to clear a stored description.
  if (description || isEdit) body.description = description;
  body.severity = values.severity;
  body.notifyOnResolve = values.notifyOnResolve;
  body.renotifyMinutes = Number.parseInt(values.renotifyMinutes, 10) || 0;
  body.cooldownMinutes = cooldownMinutesOf(values);
  body.enabled = values.enabled;
  const runbookUrl = values.runbookUrl.trim();
  // An edit sends '' to clear a stored runbook link.
  if (runbookUrl || isEdit) body.runbookUrl = runbookUrl;
  if (!(isEdit && channelsUnchanged && values.channels.length === 0 && values.libraryRefs.length === 0)) {
    body.channels = [...channelsToInput(values.channels), ...values.libraryRefs.map(libraryRefToInput)];
  }
  return body;
}

// ── Checks ──────────────────────────────────────────────────────────────────

export interface RuleChecks {
  name: boolean;
  metric: boolean;
  target: boolean;
  condition: boolean;
  channels: boolean;
  /** i18n key (under `alerts.`) of the first condition problem, if any. */
  conditionIssue: string | null;
  canSave: boolean;
}

/** A stable fingerprint of a channel list as it would be sent, to tell whether an edit touched it. */
export function channelsSignature(channels: ChannelItem[], libraryRefs: LibraryRef[] = []): string {
  return JSON.stringify([...channelsToInput(channels), ...libraryRefs.map(libraryRefToInput)]);
}

export function checkRule(values: RuleFormValues, catalog: AlertCatalog, options: { channelsUnchanged?: boolean } = {}): RuleChecks {
  const def = getDef(catalog, values.metric);
  const name = Boolean(values.name.trim()) && values.name.trim().length <= MAX_NAME_LENGTH;
  const metric = Boolean(def) && metricsForModule(catalog, values.module, values.metric).some((entry) => entry.id === values.metric);
  const target =
    !isEntityMetric(def) || values.entityMode === 'all' || (values.entityKeys.length >= 1 && values.entityKeys.length <= MAX_ENTITY_KEYS);

  let conditionIssue: string | null = null;
  const finite = (value: Num) => !isBlank(value) && Number.isFinite(toNumber(value, Number.NaN));
  if (!def?.modes.includes(values.mode)) conditionIssue = 'validation.modeUnsupported';
  else if (values.mode === 'threshold') {
    if (!finite(values.threshold)) conditionIssue = 'validation.thresholdRequired';
  } else if (values.mode === 'baseline') {
    const days = toNumber(values.baselineLookbackDays, 0);
    if (!finite(values.baselineMinRatio) || toNumber(values.baselineMinRatio) < 1 || toNumber(values.baselineMinRatio) > 20) conditionIssue = 'validation.baselineRatio';
    else if (!finite(values.baselineMinZ) || toNumber(values.baselineMinZ) < 0 || toNumber(values.baselineMinZ) > 20) conditionIssue = 'validation.baselineZ';
    else if (!finite(values.baselineMinDelta) || toNumber(values.baselineMinDelta) < 0) conditionIssue = 'validation.baselineDelta';
    else if (days < 3 || days > 45) conditionIssue = 'validation.baselineLookback';
    else if (values.baselineSeasonality === 'weekly' && days < 21) conditionIssue = 'validation.baselineWeekly';
  } else if (values.mode === 'absence') {
    const hours = toNumber(values.absenceLookbackHours, 0);
    if (hours < 1 || hours > 168) conditionIssue = 'validation.absenceHours';
    else if (!finite(values.absenceMinExpected) || toNumber(values.absenceMinExpected) <= 0) conditionIssue = 'validation.absenceExpected';
  } else if (values.mode === 'slo_burn') {
    const objective = toNumber(values.sloObjectivePct, 0);
    const days = toNumber(values.sloWindowDays, 0);
    const burn = toNumber(values.sloBurnRate, 0);
    const long = toNumber(values.sloLongWindow, 0);
    const short = toNumber(values.sloShortWindow, 0);
    if (objective < 50 || objective > 99.999) conditionIssue = 'validation.sloObjective';
    else if (days < 1 || days > 45) conditionIssue = 'validation.sloWindowDays';
    else if (burn < 1 || burn > 100) conditionIssue = 'validation.sloBurn';
    else if (short < 1 || long <= short || long > days * 1440) conditionIssue = 'validation.sloWindows';
    else if (values.metric.includes('_p95_') && !SLO_LATENCY_BOUNDS_MS.includes(Number(values.sloLatencyThresholdMs))) {
      conditionIssue = 'validation.sloLatency';
    }
  }
  if (conditionIssue === null) {
    const forMinutes = toNumber(values.forMinutes, 0);
    if (forMinutes < 0 || forMinutes > 1440) conditionIssue = 'validation.forMinutes';
    else if (!isBlank(values.minSamples) && toNumber(values.minSamples, 0) < 1) conditionIssue = 'validation.minSamples';
  }
  const condition = conditionIssue === null;

  // A stored rule saved without touching its channels keeps them (a legacy row may have none: renaming it must still work).
  const channels =
    options.channelsUnchanged === true ||
    (values.channels.length + values.libraryRefs.length >= 1 &&
      values.channels.length + values.libraryRefs.length <= 10 &&
      validateChannels(values.channels) === null);

  return { name, metric, target, condition, channels, conditionIssue, canSave: name && metric && target && condition && channels };
}

// ── Description ─────────────────────────────────────────────────────────────

function describeTarget(values: RuleFormValues, catalog: AlertCatalog, t: TFn): string {
  const def = getDef(catalog, values.metric);
  if (isEntityMetric(def) && def?.entityType) {
    if (values.entityMode === 'selected' && values.entityKeys.length > 0) {
      const [first, second] = values.entityKeys;
      return values.entityKeys.length <= 2
        ? values.entityKeys.join(', ')
        : t('target.selectedMore', { first, second, count: values.entityKeys.length - 2 });
    }
    return t('target.all', { type: entityTypeLabel(def.entityType as EntityMetricType, t, true) });
  }
  const field = SCOPE_FIELD_BY_MODULE[values.module];
  const key = field ? values[field].trim() : '';
  return key ? t(`target.scope.${field}`, { value: key }) : t('target.project');
}

/** "Alert when the error rate of Pulse Main is 2× above its 14-day normal for 10 min → Slack, Email." */
export function describeRule(values: RuleFormValues, catalog: AlertCatalog, t: TFn, locale?: string): string {
  const metric = metricLabel(catalog, values.metric, t);
  const target = describeTarget(values, catalog, t);
  const window = formatMinutes(Number.parseInt(values.windowMinutes, 10) || 15, t);
  const forMinutes = Math.trunc(toNumber(values.forMinutes, 0));
  const duration = forMinutes > 0 ? t('summary.forDuration', { duration: formatMinutes(forMinutes, t) }) : '';

  let sentence: string;
  switch (values.mode) {
    case 'baseline': {
      const key = values.baselineDirection === 'down' ? 'summary.baselineDown' : values.baselineDirection === 'both' ? 'summary.baselineBoth' : 'summary.baselineUp';
      sentence = t(key, { metric, target, ratio: toNumber(values.baselineMinRatio, 2), days: toNumber(values.baselineLookbackDays, 14), window, duration });
      break;
    }
    case 'absence':
      sentence = t('summary.absence', { target, window, hours: toNumber(values.absenceLookbackHours, 24), duration });
      break;
    case 'slo_burn':
      sentence = t('summary.sloBurn', {
        metric,
        target,
        objective: toNumber(values.sloObjectivePct, 99),
        burn: toNumber(values.sloBurnRate, 14.4),
        window,
        duration,
      });
      break;
    default:
      sentence = t('summary.threshold', {
        metric,
        target,
        operator: operatorSymbol(values.operator),
        value: formatMetricValue(toNumber(values.threshold, 0), metricUnit(catalog, values.metric), locale),
        window,
        duration,
      });
  }

  if (values.channels.length === 0 && values.libraryRefs.length === 0) return sentence;
  const kinds = values.channels.map((channel) => t(`channelTypes.${channel.type}`));
  if (values.libraryRefs.length > 0) kinds.push(t('channels.libraryKind'));
  const channels = [...new Set(kinds)].join(', ');
  return `${sentence} ${t('summary.notify', { channels })}`;
}

// ── Backtest ────────────────────────────────────────────────────────────────

/**
 * Body of `POST /alerts/rules/backtest` for the current form (the preview shape, so it needs no name or channels).
 * The replay also needs the cooldown (the least time between two firings of one target): the server assumes 60
 * minutes when none is sent. The live preview does not use it, so it stays out of the preview shape.
 */
export function buildBacktestBody(values: RuleFormValues, options: { catalog: AlertCatalog; isEdit: boolean }, days = 7): Record<string, unknown> {
  const rule = buildRulePayload(values, { ...options, preview: true });
  return { rule: { ...rule, cooldownMinutes: cooldownMinutesOf(values) }, days };
}

/** "Apply" on a backtest suggestion: the threshold it proposes. Nothing is saved until the rule is. */
export function applyBacktestSuggestion(values: RuleFormValues, suggestion: { threshold: number }): RuleFormValues {
  return { ...values, mode: 'threshold', threshold: suggestion.threshold };
}

/** Client-side mirror of the server's runbook rule: http(s) only, no whitespace or control characters, <= 2048. */
export function isValidRunbookUrl(value: string): boolean {
  const url = value.trim();
  if (!url) return true;
  if (url.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}
