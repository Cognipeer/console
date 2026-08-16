/** Lightweight view types mirroring the /api/evaluation/* JSON responses. */

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
  kind: 'agent' | 'model' | 'external';
  agentKey?: string;
  modelKey?: string;
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

export interface EvalScorerView {
  type: 'assertion' | 'llm-judge' | 'semantic' | 'tool-call' | 'json-shape';
  weight?: number;
  rubric?: string;
  threshold?: number;
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
  scorerType: 'assertion' | 'llm-judge' | 'semantic' | 'tool-call' | 'json-shape';
  score: number;
  passed: boolean;
  weight: number;
  detail?: Record<string, unknown>;
  error?: string;
}

/** Token / cost usage reported for one item's target invocation. */
export interface EvalUsageView {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface EvalRunItemView {
  itemId: string;
  output?: {
    text: string;
    latencyMs?: number;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  };
  scores: EvalScoreView[];
  score: number;
  passed: boolean;
  latencyMs?: number;
  usage?: EvalUsageView;
  error?: string;
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
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface ModelOption {
  value: string;
  label: string;
}

export type EvalComparisonStatus = 'regressed' | 'fixed' | 'unchanged' | 'added' | 'removed';

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
