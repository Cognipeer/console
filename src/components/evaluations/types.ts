/** Lightweight view types mirroring the /api/evaluation/* JSON responses. */

import type { IAgentRunRevision } from '@/lib/shared/agentRevision';

/** A tool call recorded on an assistant turn. */
export interface EvalToolCallView {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface EvalMessageView {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant turns: tool calls issued in this turn. */
  toolCalls?: EvalToolCallView[];
  /** Tool turns: id of the assistant tool call this responds to. */
  toolCallId?: string;
  /** Tool turns: tool name, when recorded. */
  name?: string;
}

/** A tool exposed to the target for one item (never executed). */
export interface EvalToolDefinitionView {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type EvalArgsMatchMode = 'exact' | 'subset' | 'schema' | 'ignore';

/** An expected tool call with a per-call argument matching strategy. */
export interface EvalExpectedToolCallView {
  name: string;
  argsMatch?: EvalArgsMatchMode;
  args?: Record<string, unknown>;
  argsSchema?: Record<string, unknown>;
}

/** A single JSON-path assertion against the (parsed) target output. */
export interface EvalJsonPathAssertionView {
  path: string;
  exists?: boolean;
  equals?: unknown;
}

/** Where an item's labels came from; a human edit outranks an AI labeling run. */
export interface EvalLabelMetaView {
  source: 'ai' | 'human';
  definitionKey?: string;
  runId?: string;
  modelKey?: string;
  judge?: { score: number; passed?: boolean; reasoning?: string };
  labeledAt?: string;
  labeledBy?: string;
}

export interface EvalDatasetItemView {
  id: string;
  input: EvalMessageView[];
  expected?: Record<string, unknown>;
  /** Tools exposed to the target for trajectory testing. */
  tools?: EvalToolDefinitionView[];
  /** Canned tool results; key format: `name + '(' + canonicalJson(args) + ')'`. */
  toolResults?: Record<string, unknown>;
  tags?: string[];
  /** Structured-output contract recorded with the request (OpenAI response_format shape). */
  responseFormat?: Record<string, unknown>;
  /** Structured segment labels (intent, complexity, …) — see EvalLabelMetaView. */
  labels?: Record<string, unknown>;
  labelMeta?: EvalLabelMetaView;
}

/** Label distribution across a dataset, from GET /evaluation/datasets/:id/labels. */
export interface EvalLabelSummaryView {
  total: number;
  labeled: number;
  humanLabeled: number;
  keys: Array<{
    key: string;
    count: number;
    values: Array<{ value: string; count: number; share: number }>;
    otherValues: number;
  }>;
  definitionKeys: string[];
}

/** Handle to the labeling run parked on `dataset.metadata.labeling`. */
export interface EvalDatasetLabelingMeta {
  runId: string;
  definitionKey: string;
  status?: string;
  startedAt?: string;
}

export interface EvalTargetView {
  id: string;
  key: string;
  name: string;
  description?: string;
  kind: 'agent' | 'model' | 'external' | 'rag';
  agentKey?: string;
  /** Default revision a run tests: a pinned published version, `'draft'`, or absent/null for "follow the published one". A single run can override it. */
  agentVersion?: number | 'draft' | null;
  modelKey?: string;
  /** `rag` targets: the Knowledge Engine module queried, and how much of it. */
  ragModuleKey?: string;
  retrievalTopK?: number;
  retrievalMinScore?: number;
  /** System-prompt override (model targets only) — replaces the dataset's system turn. */
  systemPrompt?: string;
  promptKey?: string;
  promptVersion?: number;
  /** Structured-output contract sent with every call (OpenAI response_format shape). */
  responseFormat?: Record<string, unknown>;
  maxTokens?: number;
  createdAt?: string;
}

export interface EvalDatasetGenerationMeta {
  status: 'pending' | 'running' | 'ready' | 'failed';
  requested: number;
  source: 'rag' | 'text' | 'file';
  generated?: number;
  error?: string;
  /** Set when fewer items than requested could be generated (e.g. the source ran out of distinct passages). */
  warning?: string;
}

export interface EvalDatasetView {
  id: string;
  key: string;
  name: string;
  description?: string;
  source: 'manual' | 'file' | 'generated' | 'imported';
  /** Items are paginated via GET /api/evaluation/datasets/:id/items — dataset
   *  responses carry only the count. */
  itemCount: number;
  createdAt?: string;
  metadata?: {
    generation?: EvalDatasetGenerationMeta;
    labeling?: EvalDatasetLabelingMeta;
  } & Record<string, unknown>;
}

/** Mirrors EvaluationScorerType — kept in one place so the two views agree. */
export type EvalScorerTypeView =
  | 'assertion'
  | 'llm-judge'
  | 'semantic'
  | 'tool-call'
  | 'json-shape'
  | 'context-recall'
  | 'context-precision'
  | 'groundedness';

/** Opt-in per-item applicability: the scorer is skipped on items without the named field. */
export type EvalScorerApplyWhen = 'has-reference' | 'has-expected-tool-calls';

export interface EvalScorerView {
  type: EvalScorerTypeView;
  weight?: number;
  rubric?: string;
  threshold?: number;
  applyWhen?: EvalScorerApplyWhen;
  /** tool-call: `false` fails the item when the target makes calls that were not expected (default true). */
  allowExtraCalls?: boolean;
  /** json-shape: `true` also flags keys the output has but the reference does not (default false). */
  strict?: boolean;
}

export interface EvalSuiteView {
  id: string;
  key: string;
  name: string;
  description?: string;
  targetKey: string;
  datasetKey: string;
  scorers: EvalScorerView[];
  judgeModelKey?: string;
  embeddingModelKey?: string;
  runConfig?: { concurrency?: number; turnMode?: 'single' | 'perTurn' };
  createdAt?: string;
}

export interface EvalScoreView {
  scorerType: EvalScorerTypeView;
  score: number;
  passed: boolean;
  weight: number;
  detail?: Record<string, unknown>;
  error?: string;
  /** The scorer did not apply to this item (`detail.reason` says why); it is left out of the item score. */
  skipped?: boolean;
  /** Judge spend for this score (llm-judge scorers). */
  usage?: EvalUsageView;
}

/** Token / cost usage reported for one item's target invocation. */
export interface EvalUsageView {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

/** One recorded turn of a `perTurn` run item. */
export interface EvalRunTurnView {
  index: number;
  question: string;
  text: string;
  toolCalls?: EvalToolCallView[];
  latencyMs?: number;
  usage?: EvalUsageView;
}

export interface EvalRunItemView {
  itemId: string;
  output?: {
    text: string;
    latencyMs?: number;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    /** `perTurn` runs: what the target said at every turn. */
    turns?: EvalRunTurnView[];
    /** The target stopped because it hit its output limit. */
    truncated?: boolean;
  };
  scores: EvalScoreView[];
  score: number;
  passed: boolean;
  latencyMs?: number;
  usage?: EvalUsageView;
  /** Judge spend for this item, kept apart from the target's `usage`. */
  scoringUsage?: EvalUsageView;
  /** No scorer applied to this item; it counts neither as passed nor as failed. */
  skipped?: boolean;
  /** The target or a scorer failed; the item counts in `aggregate.failed`. */
  error?: string;
  /** The item used knowledge base documents this viewer may not read: its output and scorer details are left out. */
  restricted?: boolean;
}

export interface EvalRunAggregateView {
  total: number;
  completed: number;
  failed: number;
  passed: number;
  passRate: number;
  avgScore: number;
  avgLatencyMs: number | null;
  /** Present only when at least one item reported provider usage. */
  totalCostUsd?: number;
  totalTokens?: number;
  /** Completed items no scorer applied to (excluded from passRate/avgScore). Absent on older runs. */
  skipped?: number;
  /** failed / total. Absent on older runs (derive it from failed / total). */
  errorRate?: number;
  /** Completed items whose output hit the output limit. */
  truncatedCount?: number;
  /** Items that reported target usage — the denominator for per-item token or cost averages. */
  usageItems?: number;
  /** Judge spend, separate from the target's totalCostUsd / totalTokens. */
  scoringCostUsd?: number;
  scoringTokens?: number;
}

export interface EvalRunView {
  id: string;
  suiteKey: string;
  targetKey: string;
  datasetKey: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  mode: 'sync' | 'async';
  progress: { total: number; completed: number; failed: number };
  aggregate?: EvalRunAggregateView;
  items: EvalRunItemView[];
  error?: string;
  /** Agent targets only: the configuration this run tested. */
  agentRevision?: IAgentRunRevision;
  /** Set while a cancel request waits for in-flight items to finish. */
  cancelRequestedAt?: string;
  heartbeatAt?: string;
  /** Item details were shortened so the run fits in one document. */
  itemsTruncated?: boolean;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

/** GET /api/evaluation/runs — summaries (items left out) plus the total for paging. */
export interface EvalRunListView {
  runs: EvalRunView[];
  total: number;
}

/** POST /api/evaluation/runs/:id/cancel */
export interface EvalRunCancelView {
  run: EvalRunView;
  outcome: 'cancelled' | 'cancel_requested' | 'already_finished';
}

export interface ModelOption {
  value: string;
  label: string;
}

/** `not_comparable`: the item errored or was skipped in at least one of the two runs. */
export type EvalComparisonStatus = 'regressed' | 'fixed' | 'unchanged' | 'added' | 'removed' | 'not_comparable';

export interface EvalComparisonItemView {
  itemId: string;
  baselinePassed?: boolean;
  currentPassed?: boolean;
  baselineScore?: number;
  currentScore?: number;
  scoreDelta?: number;
  status: EvalComparisonStatus;
}

export interface EvalComparisonView {
  baselineRunId: string;
  runId: string;
  summary: Record<EvalComparisonStatus, number>;
  deltas: { passRate: number; avgScore: number };
  changes: EvalComparisonItemView[];
}
