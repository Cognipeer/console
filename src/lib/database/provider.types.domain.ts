import type { ObjectId } from 'mongodb';

// ── Guardrail types ────────────────────────────────────────────────────────

export type GuardrailType = 'preset' | 'custom';
export type GuardrailAction = 'block' | 'warn' | 'flag' | 'redact';
export type GuardrailTarget = 'input' | 'output' | 'both';
/** What happens when an LLM-backed check errors out: pass content (open) or block it (closed). */
export type GuardrailFailMode = 'open' | 'closed';

export interface IGuardrailPiiPolicy {
  enabled: boolean;
  action: GuardrailAction;
  categories: Record<string, boolean>;
}

export interface IGuardrailWordFilterPolicy {
  enabled: boolean;
  action?: GuardrailAction;
  /** Built-in lists to activate, e.g. { 'profanity-en': true, 'profanity-tr': true }. */
  builtinLists?: Record<string, boolean>;
  /** Keys of tenant-uploaded word lists (guardrail_word_lists) to apply. */
  customListKeys?: string[];
  /** Tenant-defined banned words (matched after normalization). */
  words?: string[];
  /** Tenant-defined regular expressions (evaluated case-insensitively). */
  regexes?: string[];
}

/** A reusable, tenant-managed banned-word list (uploaded via CSV/text or edited inline). */
export interface IGuardrailWordList {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  /** Informational language tag, e.g. 'tr', 'en', 'mixed'. */
  language?: string;
  words: string[];
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IGuardrailModerationPolicy {
  enabled: boolean;
  /**
   * Which detector runs this policy.
   *  - `llm` (default): the chat model named by `modelKey` judges the text.
   *  - `model`: the moderation-category model named by `modelKey` classifies it.
   *
   * The judge is the universal fallback — it works against any chat model — but
   * it costs a full completion on the hot path of every guarded request, and it
   * can only report a coarse severity. Where the provider has a real
   * classifier, `model` is both far cheaper and the only path that yields true
   * per-category probabilities.
   */
  detector?: 'llm' | 'model';
  /** Chat model (detector `llm`) or moderation model (detector `model`). */
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
  wordFilter?: IGuardrailWordFilterPolicy;
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
  /** LLM-check failure behavior. Defaults to 'open' (content passes if the evaluator errors). */
  failMode?: GuardrailFailMode;
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

/**
 * How a document is split before embedding.
 *
 * `recursive_character` and `token` differ in the UNIT `chunkSize`/`chunkOverlap`
 * are measured in — characters vs. real tokens. The rest change where the
 * boundaries are allowed to fall.
 */
export type RagChunkStrategy =
  /** Split on separators, largest first, falling back to a hard cut. Sizes in characters. */
  | 'recursive_character'
  /** Same boundaries, but sized in real tokens of `encoding`. */
  | 'token'
  /** Never cross a markdown heading; each chunk carries its heading path. */
  | 'markdown'
  /** Never cut mid-sentence. */
  | 'sentence'
  /** Cut where the topic shifts, measured by embedding distance between sentences. */
  | 'semantic';

export interface IRagChunkConfig {
  strategy: RagChunkStrategy;
  /**
   * Target chunk size. Characters for every strategy except `token`, which
   * counts real tokens of `encoding`. This is a HARD cap: a run of text with no
   * usable boundary is cut rather than emitted oversized.
   */
  chunkSize: number;
  /** Overlap carried into the next chunk, in the same unit as chunkSize. Must be < chunkSize. */
  chunkOverlap: number;
  /** recursive_character / markdown: boundary preferences, best first. `sentence` splits on punctuation and ignores this. */
  separators?: string[];
  /** token: tiktoken encoding name (cl100k_base, p50k_base, o200k_base). */
  encoding?: string;
  /**
   * semantic: cosine distance between neighbouring sentences above which a new
   * chunk starts. 0..1, default 0.35. Higher = fewer, larger chunks.
   */
  semanticThreshold?: number;
  /**
   * Small-to-big retrieval. Embed the small chunk, but return a window of this
   * many characters centred on it, resolved from the stored source at query
   * time. 0 or unset disables it.
   */
  parentWindowSize?: number;
  /**
   * Prefix each chunk with one LLM-written sentence situating it in its
   * document, which measurably improves retrieval on chunks that would
   * otherwise be context-free. Costs one model call per chunk at ingest.
   */
  contextualHeader?: {
    enabled: boolean;
    /** Model used to write the header. Falls back to the module's answer model. */
    modelKey?: string;
    /** How much of the document to show the model as context. Default 8000. */
    maxDocumentChars?: number;
  };
}

export type RagDocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed';

/**
 * One vector similarity query, recorded for the index analytics panel
 * (query volume, latency, score, filter usage).
 */
export interface IVectorQueryLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  providerKey: string;
  /** Index key, matching `IVectorIndexRecord.key`. */
  indexKey: string;
  topK: number;
  matchCount: number;
  latencyMs: number;
  /** Mean similarity score across the returned matches. */
  avgScore?: number;
  /** Whether the caller supplied a metadata filter. */
  filterApplied: boolean;
  /** Whether the query ran dense+keyword rather than dense only. */
  hybrid?: boolean;
  userId?: string;
  apiTokenId?: string;
  actorType?: string;
  timestamp: Date;
}

/** Aggregated query analytics for one vector index, over a time window. */
export interface IVectorQueryStats {
  daily: Array<{
    /** UTC day, `YYYY-MM-DD`. */
    date: string;
    queryCount: number;
    avgLatencyMs: number;
    /** Null when no query in the bucket returned a score. */
    avgScore: number | null;
    filterCount: number;
  }>;
  totals: {
    totalQueries: number;
    avgLatencyMs: number | null;
    avgScore: number | null;
    minLatencyMs: number | null;
    maxLatencyMs: number | null;
  };
  topKDistribution: Array<{ topK: number; count: number }>;
}

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
  /**
   * Metadata filter ANDed into every query against this module. Lets several
   * sources share one vector index while each module only ever retrieves its
   * own slice.
   */
  defaultFilter?: Record<string, unknown>;
  /**
   * Metadata keys callers may filter on. When set, a query filtering on any
   * other key is rejected; also advertised to agents and MCP clients so they
   * know what is filterable.
   */
  filterableFields?: string[];
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
  /** Bucket the original bytes were stored in, alongside fileKey. */
  fileBucketKey?: string;
  fileProviderKey?: string;
  fileName: string;
  contentType?: string;
  size?: number;
  status: RagDocumentStatus;
  chunkCount?: number;
  errorMessage?: string;
  lastIndexedAt?: Date;
  /**
   * Per-document override of the module's chunkConfig. A 200-page PDF and a FAQ
   * CSV rarely want the same splitter. Unset means "use the module's".
   */
  chunkConfig?: IRagChunkConfig;
  /**
   * The extracted text this document was last indexed from, so a re-index never
   * has to reconstruct it from overlapping chunks. Stored inline only when it
   * fits INLINE_SOURCE_MAX_CHARS; larger sources live in the file bucket under
   * sourceTextKey.
   */
  sourceText?: string;
  sourceTextKey?: string;
  /** sha256 of the extracted text — lets a re-ingest skip unchanged content. */
  sourceHash?: string;
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
  /**
   * Offsets of this chunk in the document's source text. These are what make a
   * parent window resolvable without duplicating the text on every child row.
   */
  charStart?: number;
  charEnd?: number;
  /** Markdown heading breadcrumb the chunk sits under, outermost first. */
  headingPath?: string[];
  /** Real token count of `content`, when the strategy computed one. */
  tokenCount?: number;
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

