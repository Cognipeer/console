/**
 * Built-in "console" MCP server tools.
 *
 * These tools are project-scoped (resolved from the API token in the
 * Authorization header) and provide simple agent-observability reporting.
 *
 * Keep tools small and focused — each tool maps to a single
 * AgentTracingService call and returns a JSON-serialisable payload.
 */

import { AgentTracingService } from '@/lib/services/agentTracing';

export interface ConsoleToolContext {
  tenantDbName: string;
  projectId: string;
}

export interface ConsoleToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    ctx: ConsoleToolContext,
  ) => Promise<unknown>;
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const optionalPositiveInt = (
  value: unknown,
  fallback: number,
  max: number,
): string => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(fallback);
  return String(Math.min(Math.floor(n), max));
};

export const CONSOLE_MCP_TOOLS: ConsoleToolDefinition[] = [
  {
    name: 'list_recent_sessions',
    description:
      'List recent agent tracing sessions for the current project. '
      + 'Supports optional filters by status, agent name, and a free-text '
      + 'search across sessionId, threadId and agent name.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Maximum number of sessions to return (1-100).',
        },
        status: {
          type: 'string',
          enum: ['success', 'error', 'running'],
          description: 'Filter sessions by status.',
        },
        agent: {
          type: 'string',
          description: 'Filter by exact or partial agent name.',
        },
        query: {
          type: 'string',
          description: 'Free-text search on sessionId, threadId or agent name.',
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const result = await AgentTracingService.listSessions(
        ctx.tenantDbName,
        ctx.projectId,
        {
          agent: optionalString(args.agent),
          query: optionalString(args.query),
          status: optionalString(args.status),
          limit: optionalPositiveInt(args.limit, 20, 100),
          skip: '0',
        },
      );
      return {
        total: result.total,
        sessions: result.sessions,
      };
    },
  },
  {
    name: 'get_session',
    description:
      'Fetch a single agent tracing session by sessionId. Returns the '
      + 'session summary (without per-event payloads) for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The sessionId to look up.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const sessionId = optionalString(args.sessionId);
      if (!sessionId) {
        throw new Error('"sessionId" is required');
      }
      const result = await AgentTracingService.getSessionDetail(
        ctx.tenantDbName,
        ctx.projectId,
        sessionId,
        { includeEventContent: false },
      );
      if (!result) {
        throw new Error(`Session ${sessionId} not found`);
      }
      return {
        session: result.session,
        eventCount: result.events.length,
      };
    },
  },
  {
    name: 'get_dashboard_overview',
    description:
      'Return aggregate agent observability metrics for the current '
      + 'project (totals, per-status counts, top agents, daily trends). '
      + 'Optional ISO timestamps narrow the reporting window.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          format: 'date-time',
          description: 'ISO start timestamp (inclusive).',
        },
        to: {
          type: 'string',
          format: 'date-time',
          description: 'ISO end timestamp (inclusive).',
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const overview = await AgentTracingService.getDashboardOverview(
        ctx.tenantDbName,
        ctx.projectId,
        {
          from: optionalString(args.from),
          to: optionalString(args.to),
        },
      );
      return {
        totals: overview.analytics.totals,
        statuses: overview.analytics.statuses,
        agents: overview.analytics.agents,
        recentSessions: overview.recentSessions,
      };
    },
  },
];

const TOOL_INDEX = new Map(
  CONSOLE_MCP_TOOLS.map((tool) => [tool.name, tool] as const),
);

export function getConsoleTool(name: string): ConsoleToolDefinition | undefined {
  return TOOL_INDEX.get(name);
}

export function listConsoleToolDescriptors() {
  return CONSOLE_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}
