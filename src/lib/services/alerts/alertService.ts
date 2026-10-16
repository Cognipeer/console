/**
 * Alert service — CRUD operations for alert rules and event history.
 *
 * All operations are tenant-scoped and project-aware. Every rule write goes
 * through ONE validator (`validateRuleInput`) for create, update and preview.
 * Caller mistakes are thrown as `AlertApiError` (400/402/404/409) so the API
 * never answers 500 for them. Channel credentials are sealed on write and
 * masked on every read: nothing this service returns carries a secret.
 */

import { getDatabase, getTenantDatabase } from '@/lib/database';
import { getConfig } from '@/lib/core/config';
import type {
  AlertChannelInput,
  AlertConditionMode,
  AlertConditionOperator,
  AlertEventStatus,
  AlertMetric,
  AlertModule,
  AlertRuleSeverity,
  EntityMetricType,
  IAlertBaselineConfig,
  IAlertChannel,
  IAlertCondition,
  IAlertEvent,
  IAlertRule,
  IAlertRuleEntityScope,
  IAlertSloConfig,
  IAlertState,
  IAlertDelivery,
} from '@/lib/database';
import { ENTITY_LATENCY_BUCKET_UPPER_MS } from '@/lib/database/provider/types.base';
import { listActiveEntityKeys } from '@/lib/services/entityMetrics/entityHealthService';
import { AlertApiError } from './alertApiError';
import { ALERT_METRIC_CATALOG, ALERT_MODULE_METRICS, getMetricDef } from './metricCatalog';
import { createModeGate, getModeAvailability } from './modeAvailability';
import { IncidentService } from './incidentService';
import { evaluationShapeOf } from './ruleShape';
import { evaluateRuleTargets } from './alertEvaluator';
import {
  applyRuleListQuery,
  buildNoiseStats,
  buildRuleKpis,
  deriveRule,
  type RuleDerived,
  type RuleListKpis,
  type RuleListQuery,
  type RuleNoiseStats,
} from './ruleInsights';
import { maskChannels, sealChannels } from './channels/channelSecrets';
import { assertPublicChannelUrl, ChannelUrlError, isValidPagerDutyRoutingKey, MAX_CHANNEL_URL_LENGTH } from './channels/channelUrl';
import { dispatchNotification } from './channels';
import type { AlertNotification, DispatchResult } from './channels';

export { AlertApiError } from './alertApiError';

/** Module-to-metrics mapping (derived from the metric catalog). */
const MODULE_METRICS: Record<AlertModule, AlertMetric[]> = ALERT_MODULE_METRICS;

/**
 * Supported metric names for validation. De-duplicated because `guardrails`
 * and the retired `aegis` alias share one array.
 */
const VALID_METRICS: AlertMetric[] = [...new Set(Object.values(MODULE_METRICS).flat())];

/**
 * Modules a NEW rule can target. `aegis` is deliberately absent: it is the
 * retired spelling of `guardrails`, kept in MODULE_METRICS only so stored rules
 * still resolve.
 */
const VALID_MODULES: AlertModule[] = [
  'models', 'inference', 'guardrails', 'rag', 'mcp', 'analysis', 'evaluation', 'redteam',
  'ai-app-gateway', 'agents', 'tools',
];

/** Supported window durations (minutes) */
const VALID_WINDOWS = [5, 15, 30, 60, 120, 240, 1440];

export const ALERT_CHANNEL_TYPES = ['email', 'webhook', 'slack', 'teams', 'pagerduty'] as const;

const VALID_OPERATORS: AlertConditionOperator[] = ['gt', 'lt', 'gte', 'lte', 'eq'];
const VALID_MODES: AlertConditionMode[] = ['threshold', 'baseline', 'absence', 'slo_burn'];
const VALID_SEVERITIES: AlertRuleSeverity[] = ['auto', 'info', 'warning', 'critical'];
const ENTITY_TYPES: EntityMetricType[] = ['agent', 'model', 'tool', 'mcp', 'kb'];
const SCOPE_KEYS = ['modelKey', 'serverKey', 'guardrailKey', 'ragModuleKey', 'mcpServerKey'] as const;

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SCOPE_VALUE_LENGTH = 200;
const MAX_ENTITY_KEYS = 50;
const MAX_ENTITY_KEY_LENGTH = 200;
const MAX_CHANNELS = 10;
const MAX_EMAIL_RECIPIENTS = 50;
const MAX_SECRET_LENGTH = 512;
const MAX_COOLDOWN_MINUTES = 10_080;
const CHANNEL_ID_PATTERN = /^ch_[0-9a-f]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENTITY_LOOKBACK_MS = 30 * 86_400_000;
const PREVIEW_MAX_TARGETS = 50;

export interface CreateAlertRuleInput {
  name: string;
  description?: string;
  module: AlertModule;
  metric: AlertMetric;
  condition: IAlertCondition;
  windowMinutes: number;
  cooldownMinutes?: number;
  scope?: { modelKey?: string; serverKey?: string; guardrailKey?: string; ragModuleKey?: string; mcpServerKey?: string };
  entity?: IAlertRuleEntityScope | null;
  severity?: AlertRuleSeverity | null;
  notifyOnResolve?: boolean;
  renotifyMinutes?: number | null;
  /** http(s) runbook link; null or '' clears. */
  runbookUrl?: string | null;
  /** Plaintext on write; omit a channel's secret fields to keep the stored ones for that channel id. */
  channels?: AlertChannelInput[] | IAlertChannel[];
  enabled?: boolean;
}

export type UpdateAlertRuleInput = Partial<CreateAlertRuleInput> & { updatedBy?: string };

/** What a rule looks like once validated and normalised (channels excluded: they are sealed separately). */
export interface ValidatedRule {
  name: string;
  description: string;
  module: AlertModule;
  metric: AlertMetric;
  condition: IAlertCondition;
  windowMinutes: number;
  cooldownMinutes: number;
  scope: NonNullable<IAlertRule['scope']>;
  entity: IAlertRuleEntityScope | null;
  severity: AlertRuleSeverity;
  notifyOnResolve: boolean;
  renotifyMinutes: number;
  /** null = none. */
  runbookUrl: string | null;
  enabled: boolean;
  /** Normalised channel input; undefined = keep the stored channels (update only). */
  channels?: AlertChannelInput[];
}

export interface ValidateRuleOptions {
  /** 'preview' needs no name or channels. */
  mode: 'create' | 'update' | 'preview';
  existing?: IAlertRule | null;
}

function bad(code: string, message: string): AlertApiError {
  return new AlertApiError(400, code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('invalid_number', `${field} must be a finite number`);
  return value;
}

function integerInRange(value: unknown, field: string, min: number, max: number): number {
  const n = finiteNumber(value, field);
  if (!Number.isInteger(n) || n < min || n > max) throw bad('out_of_range', `${field} must be an integer between ${min} and ${max}`);
  return n;
}

function numberInRange(value: unknown, field: string, min: number, max: number): number {
  const n = finiteNumber(value, field);
  if (n < min || n > max) throw bad('out_of_range', `${field} must be between ${min} and ${max}`);
  return n;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw bad('invalid_value', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function has(input: Record<string, unknown>, key: string): boolean {
  return input[key] !== undefined;
}

// ── Condition ───────────────────────────────────────────────────────────────

const DEFAULT_BASELINE: IAlertBaselineConfig = {
  direction: 'up', minRatio: 2, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily',
};

const DEFAULT_SLO: Omit<IAlertSloConfig, 'latencyThresholdMs'> = {
  objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5,
};

function normalizeBaseline(raw: unknown): IAlertBaselineConfig {
  const input = isRecord(raw) ? raw : {};
  const config: IAlertBaselineConfig = {
    direction: has(input, 'direction') ? oneOf(input.direction, 'baseline.direction', ['up', 'down', 'both']) : DEFAULT_BASELINE.direction,
    minRatio: has(input, 'minRatio') ? numberInRange(input.minRatio, 'baseline.minRatio', 1, 20) : DEFAULT_BASELINE.minRatio,
    minZ: has(input, 'minZ') ? numberInRange(input.minZ, 'baseline.minZ', 0, 20) : DEFAULT_BASELINE.minZ,
    minDelta: has(input, 'minDelta') ? numberInRange(input.minDelta, 'baseline.minDelta', 0, Number.MAX_SAFE_INTEGER) : DEFAULT_BASELINE.minDelta,
    lookbackDays: has(input, 'lookbackDays') ? integerInRange(input.lookbackDays, 'baseline.lookbackDays', 3, 45) : DEFAULT_BASELINE.lookbackDays,
    seasonality: has(input, 'seasonality') ? oneOf(input.seasonality, 'baseline.seasonality', ['daily', 'weekly', 'trailing']) : DEFAULT_BASELINE.seasonality,
  };
  if (config.seasonality === 'weekly' && config.lookbackDays < 21) {
    throw bad('invalid_baseline', 'baseline.lookbackDays must be at least 21 for weekly seasonality');
  }
  return config;
}

function normalizeAbsence(raw: unknown): { lookbackHours: number; minExpectedPerWindow: number } {
  const input = isRecord(raw) ? raw : {};
  return {
    lookbackHours: has(input, 'lookbackHours') ? integerInRange(input.lookbackHours, 'absence.lookbackHours', 1, 168) : 24,
    minExpectedPerWindow: has(input, 'minExpectedPerWindow')
      ? numberInRange(input.minExpectedPerWindow, 'absence.minExpectedPerWindow', 0.001, Number.MAX_SAFE_INTEGER)
      : 1,
  };
}

function normalizeSlo(raw: unknown, metric: AlertMetric): IAlertSloConfig {
  const input = isRecord(raw) ? raw : {};
  const windowDays = has(input, 'windowDays') ? integerInRange(input.windowDays, 'slo.windowDays', 1, 45) : DEFAULT_SLO.windowDays;
  const config: IAlertSloConfig = {
    objectivePct: has(input, 'objectivePct') ? numberInRange(input.objectivePct, 'slo.objectivePct', 50, 99.999) : DEFAULT_SLO.objectivePct,
    windowDays,
    burnRate: has(input, 'burnRate') ? numberInRange(input.burnRate, 'slo.burnRate', 1, 100) : DEFAULT_SLO.burnRate,
    longWindowMinutes: has(input, 'longWindowMinutes')
      ? integerInRange(input.longWindowMinutes, 'slo.longWindowMinutes', 1, windowDays * 1440)
      : DEFAULT_SLO.longWindowMinutes,
    shortWindowMinutes: has(input, 'shortWindowMinutes')
      ? integerInRange(input.shortWindowMinutes, 'slo.shortWindowMinutes', 1, windowDays * 1440)
      : DEFAULT_SLO.shortWindowMinutes,
  };
  if (config.longWindowMinutes <= config.shortWindowMinutes) {
    throw bad('invalid_slo', 'slo.longWindowMinutes must be greater than slo.shortWindowMinutes');
  }
  if (metric.includes('_p95_')) {
    if (!has(input, 'latencyThresholdMs')) {
      throw bad('invalid_slo', `slo.latencyThresholdMs is required for latency objectives (one of: ${ENTITY_LATENCY_BUCKET_UPPER_MS.join(', ')})`);
    }
    const threshold = finiteNumber(input.latencyThresholdMs, 'slo.latencyThresholdMs');
    if (!(ENTITY_LATENCY_BUCKET_UPPER_MS as readonly number[]).includes(threshold)) {
      throw bad('invalid_slo', `slo.latencyThresholdMs must be one of: ${ENTITY_LATENCY_BUCKET_UPPER_MS.join(', ')}`);
    }
    config.latencyThresholdMs = threshold;
  }
  return config;
}

function normalizeCondition(raw: unknown, metric: AlertMetric): IAlertCondition {
  if (!isRecord(raw)) throw bad('invalid_condition', 'condition is required');
  const def = getMetricDef(metric);
  const mode = has(raw, 'mode') ? oneOf(raw.mode, 'condition.mode', VALID_MODES) : 'threshold';
  if (def && !def.modes.includes(mode)) {
    throw bad('invalid_mode', `Mode "${mode}" is not available for metric "${metric}". Valid: ${def.modes.join(', ')}`);
  }

  const condition: IAlertCondition = { operator: 'gt', threshold: 0 };
  if (mode === 'threshold') {
    if (typeof raw.threshold !== 'number') throw bad('invalid_condition', 'Condition with numeric threshold is required');
    condition.threshold = finiteNumber(raw.threshold, 'condition.threshold');
    condition.operator = oneOf(raw.operator, 'condition.operator', VALID_OPERATORS);
  } else {
    // Ignored by these modes, but kept well-formed for readers of the stored rule.
    if (has(raw, 'operator')) condition.operator = oneOf(raw.operator, 'condition.operator', VALID_OPERATORS);
    if (has(raw, 'threshold')) condition.threshold = finiteNumber(raw.threshold, 'condition.threshold');
  }

  condition.mode = mode;
  if (has(raw, 'forMinutes')) condition.forMinutes = integerInRange(raw.forMinutes, 'condition.forMinutes', 0, 1440);
  if (has(raw, 'minSamples')) condition.minSamples = integerInRange(raw.minSamples, 'condition.minSamples', 1, 1_000_000);

  if (mode === 'baseline') condition.baseline = normalizeBaseline(raw.baseline);
  if (mode === 'absence') condition.absence = normalizeAbsence(raw.absence);
  if (mode === 'slo_burn') condition.slo = normalizeSlo(raw.slo, metric);
  return condition;
}

// ── Scope, entity ───────────────────────────────────────────────────────────

function normalizeScope(raw: unknown): NonNullable<IAlertRule['scope']> {
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw bad('invalid_scope', 'scope must be an object');
  const scope: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === '') continue;
    if (!(SCOPE_KEYS as readonly string[]).includes(key)) throw bad('invalid_scope', `Unknown scope field "${key}"`);
    if (typeof value !== 'string') throw bad('invalid_scope', `scope.${key} must be a string`);
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_SCOPE_VALUE_LENGTH) throw bad('invalid_scope', `scope.${key} must be at most ${MAX_SCOPE_VALUE_LENGTH} characters`);
    scope[key] = trimmed;
  }
  return scope;
}

function normalizeEntity(raw: unknown, entityType: EntityMetricType): IAlertRuleEntityScope {
  if (raw === null || raw === undefined) return { entityType, mode: 'all' };
  if (!isRecord(raw)) throw bad('invalid_entity', 'entity must be an object');
  const type = has(raw, 'entityType') ? oneOf(raw.entityType, 'entity.entityType', ENTITY_TYPES) : entityType;
  if (type !== entityType) {
    throw bad('invalid_entity', `entity.entityType must be "${entityType}" for this metric`);
  }
  const mode = has(raw, 'mode') ? oneOf(raw.mode, 'entity.mode', ['all', 'selected']) : 'all';
  if (mode === 'all') return { entityType: type, mode };

  if (!Array.isArray(raw.keys)) throw bad('invalid_entity', 'entity.keys is required when mode is "selected"');
  const keys: string[] = [];
  for (const key of raw.keys) {
    if (typeof key !== 'string') throw bad('invalid_entity', 'entity.keys must be strings');
    const trimmed = key.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_ENTITY_KEY_LENGTH) throw bad('invalid_entity', `entity.keys entries must be at most ${MAX_ENTITY_KEY_LENGTH} characters`);
    if (!keys.includes(trimmed)) keys.push(trimmed);
  }
  if (keys.length < 1 || keys.length > MAX_ENTITY_KEYS) {
    throw bad('invalid_entity', `entity.keys must contain 1 to ${MAX_ENTITY_KEYS} entries`);
  }
  return { entityType: type, mode, keys };
}

// ── Channels ────────────────────────────────────────────────────────────────

function storedChannelOfId(existing: IAlertRule | null | undefined, id: string | undefined, type: string): IAlertChannel | undefined {
  if (!id || !existing) return undefined;
  return (existing.channels ?? []).find((channel) => channel.id === id && channel.type === type);
}

function optionalSecret(value: unknown, field: string, maxLength = MAX_SECRET_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw bad('invalid_channel', `${field} must be a string`);
  if (value.length > maxLength) throw bad('invalid_channel', `${field} must be at most ${maxLength} characters`);
  return value;
}

/** Structural checks of one channel (no network). A secret omitted for a stored channel id is kept. */
export function normalizeChannelInput(raw: unknown, index: number, existing: IAlertRule | null | undefined): AlertChannelInput {
  if (!isRecord(raw)) throw bad('invalid_channel', `channels[${index}] must be an object`);
  const id = typeof raw.id === 'string' && CHANNEL_ID_PATTERN.test(raw.id) ? raw.id : undefined;
  if (raw.type === 'library') {
    // a reference to a tenant library entry: no secrets, resolved at dispatch time
    const libraryId = typeof raw.libraryId === 'string' ? raw.libraryId.trim() : '';
    if (!libraryId || libraryId.length > 64) throw bad('invalid_channel', `channels[${index}].libraryId is required`);
    return { ...(id ? { id } : {}), type: 'library', libraryId };
  }
  const type = oneOf(raw.type, `channels[${index}].type`, ALERT_CHANNEL_TYPES);
  const stored = storedChannelOfId(existing, id, type);

  switch (type) {
    case 'email': {
      if (!Array.isArray(raw.recipients)) throw bad('invalid_channel', `channels[${index}].recipients must be an array`);
      if (raw.recipients.length > MAX_EMAIL_RECIPIENTS) {
        throw bad('invalid_channel', `channels[${index}].recipients must contain at most ${MAX_EMAIL_RECIPIENTS} addresses`);
      }
      const recipients: string[] = [];
      for (const entry of raw.recipients) {
        const email = typeof entry === 'string' ? entry.trim() : '';
        if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
          throw bad('invalid_channel', `channels[${index}] has an invalid email address`);
        }
        if (!recipients.includes(email)) recipients.push(email);
      }
      return { ...(id ? { id } : {}), type, recipients };
    }
    case 'webhook': {
      const url = optionalSecret(raw.url, `channels[${index}].url`, MAX_CHANNEL_URL_LENGTH)?.trim();
      if (!url && !stored) throw bad('invalid_channel', `channels[${index}] (webhook) needs a url`);
      const secret = optionalSecret(raw.secret, `channels[${index}].secret`);
      return { ...(id ? { id } : {}), type, ...(url ? { url } : {}), ...(secret !== undefined ? { secret } : {}) };
    }
    case 'slack':
    case 'teams': {
      const url = optionalSecret(raw.url, `channels[${index}].url`, MAX_CHANNEL_URL_LENGTH)?.trim();
      if (!url && !stored) throw bad('invalid_channel', `channels[${index}] (${type}) needs a url`);
      return { ...(id ? { id } : {}), type, ...(url ? { url } : {}) };
    }
    case 'pagerduty': {
      const routingKey = optionalSecret(raw.routingKey, `channels[${index}].routingKey`)?.trim();
      if (!routingKey && !stored) throw bad('invalid_channel', `channels[${index}] (pagerduty) needs a routing key`);
      if (routingKey && !isValidPagerDutyRoutingKey(routingKey)) {
        throw bad('invalid_channel', `channels[${index}].routingKey must be 32 letters or digits`);
      }
      return { ...(id ? { id } : {}), type, ...(routingKey ? { routingKey } : {}) };
    }
  }
}

function normalizeChannels(raw: unknown, existing: IAlertRule | null | undefined): AlertChannelInput[] {
  if (!Array.isArray(raw)) throw bad('invalid_channel', 'channels must be an array');
  if (raw.length < 1 || raw.length > MAX_CHANNELS) throw bad('invalid_channel', `channels must contain 1 to ${MAX_CHANNELS} entries`);
  return raw.map((channel, index) => normalizeChannelInput(channel, index, existing));
}

/** The network half of channel validation: every URL given must be https and resolve publicly. */
export async function verifyChannelDestinations(channels: AlertChannelInput[]): Promise<void> {
  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    if (channel.type !== 'webhook' && channel.type !== 'slack' && channel.type !== 'teams') continue;
    if (!channel.url) continue;
    try {
      await assertPublicChannelUrl(channel.url);
    } catch (error) {
      if (error instanceof ChannelUrlError) throw bad('invalid_channel', `channels[${index}]: ${error.message}`);
      throw error;
    }
  }
}

// ── The validator ───────────────────────────────────────────────────────────

function existingToInput(existing: IAlertRule): CreateAlertRuleInput {
  return {
    name: existing.name,
    description: existing.description,
    module: existing.module,
    metric: existing.metric,
    condition: existing.condition,
    windowMinutes: existing.windowMinutes,
    cooldownMinutes: existing.cooldownMinutes,
    scope: existing.scope,
    entity: existing.entity ?? null,
    severity: existing.severity ?? null,
    notifyOnResolve: existing.notifyOnResolve,
    renotifyMinutes: existing.renotifyMinutes ?? null,
    runbookUrl: existing.runbookUrl ?? null,
    enabled: existing.enabled,
  };
}

export const MAX_RUNBOOK_URL_LENGTH = 2048;
const CONTROL_CHARS = /[\u0000-\u001f\u007f\s]/;

/** A runbook is only ever a link a person clicks: http(s), no whitespace or control characters. Empty clears. */
export function normalizeRunbookUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw bad('invalid_runbook_url', 'runbookUrl must be a string');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_RUNBOOK_URL_LENGTH) {
    throw bad('invalid_runbook_url', `runbookUrl must be at most ${MAX_RUNBOOK_URL_LENGTH} characters`);
  }
  if (CONTROL_CHARS.test(trimmed)) throw bad('invalid_runbook_url', 'runbookUrl must not contain spaces or control characters');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw bad('invalid_runbook_url', 'runbookUrl must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw bad('invalid_runbook_url', 'runbookUrl must start with http:// or https://');
  }
  if (!parsed.hostname) throw bad('invalid_runbook_url', 'runbookUrl must be a valid http(s) URL');
  return trimmed;
}

/**
 * Validate and normalise a rule. One function for create, update and preview:
 * `update` overlays the given fields on the stored rule, so partial bodies and
 * full bodies are judged the same way, and the result is always a complete rule.
 *
 * Clearing: an empty `description`, an empty `scope`, `entity: null`,
 * `severity: null` and `renotifyMinutes: null` reset the field.
 */
export function validateRuleInput(input: unknown, options: ValidateRuleOptions): ValidatedRule {
  if (!isRecord(input)) throw bad('invalid_body', 'A rule object is required');
  const { mode, existing } = options;
  const base: Record<string, unknown> = mode === 'update' && existing ? { ...existingToInput(existing) } : {};
  if (mode === 'update' && existing) {
    // Retargeting: a stored target of another kind must not be validated against the new metric.
    const retargets = (typeof input.metric === 'string' && input.metric !== existing.metric)
      || (typeof input.module === 'string' && input.module !== existing.module);
    if (retargets) {
      const nextDef = typeof input.metric === 'string' ? getMetricDef(input.metric as AlertMetric) : getMetricDef(existing.metric);
      const nextEntityType = nextDef?.source === 'entity' ? nextDef.entityType : undefined;
      if (existing.entity && existing.entity.entityType !== nextEntityType) delete base.entity;
      if (nextEntityType) delete base.scope;
    }
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) merged[key] = value;
  }

  // name
  let name = '';
  if (mode === 'preview' && merged.name === undefined) {
    name = 'Preview';
  } else {
    if (typeof merged.name !== 'string' || !merged.name.trim()) throw bad('invalid_name', 'Alert rule name is required');
    name = merged.name.trim();
    if (name.length > MAX_NAME_LENGTH) throw bad('invalid_name', `name must be at most ${MAX_NAME_LENGTH} characters`);
  }

  let description = '';
  if (merged.description !== undefined && merged.description !== null) {
    if (typeof merged.description !== 'string') throw bad('invalid_description', 'description must be a string');
    description = merged.description.trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) throw bad('invalid_description', `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  // module / metric consistency (a stored rule may keep the retired `aegis` module)
  const alertModule = merged.module as AlertModule;
  const moduleAllowed = VALID_MODULES.includes(alertModule) || (existing !== undefined && existing !== null && existing.module === alertModule);
  if (typeof alertModule !== 'string' || !moduleAllowed) {
    throw bad('invalid_module', `Invalid module: ${String(merged.module)}. Must be one of: ${VALID_MODULES.join(', ')}`);
  }
  const metric = merged.metric as AlertMetric;
  if (typeof metric !== 'string' || !VALID_METRICS.includes(metric)) {
    throw bad('invalid_metric', `Invalid metric: ${String(merged.metric)}. Must be one of: ${VALID_METRICS.join(', ')}`);
  }
  const moduleMetrics = MODULE_METRICS[alertModule];
  if (!moduleMetrics.includes(metric)) {
    throw bad('metric_module_mismatch', `Metric "${metric}" is not available for module "${alertModule}". Valid: ${moduleMetrics.join(', ')}`);
  }
  const def = getMetricDef(metric);

  const windowMinutes = merged.windowMinutes as number;
  if (!VALID_WINDOWS.includes(windowMinutes)) {
    throw bad('invalid_window', `Invalid window: ${String(merged.windowMinutes)}. Must be one of: ${VALID_WINDOWS.join(', ')}`);
  }

  const condition = normalizeCondition(merged.condition, metric);

  // target
  let scope: NonNullable<IAlertRule['scope']> = {};
  let entity: IAlertRuleEntityScope | null = null;
  if (def?.source === 'entity' && def.entityType) {
    entity = normalizeEntity(merged.entity, def.entityType);
  } else {
    if (merged.entity !== undefined && merged.entity !== null) {
      throw bad('invalid_entity', `Metric "${metric}" does not support entity targeting`);
    }
    scope = normalizeScope(merged.scope);
  }

  const cooldownMinutes = merged.cooldownMinutes === undefined || merged.cooldownMinutes === null
    ? 60
    : integerInRange(merged.cooldownMinutes, 'cooldownMinutes', 0, MAX_COOLDOWN_MINUTES);

  let renotifyMinutes = 0;
  if (merged.renotifyMinutes !== undefined && merged.renotifyMinutes !== null) {
    renotifyMinutes = finiteNumber(merged.renotifyMinutes, 'renotifyMinutes');
    if (renotifyMinutes !== 0 && (!Number.isInteger(renotifyMinutes) || renotifyMinutes < 15 || renotifyMinutes > 1440)) {
      throw bad('invalid_renotify', 'renotifyMinutes must be 0 or an integer between 15 and 1440');
    }
  }

  const severity: AlertRuleSeverity = merged.severity === undefined || merged.severity === null
    ? 'auto'
    : oneOf(merged.severity, 'severity', VALID_SEVERITIES);

  const runbookUrl = normalizeRunbookUrl(merged.runbookUrl);

  if (merged.notifyOnResolve !== undefined && typeof merged.notifyOnResolve !== 'boolean') {
    throw bad('invalid_value', 'notifyOnResolve must be a boolean');
  }
  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') {
    throw bad('invalid_value', 'enabled must be a boolean');
  }

  let channels: AlertChannelInput[] | undefined;
  if (mode !== 'preview') {
    if (input.channels !== undefined) channels = normalizeChannels(input.channels, existing);
    else if (mode === 'create') channels = [{ type: 'email', recipients: [] }];
  }

  return {
    name,
    description,
    module: alertModule,
    metric,
    condition,
    windowMinutes,
    cooldownMinutes,
    scope,
    entity,
    severity,
    notifyOnResolve: merged.notifyOnResolve === undefined ? true : (merged.notifyOnResolve as boolean),
    renotifyMinutes,
    runbookUrl,
    enabled: merged.enabled === undefined ? true : (merged.enabled as boolean),
    ...(channels ? { channels } : {}),
  };
}

/** The condition modes that need the enterprise seam: refused with 402 when unavailable. */
async function assertModeAvailable(tenantId: string, condition: IAlertCondition): Promise<void> {
  const mode = condition.mode ?? 'threshold';
  if (mode !== 'baseline' && mode !== 'slo_burn') return;
  const availability = await createModeGate(tenantId).check(mode);
  if (availability.available) return;
  throw new AlertApiError(
    402,
    availability.reason,
    availability.reason === 'license_required'
      ? `The "${mode}" condition mode needs an enterprise licence`
      : `The "${mode}" condition mode is not available in this edition`,
    { error: 'Payment Required', requiresEnterprise: true, module: 'alerts-advanced' },
  );
}

function maskRule<T extends IAlertRule | null>(rule: T): T {
  if (!rule) return rule;
  return { ...rule, channels: maskChannels(rule.channels) };
}

/** Most addresses one unsaved email channel is tested against. */
const MAX_TEST_EMAIL_RECIPIENTS = 5;

export interface RuleScopeOptions {
  /** When set, a rule of another project reads as missing. */
  projectId?: string;
}

export interface RulePreviewTarget {
  entityKey: string;
  value: number | null;
  sampleCount: number;
  breached: boolean;
  baseline?: number | null;
  insufficientData?: boolean;
}

export class AlertService {
  // ── Rule CRUD ────────────────────────────────────────────────────────

  static async createRule(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    input: CreateAlertRuleInput,
  ): Promise<IAlertRule> {
    const rule = validateRuleInput(input, { mode: 'create' });
    await assertModeAvailable(tenantId, rule.condition);
    if (rule.channels) await verifyChannelDestinations(rule.channels);

    const db = await getTenantDatabase(tenantDbName);
    const channels = await sealChannels(rule.channels ?? [], []);

    const created = await db.createAlertRule({
      tenantId,
      projectId,
      name: rule.name,
      ...(rule.description ? { description: rule.description } : {}),
      module: rule.module,
      enabled: rule.enabled,
      metric: rule.metric,
      condition: rule.condition,
      windowMinutes: rule.windowMinutes,
      cooldownMinutes: rule.cooldownMinutes,
      scope: rule.scope,
      ...(rule.entity ? { entity: rule.entity } : {}),
      severity: rule.severity,
      notifyOnResolve: rule.notifyOnResolve,
      renotifyMinutes: rule.renotifyMinutes,
      ...(rule.runbookUrl ? { runbookUrl: rule.runbookUrl } : {}),
      channels,
      createdBy: userId,
    });

    return maskRule(created);
  }

  static async updateRule(
    tenantDbName: string,
    ruleId: string,
    data: UpdateAlertRuleInput,
    options: RuleScopeOptions = {},
  ): Promise<IAlertRule | null> {
    const db = await getTenantDatabase(tenantDbName);
    const existing = await db.findAlertRuleById(ruleId, options.projectId);
    if (!existing) return null;

    const { updatedBy, ...body } = data;
    const rule = validateRuleInput(body, { mode: 'update', existing });
    if (body.condition !== undefined || body.metric !== undefined || body.module !== undefined) {
      await assertModeAvailable(existing.tenantId, rule.condition);
    }
    if (rule.channels) await verifyChannelDestinations(rule.channels);

    const patch: Partial<IAlertRule> & Record<string, unknown> = {
      name: rule.name,
      description: rule.description,
      module: rule.module,
      metric: rule.metric,
      condition: rule.condition,
      windowMinutes: rule.windowMinutes,
      cooldownMinutes: rule.cooldownMinutes,
      scope: rule.scope,
      // `null` clears the field (see updateAlertRule in both providers).
      entity: rule.entity as unknown as IAlertRuleEntityScope,
      severity: rule.severity,
      notifyOnResolve: rule.notifyOnResolve,
      renotifyMinutes: rule.renotifyMinutes,
      // `null` clears the runbook (see updateAlertRule in both providers).
      runbookUrl: rule.runbookUrl,
      enabled: rule.enabled,
    };
    if (rule.channels) patch.channels = await sealChannels(rule.channels, existing.channels ?? []);
    if (updatedBy) patch.updatedBy = updatedBy;

    const updated = await db.updateAlertRule(ruleId, patch, options.projectId);
    if (!updated) return null;

    const reshaped = evaluationShapeOf(existing) !== evaluationShapeOf({ ...existing, ...patch } as IAlertRule);
    const disabled = existing.enabled && rule.enabled === false;
    if (disabled) await AlertService.retireStates(tenantDbName, ruleId, 'Rule disabled');
    else if (reshaped) await AlertService.retireStates(tenantDbName, ruleId, 'Rule conditions changed');

    return maskRule(updated);
  }

  static async deleteRule(
    tenantDbName: string,
    ruleId: string,
    options: RuleScopeOptions = {},
  ): Promise<boolean> {
    const db = await getTenantDatabase(tenantDbName);
    const deleted = options.projectId === undefined
      ? await db.deleteAlertRule(ruleId)
      : await db.deleteAlertRule(ruleId, options.projectId);
    if (deleted) await AlertService.retireStates(tenantDbName, ruleId, 'Rule deleted', { keepCooldown: true });
    return deleted;
  }

  static async getRule(
    tenantDbName: string,
    ruleId: string,
    options: RuleScopeOptions = {},
  ): Promise<IAlertRule | null> {
    const db = await getTenantDatabase(tenantDbName);
    const rule = options.projectId === undefined
      ? await db.findAlertRuleById(ruleId)
      : await db.findAlertRuleById(ruleId, options.projectId);
    return maskRule(rule);
  }

  static async listRules(
    tenantDbName: string,
    tenantId: string,
    projectId?: string,
  ): Promise<IAlertRule[]> {
    const db = await getTenantDatabase(tenantDbName);
    const rules = await db.listAlertRules(tenantId, { projectId });
    return rules.map((rule) => maskRule(rule));
  }

  static async toggleRule(
    tenantDbName: string,
    ruleId: string,
    enabled: boolean,
    userId: string,
    options: RuleScopeOptions = {},
  ): Promise<IAlertRule | null> {
    const db = await getTenantDatabase(tenantDbName);
    const updated = options.projectId === undefined
      ? await db.updateAlertRule(ruleId, { enabled, updatedBy: userId })
      : await db.updateAlertRule(ruleId, { enabled, updatedBy: userId }, options.projectId);
    if (updated && !enabled) await AlertService.retireStates(tenantDbName, ruleId, 'Rule disabled');
    return maskRule(updated);
  }

  /** Longest a rule can be muted in one go. */
  static readonly MAX_MUTE_MS = 30 * 86_400_000;

  /**
   * Mute a rule until `until` (ISO, at most 30 days ahead) or unmute it (`until: null`).
   * Evaluation, states, events and incidents continue; only channel notifications are skipped.
   */
  static async muteRule(
    tenantDbName: string,
    ruleId: string,
    input: { until: unknown; reason?: unknown },
    userId: string,
    options: RuleScopeOptions = {},
  ): Promise<IAlertRule | null> {
    let patch: Partial<IAlertRule>;
    if (input.until === null) {
      patch = { mutedUntil: null, mutedBy: null, muteReason: null };
    } else {
      if (typeof input.until !== 'string' || !input.until.trim()) {
        throw bad('invalid_until', 'until must be an ISO date-time or null');
      }
      const until = new Date(input.until);
      const nowMs = Date.now();
      if (Number.isNaN(until.getTime())) throw bad('invalid_until', 'until must be an ISO date-time or null');
      if (until.getTime() <= nowMs) throw bad('invalid_until', 'until must be in the future');
      if (until.getTime() > nowMs + AlertService.MAX_MUTE_MS + 60_000) {
        throw bad('invalid_until', 'A rule can be muted for at most 30 days');
      }
      let reason: string | null = null;
      if (input.reason !== undefined && input.reason !== null) {
        if (typeof input.reason !== 'string') throw bad('invalid_reason', 'reason must be a string');
        if (input.reason.trim().length > 500) throw bad('invalid_reason', 'reason must be at most 500 characters');
        reason = input.reason.trim() || null;
      }
      patch = { mutedUntil: until, mutedBy: userId, muteReason: reason };
    }
    const db = await getTenantDatabase(tenantDbName);
    const updated = options.projectId === undefined
      ? await db.updateAlertRule(ruleId, { ...patch, updatedBy: userId })
      : await db.updateAlertRule(ruleId, { ...patch, updatedBy: userId }, options.projectId);
    return maskRule(updated);
  }

  /**
   * The rules list as the UI consumes it: server-side filters and sort, derived
   * display state, optional 7-day noise statistics and the list KPIs (computed
   * over the project's whole rule set, before the filters).
   */
  static async listRulesView(
    tenantDbName: string,
    tenantId: string,
    projectId: string | undefined,
    options: RuleListQuery & { includeStats?: boolean } = {},
  ): Promise<{
    rules: IAlertRule[];
    states: Record<string, { ok: number; pending: number; firing: number }>;
    derived: Record<string, RuleDerived>;
    stats: Record<string, RuleNoiseStats> | null;
    statsCapped: boolean;
    kpis: RuleListKpis;
    total: number;
  }> {
    const db = await getTenantDatabase(tenantDbName);
    const all = (await db.listAlertRules(tenantId, { projectId })).map((rule) => maskRule(rule));
    const now = new Date();
    const states = await AlertService.stateCounts(tenantDbName, all.map((rule) => String(rule._id)));

    const derived: Record<string, RuleDerived> = {};
    for (const rule of all) derived[String(rule._id)] = deriveRule(rule, states[String(rule._id)], now);

    const wantStats = options.includeStats === true || options.sort === '-fired7d';
    let stats: Record<string, RuleNoiseStats> | null = null;
    let statsCapped = false;
    if (wantStats && all.length > 0) {
      const limit = 5000;
      const firings = await db.listAlertFirings(tenantId, {
        projectId,
        since: new Date(now.getTime() - 7 * 86_400_000),
        limit,
      });
      statsCapped = firings.length >= limit;
      stats = buildNoiseStats(firings, now);
    } else if (wantStats) {
      stats = {};
    }

    const rules = applyRuleListQuery(all, options, derived, stats);
    return { rules, states, derived, stats, statsCapped, kpis: buildRuleKpis(all, derived, stats), total: rules.length };
  }

  /** The delivery log of one incident (newest first, at most 200). */
  static async listIncidentDeliveries(
    tenantDbName: string,
    tenantId: string,
    incidentId: string,
    limit = 200,
  ): Promise<IAlertDelivery[]> {
    const db = await getTenantDatabase(tenantDbName);
    return db.listAlertDeliveries(tenantId, { incidentId, limit });
  }

  /** Forget a rule's states; incidents that were open stay open and get a note saying why nothing will resolve them. */
  private static async retireStates(
    tenantDbName: string,
    ruleId: string,
    note: string,
    options: { keepCooldown?: boolean } = {},
  ): Promise<void> {
    const db = await getTenantDatabase(tenantDbName);
    const states = await db.listAlertStates({ ruleId, phases: ['firing'], limit: 5000 });
    for (const state of states) {
      if (!state.incidentId) continue;
      try {
        await IncidentService.addSystemNote(tenantDbName, state.incidentId, note);
      } catch { /* the note is informational */ }
    }
    await db.deleteAlertStates({ ruleId });
    if (options.keepCooldown !== true) {
      // The states carried the cooldown; a retired rule starts afresh, so the pre-v2
      // `lastTriggeredAt` (which seeds the cooldown of a rule without states) goes too.
      try {
        await db.updateAlertRule(ruleId, { lastTriggeredAt: null as unknown as Date });
      } catch { /* a deleted rule has nothing to clear */ }
    }
  }

  /** Per-rule counts of persisted states (healthy entities leave no row, so `ok` counts only those that have been non-ok). */
  static async stateCounts(
    tenantDbName: string,
    ruleIds: string[],
  ): Promise<Record<string, { ok: number; pending: number; firing: number }>> {
    const counts: Record<string, { ok: number; pending: number; firing: number }> = {};
    if (ruleIds.length === 0) return counts;
    const db = await getTenantDatabase(tenantDbName);
    const states = await db.listAlertStates({ ruleIds, limit: 5000 });
    for (const state of states) {
      // The rule-level licence marker is not an entity.
      if ((state.detail as Record<string, unknown> | null | undefined)?.licenseRequired === true) continue;
      const entry = (counts[state.ruleId] ??= { ok: 0, pending: 0, firing: 0 });
      entry[state.phase] += 1;
    }
    return counts;
  }

  static async listRuleStates(tenantDbName: string, ruleId: string): Promise<IAlertState[]> {
    const db = await getTenantDatabase(tenantDbName);
    return db.listAlertStates({ ruleId, limit: 200 });
  }

  static getModeAvailability(tenantId: string) {
    return getModeAvailability(tenantId);
  }

  /** Metric catalog as the UI consumes it. */
  static getCatalog() {
    return ALERT_METRIC_CATALOG;
  }

  // ── Preview, entities, channel test ───────────────────────────────────

  /**
   * What a rule WOULD do right now: values and breach per target, no state, no
   * notification. At most 50 targets, breaching ones first.
   */
  static async previewRule(
    tenantDbName: string,
    session: { tenantId: string; tenantSlug?: string },
    projectId: string,
    input: unknown,
  ): Promise<{ targets: RulePreviewTarget[]; notes: string[] }> {
    const rule = validateRuleInput(input, { mode: 'preview' });
    await assertModeAvailable(session.tenantId, rule.condition);

    const synthetic: IAlertRule = {
      _id: 'preview',
      tenantId: session.tenantId,
      projectId,
      name: rule.name,
      module: rule.module,
      enabled: true,
      metric: rule.metric,
      condition: rule.condition,
      windowMinutes: rule.windowMinutes,
      cooldownMinutes: rule.cooldownMinutes,
      scope: rule.scope,
      ...(rule.entity ? { entity: rule.entity } : {}),
      severity: rule.severity,
      channels: [],
      createdBy: 'preview',
    };

    const evaluation = await evaluateRuleTargets(
      {
        tenantDbName,
        tenantId: session.tenantId,
        tenantSlug: session.tenantSlug ?? '',
        companyName: '',
      },
      synthetic,
      { nowMs: Date.now(), gate: createModeGate(session.tenantId), stateKeys: [] },
    );

    const notes = [...evaluation.notes];
    const sorted = [...evaluation.targets].sort((a, b) => {
      if (a.breached !== b.breached) return a.breached ? -1 : 1;
      return (b.sampleCount - a.sampleCount) || a.entityKey.localeCompare(b.entityKey);
    });
    if (sorted.length > PREVIEW_MAX_TARGETS) {
      notes.push(`Showing ${PREVIEW_MAX_TARGETS} of ${sorted.length} entities`);
    }
    if (sorted.length === 0 && evaluation.entityType) {
      notes.push('No entity has data in the evaluation window yet');
    }

    const targets = sorted.slice(0, PREVIEW_MAX_TARGETS).map((target): RulePreviewTarget => ({
      entityKey: target.entityKey,
      value: target.value,
      sampleCount: target.sampleCount,
      breached: target.breached,
      ...(target.baseline !== undefined ? { baseline: target.baseline } : {}),
      ...(target.insufficientData ? { insufficientData: true } : {}),
    }));
    return { targets, notes };
  }

  /** Entities with data in the last 30 days, for pickers. */
  static async listEntities(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    query: { entityType?: string; q?: string; limit?: number },
  ): Promise<Array<{ key: string; requests: number; lastSeenMs: number }>> {
    if (!query.entityType || !ENTITY_TYPES.includes(query.entityType as EntityMetricType)) {
      throw bad('invalid_entity_type', `entityType must be one of: ${ENTITY_TYPES.join(', ')}`);
    }
    const now = Date.now();
    const keys = await listActiveEntityKeys({
      tenantDbName,
      tenantId,
      projectId,
      entityType: query.entityType as EntityMetricType,
      fromMs: now - ENTITY_LOOKBACK_MS,
      toMs: now,
      q: query.q,
      limit: query.limit,
    });
    return keys.map((entry) => ({ key: entry.key, requests: entry.requests, lastSeenMs: entry.lastBucketMs }));
  }

  /**
   * Send a clearly-labelled test notification on one channel: either an
   * unsaved channel as typed (`channel`) or a stored one (`ruleId` + `channelId`).
   */
  static async testChannel(
    tenantDbName: string,
    session: { tenantId: string; tenantSlug: string },
    scope: { projectId: string; projectName: string; ruleScopeProjectId?: string; canTestLibrary?: boolean },
    body: { channel?: unknown; ruleId?: unknown; channelId?: unknown; libraryChannelId?: unknown },
  ): Promise<DispatchResult> {
    const libraryTestForbidden = () =>
      new AlertApiError(403, 'forbidden', 'Only workspace owners and admins can test a shared library channel');
    let stored: IAlertChannel;
    let ruleName = 'Channel test';
    let ruleId = 'test';
    let ruleDef = getMetricDef('agent_error_rate');
    let alertModule: AlertModule = 'agents';
    let metric: AlertMetric = 'agent_error_rate';

    if (body.channel !== undefined) {
      const input = normalizeChannelInput(body.channel, 0, null);
      if (input.type === 'email' && (input.recipients?.length ?? 0) > MAX_TEST_EMAIL_RECIPIENTS) {
        // An unsaved channel is mailed as typed; a long list would make the test a mass mailer.
        throw bad('too_many_recipients', `Send the test to at most ${MAX_TEST_EMAIL_RECIPIENTS} addresses (save the channel to test a longer list)`);
      }
      await verifyChannelDestinations([input]);
      [stored] = await sealChannels([input], []);
    } else if (typeof body.libraryChannelId === 'string') {
      if (!scope.canTestLibrary) throw libraryTestForbidden();
      const entry = await (await getTenantDatabase(tenantDbName)).findAlertChannelLibraryEntry(body.libraryChannelId);
      if (!entry || entry.tenantId !== session.tenantId) throw new AlertApiError(404, 'channel_not_found', 'Channel not found');
      stored = entry.config;
    } else if (typeof body.ruleId === 'string' && typeof body.channelId === 'string') {
      const db = await getTenantDatabase(tenantDbName);
      const rule = await db.findAlertRuleById(body.ruleId, scope.ruleScopeProjectId);
      if (!rule) throw new AlertApiError(404, 'rule_not_found', 'Rule not found');
      const found = (rule.channels ?? []).find((channel) => channel.id === body.channelId);
      if (!found) throw new AlertApiError(404, 'channel_not_found', 'Channel not found');
      if (found.type === 'library' && !scope.canTestLibrary) throw libraryTestForbidden();
      stored = found;
      ruleName = rule.name;
      ruleId = String(rule._id);
      ruleDef = getMetricDef(rule.metric);
      alertModule = rule.module;
      metric = rule.metric;
    } else {
      throw bad('invalid_body', 'Send either { channel } or { ruleId, channelId }');
    }

    let companyName = session.tenantSlug;
    try {
      const tenant = await (await getDatabase()).findTenantById(session.tenantId);
      if (tenant?.companyName) companyName = tenant.companyName;
    } catch { /* the slug is a fine fallback */ }

    const appUrl = getConfig().app.url;
    const now = new Date();
    const notification: AlertNotification = {
      kind: 'test',
      rule: {
        id: ruleId,
        name: ruleName,
        module: alertModule,
        metric,
        metricLabel: ruleDef?.label ?? metric,
        unit: ruleDef?.unit ?? '',
        mode: 'threshold',
        windowMinutes: 5,
      },
      entity: null,
      value: null,
      severity: 'info',
      firedAt: now,
      projectName: scope.projectName,
      companyName,
      dashboardUrl: `${appUrl}/dashboard/alerts`,
    };

    const results = await dispatchNotification(notification, [stored], {
      tenantDbName,
      tenantId: session.tenantId,
      tenantSlug: session.tenantSlug,
      companyName,
      projectName: scope.projectName,
      dashboardUrl: `${appUrl}/dashboard/alerts`,
    });
    if (results.length === 0) return { type: stored.type, target: stored.type, success: false, error: 'No delivery attempted' };
    const failure = results.find((result) => !result.success);
    return failure ?? results[0];
  }

  // ── Event (History) ──────────────────────────────────────────────────

  static async listEvents(
    tenantDbName: string,
    tenantId: string,
    options?: {
      projectId?: string;
      ruleId?: string;
      status?: AlertEventStatus;
      limit?: number;
      skip?: number;
    },
  ): Promise<IAlertEvent[]> {
    const db = await getTenantDatabase(tenantDbName);
    return db.listAlertEvents(tenantId, options);
  }

  /**
   * Acknowledge a history event: records who and when, and acknowledges the
   * linked incident while it is still open. A resolved event keeps its status.
   */
  static async acknowledgeEvent(
    tenantDbName: string,
    eventId: string,
    options: { projectId?: string; userId?: string } = {},
  ): Promise<IAlertEvent | null> {
    const db = await getTenantDatabase(tenantDbName);
    const event = await db.findAlertEventById(eventId, options.projectId);
    if (!event) return null;

    const now = new Date();
    const update: Partial<IAlertEvent> = { acknowledgedAt: now };
    if (options.userId) update.acknowledgedBy = options.userId;
    if (event.status === 'fired') update.status = 'acknowledged';
    const updated = await db.updateAlertEvent(String(event._id), update);

    try {
      const incident = await db.findIncidentByAlertEventId(String(event._id));
      if (incident && incident.status === 'open') {
        await IncidentService.updateStatus(
          tenantDbName,
          String(incident._id),
          'acknowledged',
          options.userId ?? 'system',
          { projectId: options.projectId },
        );
      }
    } catch { /* the event is acknowledged either way */ }

    return updated;
  }

  static async countActive(
    tenantDbName: string,
    tenantId: string,
    projectId?: string,
  ): Promise<number> {
    const db = await getTenantDatabase(tenantDbName);
    return db.countActiveAlerts(tenantId, projectId);
  }
}

/** Re-export for convenience */
export { VALID_METRICS, VALID_WINDOWS, VALID_MODULES, MODULE_METRICS };
