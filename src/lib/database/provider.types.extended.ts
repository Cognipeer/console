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
}

export interface IMcpServer {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  /** Raw OpenAPI spec JSON string */
  openApiSpec: string;
  /** Parsed tool definitions extracted from the spec */
  tools: IMcpTool[];
  /** Upstream base URL (derived from spec or overridden) */
  upstreamBaseUrl: string;
  /** Authentication for upstream API calls */
  upstreamAuth: IMcpAuthConfig;
  status: McpServerStatus;
  /** Unique slug used in the public MCP endpoint URL */
  endpointSlug: string;
  totalRequests?: number;
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
  /** HTTP method mapped from the OpenAPI operation */
  httpMethod: string;
  /** Path template from the OpenAPI spec */
  httpPath: string;
}

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
