/**
 * Incident service — CRUD and lifecycle operations for incidents.
 *
 * Incidents are created automatically when alerts fire and allow users
 * to track resolution through a defined status workflow:
 *   open → acknowledged → investigating → resolved → closed
 *
 * Failures that are the caller's doing (unknown incident, illegal transition,
 * bad input) are thrown as `AlertApiError`, so the API answers 4xx instead of 500.
 */

import { getTenantDatabase } from '@/lib/database';
import type {
  AlertConditionOperator,
  AlertModule,
  AlertRuleSeverity,
  EntityMetricType,
  IAlertCondition,
  IIncident,
  IIncidentContext,
  IIncidentNote,
  IncidentStatus,
  IncidentSeverity,
  AlertMetric,
} from '@/lib/database';
import { AlertApiError } from './alertApiError';

/** Status transitions — which statuses are reachable from the current one */
const STATUS_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ['acknowledged', 'investigating', 'resolved', 'closed'],
  acknowledged: ['investigating', 'resolved', 'closed'],
  investigating: ['resolved', 'closed'],
  resolved: ['closed', 'open'],  // can reopen
  closed: ['open'],               // can reopen
};

export const INCIDENT_STATUSES: IncidentStatus[] = ['open', 'acknowledged', 'investigating', 'resolved', 'closed'];
export const INCIDENT_SEVERITIES: IncidentSeverity[] = ['critical', 'warning', 'info'];

/** How far past the threshold a breach is, as a ratio >= 1 when breached (operator-aware). */
function breachRatio(operator: AlertConditionOperator | undefined, actual: number, threshold: number): number | null {
  if (!Number.isFinite(actual) || !Number.isFinite(threshold)) return null;
  // A zero or negative threshold has no meaningful ratio.
  if (threshold <= 0) return null;
  if (operator === 'lt' || operator === 'lte') return threshold / Math.max(actual, 1e-9);
  if (operator === 'gt' || operator === 'gte') return actual / threshold;
  return null;
}

function severityFromRatio(ratio: number): IncidentSeverity {
  if (ratio >= 2) return 'critical';
  if (ratio >= 1.25) return 'warning';
  return 'info';
}

/**
 * Determine severity from metric + how far over threshold.
 *
 * With an `operator` the ratio is operator-aware (`lt` rules compare
 * threshold/actual). Without one the legacy heuristic applies.
 */
export function deriveSeverity(
  metric: AlertMetric,
  actualValue: number,
  threshold: number,
  operator?: AlertConditionOperator,
): IncidentSeverity {
  if (operator) {
    const ratio = breachRatio(operator, actualValue, threshold);
    return ratio === null ? 'warning' : severityFromRatio(ratio);
  }

  const ratio = threshold !== 0 ? actualValue / threshold : 1;

  // Error-rate based metrics are critical if ≥ 2× threshold
  if (metric === 'error_rate' || metric === 'guardrail_fail_rate') {
    if (ratio >= 2) return 'critical';
    return 'warning';
  }

  // General heuristic
  if (ratio >= 3) return 'critical';
  if (ratio >= 1.5) return 'warning';
  return 'info';
}

export interface RuleSeverityInput {
  rule: {
    metric: AlertMetric;
    severity?: AlertRuleSeverity | null;
    condition: IAlertCondition;
  };
  value: number | null;
  baseline?: { ratio: number | null; z: number | null } | null;
  slo?: { burnShort: number | null } | null;
}

/**
 * Severity of a fired alert: the rule's own unless it is 'auto' (or unset), then
 * derived from the breach — threshold ratio (operator-aware), baseline ratio/z,
 * absence (always critical) or SLO burn.
 */
export function deriveRuleSeverity(input: RuleSeverityInput): IncidentSeverity {
  const configured = input.rule.severity;
  if (configured && configured !== 'auto') return configured;

  const { condition } = input.rule;
  const mode = condition.mode ?? 'threshold';

  if (mode === 'absence') return 'critical';

  if (mode === 'baseline') {
    const cfg = condition.baseline;
    const ratio = input.baseline?.ratio ?? null;
    const z = input.baseline?.z ?? null;
    if (cfg && ((ratio !== null && ratio >= 2 * cfg.minRatio) || (z !== null && z >= 2 * cfg.minZ))) return 'critical';
    return 'warning';
  }

  if (mode === 'slo_burn') {
    const burnShort = input.slo?.burnShort ?? null;
    const burnRate = condition.slo?.burnRate;
    if (burnShort !== null && burnRate !== undefined && burnShort >= 2 * burnRate) return 'critical';
    return 'warning';
  }

  if (input.value === null) return 'warning';
  return deriveSeverity(input.rule.metric, input.value, condition.threshold, condition.operator);
}

export interface CreateIncidentInput {
  tenantId: string;
  projectId: string;
  alertEventId: string;
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  threshold: number;
  actualValue: number;
  severity?: IncidentSeverity;
  metadata?: Record<string, unknown>;
  firedAt: Date;
  module?: AlertModule;
  entityType?: EntityMetricType | null;
  entityKey?: string | null;
  baselineValue?: number | null;
  peakValue?: number | null;
  context?: IIncidentContext;
}

/** Narrowing for by-id access: when `projectId` is given a record of another project reads as missing. */
export interface IncidentScope {
  projectId?: string;
}

export interface IncidentActor {
  userId: string;
  userName?: string;
}

export type BulkIncidentAction = 'acknowledge' | 'resolve' | 'close';

const BULK_ACTION_STATUS: Record<BulkIncidentAction, IncidentStatus> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  close: 'closed',
};

export const MAX_BULK_INCIDENTS = 100;

export class IncidentService {
  /**
   * Create a new incident (typically called by the alert evaluator).
   */
  static async createIncident(
    tenantDbName: string,
    input: CreateIncidentInput,
  ): Promise<IIncident> {
    const db = await getTenantDatabase(tenantDbName);

    const operator = (input.metadata?.operator as AlertConditionOperator | undefined) ?? undefined;
    const severity = input.severity ?? deriveSeverity(
      input.metric,
      input.actualValue,
      input.threshold,
      operator,
    );

    return db.createIncident({
      tenantId: input.tenantId,
      projectId: input.projectId,
      alertEventId: input.alertEventId,
      ruleId: input.ruleId,
      ruleName: input.ruleName,
      metric: input.metric,
      threshold: input.threshold,
      actualValue: input.actualValue,
      severity,
      status: 'open',
      notes: [],
      firedAt: input.firedAt,
      metadata: input.metadata,
      ...(input.module ? { module: input.module } : {}),
      ...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
      ...(input.entityKey !== undefined ? { entityKey: input.entityKey } : {}),
      ...(input.baselineValue !== undefined ? { baselineValue: input.baselineValue } : {}),
      lastValue: input.actualValue,
      peakValue: input.peakValue ?? input.actualValue,
      ...(input.context ? { context: input.context } : {}),
    });
  }

  /**
   * Update incident status with workflow validation.
   *
   * `userId` of `'system'` marks an automatic resolution. `scope.projectId`
   * narrows the lookup to that project (a record of another project reads as
   * not found).
   */
  static async updateStatus(
    tenantDbName: string,
    incidentId: string,
    newStatus: IncidentStatus,
    userId: string,
    scope: IncidentScope = {},
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    const incident = await db.findIncidentById(incidentId, scope.projectId);
    if (!incident) return null;

    if (!INCIDENT_STATUSES.includes(newStatus)) {
      throw new AlertApiError(400, 'invalid_status', `Invalid status. Must be one of: ${INCIDENT_STATUSES.join(', ')}`);
    }

    const allowed = STATUS_TRANSITIONS[incident.status];
    if (!allowed.includes(newStatus)) {
      throw new AlertApiError(
        409,
        'invalid_transition',
        `Cannot transition from "${incident.status}" to "${newStatus}". Allowed: ${allowed.join(', ')}`,
      );
    }

    const updateData: Partial<IIncident> = { status: newStatus };

    if (newStatus === 'acknowledged') {
      updateData.acknowledgedAt = new Date();
      updateData.acknowledgedBy = userId;
    } else if (newStatus === 'resolved') {
      updateData.resolvedAt = new Date();
      updateData.resolvedBy = userId;
    } else if (newStatus === 'closed') {
      updateData.closedAt = new Date();
    } else if (newStatus === 'open') {
      // Reopening: the incident must no longer read as resolved or closed, by anyone or by the system.
      // Both providers store null as a cleared value.
      Object.assign(updateData, { resolvedAt: null, resolvedBy: null, closedAt: null, autoResolved: false });
    }

    return db.updateIncident(incidentId, updateData, scope.projectId);
  }

  /**
   * Resolve an incident because the alert recovered by itself. A person may
   * already have resolved or closed it: then it is left alone (null returned).
   */
  static async autoResolve(
    tenantDbName: string,
    incidentId: string,
    note: string,
    values: { lastValue?: number | null; peakValue?: number | null } = {},
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    const incident = await db.findIncidentById(incidentId);
    if (!incident) return null;
    if (incident.status !== 'open' && incident.status !== 'acknowledged' && incident.status !== 'investigating') return null;

    const now = new Date();
    const notes: IIncidentNote[] = [
      ...(incident.notes || []),
      { userId: 'system', userName: 'System', content: note, createdAt: now },
    ];
    return db.updateIncident(incidentId, {
      status: 'resolved',
      resolvedAt: now,
      resolvedBy: 'system',
      autoResolved: true,
      notes,
      ...(values.lastValue !== undefined ? { lastValue: values.lastValue } : {}),
      ...(values.peakValue !== undefined && values.peakValue !== null ? { peakValue: values.peakValue } : {}),
    });
  }

  /** Append a system note without touching the status (e.g. "Rule disabled"). */
  static async addSystemNote(tenantDbName: string, incidentId: string, content: string): Promise<IIncident | null> {
    return IncidentService.addNote(tenantDbName, incidentId, 'system', 'System', content);
  }

  /**
   * Add a note to an incident.
   */
  static async addNote(
    tenantDbName: string,
    incidentId: string,
    userId: string,
    userName: string,
    content: string,
    scope: IncidentScope = {},
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    const incident = await db.findIncidentById(incidentId, scope.projectId);
    if (!incident) return null;

    const note: IIncidentNote = {
      userId,
      userName,
      content: content.trim(),
      createdAt: new Date(),
    };

    const notes = [...(incident.notes || []), note];
    return db.updateIncident(incidentId, { notes }, scope.projectId);
  }

  /** Assign (or unassign with null / empty) an incident. */
  static async assign(
    tenantDbName: string,
    incidentId: string,
    assignedTo: string | null,
    scope: IncidentScope = {},
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    const incident = await db.findIncidentById(incidentId, scope.projectId);
    if (!incident) return null;
    const value = typeof assignedTo === 'string' && assignedTo.trim() ? assignedTo.trim() : null;
    // `null` clears the field (Mongo stores null, SQLite NULL): both read as unassigned.
    return db.updateIncident(incidentId, { assignedTo: value as unknown as string }, scope.projectId);
  }

  /**
   * Apply one action to many incidents (<= 100). Each id is handled on its own:
   * an unknown id or illegal transition lands in `failed`, never aborts the rest.
   */
  static async bulkUpdate(
    tenantDbName: string,
    ids: string[],
    action: BulkIncidentAction,
    actor: IncidentActor,
    scope: IncidentScope = {},
  ): Promise<{ updated: number; failed: Array<{ id: string; error: string }> }> {
    const status = BULK_ACTION_STATUS[action];
    if (!status) {
      throw new AlertApiError(400, 'invalid_action', 'action must be one of: acknowledge, resolve, close');
    }
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > MAX_BULK_INCIDENTS) {
      throw new AlertApiError(400, 'invalid_ids', `ids must contain 1 to ${MAX_BULK_INCIDENTS} incident ids`);
    }

    let updated = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of unique) {
      try {
        const incident = await IncidentService.updateStatus(tenantDbName, id, status, actor.userId, scope);
        if (incident) updated += 1;
        else failed.push({ id, error: 'Incident not found' });
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : 'Update failed' });
      }
    }
    return { updated, failed };
  }

  /**
   * Get a single incident by ID.
   */
  static async getIncident(
    tenantDbName: string,
    incidentId: string,
    scope: IncidentScope = {},
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    return db.findIncidentById(incidentId, scope.projectId);
  }

  /**
   * List incidents with filters.
   */
  static async listIncidents(
    tenantDbName: string,
    tenantId: string,
    options?: {
      projectId?: string;
      ruleId?: string;
      status?: IncidentStatus;
      severity?: IncidentSeverity;
      module?: AlertModule;
      entityKey?: string;
      limit?: number;
      skip?: number;
    },
  ): Promise<IIncident[]> {
    const db = await getTenantDatabase(tenantDbName);
    return db.listIncidents(tenantId, options);
  }

  /**
   * Count incidents (e.g. open incidents for badge).
   */
  static async countIncidents(
    tenantDbName: string,
    tenantId: string,
    options?: { projectId?: string; status?: IncidentStatus },
  ): Promise<number> {
    const db = await getTenantDatabase(tenantDbName);
    return db.countIncidents(tenantId, options);
  }

  /** Incident counts per status for one project (every status present). */
  static async countByStatus(tenantDbName: string, projectId: string): Promise<Record<IncidentStatus, number>> {
    const db = await getTenantDatabase(tenantDbName);
    return db.countIncidentsByStatus(projectId);
  }
}
