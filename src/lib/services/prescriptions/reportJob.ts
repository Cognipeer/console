/**
 * Async prescription report generation — queue enqueue + job runner.
 *
 * Evidence gathering reads full session windows (tracing overviews can take
 * tens of seconds on large tenants), so generation never runs inside an HTTP
 * request. Mirrors the snapshot job: enqueue creates the report row with
 * status 'pending' and responds 202; the consumer runs the detector battery
 * and flips the row to 'ready' (or 'failed' + error). The UI polls the
 * normal report endpoints.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import {
  buildPrescriptionReportContent,
  clampWindowDays,
  getPrescriptionEligibility,
  type PrescriptionContext,
} from './prescriptionService';
import type { PrescriptionSubjectKind } from './types';

const logger = createLogger('prescriptions:job');

/** Dedicated queue + job name (plain name works on both memory + bullmq). */
export const PRESCRIPTION_QUEUE = 'prescription-report';
export const PRESCRIPTION_JOB = 'prescription.generate';

export interface PrescriptionJobPayload extends QueuePayload {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  reportId: string;
  subjectKind: PrescriptionSubjectKind;
  subjectName?: string;
  windowDays: number;
  enqueuedAt: string;
}

/**
 * Create the pending report row and publish the generation job. Idempotent
 * per subject: while a pending/running report already exists for the same
 * subject, that one is returned instead of enqueueing a duplicate.
 */
export async function enqueuePrescriptionReport(
  ctx: PrescriptionContext,
  params: {
    subjectKind: PrescriptionSubjectKind;
    subjectName?: string;
    windowDays?: number;
  },
): Promise<{ reportId: string; status: string; deduplicated: boolean }> {
  if (params.subjectKind !== 'workspace' && !params.subjectName?.trim()) {
    throw new Error(`subjectName is required for ${params.subjectKind} reports`);
  }
  const windowDays = clampWindowDays(params.windowDays);
  const subjectName = params.subjectKind === 'workspace' ? null : params.subjectName!.trim();

  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const { reports } = await db.listPrescriptionReports({
    projectId: ctx.projectId,
    subjectKind: params.subjectKind,
    subjectName: subjectName ?? undefined,
    limit: 5,
  });
  const inFlight = reports.find((r) => r.status === 'pending' || r.status === 'running');
  if (inFlight?._id) {
    return { reportId: String(inFlight._id), status: inFlight.status, deduplicated: true };
  }

  const report = await db.createPrescriptionReport({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    subjectKind: params.subjectKind,
    subjectName,
    windowDays,
    status: 'pending',
    findings: [],
    createdBy: ctx.userId ?? null,
  });

  const payload: PrescriptionJobPayload = {
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    userId: ctx.userId,
    reportId: String(report._id),
    subjectKind: params.subjectKind,
    subjectName: subjectName ?? undefined,
    windowDays,
    enqueuedAt: new Date().toISOString(),
  };
  const queue = await getQueue();
  await queue.publish(PRESCRIPTION_QUEUE, PRESCRIPTION_JOB, payload, {
    attempts: 2,
    backoffMs: 5000,
  });
  logger.info('Prescription report enqueued', {
    reportId: payload.reportId,
    subjectKind: params.subjectKind,
    subjectName,
  });
  return { reportId: payload.reportId, status: 'pending', deduplicated: false };
}

/** Execute one report generation. Throws on failure so the queue can retry. */
export async function runPrescriptionJob(payload: PrescriptionJobPayload): Promise<void> {
  await runWithTenantScope(payload.tenantDbName, async (db) => {
    await db.updatePrescriptionReport(payload.reportId, { status: 'running', error: null });
    const ctx: PrescriptionContext = {
      tenantDbName: payload.tenantDbName,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      userId: payload.userId,
    };
    try {
      const content = await buildPrescriptionReportContent(ctx, {
        subjectKind: payload.subjectKind,
        subjectName: payload.subjectName,
        windowDays: payload.windowDays,
      });
      await db.updatePrescriptionReport(payload.reportId, {
        status: 'ready',
        error: null,
        from: content.from,
        to: content.to,
        totals: content.totals as unknown as Record<string, unknown>,
        findings: content.findings,
        finishedAt: new Date(),
      });
      logger.info('Prescription report ready', {
        reportId: payload.reportId,
        findings: content.findings.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Report generation failed';
      await db.updatePrescriptionReport(payload.reportId, {
        status: 'failed',
        error: message,
        finishedAt: new Date(),
      });
      logger.error('Prescription report failed', { reportId: payload.reportId, error: message });
      throw err;
    }
  });
}

/** Cap on reports one auto-run call may enqueue (before the workspace one). */
const AUTO_RUN_MAX_AGENTS = 10;

/**
 * The "enough data arrived → analyse" trigger: enqueue reports for every
 * eligible subject whose latest ready report is stale. User- or scheduler-
 * initiated for the CURRENT tenant only — deliberately no cross-tenant
 * sweep (a platform-wide unbounded sweep is the exact failure mode that has
 * taken production down before).
 */
export async function runAutoAnalyses(
  ctx: PrescriptionContext,
  options: { windowDays?: number } = {},
): Promise<{
  enqueued: Array<{ subjectKind: PrescriptionSubjectKind; subjectName?: string; reportId: string }>;
  skipped: number;
}> {
  const eligibility = await getPrescriptionEligibility(ctx, options);
  const due = eligibility.entries.filter((e) => e.eligible && e.stale);
  const agents = due.filter((e) => e.subjectKind === 'agent').slice(0, AUTO_RUN_MAX_AGENTS);
  const workspace = due.filter((e) => e.subjectKind === 'workspace');

  const enqueued: Array<{ subjectKind: PrescriptionSubjectKind; subjectName?: string; reportId: string }> = [];
  for (const entry of [...workspace, ...agents]) {
    const result = await enqueuePrescriptionReport(ctx, {
      subjectKind: entry.subjectKind,
      subjectName: entry.subjectName,
      windowDays: eligibility.windowDays,
    });
    if (!result.deduplicated) {
      enqueued.push({
        subjectKind: entry.subjectKind,
        subjectName: entry.subjectName,
        reportId: result.reportId,
      });
    }
  }
  return { enqueued, skipped: due.length - enqueued.length };
}
