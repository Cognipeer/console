/**
 * Types for the EU AI Act compliance report — a regulator-facing rollup of
 * red-team evidence, structured to mirror the GPAI Code-of-Practice "Safety and
 * Security Model Report" (Commitment 7) and the Article 15 robustness duties.
 */

import type { EuRiskCategory, EuArticleRef } from '../euTaxonomy';
import type { RedTeamSeverity } from '@/lib/database';

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
  owaspCategory: string;
  outcome: 'safe' | 'vulnerable' | 'needs_review';
  /** The adversarial input (last user turn of the attempt). */
  input: string;
  /** The system's response (final assistant turn). */
  output: string;
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

/** A probe category expected but not exercised by any completed scan. */
export interface ComplianceCoverageGap {
  owaspCategory: string;
  reason: string;
}

export interface EuComplianceReport {
  generatedAt: string;
  scope: { projectId?: string; runsConsidered: number; scanWindow?: { from?: string; to?: string } };
  system: CampaignComplianceMeta & { campaigns: string[]; targets: string[] };
  posture: {
    totalAttempts: number;
    completed: number;
    vulnerable: number;
    needsReview: number;
    attackSuccessRate: number;
    resilienceScore: number;
    bySeverity: Record<string, number>;
  };
  byOwaspCategory: Array<{ category: string; total: number; vulnerable: number; needsReview: number; resilience: number }>;
  byEuCategory: ComplianceEuCategoryPosture[];
  findings: ComplianceFinding[];
  coverageGaps: ComplianceCoverageGap[];
  /** Machine-readable statement of which regulatory hooks the report addresses. */
  regulatoryBasis: EuArticleRef[];
  /** Human-readable caveats the report must carry to be honest evidence. */
  disclaimers: string[];
}
