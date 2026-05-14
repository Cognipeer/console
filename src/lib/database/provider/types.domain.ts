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

// ── Alert types ─────────────────────────────────────────────────────────

export type AlertModule = 'models' | 'inference' | 'guardrails' | 'rag' | 'mcp';

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
  | 'mcp_total_requests';

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
  /** Source type – 'tool' for unified tool system, 'mcp' for legacy */
  source: 'tool' | 'mcp';
  /** Identifier of the source (tool key or MCP server key) */
  sourceKey: string;
  /** Action/tool names selected from that source */
  toolNames: string[];
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

export type BrowserAgentStatus = 'active' | 'inactive' | 'draft';

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

export interface IBrowserAgent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** Parent Browser profile that owns this agent. */
  browserId: string;
  key: string;
  name: string;
  description?: string;
  /** Tenant model key from the model registry. */
  modelKey: string;
  systemPrompt?: string;
  /** Default browser session config applied when the agent runs. */
  browserConfig?: IBrowserSessionConfig;
  /** Bucket where artifacts (screenshots / PDF) are uploaded. */
  artifactBucketKey?: string;
  /** Reasoning / planning hints (max steps, tool whitelist, etc.). */
  runOptions?: {
    maxSteps?: number;
    temperature?: number;
    runtimeProfile?: string;
  };
  status: BrowserAgentStatus;
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

