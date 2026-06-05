import type { IMcpTool, IMcpAuthConfig, McpAuthType } from '@/lib/database';

// ── View types ──────────────────────────────────────────────────────────

export interface McpServerView {
  id: string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  tools: IMcpTool[];
  upstreamBaseUrl: string;
  upstreamAuth: IMcpAuthConfig;
  status: string;
  endpointSlug: string;
  totalRequests?: number;
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
  createdAt?: Date;
}

// ── Input types ─────────────────────────────────────────────────────────

export interface CreateMcpServerInput {
  name: string;
  description?: string;
  openApiSpec: string;
  upstreamBaseUrl?: string;
  upstreamAuth: {
    type: McpAuthType;
    token?: string;
    headerName?: string;
    headerValue?: string;
    username?: string;
    password?: string;
  };
}

export interface UpdateMcpServerInput {
  name?: string;
  description?: string;
  openApiSpec?: string;
  upstreamBaseUrl?: string;
  upstreamAuth?: IMcpAuthConfig;
  status?: string;
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
