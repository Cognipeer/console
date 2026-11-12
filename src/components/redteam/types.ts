/** Lightweight view types mirroring the /api/redteam/* JSON responses. */

import type { IAgentRunRevision } from '@/lib/shared/agentRevision';

export type RedTeamTargetKind = 'agent' | 'model';
export type RedTeamOutcome = 'safe' | 'vulnerable' | 'needs_review';
export type RedTeamSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RedTeamRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** A custom probe that exists but is switched off, so scans skip it. */
export interface DisabledProbeView {
  key: string;
  name: string;
}

export type RedTeamProbePolarity = 'attack' | 'over-refusal';
export type RedTeamProbeOrigin = 'manual' | 'clone' | 'import';
export type RedTeamProbeRequirement = 'long-context' | 'caller-history' | 'usage-metrics';

export interface ProbeReferenceView {
  title: string;
  url: string;
}

/** Where an imported probe came from (mirrors IRedTeamProbeSource; dates arrive as strings). */
export interface ProbeSourceView {
  format?: string;
  name: string;
  license?: string;
  attribution?: string;
  url?: string;
  fileName?: string;
  importedAt?: string;
}

export interface ProbeCatalogView {
  key: string;
  name: string;
  family: string;
  category: string;
  severity: string;
  description: string;
  custom?: boolean;
  /** Every field below is absent on an older server; screens fall back to the old behaviour. */
  version?: number;
  technique?: string;
  references?: ProbeReferenceView[];
  targets?: RedTeamTargetKind[];
  requires?: RedTeamProbeRequirement[];
  addedAt?: string;
  polarity?: RedTeamProbePolarity;
  /** Every attempt carries forged history, so the probe needs a target that takes caller history. */
  requiresHistory?: boolean;
  attemptCount?: number;
  /** Attempts that would run on an agent (no system prompt, no history, targets include agent). */
  agentAttemptCount?: number;
  /** Detector keys in build order, e.g. `refusal`, `pattern`, `markdown-exfil`, `llm-judge:<lens>`. */
  detectors?: string[];
  /** Part of the set that runs when a campaign selects no probes. */
  isDefault?: boolean;
  /** Custom probes only. */
  id?: string;
  origin?: RedTeamProbeOrigin;
  clonedFrom?: { probeKey: string; version: number };
  sourceName?: string;
  /** The probe plants its own system prompt; an agent keeps its own instructions, so these attempts are not run against agents. */
  requiresSystemPrompt?: boolean;
  /** The probe has multi-turn or adaptive attempts, which need a judge / attacker model on the campaign. */
  needsJudgeModel?: boolean;
}

export interface ProbeHistoryMessageView {
  role: 'user' | 'assistant';
  content: string;
}

export interface CustomProbeAttemptView {
  id: string;
  turns: string[];
  history?: ProbeHistoryMessageView[];
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
  named?: string[];
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
  polarity?: RedTeamProbePolarity;
  origin?: RedTeamProbeOrigin;
  clonedFrom?: { probeKey: string; version: number };
  source?: ProbeSourceView;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** GET /api/redteam/probes/builtin/:key: a built-in probe in custom-probe form. */
export interface BuiltinProbeDefinitionView extends ProbeCatalogView {
  attempts: CustomProbeAttemptView[];
  detectorSpec: CustomProbeDetectorsView;
}

export interface RedTeamCampaignView {
  id: string;
  key: string;
  name: string;
  description?: string;
  targetKind: RedTeamTargetKind;
  agentKey?: string;
  /** Agent campaigns: default revision a scan attacks — a pinned version, `'draft'`, or absent/null for the published one. A single scan can override it. */
  agentVersion?: number | 'draft' | null;
  modelKey?: string;
  probeKeys: string[];
  judgeModelKey?: string;
  runConfig?: { concurrency?: number; maxOutputTokens?: number };
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
  /** `<probeKey>::<attemptId>`: an attempt id is only unique inside its probe, so rows and reviews use this. */
  attemptKey: string;
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
  /** The target failed after some turns: the transcript so far was judged, so the verdict is based on partial evidence. */
  partial?: boolean;
  review?: RedTeamReviewView;
  /** `over-refusal`: the prompts were harmless, so a refusal is the failure. Absent means an attack attempt. */
  polarity?: RedTeamProbePolarity;
  /** The attempt used knowledge base documents this viewer may not read: its transcript and rationales are left out. */
  restricted?: boolean;
}

export type RedTeamInconclusiveReason = 'no-completed-attempts' | 'target-errors' | 'judge-errors';

export interface RedTeamAggregateView {
  total: number;
  completed: number;
  failed: number;
  vulnerable: number;
  safe: number;
  needsReview: number;
  /** null when no attempt completed. Runs stored before that kept 0. */
  attackSuccessRate: number | null;
  resilienceScore: number | null;
  bySeverity: Record<string, number>;
  byCategory: Record<string, { total: number; vulnerable: number; needsReview: number; failed?: number }>;
  avgLatencyMs: number | null;
  judgeErrors?: number;
  inconclusive?: boolean;
  /** Absent on runs stored before reasons were recorded; `inconclusive: true` without it means judge errors. */
  inconclusiveReasons?: RedTeamInconclusiveReason[];
  /** Present only when the run had over-refusal attempts; they are not counted above. */
  overRefusal?: RedTeamOverRefusalView;
}

export interface RedTeamOverRefusalView {
  total: number;
  completed: number;
  failed: number;
  refused: number;
  needsReview: number;
  rate: number | null;
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
  /** Attempts generated beyond the per-run cap and never executed. */
  skippedAttempts?: number;
  /** Attempts not run because they plant a system prompt and the target (an agent) keeps its own. */
  notApplicableAttempts?: number;
  warnings?: string[];
  /** A stop was requested for a running scan; it ends as cancelled once the worker notices. */
  cancelRequested?: boolean;
  error?: string;
  /** Agent campaigns: the configuration this scan attacked. */
  agentRevision?: IAgentRunRevision;
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
  resilienceScore: number | null;
  attackSuccessRate: number | null;
  vulnerable: number;
}

export interface RedTeamOverviewView {
  scans: number;
  totalAttempts: number;
  completed: number;
  vulnerable: number;
  needsReview: number;
  attackSuccessRate: number | null;
  resilienceScore: number | null;
  bySeverity: Record<string, number>;
  byCategory: RedTeamOverviewCategoryView[];
  trend: RedTeamOverviewTrendView[];
  latestRunAt?: string;
  /** How many of the latest completed runs the figures cover (the service default is 100). */
  windowRuns?: number;
  /** Share of harmless prompts refused over the runs that had any; null when none did. */
  overRefusalRate?: number | null;
  overRefusalRuns?: number;
}

/** GET /api/redteam/runs answer: one page plus the total across pages. */
export interface RedTeamRunListView {
  runs: RedTeamRunView[];
  total?: number;
}

export type ComparisonStatus = 'regressed' | 'fixed' | 'unchanged' | 'added' | 'removed' | 'errored';

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
  deltas: { attackSuccessRate: number | null; resilienceScore: number | null; vulnerable: number };
  changes: RedTeamComparisonAttemptView[];
  /** The two runs did not run the same attempts; only shared attempt keys count as regressed or fixed. */
  probeSetChanged?: boolean;
  onlyInBaseline?: string[];
  onlyInCurrent?: string[];
}
