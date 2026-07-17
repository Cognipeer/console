import type {
  IMcpAegisConfig,
  IMcpAuthConfig,
  IMcpExposureConfig,
  IMcpRemoteConfig,
  IMcpStdioConfig,
  IMcpTool,
  McpAuthType,
  McpSourceType,
} from '@/lib/database';
import type { SpecFormatHint } from '@/lib/services/specImport';

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
  exposure?: IMcpExposureConfig;
  aegis?: IMcpAegisConfig;
}

export interface UpdateMcpServerInput {
  name?: string;
  description?: string;
  openApiSpec?: string;
  specFormat?: SpecFormatHint;
  upstreamBaseUrl?: string;
  upstreamAuth?: IMcpAuthConfig;
  remoteConfig?: IMcpRemoteConfig;
  stdioConfig?: IMcpStdioConfig;
  exposure?: IMcpExposureConfig;
  aegis?: IMcpAegisConfig;
  status?: string;
  /** Opt-in policy for caller-supplied runtime header passthrough (null clears). */
  runtimeHeaders?: { allow?: boolean; allowedNames?: string[] } | null;
  /** Full replacement list of disabled tool names (empty array enables all). */
  disabledTools?: string[];
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
