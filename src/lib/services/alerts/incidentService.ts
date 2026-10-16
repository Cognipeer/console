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
  IIncidentStatRow,
  IncidentSort,
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
    if (!cfg) return 'warning';
    // Direction-aware: a drop reads ratio < 1 and a negative z (EE judgeDeviation), a rise ratio > 1 and a positive z.
    const up = (ratio !== null && ratio >= 2 * cfg.minRatio) || (z !== null && z >= 2 * cfg.minZ);
    const down = (ratio !== null && cfg.minRatio > 0 && ratio <= 1 / (2 * cfg.minRatio)) || (z !== null && z <= -2 * cfg.minZ);
    if (cfg.direction === 'up' ? up : cfg.direction === 'down' ? down : up || down) return 'critical';
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

export type BulkIncidentAction = 'acknowledge' | 'resolve' | 'close' | 'assign' | 'snooze' | 'unsnooze' | 'reopen';

/** Bulk actions that are plain status transitions. */
const BULK_ACTION_STATUS: Partial<Record<BulkIncidentAction, IncidentStatus>> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  close: 'closed',
};

export const BULK_INCIDENT_ACTIONS: BulkIncidentAction[] = ['acknowledge', 'resolve', 'close', 'assign', 'snooze', 'unsnooze', 'reopen'];

/** Statuses an incident can be reopened from (the transition table allows resolved/closed; bulk reopen also takes acknowledged/investigating). */
export const REOPENABLE_STATUSES: IncidentStatus[] = ['acknowledged', 'investigating', 'resolved', 'closed'];
/** Statuses a snooze makes sense for: the incident is still live. */
export const SNOOZABLE_STATUSES: IncidentStatus[] = ['open', 'acknowledged', 'investigating'];

/** A snooze lasts at most this long. */
export const MAX_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export type IncidentStatsRange = '24h' | '7d' | '30d';
export const INCIDENT_STATS_RANGE_MS: Record<IncidentStatsRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
/** Most rows stats read; beyond it the numbers cover the newest incidents and `capped` is true. */
export const INCIDENT_STATS_ROW_CAP = 5000;

export interface IncidentStats {
  open: number;
  acknowledged: number;
  resolvedInRange: number;
  firedInRange: number;
  /** MEDIAN time from fired to acknowledged (ms) over incidents acknowledged in the range; null without a sample. */
  mttaMs: number | null;
  /** MEDIAN time from fired to resolved (ms) over incidents resolved in the range; null without a sample. */
  mttrMs: number | null;
  /** Distinct incidents examined. */
  sample: number;
  mttaSample: number;
  mttrSample: number;
  capped: boolean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Pure stats math over the minimal rows. MTTA counts an acknowledgement that
 * happened in the range, at/after the firing and not before the latest reopen
 * (an acknowledgement kept across a reopen is stale); MTTR counts a resolution
 * in the range at/after the firing (reopen clears resolvedAt, so a reopened
 * incident drops out until resolved again; closed-without-resolve never has one).
 */
export function computeIncidentStats(
  rows: IIncidentStatRow[],
  counts: Pick<Record<IncidentStatus, number>, 'open' | 'acknowledged'>,
  since: Date,
  capped = false,
): IncidentStats {
  const sinceMs = since.getTime();
  const at = (value: Date | string | null | undefined): number | null => {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  let firedInRange = 0;
  let resolvedInRange = 0;
  const mtta: number[] = [];
  const mttr: number[] = [];
  for (const row of rows) {
    const firedAt = at(row.firedAt);
    if (firedAt === null) continue;
    if (firedAt >= sinceMs) firedInRange += 1;
    const ackAt = at(row.acknowledgedAt);
    const reopenedAt = at(row.reopenedAt);
    if (ackAt !== null && ackAt >= firedAt && ackAt >= sinceMs && (reopenedAt === null || ackAt >= reopenedAt)) {
      mtta.push(ackAt - firedAt);
    }
    const resolvedAt = at(row.resolvedAt);
    if (resolvedAt !== null && resolvedAt >= sinceMs) {
      resolvedInRange += 1;
      if (resolvedAt >= firedAt) mttr.push(resolvedAt - firedAt);
    }
  }
  return {
    open: counts.open ?? 0,
    acknowledged: counts.acknowledged ?? 0,
    resolvedInRange,
    firedInRange,
    mttaMs: median(mtta),
    mttrMs: median(mttr),
    sample: rows.length,
    mttaSample: mtta.length,
    mttrSample: mttr.length,
    capped,
  };
}

export const MAX_BULK_INCIDENTS = 100;

export interface BulkIncidentParams {
  /** `assign`: a user id or null to unassign (the route maps 'me' to the caller). */
  assignedTo?: string | null;
  /** `snooze`: when the snooze ends. */
  until?: Date;
}

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
      Object.assign(updateData, { snoozedUntil: null, snoozedBy: null });
    } else if (newStatus === 'closed') {
      updateData.closedAt = new Date();
      Object.assign(updateData, { snoozedUntil: null, snoozedBy: null });
    } else if (newStatus === 'open') {
      // Reopening: the incident must no longer read as resolved or closed, by anyone or by the system.
      // Both providers store null as a cleared value.
      Object.assign(updateData, {
        resolvedAt: null, resolvedBy: null, closedAt: null, autoResolved: false,
        reopenedAt: new Date(), reopenCount: (incident.reopenCount ?? 0) + 1,
      });
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
      snoozedUntil: null,
      snoozedBy: null,
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

  /**
   * The assignee as it is stored: a user id of this tenant, or null (unassign).
   * Anything else is a 400, so an assignment never points at a stranger.
   */
  static async resolveAssignee(tenantDbName: string, assignedTo: string | null): Promise<string | null> {
    const value = typeof assignedTo === 'string' && assignedTo.trim() ? assignedTo.trim() : null;
    if (!value) return null;
    const db = await getTenantDatabase(tenantDbName);
    const user = await db.findUserById(value).catch(() => null);
    if (!user) throw new AlertApiError(400, 'invalid_assignee', 'assignedTo is not a user of this tenant');
    return value;
  }

  /** A snooze must end in the future and at most 30 days ahead. */
  static assertSnoozeWindow(until: Date): void {
    const ms = until instanceof Date ? until.getTime() : NaN;
    const nowMs = Date.now();
    if (!Number.isFinite(ms) || ms <= nowMs) {
      throw new AlertApiError(400, 'invalid_snooze', 'snooze must end in the future');
    }
    if (ms > nowMs + MAX_SNOOZE_MS) {
      throw new AlertApiError(400, 'invalid_snooze', 'snooze can be at most 30 days');
    }
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
   * Reopen an incident from acknowledged, investigating, resolved or closed
   * (the transition table alone only reopens resolved/closed; PATCH keeps that
   * table, the bulk action is the wider one). Clears the resolution fields,
   * stamps `reopenedAt` and counts the reopening.
   */
  static async reopen(
    tenantDbName: string,
    incidentId: string,
    scope: IncidentScope = {},
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    const incident = await db.findIncidentById(incidentId, scope.projectId);
    if (!incident) return null;
    if (!REOPENABLE_STATUSES.includes(incident.status)) {
      throw new AlertApiError(409, 'invalid_transition', `Cannot reopen an incident that is "${incident.status}"`);
    }
    // null clears a field in both providers (the IIncident date fields are typed without null).
    const update = {
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      closedAt: null,
      autoResolved: false,
      reopenedAt: new Date(),
      reopenCount: (incident.reopenCount ?? 0) + 1,
    } as unknown as Partial<IIncident>;
    return db.updateIncident(incidentId, update, scope.projectId);
  }

  /**
   * Silence re-notifications of a live incident until `until` (status unchanged),
   * or clear the snooze with null. Resolved/closed incidents cannot be snoozed
   * (resolve/close already cleared it); clearing is always allowed.
   */
  static async snooze(
    tenantDbName: string,
    incidentId: string,
    until: Date | null,
    userId: string,
    scope: IncidentScope = {},
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    const incident = await db.findIncidentById(incidentId, scope.projectId);
    if (!incident) return null;
    if (until === null) {
      return db.updateIncident(incidentId, { snoozedUntil: null, snoozedBy: null }, scope.projectId);
    }
    IncidentService.assertSnoozeWindow(until);
    if (!SNOOZABLE_STATUSES.includes(incident.status)) {
      throw new AlertApiError(409, 'invalid_transition', `Cannot snooze an incident that is "${incident.status}"`);
    }
    return db.updateIncident(incidentId, { snoozedUntil: until, snoozedBy: userId }, scope.projectId);
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
    params: BulkIncidentParams = {},
  ): Promise<{ updated: number; failed: Array<{ id: string; error: string }>; results: Array<{ id: string; ok: boolean; error?: string }> }> {
    if (!BULK_INCIDENT_ACTIONS.includes(action)) {
      throw new AlertApiError(400, 'invalid_action', `action must be one of: ${BULK_INCIDENT_ACTIONS.join(', ')}`);
    }
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > MAX_BULK_INCIDENTS) {
      throw new AlertApiError(400, 'invalid_ids', `ids must contain 1 to ${MAX_BULK_INCIDENTS} incident ids`);
    }
    if (action === 'snooze') IncidentService.assertSnoozeWindow(params.until as Date);
    let assignee: string | null = null;
    if (action === 'assign') {
      if (params.assignedTo === undefined) {
        throw new AlertApiError(400, 'invalid_assignee', 'assignedTo (a user id, "me" or null) is required');
      }
      assignee = await IncidentService.resolveAssignee(tenantDbName, params.assignedTo);
    }

    let updated = 0;
    const failed: Array<{ id: string; error: string }> = [];
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of unique) {
      try {
        let incident: IIncident | null;
        switch (action) {
          case 'assign':
            incident = await IncidentService.assign(tenantDbName, id, assignee, scope);
            break;
          case 'snooze':
            incident = await IncidentService.snooze(tenantDbName, id, params.until as Date, actor.userId, scope);
            break;
          case 'unsnooze':
            incident = await IncidentService.snooze(tenantDbName, id, null, actor.userId, scope);
            break;
          case 'reopen':
            incident = await IncidentService.reopen(tenantDbName, id, scope);
            break;
          default:
            incident = await IncidentService.updateStatus(tenantDbName, id, BULK_ACTION_STATUS[action] as IncidentStatus, actor.userId, scope);
        }
        if (incident) { updated += 1; results.push({ id, ok: true }); }
        else { failed.push({ id, error: 'Incident not found' }); results.push({ id, ok: false, error: 'Incident not found' }); }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Update failed';
        failed.push({ id, error: message });
        results.push({ id, ok: false, error: message });
      }
    }
    return { updated, failed, results };
  }

  /**
   * Incident stats for a project over a range: live counts per status plus,
   * from a bounded read of minimal rows (fired in the range, or resolved in it),
   * how many were fired / resolved and the MEDIAN time to acknowledge / resolve.
   */
  static async stats(
    tenantDbName: string,
    projectId: string,
    range: IncidentStatsRange,
    now: Date = new Date(),
  ): Promise<IncidentStats> {
    const db = await getTenantDatabase(tenantDbName);
    const since = new Date(now.getTime() - INCIDENT_STATS_RANGE_MS[range]);
    const [counts, rows] = await Promise.all([
      db.countIncidentsByStatus(projectId),
      db.listIncidentStatRows(projectId, { firedSince: since, resolvedSince: since, limit: INCIDENT_STATS_ROW_CAP }),
    ]);
    const list = Array.isArray(rows) ? rows : [];
    return computeIncidentStats(list, counts ?? { open: 0, acknowledged: 0 }, since, list.length >= INCIDENT_STATS_ROW_CAP);
  }

  /**
   * Past incidents of the same rule and entity (last 30 days, the incident itself excluded):
   * count, MEDIAN duration of the resolved ones and the five newest. Bounded by the store
   * page (200 rows), so `count30d` tops out there on a very noisy pair.
   */
  static async similar(
    tenantDbName: string,
    tenantId: string,
    incident: IIncident,
    now: Date = new Date(),
  ): Promise<{ count30d: number; medianDurationMs: number | null; last: Array<{ id: string; firedAt: Date; resolvedAt: Date | null; status: IncidentStatus }> }> {
    const db = await getTenantDatabase(tenantDbName);
    const rows = await db.listIncidents(tenantId, {
      projectId: incident.projectId,
      ruleId: incident.ruleId,
      ...(incident.entityKey ? { entityKey: incident.entityKey } : {}),
      firedAfter: new Date(now.getTime() - INCIDENT_STATS_RANGE_MS['30d']),
      excludeId: String(incident._id),
      sort: '-firedAt',
      limit: 200,
    });
    const others = rows.filter((row) => String(row._id) !== String(incident._id))
      .filter((row) => (incident.entityKey ? row.entityKey === incident.entityKey : !row.entityKey));
    const durations = others
      .filter((row) => row.resolvedAt)
      .map((row) => new Date(row.resolvedAt as Date).getTime() - new Date(row.firedAt).getTime())
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    return {
      count30d: others.length,
      medianDurationMs: median(durations),
      last: others.slice(0, 5).map((row) => ({
        id: String(row._id),
        firedAt: row.firedAt,
        resolvedAt: row.resolvedAt ?? null,
        status: row.status,
      })),
    };
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
      updatedAfter?: Date;
      firedAfter?: Date;
      q?: string;
      assignee?: string | null;
      snoozed?: boolean;
      excludeId?: string;
      sort?: IncidentSort;
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

  /**
   * Display names of the people an incident list or detail refers to
   * (acknowledged / assigned / resolved by). ONE read of the tenant's users,
   * and only when the page names somebody. 'system' (automatic resolution) and
   * ids that match no user are absent; emails are never exposed.
   */
  static async resolveUserNames(
    tenantDbName: string,
    incidents: Array<Pick<IIncident, 'acknowledgedBy' | 'assignedTo' | 'resolvedBy'>>,
  ): Promise<Map<string, string>> {
    const wanted = new Set<string>();
    for (const incident of incidents) {
      for (const id of [incident.acknowledgedBy, incident.assignedTo, incident.resolvedBy]) {
        if (typeof id === 'string' && id && id !== 'system') wanted.add(id);
      }
    }
    const names = new Map<string, string>();
    if (wanted.size === 0) return names;
    try {
      const db = await getTenantDatabase(tenantDbName);
      for (const user of await db.listUsers()) {
        const id = String(user._id ?? '');
        const name = typeof user.name === 'string' ? user.name.trim() : '';
        if (id && name && wanted.has(id)) names.set(id, name);
      }
    } catch { /* names are a convenience: the ids still identify the people */ }
    return names;
  }

  /** The incident with `acknowledgedByName`, `assignedToName` and `resolvedByName` (string | null). */
  static withUserNames<T extends Pick<IIncident, 'acknowledgedBy' | 'assignedTo' | 'resolvedBy'>>(
    incident: T,
    names: Map<string, string>,
  ): T & { acknowledgedByName: string | null; assignedToName: string | null; resolvedByName: string | null } {
    const nameOf = (id: string | null | undefined) => (id ? names.get(id) ?? null : null);
    return {
      ...incident,
      acknowledgedByName: nameOf(incident.acknowledgedBy),
      assignedToName: nameOf(incident.assignedTo),
      resolvedByName: nameOf(incident.resolvedBy),
    };
  }

  /** Incident counts per status for one project (every status present). */
  static async countByStatus(tenantDbName: string, projectId: string): Promise<Record<IncidentStatus, number>> {
    const db = await getTenantDatabase(tenantDbName);
    return db.countIncidentsByStatus(projectId);
  }
}
