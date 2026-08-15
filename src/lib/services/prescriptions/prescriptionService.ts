/**
 * Prescriptions service — evidence gathering, report content, lifecycle.
 *
 * Report generation is a read-mostly pipeline over data other services
 * already maintain: tracing overviews (AgentTracingService) and cost rollups
 * (cost service). This module never edits those services — it consumes their
 * outputs, runs the deterministic detector battery, and persists the result
 * as a prescription report. The optional LLM narrative is generated from the
 * finished findings and is explicitly forbidden (by prompt and by design)
 * from introducing numbers of its own.
 */

import { getDatabase } from '@/lib/database';
import type { IModel, IPrescriptionReport } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { AgentTracingService } from '@/lib/services/agentTracing';
import {
  getAgentCosts,
  getCostReport,
  getObservedModelCosts,
} from '@/lib/services/cost/costService';
import {
  invokeChatViaSdk,
  prepareSdkInvocation,
} from '@/lib/services/evaluation/sdkInvoker';
import { runDetectors } from './detectors';
import type {
  AgentOverviewEvidence,
  DetectorInput,
  FindingStatus,
  PrescriptionEligibilityEntry,
  PrescriptionFinding,
  PrescriptionSubjectKind,
  PrescriptionTotals,
} from './types';

const logger = createLogger('prescriptions:service');

export interface PrescriptionContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  userId?: string;
}

export const DEFAULT_WINDOW_DAYS = 14;
const MIN_WINDOW_DAYS = 3;
const MAX_WINDOW_DAYS = 90;

/** Sessions in the window an agent needs before an automatic analysis. */
export function minSessionsThreshold(): number {
  const parsed = Number(process.env.PRESCRIPTIONS_MIN_SESSIONS ?? 50);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

/** A ready report older than this is considered stale for auto-runs. */
export function staleDaysThreshold(): number {
  const parsed = Number(process.env.PRESCRIPTIONS_STALE_DAYS ?? 7);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export function clampWindowDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_DAYS;
  return Math.max(MIN_WINDOW_DAYS, Math.min(MAX_WINDOW_DAYS, Math.round(parsed)));
}

// ── Evidence gathering + detector run ──────────────────────────────────────

export interface ReportContent {
  findings: PrescriptionFinding[];
  totals: PrescriptionTotals;
  from: Date;
  to: Date;
}

/** Model overviews miss the agent-only blocks; pad them so detectors that
 *  need tools/daily simply see empty evidence and stay silent. */
function adaptModelOverview(raw: {
  model: { name: string; sessionsCount: number; latestSessionAt?: string | Date | null };
  analytics: {
    totals: AgentOverviewEvidence['analytics']['totals'];
    statuses: AgentOverviewEvidence['analytics']['statuses'];
    insights: AgentOverviewEvidence['analytics']['insights'];
  };
}): AgentOverviewEvidence {
  return {
    agent: {
      name: raw.model.name,
      sessionsCount: raw.model.sessionsCount,
      latestSessionAt: raw.model.latestSessionAt ?? null,
    },
    analytics: {
      totals: raw.analytics.totals,
      tools: { totals: { totalCalls: 0, errorCalls: 0, successCalls: 0, errorRate: 0 }, items: [] },
      statuses: raw.analytics.statuses,
      models: [],
      daily: [],
      insights: raw.analytics.insights,
    },
  };
}

/**
 * Gather the evidence bundle for a subject, run the detector battery, and
 * return the report content. Pure computation over service reads — status
 * transitions and persistence belong to the job layer.
 */
export async function buildPrescriptionReportContent(
  ctx: PrescriptionContext,
  params: {
    subjectKind: PrescriptionSubjectKind;
    subjectName?: string;
    windowDays: number;
  },
): Promise<ReportContent> {
  const windowDays = clampWindowDays(params.windowDays);
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const costCtx = {
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
  };

  // Observed models are gathered for every subject kind — cache-savings
  // estimates need the pricing attached to each observed entry.
  const observedModels = await getObservedModelCosts(costCtx, { from, to });

  const input: DetectorInput = {
    subject: { kind: params.subjectKind, name: params.subjectName },
    windowDays,
    observedModels,
  };
  let totals: PrescriptionTotals = {
    sessions: null,
    requests: null,
    totalTokens: null,
    costUsd: null,
  };

  if (params.subjectKind === 'workspace') {
    const [costReport, agentCosts] = await Promise.all([
      getCostReport(costCtx, { granularity: 'daily', from, to }),
      getAgentCosts(costCtx, { from, to }),
    ]);
    input.costReport = costReport;
    input.agentCosts = agentCosts;
    totals = {
      sessions: null,
      requests: costReport.totals.requests,
      totalTokens: costReport.totals.totalTokens,
      costUsd: costReport.totals.costUsd,
    };
  } else {
    if (!params.subjectName) {
      throw new Error(`subjectName is required for ${params.subjectKind} reports`);
    }
    const windowFilters = { from: from.toISOString(), to: to.toISOString() };
    if (params.subjectKind === 'agent') {
      const [overview, agentCosts] = await Promise.all([
        AgentTracingService.getAgentOverview(
          ctx.tenantDbName,
          ctx.projectId,
          params.subjectName,
          windowFilters,
        ),
        getAgentCosts(costCtx, { from, to }),
      ]);
      input.overview = overview as unknown as AgentOverviewEvidence;
      input.agentCost = agentCosts.entries.find((e) => e.agentKey === params.subjectName) ?? null;
      totals = {
        sessions: input.overview.analytics.totals.sessionsCount,
        requests: input.agentCost?.requests ?? null,
        totalTokens: input.overview.analytics.totals.totalTokens,
        costUsd: input.agentCost?.costUsd ?? null,
      };
    } else {
      const raw = await AgentTracingService.getModelOverview(
        ctx.tenantDbName,
        ctx.projectId,
        params.subjectName,
        windowFilters,
      );
      input.overview = adaptModelOverview(raw as unknown as Parameters<typeof adaptModelOverview>[0]);
      const entry = observedModels.entries.find((e) => e.modelKey === params.subjectName);
      totals = {
        sessions: input.overview.analytics.totals.sessionsCount,
        requests: entry?.requests ?? null,
        totalTokens: input.overview.analytics.totals.totalTokens,
        costUsd: entry?.costUsd ?? null,
      };
    }
  }

  return { findings: runDetectors(input), totals, from, to };
}

// ── Report CRUD (project-scoped views over the DB mixin) ───────────────────

export async function listPrescriptionReports(
  ctx: PrescriptionContext,
  filters: {
    subjectKind?: PrescriptionSubjectKind;
    subjectName?: string;
    limit?: number;
    skip?: number;
  } = {},
): Promise<{ reports: IPrescriptionReport[]; total: number }> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  return db.listPrescriptionReports({ projectId: ctx.projectId, ...filters });
}

export async function getPrescriptionReport(
  ctx: PrescriptionContext,
  reportId: string,
): Promise<IPrescriptionReport | null> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  const report = await db.findPrescriptionReportById(reportId);
  if (!report || report.projectId !== ctx.projectId) return null;
  return report;
}

export async function deletePrescriptionReport(
  ctx: PrescriptionContext,
  reportId: string,
): Promise<boolean> {
  const existing = await getPrescriptionReport(ctx, reportId);
  if (!existing?._id) return false;
  const db = await getDatabase();
  return db.deletePrescriptionReport(String(existing._id));
}

const FINDING_STATUSES: FindingStatus[] = ['open', 'applied', 'dismissed'];

/**
 * Prescription lifecycle: mark a finding applied / dismissed / reopened.
 * `applied` is what makes the loop closable — the next report on the same
 * subject shows whether the metric actually moved.
 */
export async function updateFindingStatus(
  ctx: PrescriptionContext,
  reportId: string,
  findingId: string,
  status: FindingStatus,
): Promise<IPrescriptionReport | null> {
  if (!FINDING_STATUSES.includes(status)) {
    throw new Error(`Invalid finding status: ${status}`);
  }
  const report = await getPrescriptionReport(ctx, reportId);
  if (!report?._id) return null;
  const findings = (report.findings as PrescriptionFinding[] | undefined) ?? [];
  let touched = false;
  const next = findings.map((finding) => {
    if (finding?.id !== findingId) return finding;
    touched = true;
    return { ...finding, status };
  });
  if (!touched) return null;
  const db = await getDatabase();
  return db.updatePrescriptionReport(String(report._id), { findings: next });
}

// ── Narrative (LLM synthesis — narrates findings, never discovers) ─────────

const NARRATIVE_SYSTEM_PROMPT = [
  'You are the analysis narrator of an AI operations platform.',
  'You receive DETERMINISTIC findings produced by detectors over observed agent traffic, as JSON.',
  'Write a concise executive narrative in English, in markdown.',
  'Hard rules:',
  '- Use ONLY figures that literally appear in the JSON, verbatim. Never invent, recompute, extrapolate, or round differently.',
  '- Never add findings, causes, or savings that are not in the JSON.',
  '- If a finding has estMonthlySavingsUsd null, do not attach any dollar figure to it.',
  '- Order by severity: critical, then warn, then info.',
  '- Structure: "## Summary" (2-3 sentences), "## Priorities" (numbered, one line each: what + prescribed action), "## Expected impact" (only findings with a non-null savings estimate; state it is a conservative estimate).',
  '- Maximum ~400 words.',
].join('\n');

export async function generateNarrative(
  ctx: PrescriptionContext,
  reportId: string,
  modelKey: string,
): Promise<IPrescriptionReport | null> {
  const report = await getPrescriptionReport(ctx, reportId);
  if (!report?._id) return null;
  if (report.status !== 'ready') {
    throw new Error('Narrative can only be generated for a ready report');
  }

  const { model, config } = await prepareSdkInvocation(
    { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId },
    modelKey,
  );

  const payload = {
    subject: { kind: report.subjectKind, name: report.subjectName ?? undefined },
    windowDays: report.windowDays,
    totals: report.totals ?? null,
    findings: ((report.findings as PrescriptionFinding[] | undefined) ?? []).map((f) => ({
      severity: f.severity,
      category: f.category,
      title: f.title,
      summary: f.summary,
      evidence: f.evidence,
      estMonthlySavingsUsd: f.estMonthlySavingsUsd,
      prescription: f.prescription.action,
    })),
  };

  const result = await invokeChatViaSdk(
    { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId },
    model as IModel,
    [
      { role: 'system', content: NARRATIVE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ],
    { config },
  );

  const text = result.text?.trim();
  if (!text) throw new Error('Narrative model returned an empty response');

  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  return db.updatePrescriptionReport(String(report._id), {
    narrative: { text, modelKey, generatedAt: new Date() },
  });
}

// ── Eligibility ("enough data arrived — analyse") ──────────────────────────

/**
 * Which subjects have enough windowed data for an automatic analysis, and
 * whether their latest ready report is stale. This is the product's trigger
 * surface: the UI renders it as "analysis available", and the auto-run
 * endpoint generates reports for every stale eligible subject.
 */
export async function getPrescriptionEligibility(
  ctx: PrescriptionContext,
  options: { windowDays?: number } = {},
): Promise<{
  windowDays: number;
  minSessions: number;
  staleDays: number;
  entries: PrescriptionEligibilityEntry[];
}> {
  const windowDays = clampWindowDays(options.windowDays ?? DEFAULT_WINDOW_DAYS);
  const minSessions = minSessionsThreshold();
  const staleDays = staleDaysThreshold();
  const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const [{ agents }, { reports }] = await Promise.all([
    AgentTracingService.listRecentAgents(ctx.tenantDbName, ctx.projectId, { from, limit: 100 }),
    listPrescriptionReports(ctx, { limit: 200 }),
  ]);

  // Newest ready report per subject (list is createdAt-desc).
  const latestReady = new Map<string, IPrescriptionReport>();
  const inFlight = new Set<string>();
  for (const report of reports) {
    const key = `${report.subjectKind}:${report.subjectName ?? ''}`;
    if (report.status === 'ready' && !latestReady.has(key)) latestReady.set(key, report);
    if (report.status === 'pending' || report.status === 'running') inFlight.add(key);
  }

  const staleBefore = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const entryFor = (
    subjectKind: PrescriptionSubjectKind,
    subjectName: string | undefined,
    sessionsCount: number,
  ): PrescriptionEligibilityEntry => {
    const key = `${subjectKind}:${subjectName ?? ''}`;
    const last = latestReady.get(key);
    const lastAt = last?.createdAt ? new Date(last.createdAt) : null;
    return {
      subjectKind,
      subjectName,
      sessionsCount,
      eligible: sessionsCount >= minSessions,
      lastReportId: last?._id ? String(last._id) : undefined,
      lastReportAt: lastAt ? lastAt.toISOString() : undefined,
      // In-flight reports are not stale — auto-run must not double-enqueue.
      stale: !inFlight.has(key) && (!lastAt || lastAt.getTime() < staleBefore),
    };
  };

  const totalSessions = agents.reduce((sum, a) => sum + a.sessionsCount, 0);
  const entries: PrescriptionEligibilityEntry[] = [
    entryFor('workspace', undefined, totalSessions),
    ...agents.map((agent) => entryFor('agent', agent.name, agent.sessionsCount)),
  ];

  return { windowDays, minSessions, staleDays, entries };
}

export { logger as prescriptionLogger };
