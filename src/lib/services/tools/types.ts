/**
 * Tool Service – Types
 */

import type { IToolAction, IToolAuthConfig, ToolSourceType } from '@/lib/database';
import type { SpecFormatHint } from '@/lib/services/specImport';

// ── View types ──────────────────────────────────────────────────────────

export interface ToolView {
  id: string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  type: ToolSourceType;
  status: string;
  actions: IToolAction[];
  upstreamBaseUrl?: string;
  mcpEndpoint?: string;
  mcpTransport?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ToolRequestLogView {
  id: string;
  toolKey: string;
  actionKey: string;
  actionName: string;
  status: string;
  latencyMs?: number;
  errorMessage?: string;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  callerType?: string;
  callerTokenId?: string;
  createdAt?: Date;
}

export interface ToolAggregateView {
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

// ── Input types ─────────────────────────────────────────────────────────

export interface CreateToolInput {
  name: string;
  description?: string;
  type: ToolSourceType;
  /** For OpenAPI: spec JSON/YAML, or a Postman collection */
  openApiSpec?: string;
  /** How to interpret `openApiSpec` (default: auto-detect). */
  specFormat?: SpecFormatHint;
  upstreamBaseUrl?: string;
  upstreamAuth?: {
    type: 'none' | 'token' | 'header' | 'basic';
    token?: string;
    headerName?: string;
    headerValue?: string;
    username?: string;
    password?: string;
  };
  /** For MCP: endpoint URL */
  mcpEndpoint?: string;
  mcpTransport?: 'sse' | 'streamable-http';
}

export interface UpdateToolInput {
  name?: string;
  description?: string;
  openApiSpec?: string;
  specFormat?: SpecFormatHint;
  upstreamBaseUrl?: string;
  upstreamAuth?: IToolAuthConfig;
  mcpEndpoint?: string;
  mcpTransport?: 'sse' | 'streamable-http';
  status?: string;
}

export interface ExecuteToolActionResult {
  result: unknown;
  latencyMs: number;
}
