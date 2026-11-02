/**
 * Tool Service – Types
 */

import type { IToolAction, IToolAuthConfig, ToolSourceType, ToolStatus } from '@/lib/database';
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
  /** Set when another module owns the tool; it is then read-only through the Tools API. */
  managedBy?: { kind: 'connector'; id: string };
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
  /** Wanted key (an import keeps the manifest's); made unique within the project. Defaults to one derived from `name`. */
  key?: string;
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
  /** Opt-in policy for caller-supplied runtime header passthrough (null clears). */
  runtimeHeaders?: { allow?: boolean; allowedNames?: string[] } | null;
}

export interface ExecuteToolActionResult {
  result: unknown;
  latencyMs: number;
  /** The upstream MCP server answered `isError: true`: the call failed, and `result` is its error text. */
  isError?: boolean;
}

export interface ExecuteToolActionOptions {
  /**
   * Receives the credential values resolved for this call (a connector-managed
   * tool), so the caller's request log scrubs them like a static credential.
   */
  onSecrets?: (values: string[]) => void;
}

/**
 * A tool another module owns (today the enterprise Connectors module). Built by
 * that module's service code, never from a request body.
 */
export interface ManagedToolInput {
  connectorId: string;
  key?: string;
  name: string;
  description?: string;
  type: ToolSourceType;
  /** Defaults to `active`; a tool whose owner is switched off is created `disabled`. */
  status?: ToolStatus;
  actions: IToolAction[];
  mcpEndpoint?: string;
  mcpTransport?: 'sse' | 'streamable-http';
  upstreamBaseUrl?: string;
  openApiSpec?: string;
  metadata?: Record<string, unknown>;
}

export type ManagedToolUpdate = Partial<Omit<ManagedToolInput, 'connectorId' | 'key' | 'type'>>;
