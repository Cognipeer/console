/**
 * Prescriptions — automated analysis reports over observed traffic.
 *
 * A report is generated per SUBJECT (one agent, one model, or the whole
 * workspace) over a time window. A battery of deterministic detectors turns
 * the already-collected evidence (tracing overview + cost rollups) into
 * FINDINGS: each one names the problem, shows the evidence, and prescribes a
 * concrete action. Numbers only ever come from detectors — the optional LLM
 * narrative NARRATES findings, it never discovers or invents them.
 */

import type { AgentInsights } from '@/lib/services/agentTracing';
import type {
  AgentCostEntry,
  AgentCosts,
  CostReport,
  ObservedModelCosts,
} from '@/lib/services/cost/costService';

export type PrescriptionSubjectKind = 'agent' | 'model' | 'workspace';

export type FindingSeverity = 'info' | 'warn' | 'critical';
export type FindingCategory = 'cost' | 'reliability' | 'performance' | 'hygiene';
export type FindingStatus = 'open' | 'applied' | 'dismissed';

export interface FindingEvidence {
  label: string;
  value: string;
}

export interface PrescriptionFinding {
  /** Unique within the report: `<detector>` or `<detector>:<discriminator>`. */
  id: string;
  detector: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  summary: string;
  evidence: FindingEvidence[];
  /**
   * Honest, conservative monthly estimate. null = the problem is real but
   * cannot be priced from the available data (e.g. the model is unpriced) —
   * NEVER guessed.
   */
  estMonthlySavingsUsd: number | null;
  prescription: {
    action: string;
    ctaLabel?: string;
    ctaHref?: string;
  };
  status: FindingStatus;
}

/** Aggregate figures snapshot stored on the report for the header tiles. */
export interface PrescriptionTotals {
  sessions: number | null;
  requests: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

/**
 * Structural type for the slice of `AgentTracingService.getAgentOverview` /
 * `getModelOverview` output the detectors consume. Kept structural (not the
 * service's inferred return type) so detectors stay a pure, independently
 * testable module.
 */
export interface AgentOverviewEvidence {
  agent: {
    name: string;
    sessionsCount: number;
    latestSessionAt: string | Date | null;
  };
  analytics: {
    totals: {
      sessionsCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCachedInputTokens: number;
      totalTokens: number;
      averageDurationMs: number;
    };
    tools: {
      totals: { totalCalls: number; errorCalls: number; successCalls: number; errorRate: number };
      items: Array<{
        toolName: string;
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      }>;
    };
    statuses: Array<{ status: string; count: number }>;
    models: Array<{ model: string; sessionsCount: number }>;
    daily: Array<{ date: string; sessionsCount: number; totalTokens: number }>;
    insights: AgentInsights | null;
  };
}

/** Everything a detector may look at. Gathered once per report generation. */
export interface DetectorInput {
  subject: { kind: PrescriptionSubjectKind; name?: string };
  windowDays: number;
  /** Present for agent/model subjects. */
  overview?: AgentOverviewEvidence;
  /** The subject agent's cost entry (agent subjects, when attributable). */
  agentCost?: AgentCostEntry | null;
  /** Workspace-wide evidence (always gathered — pricing lookups need it). */
  observedModels?: ObservedModelCosts;
  /** Workspace subjects only. */
  costReport?: CostReport;
  agentCosts?: AgentCosts;
}

export type DetectorFn = (input: DetectorInput) => PrescriptionFinding[];

export interface Detector {
  key: string;
  /** Which subject kinds this detector applies to. */
  subjects: PrescriptionSubjectKind[];
  run: DetectorFn;
}

export type PrescriptionReportStatus = 'pending' | 'running' | 'ready' | 'failed';

/** Eligibility row: is there enough data for an automatic analysis? */
export interface PrescriptionEligibilityEntry {
  subjectKind: PrescriptionSubjectKind;
  subjectName?: string;
  sessionsCount: number;
  eligible: boolean;
  /** Latest ready report for this subject, when one exists. */
  lastReportId?: string;
  lastReportAt?: string;
  /** true = no report, or the latest one is older than the staleness bar. */
  stale: boolean;
}
