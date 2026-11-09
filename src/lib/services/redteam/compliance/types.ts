/**
 * Types for the EU AI Act compliance report — a regulator-facing rollup of
 * red-team evidence, structured to mirror the GPAI Code-of-Practice "Safety and
 * Security Model Report" (Commitment 7) and the Article 15 robustness duties.
 */

import type { EuRiskCategory, EuArticleRef } from '../euTaxonomy';
import type { RedTeamInconclusiveReason, RedTeamSeverity } from '@/lib/database';

/** EU AI Act risk classification recorded for the system under test. */
export type EuRiskTier =
  | 'prohibited'
  | 'high-risk'
  | 'gpai-systemic'
  | 'gpai'
  | 'limited-risk'
  | 'minimal-risk'
  | 'unclassified';

export const EU_RISK_TIERS: EuRiskTier[] = [
  'prohibited',
  'high-risk',
  'gpai-systemic',
  'gpai',
  'limited-risk',
  'minimal-risk',
  'unclassified',
];

/**
 * Compliance metadata recorded on a red-team campaign, describing the system it
 * evaluates. Persisted under `campaign.metadata.compliance` (no schema change).
 * These are exactly the fields an auditor expects in a Model Report header.
 */
export interface CampaignComplianceMeta {
  /** AI Act risk classification of the system under test. */
  riskTier?: EuRiskTier;
  /** Declared intended purpose (Annex IV technical documentation). */
  intendedPurpose?: string;
  /** Link to the model/system card documenting capabilities and limits. */
  systemCardUrl?: string;
  /** Legal entity deploying the system. */
  deployer?: string;
  /** Legal entity providing the model. */
  provider?: string;
  /** Free-text compliance notes (mitigations, residual-risk acceptance). */
  notes?: string;
}

/** One evidenced input→output sample (CoP requires ~5 random samples per eval). */
export interface ComplianceEvidenceSample {
  runId: string;
  campaignKey: string;
  probeKey: string;
  attemptId: string;
  /** `<probeKey>::<attemptId>`, the attempt's identity within its run. */
  attemptKey?: string;
  /** The 2025 OWASP key. */
  owaspCategory: string;
  outcome: 'safe' | 'vulnerable' | 'needs_review';
  /** The adversarial input (last user turn of the attempt). */
  input: string;
  /** The system's response (final assistant turn). */
  output: string;
  /** Agent scans: the published version that answered; `null` when nothing was published and the draft answered. */
  agentVersion?: number | null;
}

/** Posture for one EU risk family, with the regulatory hooks it evidences. */
export interface ComplianceEuCategoryPosture {
  category: EuRiskCategory;
  label: string;
  description: string;
  total: number;
  vulnerable: number;
  needsReview: number;
  resilience: number;
  articleRefs: EuArticleRef[];
  /** Up to N evidence samples drawn from this family's attempts. */
  evidence: ComplianceEvidenceSample[];
}

/** A distinct unresolved vulnerability surfaced by the scans. */
export interface ComplianceFinding {
  owaspCategory: string;
  euCategories: EuRiskCategory[];
  probeKey: string;
  severity: RedTeamSeverity;
  count: number;
  /** One representative evidence sample for the finding. */
  example?: ComplianceEvidenceSample;
}

/** An OWASP category (of the ten in the 2025 list) that no scan of the current posture exercised. */
export interface ComplianceCoverageGap {
  owaspCategory: string;
  /** Display label of the category. */
  label?: string;
  reason: string;
}

/** Older completed scans of the campaigns in the report: counts only, never posture. */
export interface ComplianceHistory {
  runs: number;
  byCampaign: Array<{ campaignKey: string; runs: number; attempts: number; vulnerable: number }>;
}

/** A completed scan whose rates cannot be trusted, so it is left out of the posture. */
export interface ComplianceInconclusiveRun {
  runId: string;
  campaignKey: string;
  finishedAt?: string;
  reasons: RedTeamInconclusiveReason[];
}

export interface EuComplianceReport {
  generatedAt: string;
  /** `runsConsidered`: the scans the posture is read from (the latest conclusive completed scan of each campaign). */
  scope: { projectId?: string; runsConsidered: number; scanWindow?: { from?: string; to?: string } };
  /** The category list the report is organised by. */
  owaspReference: { name: string; version: string; label: string };
  system: CampaignComplianceMeta & { campaigns: string[]; targets: string[] };
  posture: {
    totalAttempts: number;
    completed: number;
    vulnerable: number;
    needsReview: number;
    /** null when no attempt completed. */
    attackSuccessRate: number | null;
    resilienceScore: number | null;
    bySeverity: Record<string, number>;
  };
  byOwaspCategory: Array<{ category: string; label?: string; total: number; vulnerable: number; needsReview: number; resilience: number }>;
  byEuCategory: ComplianceEuCategoryPosture[];
  findings: ComplianceFinding[];
  coverageGaps: ComplianceCoverageGap[];
  /** Older completed scans of the same campaigns (counts only). */
  history: ComplianceHistory;
  /** Completed scans left out of the posture because their rates cannot be trusted. */
  inconclusiveRuns: ComplianceInconclusiveRun[];
  /** Machine-readable statement of which regulatory hooks the report addresses. */
  regulatoryBasis: EuArticleRef[];
  /** Human-readable caveats the report must carry to be honest evidence. */
  disclaimers: string[];
}
