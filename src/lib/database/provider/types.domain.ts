import type { ObjectId } from 'mongodb';

// ── Guardrail types ────────────────────────────────────────────────────────

export type GuardrailType = 'preset' | 'custom';
export type GuardrailAction = 'block' | 'warn' | 'flag';
export type GuardrailTarget = 'input' | 'output' | 'both';

export interface IGuardrailPiiPolicy {
  enabled: boolean;
  action: GuardrailAction;
  categories: Record<string, boolean>;
}

export interface IGuardrailModerationPolicy {
  enabled: boolean;
  modelKey?: string;
  categories: Record<string, boolean>;
}

export interface IGuardrailPromptShieldPolicy {
  enabled: boolean;
  modelKey?: string;
  sensitivity: 'low' | 'balanced' | 'high';
}

export interface IGuardrailPresetPolicy {
  pii?: IGuardrailPiiPolicy;
  moderation?: IGuardrailModerationPolicy;
  promptShield?: IGuardrailPromptShieldPolicy;
}

export interface IGuardrail {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  type: GuardrailType;
  target: GuardrailTarget;
  action: GuardrailAction;
  enabled: boolean;
  modelKey?: string;
  // For preset guardrails
  policy?: IGuardrailPresetPolicy;
  // For custom prompt guardrails
  customPrompt?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Evaluation types ─────────────────────────────────────────────────────────

export type EvaluationTargetKind = 'agent' | 'model' | 'external';
export type EvaluationRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type EvaluationRunMode = 'sync' | 'async';
export type EvaluationDatasetSource = 'manual' | 'file' | 'generated';
export type EvaluationScorerType = 'assertion' | 'llm-judge';

export interface IEvaluationExternalTarget {
  protocol: 'openai-chat' | 'webhook';
  url: string;
  headers?: Record<string, string>;
  /** Provider key holding encrypted credentials for the external endpoint. */
  credentialProviderKey?: string;
  /** Dot-path used to pull the assistant text out of a webhook response. */
  responsePath?: string;
}

export interface IEvaluationTarget {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  kind: EvaluationTargetKind;
  agentKey?: string;
  modelKey?: string;
  external?: IEvaluationExternalTarget;
  defaultParams?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IEvaluationDatasetItem {
  id: string;
  input: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  expected?: Record<string, unknown>;
  tags?: string[];
}

export interface IEvaluationDataset {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  source: EvaluationDatasetSource;
  items: IEvaluationDatasetItem[];
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IEvaluationScorerConfig {
  type: EvaluationScorerType;
  weight?: number;
  rubric?: string;
  threshold?: number;
}

export interface IEvaluationSuite {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  targetKey: string;
  datasetKey: string;
  scorers: IEvaluationScorerConfig[];
  /** Model used to back any llm-judge scorers. */
  judgeModelKey?: string;
  runConfig?: { concurrency?: number };
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IEvaluationScore {
  scorerType: EvaluationScorerType;
  score: number;
  passed: boolean;
  weight: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface IEvaluationRunItem {
  itemId: string;
  output?: { text: string; latencyMs?: number };
  scores: IEvaluationScore[];
  score: number;
  passed: boolean;
  latencyMs?: number;
  error?: string;
}

export interface IEvaluationRunAggregate {
  total: number;
  completed: number;
  failed: number;
  passed: number;
  passRate: number;
  avgScore: number;
  avgLatencyMs: number | null;
}

export interface IEvaluationRun {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  suiteKey: string;
  targetKey: string;
  datasetKey: string;
  status: EvaluationRunStatus;
  mode: EvaluationRunMode;
  progress: { total: number; completed: number; failed: number };
  aggregate?: IEvaluationRunAggregate;
  items: IEvaluationRunItem[];
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Analysis types ───────────────────────────────────────────────────────────

export type AnalysisFieldType = 'string' | 'number' | 'boolean' | 'enum';
export type AnalysisRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AnalysisRunMode = 'sync' | 'async';
export type AnalysisConversationSource = 'imported' | 'platform' | 'manual';

export interface IAnalysisFieldDef {
  key: string;
  type: AnalysisFieldType;
  description?: string;
  enumValues?: string[];
  required?: boolean;
}

export interface IAnalysisModes {
  /** Persist extracted fields back onto each conversation. */
  store?: boolean;
  /** Grade conversation quality against a rubric with an LLM judge. */
  judge?: { rubric: string; threshold?: number };
  /** Compare extracted fields against each conversation's referenceFields. */
  accuracy?: boolean;
}

export interface IAnalysisDefinition {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  fieldSet: IAnalysisFieldDef[];
  extractionInstructions?: string;
  modes: IAnalysisModes;
  /** Model used for field extraction. */
  extractionModelKey?: string;
  /** Model used to back the llm-judge mode. */
  judgeModelKey?: string;
  runConfig?: { concurrency?: number };
  /** Optional cron schedule for unattended (e.g. nightly) runs. */
  schedule?: { cron: string; enabled: boolean };
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAnalysisTranscriptMessage {
  role: string;
  content: string;
}

export interface IAnalysisConversation {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name?: string;
  description?: string;
  transcript: IAnalysisTranscriptMessage[];
  source: AnalysisConversationSource;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  /** Ground-truth field values for accuracy scoring. */
  referenceFields?: Record<string, unknown>;
  /** Latest extracted fields (store mode). */
  extractedFields?: Record<string, unknown>;
  lastAnalyzedAt?: Date;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAnalysisFieldAccuracy {
  expected: unknown;
  actual: unknown;
  match: boolean;
}

export interface IAnalysisItemResult {
  conversationKey: string;
  extractedFields: Record<string, unknown>;
  missing: string[];
  judge?: { score: number; passed?: boolean; reasoning?: string; error?: string };
  accuracy?: { score: number; perField: Record<string, IAnalysisFieldAccuracy>; comparedCount: number };
  passed: boolean;
  error?: string;
}

export interface IAnalysisRunAggregate {
  total: number;
  completed: number;
  failed: number;
  passed: number;
  passRate: number;
  avgJudgeScore: number | null;
  avgExtractionAccuracy: number | null;
}

export interface IAnalysisRun {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  definitionKey: string;
  status: AnalysisRunStatus;
  mode: AnalysisRunMode;
  progress: { total: number; completed: number; failed: number };
  aggregate?: IAnalysisRunAggregate;
  items: IAnalysisItemResult[];
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IInferenceServerMetrics {
  _id?: ObjectId | string;
  tenantId: string;
  serverKey: string;
  timestamp: Date;
  numRequestsRunning?: number;
  numRequestsWaiting?: number;
  gpuCacheUsagePercent?: number;
  cpuCacheUsagePercent?: number;
  promptTokensThroughput?: number;
  generationTokensThroughput?: number;
  timeToFirstTokenSeconds?: number;
  timePerOutputTokenSeconds?: number;
  e2eRequestLatencySeconds?: number;
  requestsPerSecond?: number;
  runningModels?: string[];
  raw?: Record<string, unknown>;
  createdAt?: Date;
}

// ── RAG Module types ────────────────────────────────────────────────────

export type RagChunkStrategy = 'recursive_character' | 'token';

export interface IRagChunkConfig {
  strategy: RagChunkStrategy;
  /** Common */
  chunkSize: number;
  chunkOverlap: number;
  /** recursive_character specific */
  separators?: string[];
  /** token specific */
  encoding?: string;
}

export type RagDocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed';

export interface IRagModule {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  fileBucketKey?: string;
  fileProviderKey?: string;
  chunkConfig: IRagChunkConfig;
  status: 'active' | 'disabled';
  /** Optional reference to a Reranker service that re-orders vector matches before returning. */
  rerankerKey?: string;
  /** When reranker is enabled, fetch this many candidates from vector store before re-ranking down to topK. */
  rerankerOversample?: number;
  totalDocuments?: number;
  totalChunks?: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRagDocument {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  fileKey?: string;
  fileName: string;
  contentType?: string;
  size?: number;
  status: RagDocumentStatus;
  chunkCount?: number;
  errorMessage?: string;
  lastIndexedAt?: Date;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRagChunk {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  documentId: string;
  chunkIndex: number;
  vectorId: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface IRagQueryLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  query: string;
  topK: number;
  matchCount: number;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

// ── Reranker types ──────────────────────────────────────────────────────

/**
 * Reranker strategies determine how candidate documents are re-scored.
 * - dedicated-model: calls a model with `category: 'rerank'` (Cohere/Jina/Voyage/BGE).
 * - llm-judge: prompts an LLM (category 'llm') with each candidate to produce a 0–1 score.
 * - llm-listwise: prompts an LLM once with the entire candidate list and asks for a ranked order.
 * - heuristic: keyword overlap / recency boost — no model required.
 * - fusion: reciprocal rank fusion across input score arrays (no model). Reserved for future.
 */
export type RerankerStrategy =
  | 'dedicated-model'
  | 'llm-judge'
  | 'llm-listwise'
  | 'heuristic'
  | 'fusion';

export type RerankerStatus = 'active' | 'disabled';

export interface IRerankerConfig {
  /** Model key (from Model Hub) — required for dedicated-model / llm-judge / llm-listwise. */
  modelKey?: string;
  /** Default topN returned by the reranker. If undefined, returns the same count as input. */
  topN?: number;
  /** Optional score threshold — drop candidates below this normalized [0,1] score. */
  scoreThreshold?: number;
  /** Batch size for llm-judge mode (parallel scoring). */
  batchSize?: number;
  /** Temperature for LLM strategies. */
  temperature?: number;
  /** Custom prompt template (llm-judge / llm-listwise). Supports {{query}} and {{document}} placeholders. */
  promptTemplate?: string;
  /** Score normalization — 'minmax' rescales scores to [0,1]. */
  scoreNormalization?: 'none' | 'minmax';
  /** Heuristic config: weights for keyword overlap vs recency, etc. */
  heuristicWeights?: {
    keyword?: number;
    recency?: number;
    originalScore?: number;
  };
}

export interface IReranker {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  strategy: RerankerStrategy;
  config: IRerankerConfig;
  status: RerankerStatus;
  totalRuns?: number;
  avgLatencyMs?: number;
  lastUsedAt?: Date;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRerankerRunLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  rerankerKey: string;
  strategy: RerankerStrategy;
  modelKey?: string;
  query: string;
  inputCount: number;
  outputCount: number;
  latencyMs?: number;
  status: 'success' | 'error';
  errorMessage?: string;
  /** Optional caller context — 'rag' for embedded use, 'api' for client v1, 'dashboard' for playground. */
  source?: 'rag' | 'api' | 'dashboard';
  ragModuleKey?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

// ── Alert types ─────────────────────────────────────────────────────────

export type AlertModule = 'models' | 'inference' | 'guardrails' | 'rag' | 'mcp' | 'analysis' | 'evaluation';

export type AlertMetric =
  // models
  | 'error_rate'
  | 'avg_latency_ms'
  | 'p95_latency_ms'
  | 'total_cost'
  | 'total_requests'
  // inference
  | 'gpu_cache_usage'
  | 'request_queue_depth'
  // guardrails
  | 'guardrail_fail_rate'
  | 'guardrail_avg_latency_ms'
  | 'guardrail_total_evaluations'
  // rag
  | 'rag_avg_latency_ms'
  | 'rag_total_queries'
  | 'rag_failed_documents'
  // mcp
  | 'mcp_error_rate'
  | 'mcp_avg_latency_ms'
  | 'mcp_total_requests'
  // analysis (percentages, 0–100, averaged over completed runs in the window)
  | 'analysis_pass_rate'
  | 'analysis_avg_judge_score'
  | 'analysis_avg_accuracy'
  // evaluation (percentages, 0–100, averaged over completed runs in the window)
  | 'evaluation_pass_rate'
  | 'evaluation_avg_score';

export type AlertConditionOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq';

export interface IAlertCondition {
  operator: AlertConditionOperator;
  threshold: number;
}

export type IAlertChannel =
  | { type: 'email'; recipients: string[] };

export type AlertEventStatus = 'fired' | 'resolved' | 'acknowledged';

export interface IAlertRule {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  module: AlertModule;
  enabled: boolean;
  metric: AlertMetric;
  condition: IAlertCondition;
  windowMinutes: number;
  cooldownMinutes: number;
  scope?: {
    modelKey?: string;
    serverKey?: string;
    guardrailKey?: string;
    ragModuleKey?: string;
    mcpServerKey?: string;
  };
  channels: IAlertChannel[];
  lastTriggeredAt?: Date;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAlertEvent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  threshold: number;
  actualValue: number;
  status: AlertEventStatus;
  channels: Array<{
    type: string;
    target: string;
    success: boolean;
    error?: string;
  }>;
  firedAt: Date;
  resolvedAt?: Date;
  metadata?: Record<string, unknown>;
}

// ── Tool (unified tool system) types ─────────────────────────────────────

export type ToolSourceType = 'openapi' | 'mcp';
export type ToolStatus = 'active' | 'disabled';

export type ToolAuthType = 'none' | 'token' | 'header' | 'basic';

export interface IToolAuthConfig {
  type: ToolAuthType;
  /** For 'token': the bearer token value */
  token?: string;
  /** For 'header': custom header name + value */
  headerName?: string;
  headerValue?: string;
  /** For 'basic': username + password */
  username?: string;
  password?: string;
}

export interface IToolAction {
  /** Unique key within the tool (slug of operationId or tool name) */
  key: string;
  name: string;
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: Record<string, unknown>;
  /** How this action is executed */
  executionType: 'openapi_http' | 'mcp_call';
  /** OpenAPI-specific: HTTP method */
  httpMethod?: string;
  /** OpenAPI-specific: Path template */
  httpPath?: string;
  /** MCP-specific: original tool name on the MCP server */
  mcpToolName?: string;
}

export interface ITool {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  type: ToolSourceType;
  status: ToolStatus;
  /** Actions (callable tools) derived from the source */
  actions: IToolAction[];
  /** OpenAPI-specific: raw spec JSON string */
  openApiSpec?: string;
  /** Upstream base URL for HTTP calls */
  upstreamBaseUrl?: string;
  /** Authentication for upstream API / MCP server */
  upstreamAuth?: IToolAuthConfig;
  /** MCP-specific: MCP server endpoint URL */
  mcpEndpoint?: string;
  /** MCP-specific: transport type */
  mcpTransport?: 'sse' | 'streamable-http';
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Tool Request Log types ────────────────────────────────────────────────

export interface IToolRequestLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  toolKey: string;
  actionKey: string;
  actionName: string;
  status: 'success' | 'error';
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  errorMessage?: string;
  latencyMs?: number;
  callerType?: 'dashboard' | 'api' | 'agent';
  callerTokenId?: string;
  createdAt?: Date;
}

export interface IToolRequestAggregate {
  toolKey: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  actionBreakdown: Record<string, number>;
  timeseries?: Array<{
    period: string;
    total: number;
    success: number;
    errors: number;
  }>;
}

// ── Agent types ──────────────────────────────────────────────────────────

export type AgentStatus = 'active' | 'inactive' | 'draft';

export interface IAgentConfig {
  modelKey: string;
  systemPrompt?: string;
  promptKey?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** RAG module key – attached as a retrieval tool */
  knowledgeEngineKey?: string;
  /** Guardrail key applied to user input */
  inputGuardrailKey?: string;
  /** Guardrail key applied to assistant output */
  outputGuardrailKey?: string;
  /** Bound tools from various sources (tools, MCP servers legacy) */
  toolBindings?: IAgentToolBinding[];
}

/** A single tool-source binding for an agent */
export interface IAgentToolBinding {
  /** Source type – 'tool' (unified), 'mcp' (legacy), or 'system' (built-in like browser_use) */
  source: 'tool' | 'mcp' | 'system';
  /** Identifier of the source (tool key, MCP server key, or system tool key) */
  sourceKey: string;
  /** Action/tool names selected from that source */
  toolNames: string[];
  /** Optional configuration for the binding (e.g. { browserId } for system browser_use) */
  config?: Record<string, unknown>;
}

export interface IAgent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  key: string;
  name: string;
  description?: string;
  config: IAgentConfig;
  status: AgentStatus;
  /** Currently published version number (null = never published) */
  publishedVersion?: number | null;
  /** Latest version number (incremented on each publish) */
  latestVersion?: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Immutable snapshot of an agent version (created on publish) */
export interface IAgentVersion {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentId: string;
  agentKey: string;
  version: number;
  /** Full agent data snapshot stored as single JSON object */
  snapshot: {
    name: string;
    description?: string;
    config: IAgentConfig;
    status: AgentStatus;
  };
  /** Optional user-provided changelog message */
  changelog?: string;
  publishedBy: string;
  createdAt?: Date;
}

export interface IAgentConversation {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  title?: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: Date;
  }>;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── JS Sandbox runtime types ─────────────────────────────────────────────

export type JsSandboxRuntimeStatus = 'active' | 'disabled';
export type JsSandboxEngine = 'isolated-vm';
export type JsSandboxExecutionStatus = 'success' | 'error' | 'timeout';
export type JsSandboxCallerType = 'dashboard' | 'api' | 'agent';

export interface IJsSandboxRuntimeLimits {
  /** Default execution timeout used when a request does not override it. */
  defaultTimeoutMs: number;
  /** Hard upper timeout bound accepted by the runtime. */
  maxTimeoutMs: number;
  /** V8 isolate memory limit in megabytes. */
  memoryLimitMb: number;
  /** Maximum UTF-8 source size accepted per execution. */
  maxCodeSizeBytes: number;
  /** Maximum serialized result size accepted per execution. */
  maxResultSizeBytes: number;
  /** Maximum number of captured console log entries. */
  maxLogEntries: number;
}

export interface IJsSandboxNetworkPolicy {
  enabled: boolean;
  allowList?: string[];
}

export interface IJsSandboxRuntime {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  status: JsSandboxRuntimeStatus;
  engine: JsSandboxEngine;
  libraries: string[];
  limits: IJsSandboxRuntimeLimits;
  network: IJsSandboxNetworkPolicy;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IJsSandboxExecutionLog {
  stdout: string[];
  stderr: string[];
}

export interface IJsSandboxExecution {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  runtimeId: string;
  runtimeKey: string;
  executionId: string;
  status: JsSandboxExecutionStatus;
  durationMs: number;
  timeoutMs: number;
  memoryLimitMb: number;
  codeHash: string;
  codePreview: string;
  inputPreview?: string;
  result?: unknown;
  logs?: IJsSandboxExecutionLog;
  errorMessage?: string;
  callerType: JsSandboxCallerType;
  callerTokenId?: string;
  createdAt?: Date;
}

// ── Incident types ──────────────────────────────────────────────────────

export type IncidentStatus = 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'closed';
export type IncidentSeverity = 'critical' | 'warning' | 'info';

export interface IIncidentNote {
  userId: string;
  userName: string;
  content: string;
  createdAt: Date;
}

export interface IIncident {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  alertEventId: string;
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  threshold: number;
  actualValue: number;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assignedTo?: string;
  notes: IIncidentNote[];
  firedAt: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  closedAt?: Date;
  resolvedBy?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Browser session & agent types ──────────────────────────────────────────

export type BrowserSessionStatus =
  | 'pending'
  | 'running'
  | 'idle'
  | 'closed'
  | 'errored'
  | 'expired';

export type BrowserActionType =
  | 'create'
  | 'goto'
  | 'click'
  | 'hover'
  | 'type'
  | 'press'
  | 'wait'
  | 'scroll'
  | 'extract'
  | 'snapshot'
  | 'screenshot'
  | 'pdf'
  | 'tool_call'
  | 'agent_event'
  | 'close'
  | 'error';

export type BrowserStatus = 'active' | 'disabled';

/**
 * Browser profile / configuration. A Browser is the parent container that
 * groups browser sessions and browser agents and stores shared defaults
 * (artifact bucket, session config, default model, …). Sessions and agents
 * are always created **under** a Browser.
 */
export interface IBrowser {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** URL-friendly unique identifier scoped to the tenant/project. */
  key: string;
  name: string;
  description?: string;
  status: BrowserStatus;
  /** Default Files bucket where screenshots / PDFs are persisted. */
  artifactBucketKey?: string;
  /** Default browser session configuration applied to spawned sessions. */
  defaultSessionConfig?: IBrowserSessionConfig;
  /** Default tenant model key applied when running agents under this browser. */
  defaultModelKey?: string;
  /** Default agent runtime knobs (maxSteps, runtimeProfile, …). */
  defaultRunOptions?: {
    maxSteps?: number;
    temperature?: number;
    runtimeProfile?: string;
  };
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBrowserAccessRules {
  /** Optional list of host patterns the browser is allowed to navigate to. */
  allowList?: string[];
  /** Optional list of host patterns to block. Evaluated after allowList. */
  blockList?: string[];
}

export interface IBrowserSessionConfig {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  /** Auto-close after this many ms of inactivity. Defaults via config. */
  idleTimeoutMs?: number;
  /** Hard upper bound on session lifetime (ms). */
  maxLifetimeMs?: number;
  access?: IBrowserAccessRules;
}

export interface IBrowserSession {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** Parent Browser profile that owns this session. */
  browserId: string;
  /** Stable identifier exposed to clients. */
  sessionKey: string;
  name?: string;
  agentId?: string;
  agentKey?: string;
  status: BrowserSessionStatus;
  config: IBrowserSessionConfig;
  /** Live state captured for observability — not source of truth. */
  currentUrl?: string;
  pageTitle?: string;
  lastActivityAt?: Date;
  /** Last screenshot artifact reference (file bucket / object key). */
  lastScreenshot?: {
    bucketKey: string;
    fileId: string;
    objectKey: string;
    capturedAt: Date;
  };
  /** Bucket key used to persist artifacts (screenshots / PDFs). */
  artifactBucketKey?: string;
  startedAt?: Date;
  endedAt?: Date;
  errorMessage?: string;
  /** Raw counters for fast list views. */
  eventCount?: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBrowserSessionEvent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  sessionId: string;
  /** Sequence index for ordering within a session. */
  sequence: number;
  type: BrowserActionType;
  status?: 'success' | 'error';
  url?: string;
  selector?: string;
  ref?: string;
  durationMs?: number;
  /** Optional artifact pointer (screenshot / pdf). */
  artifact?: {
    bucketKey: string;
    fileId: string;
    objectKey: string;
    contentType?: string;
  };
  /** Compact, sanitized payload (not raw HTML / large blobs). */
  data?: Record<string, unknown>;
  errorMessage?: string;
  createdAt?: Date;
}

// ── Crawler types ──────────────────────────────────────────────────────────
//
// The Crawler service ingests web pages (and downloadable files) into
// markdown via @cognipeer/to-markdown. A Crawler is a user-defined profile
// that holds the plan (seeds, depth, scope), HTTP settings (headers, cookies,
// auth), an optional RAG module binding and an optional outbound webhook.
// A CrawlJob is one execution; CrawlResult is one fetched page or file.

export type CrawlerStatus = 'active' | 'disabled';
export type CrawlerEngine = 'axios' | 'playwright' | 'auto';
export type CrawlerWebhookEvent = 'page' | 'completed' | 'failed';

export interface ICrawlerScope {
  /** Restrict crawl to the seed domain (and its subdomains if `includeSubdomains`). */
  sameDomainOnly: boolean;
  includeSubdomains: boolean;
  /** Optional host glob patterns (`docs.*.example.com`) – matched against the URL host. */
  allowList?: string[];
  /** Evaluated after allowList – matching hosts are skipped. */
  blockList?: string[];
}

export interface ICrawlerCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Unix seconds. Omit for session cookie. */
  expires?: number;
}

export interface ICrawlerHttpConfig {
  userAgent?: string;
  acceptLanguage?: string;
  /** Per-request timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Concurrent in-flight requests. Default 5, capped at 16. */
  maxConcurrency?: number;
  /** Retry count per request. Default 2. */
  retries?: number;
  headers?: Record<string, string>;
  cookies?: ICrawlerCookie[];
  basicAuth?: { username: string; password: string };
  bearerToken?: string;
  /** Allow private / link-local destinations. Default false (SSRF guard). */
  allowPrivateNetwork?: boolean;
}

export interface ICrawlerWebhookConfig {
  url: string;
  /** HMAC secret used to sign payloads. */
  secret?: string;
  events: CrawlerWebhookEvent[];
}

export interface ICrawlerRagBinding {
  ragModuleKey: string;
  enabled: boolean;
}

export type CrawlerScheduleMode = 'interval' | 'cron';

export interface ICrawlerSchedule {
  mode: CrawlerScheduleMode;
  enabled: boolean;
  /** interval mode: seconds between runs. Minimum 60. */
  intervalSeconds?: number;
  /** cron mode: 5- or 6-field cron expression (UTC). */
  cron?: string;
  /** Optional activation window. */
  startAt?: Date;
  endAt?: Date;
  /** Last run start (mirror of the latest CrawlJob.startedAt). */
  lastRunAt?: Date;
  /** Next scheduled run (computed at write time + after every run). */
  nextRunAt?: Date;
}

export interface ICrawler {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** URL-friendly unique identifier scoped to the tenant/project. */
  key: string;
  name: string;
  description?: string;
  status: CrawlerStatus;

  /** Seed URLs the crawl starts from. At least 1. */
  seeds: string[];
  engine: CrawlerEngine;
  /** 0..3 – capped at 3 to bound runtime. */
  maxDepth: number;
  /** 0 = unlimited. */
  maxPages: number;
  autoCrawl: boolean;
  scope: ICrawlerScope;
  /** MIME types treated as downloadable files (recorded but not stored in F1). */
  downloadableMimes?: string[];

  http: ICrawlerHttpConfig;
  /** Optional markdown extractor options forwarded to @cognipeer/to-markdown. */
  markdownOptions?: { ocr?: { enabled: boolean; languages?: string[] } };

  rag?: ICrawlerRagBinding;
  webhook?: ICrawlerWebhookConfig;
  schedule?: ICrawlerSchedule;

  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CrawlJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'partial';

export type CrawlJobTrigger = 'manual' | 'api' | 'adhoc' | 'schedule';

/**
 * Frozen plan snapshot stored at run time so the job is reproducible even
 * if the parent crawler is later edited.
 */
export interface ICrawlPlanSnapshot {
  seeds: string[];
  engine: CrawlerEngine;
  maxDepth: number;
  maxPages: number;
  autoCrawl: boolean;
  scope: ICrawlerScope;
  http: ICrawlerHttpConfig;
  downloadableMimes?: string[];
  markdownOptions?: { ocr?: { enabled: boolean; languages?: string[] } };
  rag?: ICrawlerRagBinding;
  webhook?: ICrawlerWebhookConfig;
}

export interface ICrawlJob {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** Parent crawler key when triggered from a saved profile; absent for ad-hoc runs. */
  crawlerKey?: string;
  trigger: CrawlJobTrigger;
  triggerActor: string;
  planSnapshot: ICrawlPlanSnapshot;
  status: CrawlJobStatus;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  pagesDiscovered: number;
  pagesProcessed: number;
  filesProcessed: number;
  errorsCount: number;
  limitReached?: boolean;
  /** Per-run callback override (ad-hoc tek-shot run desteği). */
  callbackUrl?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CrawlResultType = 'html' | 'file' | 'error';

export interface ICrawlResult {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  jobId: string;
  crawlerKey?: string;
  url: string;
  parentUrl?: string;
  depth: number;
  type: CrawlResultType;
  httpStatus?: number;
  contentType?: string;
  title?: string;
  description?: string;
  /** Present when type === 'html'. */
  bodyMarkdown?: string;
  bytes?: number;
  /** RAG ingest outcome (when crawler has a RAG binding). */
  ragDocumentId?: string;
  ragStatus?: 'pending' | 'indexed' | 'skipped' | 'failed';
  errorMessage?: string;
  fetchedAt?: Date;
  createdAt?: Date;
}

// ── PII Service types ───────────────────────────────────────────────────────

/**
 * Action taken when PII is detected.
 *  - 'detect'   → return findings, never alter text
 *  - 'redact'   → replace match with a tag like [REDACTED_EMAIL]
 *  - 'mask'     → partial masking, e.g. j***@gmail.com, **** **** **** 1234
 *  - 'block'    → mark finding as blocking; caller decides what to do
 *  - 'tokenize' → reversible masking: replace match with a unique token like
 *                 [EMAIL_1] and return a vault so the original can be restored
 *                 later via detokenize (e.g. round-trip around an LLM call)
 */
export type PiiAction = 'detect' | 'redact' | 'mask' | 'block' | 'tokenize';

/** Language scope for built-in patterns. 'global' = language-independent. */
export type PiiLanguage = 'global' | 'en' | 'tr' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'ar' | 'ja' | 'zh';

/** A tenant-defined custom regex pattern. */
export interface IPiiCustomPattern {
  /** Stable id within the policy (uuid). */
  id: string;
  /** Human-readable category id (used in findings: e.g. "customer_id"). */
  categoryId: string;
  /** Display label (default locale). */
  label: string;
  /** Optional localized labels keyed by language. */
  labels?: Partial<Record<PiiLanguage, string>>;
  /** Regex source string (JS regex, without surrounding slashes). */
  pattern: string;
  /** Regex flags. 'g' is enforced by the detector regardless. */
  flags?: string;
  /** Languages this pattern applies to. Empty / undefined = global. */
  languages?: PiiLanguage[];
  /** Severity for findings produced by this pattern. */
  severity?: 'low' | 'medium' | 'high';
  /** Whether this pattern is enabled. */
  enabled: boolean;
}

/**
 * A reusable PII policy: which built-in categories are enabled,
 * which custom patterns to run, default action and target languages.
 */
export interface IPiiPolicy {
  _id?: import('mongodb').ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  /** Default action applied to findings from this policy. */
  defaultAction: PiiAction;
  /** Built-in categories toggled on/off. Keys are category ids (e.g. 'email'). */
  categories: Record<string, boolean>;
  /** Custom regex patterns defined per tenant. */
  customPatterns?: IPiiCustomPattern[];
  /** Languages to scan for. 'global' is always included. Empty = all. */
  languages?: PiiLanguage[];
  /** Whether the policy is enabled overall. */
  enabled: boolean;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
