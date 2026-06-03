/** Lightweight view types mirroring the /api/evaluation/* JSON responses. */

export interface EvalMessageView {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EvalDatasetItemView {
  id: string;
  input: EvalMessageView[];
  expected?: Record<string, unknown>;
  tags?: string[];
}

export interface EvalTargetView {
  id: string;
  key: string;
  name: string;
  description?: string;
  kind: 'agent' | 'model' | 'external';
  agentKey?: string;
  modelKey?: string;
  createdAt?: string;
}

export interface EvalDatasetView {
  id: string;
  key: string;
  name: string;
  description?: string;
  source: 'manual' | 'file' | 'generated';
  items: EvalDatasetItemView[];
  createdAt?: string;
}

export interface EvalScorerView {
  type: 'assertion' | 'llm-judge';
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
  runConfig?: { concurrency?: number };
  createdAt?: string;
}

export interface EvalScoreView {
  scorerType: 'assertion' | 'llm-judge';
  score: number;
  passed: boolean;
  weight: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface EvalRunItemView {
  itemId: string;
  output?: { text: string; latencyMs?: number };
  scores: EvalScoreView[];
  score: number;
  passed: boolean;
  latencyMs?: number;
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
