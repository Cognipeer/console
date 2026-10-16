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
  /** `library`: a reference to a tenant channel library entry (`libraryId`), not an inline channel. */
  type: AlertChannelType | 'library';
  libraryId?: string;
  recipients?: string[];
  /** email: `project_admins` also mails the project's admins, resolved when it sends. */
  audience?: 'project_admins';
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
  createdBy?: string;
  /** Set when the rule was added from a rule template. */
  template?: { key: string; version: number } | null;
  runbookUrl?: string | null;
  mutedUntil?: string | null;
  mutedBy?: string | null;
  muteReason?: string | null;
  lastEvaluation?: { at: string; targets: number; noDataTargets: number } | null;
}

/** Primary status of a rule (`derived[id].status` of `GET /alerts/rules`); `muted` is a flag next to it. */
export type RuleStatus = 'firing' | 'pending' | 'ok' | 'noData' | 'disabled';

export interface RuleDerivedDto {
  status: RuleStatus;
  muted: boolean;
  noData: boolean;
}

export interface RuleStatsDto {
  fired7d: number;
  /** Rolling 24 h buckets, oldest first. */
  daily7d: number[];
}

export interface RuleKpisDto {
  total: number;
  enabled: number;
  firing: number;
  muted: number;
  noData: number;
  /** Rules fired 10+ times in 7 days; null when the stats were not requested. */
  noisy: number | null;
}

/** `POST /alerts/rules/backtest` */
export interface BacktestResultDto {
  supported: boolean;
  reason?: 'legacy_metric' | 'mode_not_replayable';
  message?: string;
  days: number;
  stepMinutes: number;
  evaluations: number;
  fires: number;
  firesPerEntity: Array<{ entityKey: string; fires: number }>;
  incidents: Array<{ entityKey: string; firedAt: string; resolvedAt?: string }>;
  suggestion?: { threshold: number; firesAtThreshold: number; note?: string };
  notes?: string[];
}

/** One entry of the tenant channel library (`GET /alerts/channels/library`); masked, never a secret. */
export interface LibraryChannelDto {
  id: string;
  name: string;
  kind: AlertChannelType;
  config: MaskedChannel;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  usedBy: Array<{ ruleId: string; ruleName: string; projectId?: string }>;
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
  versionChange?: { from: string | null; to: string | null; firstSeenAt?: string } | null;
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
  /** The project the incident belongs to (an owner or admin may open one outside the active project). */
  projectId?: string;
  ruleName: string;
  ruleId: string;
  alertEventId: string;
  metric: string;
  threshold: number;
  actualValue: number;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assignedTo?: string | null;
  /** Names the server resolved for the ids (null when unknown); absent on an older server. */
  assignedToName?: string | null;
  acknowledgedByName?: string | null;
  resolvedByName?: string | null;
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
  /** Re-notifications are silenced until this ISO time (status unchanged). */
  snoozedUntil?: string | null;
  snoozedBy?: string | null;
  reopenedAt?: string | null;
  reopenCount?: number;
  context?: IncidentContextDto | null;
  metadata?: Record<string, unknown>;
  updatedAt?: string | null;
}

/** `GET /alerts/incidents/stats?range=` */
export interface IncidentStatsDto {
  range: '24h' | '7d' | '30d';
  open: number;
  acknowledged: number;
  resolvedInRange: number;
  firedInRange: number;
  /** MEDIAN ms fired -> acknowledged; null without a sample. */
  mttaMs: number | null;
  /** MEDIAN ms fired -> resolved; null without a sample. */
  mttrMs: number | null;
  sample: number;
  mttaSample: number;
  mttrSample: number;
  capped: boolean;
}

/** `GET /alerts/incidents/:id/similar` */
export interface SimilarIncidentsDto {
  count30d: number;
  medianDurationMs: number | null;
  last: Array<{ id: string; firedAt: string; resolvedAt: string | null; status: IncidentStatus }>;
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

/** The rule categories of the template catalog (`GET /alerts/templates` → `items[].category`). */
export type AlertTemplateCategoryDto = 'errors' | 'latency' | 'traffic' | 'cost' | 'quality' | 'safety';

/** `added`: a rule of the project came from the template. `covered`: another enabled rule already watches the same metric and mode. */
export type AlertTemplateStateDto = 'added' | 'covered' | 'available';

/** Whether this build and licence can run the template's rule. */
export type AlertTemplateAvailabilityDto =
  | { available: true }
  | { available: false; reason: 'not_enterprise_build' | 'license_required' };

/** The rule a template creates, in the shape `POST /alerts/rules` takes (the rule form's prefill). */
export interface AlertTemplateInputDto {
  name: string;
  description?: string;
  module: AlertModule;
  metric: string;
  condition: AlertConditionDto;
  windowMinutes: number;
  cooldownMinutes?: number;
  entity?: { entityType: EntityMetricType; mode: 'all' | 'selected'; keys?: string[] };
  severity?: AlertRuleSeverity;
  notifyOnResolve?: boolean;
  renotifyMinutes?: number;
  channels?: Array<{ type: AlertChannelType; recipients?: string[]; audience?: 'project_admins' }>;
  enabled?: boolean;
}

export interface AlertTemplateItemDto {
  key: string;
  version: number;
  category: AlertTemplateCategoryDto;
  module: AlertModule;
  metric: string;
  mode: AlertConditionMode;
  /** Part of the default set new projects get. */
  default: boolean;
  name: string;
  description: string;
  state: AlertTemplateStateDto;
  /** The rule added from the template (`added`) or the one covering it (`covered`). */
  rule?: { id: string; name: string; enabled: boolean };
  availability: AlertTemplateAvailabilityDto;
  input: AlertTemplateInputDto;
}

/** `GET /alerts/templates`. */
export interface AlertTemplateListDto {
  version: number;
  items: AlertTemplateItemDto[];
  /** Admins the template rules notify in this project; 0 means the workspace owners and admins get them. */
  projectAdminRecipients: number;
  /** Whether new projects get the default rules in this installation. */
  defaultRulesOnNewProjects: boolean;
}

/** `POST /alerts/templates` (201 when anything was created, else 200). */
export interface AlertTemplateApplyResultDto {
  created: AlertRuleDto[];
  skipped: Array<{ key: string; reason: 'exists' | 'covered' | 'unavailable' }>;
}
