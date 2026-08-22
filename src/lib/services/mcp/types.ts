import type {
  IMcpAegisConfig,
  IMcpAuthConfig,
  IMcpExposureConfig,
  IMcpRemoteConfig,
  IMcpStdioConfig,
  IMcpTool,
  IMcpToolAnnotations,
  McpAuthType,
  McpSourceType,
} from '@/lib/database';
import type { SpecFormatHint } from '@/lib/services/specImport';
import type { IMcpCompositeMemberSummary } from './composite';

// ── View types ──────────────────────────────────────────────────────────

export interface McpServerView {
  id: string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  sourceType: McpSourceType;
  tools: IMcpTool[];
  /** Tool names hidden from callers (tools/list, agents, execute). */
  disabledTools: string[];
  /** Operator overrides for the hints advertised in `tools/list`, keyed by tool name. */
  toolAnnotations?: Record<string, IMcpToolAnnotations>;
  /** Operator-authored tool descriptions, keyed by tool name. */
  toolDescriptions?: Record<string, string>;
  /** Operator-set exposed names, keyed by the real (discovered) tool name. */
  toolNames?: Record<string, string>;
  /** sourceType 'composite' only: cached display summary of each member. */
  members?: IMcpCompositeMemberSummary[];
  toolsDiscoveredAt?: Date;
  upstreamBaseUrl?: string;
  /** Secrets are masked in views. */
  upstreamAuth: IMcpAuthConfig;
  remoteConfig?: IMcpRemoteConfig;
  /** Env values are masked in views. */
  stdioConfig?: IMcpStdioConfig;
  exposure: IMcpExposureConfig;
  aegis?: IMcpAegisConfig;
  status: string;
  endpointSlug: string;
  totalRequests?: number;
  lastError?: { message: string; at: Date } | null;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface McpRequestLogView {
  id: string;
  serverKey: string;
  toolName: string;
  status: string;
  latencyMs?: number;
  errorMessage?: string;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  callerTokenId?: string;
  callerType?: string;
  transport?: string;
  createdAt?: Date;
}

// ── Input types ─────────────────────────────────────────────────────────

export interface CreateMcpServerInput {
  name: string;
  /** Custom identifier for the token-authed API path (default: slugified from `name`). */
  key?: string;
  description?: string;
  /** Tool source (default 'openapi' for backward compatibility). */
  sourceType?: McpSourceType;
  /** OpenAPI JSON/YAML or a Postman collection (sourceType 'openapi'). */
  openApiSpec?: string;
  /** How to interpret `openApiSpec` (default: auto-detect). */
  specFormat?: SpecFormatHint;
  upstreamBaseUrl?: string;
  upstreamAuth: {
    type: McpAuthType;
    token?: string;
    headerName?: string;
    headerValue?: string;
    username?: string;
    password?: string;
  };
  /** Remote MCP upstream (sourceType 'remote'). */
  remoteConfig?: IMcpRemoteConfig;
  /** Stdio launch config (sourceType 'stdio'). */
  stdioConfig?: IMcpStdioConfig;
  /** Console-native capability config (sourceType 'internal'). */
  internalConfig?: InternalMcpConfigInput;
  /** Member MCP servers to republish (sourceType 'composite'). */
  compositeConfig?: CompositeConfigInput;
  exposure?: IMcpExposureConfig;
  /** Custom public-URL path segment (default: a random unguessable slug). Only
   *  meaningful once exposure.accessMode is 'public'; must be unique tenant-wide. */
  endpointSlug?: string;
  aegis?: IMcpAegisConfig;
}

/** Which internal capability backs the server, and its instance + settings. */
export interface InternalMcpConfigInput {
  /** Provider id from the internal MCP provider registry, e.g. 'knowledge-base'. */
  provider: string;
  /** The provider-specific instance key, e.g. a RAG module key. */
  instanceKey: string;
  /** Provider-defined settings. Empty for 'knowledge-base' today. */
  config?: Record<string, unknown>;
}

/** The member servers a composite republishes, and how their tools are named. */
export interface CompositeConfigInput {
  members: Array<{
    /** Member MCP server's _id. */
    serverId: string;
    /** Exposed-name prefix for this member's tools; defaults to slug(serverKey). */
    toolPrefix?: string;
    /** Always prefix this member's tools, even when the name wouldn't collide. */
    alwaysPrefix?: boolean;
  }>;
}

export interface UpdateMcpServerInput {
  /** Rename the server's identifier (slugified + de-duplicated; empty/whitespace is ignored). */
  key?: string;
  name?: string;
  description?: string;
  openApiSpec?: string;
  specFormat?: SpecFormatHint;
  upstreamBaseUrl?: string;
  upstreamAuth?: IMcpAuthConfig;
  remoteConfig?: IMcpRemoteConfig;
  stdioConfig?: IMcpStdioConfig;
  /** Console-native capability config (sourceType 'internal'). */
  internalConfig?: InternalMcpConfigInput;
  /** Full replacement member list (sourceType 'composite'). */
  compositeConfig?: CompositeConfigInput;
  exposure?: IMcpExposureConfig;
  /** Rename the server's public-URL path segment; must be unique tenant-wide. */
  endpointSlug?: string;
  aegis?: IMcpAegisConfig;
  status?: string;
  /** Opt-in policy for caller-supplied runtime header passthrough (null clears). */
  runtimeHeaders?: { allow?: boolean; allowedNames?: string[] } | null;
  /** Full replacement list of disabled tool names (empty array enables all). */
  disabledTools?: string[];
  /** Partial patch of per-tool annotation overrides (null/empty clears one). */
  toolAnnotations?: Record<string, IMcpToolAnnotations | null>;
  /** Partial patch of per-tool description overrides (null/empty restores the discovered text). */
  toolDescriptions?: Record<string, string | null>;
  /** Partial patch of per-tool name overrides, keyed by real tool name (null/empty restores the discovered name). */
  toolNames?: Record<string, string | null>;
}

/** Request-scoped context threaded into audit writes. */
export interface McpAuditContext {
  performedBy: string;
  ipAddress?: string;
  userAgent?: string;
}

// ── OpenAPI parsing types ───────────────────────────────────────────────

export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    description?: string;
    version?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, {
      schema?: Record<string, unknown>;
    }>;
  };
  responses?: Record<string, unknown>;
}
