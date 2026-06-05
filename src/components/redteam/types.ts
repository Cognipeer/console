/** Lightweight view types mirroring the /api/redteam/* JSON responses. */

export type RedTeamTargetKind = 'agent' | 'model';
export type RedTeamOutcome = 'safe' | 'vulnerable' | 'needs_review';
export type RedTeamSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RedTeamRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ProbeCatalogView {
  key: string;
  family: string;
  category: string;
  severity: string;
  description: string;
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
