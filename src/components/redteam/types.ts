/** Lightweight view types mirroring the /api/redteam/* JSON responses. */

export type RedTeamTargetKind = 'agent' | 'model';
export type RedTeamOutcome = 'safe' | 'vulnerable' | 'needs_review';
export type RedTeamSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RedTeamRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ProbeCatalogView {
  key: string;
  name: string;
  family: string;
  category: string;
  severity: string;
  description: string;
  custom?: boolean;
}

export interface CustomProbeAttemptView {
  id: string;
  turns: string[];
  system?: string;
  canary?: string;
  forbiddenPatterns?: string[];
  refusalExpected?: boolean;
  adaptive?: boolean;
  objective?: string;
}

export interface CustomProbeJudgeView {
  lens: string;
  rubric: string;
  threshold?: number;
}

export interface CustomProbeDetectorsView {
  refusal?: boolean;
  pattern?: boolean;
  judges?: CustomProbeJudgeView[];
}

export interface CustomProbeView {
  id: string;
  key: string;
  name: string;
  description: string;
  family: string;
  category: string;
  severity: RedTeamSeverity;
  attempts: CustomProbeAttemptView[];
  detectors: CustomProbeDetectorsView;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface RedTeamCampaignView {
  id: string;
  key: string;
  name: string;
  description?: string;
  targetKind: RedTeamTargetKind;
  agentKey?: string;
  modelKey?: string;
  probeKeys: string[];
  judgeModelKey?: string;
  runConfig?: { concurrency?: number };
  schedule?: { cron: string; enabled: boolean };
  createdAt?: string;
}

export interface RedTeamSignalView {
  detectorKey: string;
  kind: string;
  hit: boolean;
  score: number;
  confidence: number;
  gate?: 'safe';
  rationale: string;
  modelRef?: string;
  error?: string;
}

export interface RedTeamTurnView {
  user: string;
  assistant: string;
}

export interface RedTeamReviewView {
  outcome: RedTeamOutcome;
  note?: string;
  reviewedBy: string;
  reviewedAt: string;
}

export interface RedTeamAttemptView {
  probeKey: string;
  attemptId: string;
  family: string;
  category: string;
  severity: RedTeamSeverity;
  outcome: RedTeamOutcome;
  decidedBy: string;
  confidence: number;
  transcript: RedTeamTurnView[];
  signals: RedTeamSignalView[];
  latencyMs?: number;
  error?: string;
  review?: RedTeamReviewView;
}

export interface RedTeamAggregateView {
  total: number;
  completed: number;
  failed: number;
  vulnerable: number;
  safe: number;
  needsReview: number;
  attackSuccessRate: number;
  resilienceScore: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, { total: number; vulnerable: number; needsReview: number }>;
  avgLatencyMs: number | null;
}

export interface RedTeamRunView {
  id: string;
  campaignKey: string;
  targetKind: RedTeamTargetKind;
  targetRef: string;
  status: RedTeamRunStatus;
  mode: 'sync' | 'async';
  progress: { total: number; completed: number; failed: number };
  aggregate?: RedTeamAggregateView;
  attempts: RedTeamAttemptView[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface RedTeamOverviewCategoryView {
  category: string;
  total: number;
  vulnerable: number;
  needsReview: number;
  resilience: number;
}

export interface RedTeamOverviewTrendView {
  runId: string;
  campaignKey: string;
  finishedAt?: string;
  resilienceScore: number;
  attackSuccessRate: number;
  vulnerable: number;
}

export interface RedTeamOverviewView {
  scans: number;
  totalAttempts: number;
  completed: number;
  vulnerable: number;
  needsReview: number;
  attackSuccessRate: number;
  resilienceScore: number;
  bySeverity: Record<string, number>;
  byCategory: RedTeamOverviewCategoryView[];
  trend: RedTeamOverviewTrendView[];
  latestRunAt?: string;
}

export type ComparisonStatus = 'regressed' | 'fixed' | 'unchanged' | 'added' | 'removed';

export interface RedTeamComparisonAttemptView {
  key: string;
  probeKey: string;
  attemptId: string;
  category: string;
  severity: string;
  baseline?: RedTeamOutcome;
  current?: RedTeamOutcome;
  status: ComparisonStatus;
}

export interface RedTeamComparisonView {
  baselineRunId: string;
  runId: string;
  summary: Record<ComparisonStatus, number>;
  deltas: { attackSuccessRate: number; resilienceScore: number; vulnerable: number };
  changes: RedTeamComparisonAttemptView[];
}
