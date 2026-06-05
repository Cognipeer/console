/**
 * Incident service — CRUD and lifecycle operations for incidents.
 *
 * Incidents are created automatically when alerts fire and allow users
 * to track resolution through a defined status workflow:
 *   open → acknowledged → investigating → resolved → closed
 */

import { getTenantDatabase } from '@/lib/database';
import type {
  IIncident,
  IIncidentNote,
  IncidentStatus,
  IncidentSeverity,
  AlertMetric,
} from '@/lib/database';

/** Status transitions — which statuses are reachable from the current one */
const STATUS_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ['acknowledged', 'investigating', 'resolved', 'closed'],
  acknowledged: ['investigating', 'resolved', 'closed'],
  investigating: ['resolved', 'closed'],
  resolved: ['closed', 'open'],  // can reopen
  closed: ['open'],               // can reopen
};

/** Determine severity from metric + how far over threshold */
export function deriveSeverity(
  metric: AlertMetric,
  actualValue: number,
  threshold: number,
): IncidentSeverity {
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

    const severity = input.severity ?? deriveSeverity(
      input.metric,
      input.actualValue,
      input.threshold,
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
    });
  }

  /**
   * Update incident status with workflow validation.
   */
  static async updateStatus(
    tenantDbName: string,
    incidentId: string,
    newStatus: IncidentStatus,
    userId: string,
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    const incident = await db.findIncidentById(incidentId);
    if (!incident) return null;

    const allowed = STATUS_TRANSITIONS[incident.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Cannot transition from "${incident.status}" to "${newStatus}". Allowed: ${allowed.join(', ')}`,
      );
    }

    const updateData: Partial<IIncident> = { status: newStatus };

    if (newStatus === 'acknowledged') {
      updateData.acknowledgedAt = new Date();
    } else if (newStatus === 'resolved') {
      updateData.resolvedAt = new Date();
      updateData.resolvedBy = userId;
    } else if (newStatus === 'closed') {
      updateData.closedAt = new Date();
    }

    return db.updateIncident(incidentId, updateData);
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
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    const incident = await db.findIncidentById(incidentId);
    if (!incident) return null;

    const note: IIncidentNote = {
      userId,
      userName,
      content: content.trim(),
      createdAt: new Date(),
    };

    const notes = [...(incident.notes || []), note];
    return db.updateIncident(incidentId, { notes });
  }

  /**
   * Get a single incident by ID.
   */
  static async getIncident(
    tenantDbName: string,
    incidentId: string,
  ): Promise<IIncident | null> {
    const db = await getTenantDatabase(tenantDbName);
    return db.findIncidentById(incidentId);
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
}
