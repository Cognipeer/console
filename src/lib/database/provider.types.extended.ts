import type { ObjectId } from 'mongodb';
import type {
  GuardrailAction,
  GuardrailTarget,
  GuardrailType,
} from './provider.types.domain';

// ── Memory types ─────────────────────────────────────────────────────────

export type MemoryScope = 'user' | 'agent' | 'session' | 'global';
export type MemorySource = 'chat' | 'api' | 'agent' | 'manual';
export type MemoryStoreStatus = 'active' | 'inactive' | 'error';
export type MemoryItemStatus = 'active' | 'archived' | 'expired';

export interface IMemoryStoreConfig {
  embeddingDimension: number;
  metric: 'cosine' | 'euclidean' | 'dotproduct';
  defaultScope: MemoryScope;
  deduplication: boolean;
  autoSummarize: boolean;
  maxMemories?: number;
  ttlDays?: number;
}

export interface IMemoryStore {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  key: string;
  name: string;
  description?: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  embeddingModelKey: string;
  config: IMemoryStoreConfig;
  status: MemoryStoreStatus;
  memoryCount: number;
  lastActivityAt?: Date;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IMemoryItem {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  storeKey: string;
  content: string;
  contentHash: string;
  summary?: string;
  scope: MemoryScope;
  scopeId?: string;
  metadata: Record<string, unknown>;
  tags: string[];
  source?: MemorySource;
  importance: number;
  accessCount: number;
  lastAccessedAt?: Date;
  embeddingVersion: string;
  vectorId: string;
  expiresAt?: Date;
  status: MemoryItemStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IGuardrailEvaluationLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  guardrailId: string;
  guardrailKey: string;
  guardrailName: string;
  guardrailType: GuardrailType;
  target: GuardrailTarget;
  action: GuardrailAction;
  passed: boolean;
  findings: Array<{
    type: string;
    category: string;
    severity: 'low' | 'medium' | 'high';
    message: string;
    action: string;
    block: boolean;
    value?: string;
  }>;
  inputText?: string;
  latencyMs?: number;
  source?: string;
  requestId?: string;
  message?: string | null;
  createdAt?: Date;
}

export interface IGuardrailEvalAggregate {
  guardrailId: string;
  totalEvaluations: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  avgLatencyMs: number | null;
  findingsByType: Record<string, number>;
  findingsBySeverity: Record<string, number>;
  timeseries?: Array<{
    period: string;
    total: number;
    passed: number;
    failed: number;
  }>;
}

// ── Config (Secret/Configuration Management) types ───────────────────────

export type ConfigValueType = 'string' | 'number' | 'boolean' | 'json';

export interface IConfigGroup {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IConfigItem {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  groupId: string;
  key: string;
  name: string;
  description?: string;
  /** Stored value. If `isSecret` is true, this is encrypted at rest. */
  value: string;
  valueType: ConfigValueType;
  isSecret: boolean;
  tags?: string[];
  version: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IConfigAuditLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  configKey: string;
  action: 'create' | 'update' | 'delete' | 'read';
  previousValue?: string;
  newValue?: string;
  version?: number;
  performedBy: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

// ── MCP Server types ─────────────────────────────────────────────────────

export type McpServerStatus = 'active' | 'disabled';

export type McpAuthType = 'none' | 'token' | 'header' | 'basic';

export interface IMcpAuthConfig {
  type: McpAuthType;
  /** For 'token': the bearer token value */
  token?: string;
  /** For 'header': custom header name + value */
  headerName?: string;
  headerValue?: string;
  /** For 'basic': username + password */
  username?: string;
  password?: string;
  /**
   * Encrypted-at-rest secret payload (AES-256-GCM). When set, the plaintext
   * secret fields above are absent from the stored record and must be
   * recovered through the MCP secret vault before use.
   */
  sealed?: string;
}

/** Where the server's tools come from. Legacy records (no field) are 'openapi'. */
export type McpSourceType = 'openapi' | 'remote' | 'stdio';

/** Protocols the gateway exposes for a server. */
export type McpExposureProtocol = 'streamable-http' | 'sse';

/** How callers authenticate against the exposed MCP endpoint. */
export type McpAccessMode = 'token' | 'public';

export interface IMcpExposureConfig {
  protocols: McpExposureProtocol[];
  accessMode: McpAccessMode;
}

/** Upstream remote MCP server the gateway proxies. */
export interface IMcpRemoteConfig {
  url: string;
  transport: 'streamable-http' | 'sse';
}

export type McpStdioRuntime = 'npx' | 'uvx';
export type McpStdioExecutionMode = 'subprocess' | 'sandbox';

export interface IMcpSandboxResources {
  cpuCores?: number;
  memoryMb?: number;
}

/** Locally-launched MCP server (npx / uvx package) config. */
export interface IMcpStdioConfig {
  runtime: McpStdioRuntime;
  /** Package spec, e.g. "@modelcontextprotocol/server-everything" or "mcp-server-fetch" */
  packageName: string;
  args?: string[];
  /** Plaintext env var names → values. Secret values are sealed into envSealed. */
  env?: Record<string, string>;
  /** Encrypted-at-rest env payload (AES-256-GCM JSON of Record<string,string>). */
  envSealed?: string;
  executionMode: McpStdioExecutionMode;
  /** Only for executionMode 'sandbox'. */
  sandbox?: {
    templateKey?: string;
    resources?: IMcpSandboxResources;
    /** Persistent sandbox instance backing this server (set once provisioned). */
    instanceId?: string;
  };
}

/** Aegis integration seam — enforcement is wired by the enterprise overlay. */
export interface IMcpAegisConfig {
  shieldId?: string;
  mode: 'off' | 'monitor' | 'enforce';
}

export interface IMcpServer {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  /** Tool source. Legacy records without the field are treated as 'openapi'. */
  sourceType?: McpSourceType;
  /** Raw OpenAPI spec JSON string (sourceType 'openapi' only). */
  openApiSpec?: string;
  /** Remote upstream MCP config (sourceType 'remote'). */
  remoteConfig?: IMcpRemoteConfig;
  /** Stdio launch config (sourceType 'stdio'). */
  stdioConfig?: IMcpStdioConfig;
  /** Parsed/discovered tool definitions */
  tools: IMcpTool[];
  /** When tools were last discovered from a remote/stdio source. */
  toolsDiscoveredAt?: Date;
  /** Upstream base URL (sourceType 'openapi'). */
  upstreamBaseUrl?: string;
  /** Authentication for upstream API/MCP calls */
  upstreamAuth: IMcpAuthConfig;
  /** Endpoint exposure: enabled protocols + access mode. Default: both + token. */
  exposure?: IMcpExposureConfig;
  /** Aegis shield binding (prep — enforcement lands with the EE integration). */
  aegis?: IMcpAegisConfig;
  status: McpServerStatus;
  /** Unique slug used in the public MCP endpoint URL */
  endpointSlug: string;
  totalRequests?: number;
  /** Last runtime error observed for this server (stdio spawn/remote probe). */
  lastError?: { message: string; at: Date } | null;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IMcpTool {
  name: string;
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: Record<string, unknown>;
  /** HTTP method mapped from the OpenAPI operation (sourceType 'openapi'). */
  httpMethod?: string;
  /** Path template from the OpenAPI spec (sourceType 'openapi'). */
  httpPath?: string;
}

/** Who initiated an MCP tool call. */
export type McpCallerType = 'dashboard' | 'api' | 'agent' | 'public';

/** Which surface the call arrived on. */
export type McpCallTransport = 'rest' | 'jsonrpc' | 'sse' | 'internal';

export interface IMcpRequestLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  serverKey: string;
  toolName: string;
  status: 'success' | 'error';
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  errorMessage?: string;
  latencyMs?: number;
  callerTokenId?: string;
  callerType?: McpCallerType;
  callerUserId?: string;
  transport?: McpCallTransport;
  sourceType?: McpSourceType;
  /** SSE session id when the call arrived over an SSE session. */
  sessionId?: string;
  createdAt?: Date;
}

// ── MCP audit log ─────────────────────────────────────────────────────────

export type McpAuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'status_change'
  | 'exposure_change'
  | 'secrets_change'
  | 'tools_refresh'
  | 'playground_execute';

export interface IMcpAuditLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  serverId?: string;
  serverKey: string;
  action: McpAuditAction;
  /** Field-level diff with secrets masked. */
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  performedBy: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface IMcpRequestAggregate {
  serverKey: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  toolBreakdown: Record<string, number>;
  timeseries?: Array<{
    period: string;
    total: number;
    success: number;
    errors: number;
  }>;
}
