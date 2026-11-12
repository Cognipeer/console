'use client';

/**
 * React Query hooks of the MCP servers screens (server list, monitor, tool selection).
 *
 * - Every key starts `['mcp', <project>, ...]` (`mcpKeys`); `<project>` is the marker of `useResourceKey`
 *   (see `projectScope.ts`), so a project switch never shows the old project's servers.
 * - The create form and the detail view write servers outside these hooks, so the list always rereads on a visit.
 *
 * The routes are the dashboard's `/api/mcp` plugin (`src/server/api/plugins/mcp.ts`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch } from '@/lib/api/client';
import type { McpServerView } from '@/lib/services/mcp';
import { retryUnlessClientError } from './errors';
import { pollingOptions } from './polling';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface McpMonitorEntry {
  server: McpServerView;
  aggregate: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    avgLatencyMs: number | null;
  };
  runtime: {
    kind: 'openapi' | 'remote' | 'stdio-subprocess' | 'stdio-sandbox';
    state: 'ready' | 'disabled' | 'degraded' | 'unavailable';
    detail?: string;
  };
}

export interface McpRequestLogRow {
  _id?: string;
  serverKey: string;
  toolName: string;
  status: string;
  latencyMs?: number;
  errorMessage?: string;
  callerType?: string;
  transport?: string;
  createdAt?: string;
}

export interface McpAuditRow {
  _id?: string;
  serverKey: string;
  action: string;
  performedBy: string;
  ipAddress?: string;
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  createdAt?: string;
}

export interface McpMonitorSnapshot {
  servers: McpMonitorEntry[];
  recentLogs: McpRequestLogRow[];
  recentAudit: McpAuditRow[];
}

/** The fields of a server an edit may change (the routes accept more; these are the ones the screens send). */
export type UpdateMcpServerInput = Record<string, unknown>;

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const mcpKeys = {
  all: ['mcp'] as const,
  project: (project: string) => ['mcp', project] as const,
  list: (project: string) => ['mcp', project, 'list'] as const,
  monitor: (project: string) => ['mcp', project, 'monitor'] as const,
};

/* ── Queries ─────────────────────────────────────────────────────────────── */

/** The project's MCP servers. */
export function useMcpServerList() {
  const [, project] = useResourceKey('mcp');
  return useQuery({
    queryKey: mcpKeys.list(project),
    queryFn: async ({ signal }) =>
      (await apiGet<{ servers?: McpServerView[] }>('/api/mcp', { signal })).servers ?? [],
    retry: retryUnlessClientError,
    // The create form and the detail view write servers: a visit always rereads them.
    staleTime: 0,
  });
}

/** Monitor snapshot: servers with their runtime state, recent requests and recent audit entries. Refreshes every 30 s. */
export function useMcpMonitor() {
  const [, project] = useResourceKey('mcp');
  return useQuery({
    queryKey: mcpKeys.monitor(project),
    queryFn: async ({ signal }): Promise<McpMonitorSnapshot> => {
      const data = await apiGet<Partial<McpMonitorSnapshot>>('/api/mcp/monitor', { signal });
      return {
        servers: data.servers ?? [],
        recentLogs: data.recentLogs ?? [],
        recentAudit: data.recentAudit ?? [],
      };
    },
    retry: retryUnlessClientError,
    staleTime: 0,
    ...pollingOptions(() => true, 30_000),
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/**
 * Edits a server (status, tool selection, tool annotations...). The answer carries the stored server; the list and
 * the monitor are read again on the next visit.
 */
export function useUpdateMcpServer() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateMcpServerInput & { id: string }) =>
      apiPatch<{ server: McpServerView }>(`/api/mcp/${id}`, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mcpKeys.project(project) });
    },
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ success?: boolean }>(`/api/mcp/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mcpKeys.project(project) });
    },
  });
}
