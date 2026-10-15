/**
 * Wire shapes of the alerts API as the UI sees them (JSON: dates are ISO strings).
 * Mirrors `src/server/api/plugins/alerts.ts`; the stored/domain types live in
 * `@/lib/database` and are only used here for their string unions.
 */

import type {
  AlertConditionMode,
  AlertConditionOperator,
  AlertModule,
  AlertRuleSeverity,
  AlertStatePhase,
  EntityMetricType,
  IncidentSeverity,
  IncidentStatus,
} from '@/lib/database';
import type { AlertMetricDef } from '@/lib/services/alerts/metricCatalog';

export type {
  AlertConditionMode,
  AlertConditionOperator,
  AlertMetricDef,
  AlertModule,
  AlertRuleSeverity,
  AlertStatePhase,
  EntityMetricType,
  IncidentSeverity,
  IncidentStatus,
};

export type AlertChannelType = 'email' | 'webhook' | 'slack' | 'teams' | 'pagerduty';

export const ALL_CHANNEL_TYPES: AlertChannelType[] = ['email', 'webhook', 'slack', 'teams', 'pagerduty'];

/** `GET /alerts/rules` → `meta.modes[mode]`. */
export interface ModeAvailabilityDto {
  available: boolean;
  reason?: 'not_enterprise_build' | 'license_required';
}

export interface AlertMeta {
  moduleMetrics?: Record<string, string[]>;
  validMetrics?: string[];
  validModules: AlertModule[];
  validWindows: number[];
  catalog: AlertMetricDef[];
  modes: Partial<Record<AlertConditionMode, ModeAvailabilityDto>>;
  channelTypes: AlertChannelType[];
}

/** A stored channel as the API returns it: masked (hints only, never a secret). */
export interface MaskedChannel {
  id?: string;
  type: AlertChannelType;
  recipients?: string[];
  urlHint?: string;
  hasSecret?: boolean;
  keyHint?: string;
}

export interface AlertConditionDto {
  operator: AlertConditionOperator;
  threshold: number;
  mode?: AlertConditionMode;
  forMinutes?: number;
  minSamples?: number;
  baseline?: {
    direction: 'up' | 'down' | 'both';
    minRatio: number;
    minZ: number;
    minDelta: number;
    lookbackDays: number;
    seasonality: 'daily' | 'weekly' | 'trailing';
  };
  absence?: { lookbackHours: number; minExpectedPerWindow: number };
  slo?: {
    objectivePct: number;
    windowDays: number;
    burnRate: number;
    longWindowMinutes: number;
    shortWindowMinutes: number;
    latencyThresholdMs?: number;
  };
}

export interface AlertRuleScopeDto {
  modelKey?: string;
  serverKey?: string;
  guardrailKey?: string;
  ragModuleKey?: string;
  mcpServerKey?: string;
}

export interface AlertRuleDto {
  _id: string;
  name: string;
  description?: string;
  module?: AlertModule;
  metric: string;
  condition: AlertConditionDto;
  windowMinutes: number;
  cooldownMinutes: number;
  enabled: boolean;
  scope?: AlertRuleScopeDto;
  entity?: { entityType: EntityMetricType; mode: 'all' | 'selected'; keys?: string[] };
  severity?: AlertRuleSeverity;
  notifyOnResolve?: boolean;
  renotifyMinutes?: number;
  channels: MaskedChannel[];
  lastTriggeredAt?: string;
  createdAt?: string;
}

export interface StateCounts {
  ok: number;
  pending: number;
  firing: number;
}

export interface IncidentNoteDto {
  userId: string;
  userName: string;
  content: string;
  createdAt: string;
}

export interface IncidentContextDto {
  mode: AlertConditionMode;
  windowMinutes: number;
  versionChange?: { from: string | null; to: string | null } | null;
  errorSignatures?: Array<{ message: string; count: number }>;
  failingSessions?: { count: number; listPath: string } | null;
  correlations?: Array<{
    entityType: EntityMetricType;
    entityKey: string;
    metric: string;
    value: number;
    baseline: number | null;
    ratio: number | null;
  }>;
  notes?: string[];
}

export interface IncidentDto {
  _id: string;
  ruleName: string;
  ruleId: string;
  alertEventId: string;
  metric: string;
  threshold: number;
  actualValue: number;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assignedTo?: string | null;
  notes: IncidentNoteDto[];
  firedAt: string;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  resolvedBy?: string | null;
  module?: AlertModule;
  entityType?: EntityMetricType | null;
  entityKey?: string | null;
  baselineValue?: number | null;
  lastValue?: number | null;
  peakValue?: number | null;
  autoResolved?: boolean;
  acknowledgedBy?: string | null;
  context?: IncidentContextDto | null;
  metadata?: Record<string, unknown>;
}

export type IncidentCounts = Record<IncidentStatus, number>;

export interface AlertEventDto {
  _id: string;
  ruleId?: string;
  ruleName: string;
  metric: string;
  threshold: number;
  actualValue: number;
  status: 'fired' | 'resolved' | 'acknowledged';
  firedAt: string;
  resolvedAt?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  entityType?: EntityMetricType | null;
  entityKey?: string | null;
  baselineValue?: number | null;
  sampleCount?: number;
  channels: Array<{ type: string; target: string; success: boolean; error?: string }>;
  metadata?: Record<string, unknown>;
}

export interface PreviewTarget {
  entityKey: string;
  value: number | null;
  sampleCount: number;
  breached: boolean;
  baseline?: number | null;
  insufficientData?: boolean;
}

export interface ChannelTestResult {
  type: string;
  target: string;
  success: boolean;
  error?: string;
}
