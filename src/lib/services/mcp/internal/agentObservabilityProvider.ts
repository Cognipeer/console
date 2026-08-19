/**
 * Internal MCP provider: Agent Observability (reporting only).
 *
 * Read-only tools over agent tracing data for the project the MCP server
 * belongs to — list agents, list sessions, and inspect one session. No
 * mutation tools are exposed; this is strictly a reporting surface.
 */

import { AgentTracingService } from '@/lib/services/agentTracing';
import type {
  InternalMcpInstanceOption,
  InternalMcpProvider,
  InternalMcpProviderContext,
} from './types';

/** This provider isn't scoped to a per-instance resource (unlike a Knowledge
 *  Base module) — one MCP server covers all agent activity in the project. */
const INSTANCE_KEY = 'project';

const TOOL_LIST_AGENTS = 'list_agents';
const TOOL_LIST_SESSIONS = 'list_sessions';
const TOOL_GET_SESSION_DETAIL = 'get_session_detail';

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const boundedInt = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
};

function requireProjectId(ctx: InternalMcpProviderContext): string {
  if (!ctx.projectId) {
    throw new Error('Agent Observability tools require a project-scoped MCP server');
  }
  return ctx.projectId;
}

export const agentObservabilityProvider: InternalMcpProvider = {
  id: 'agent-observability',
  label: 'Agent Observability',
  description: 'Read-only reporting over agent tracing: list agents, list sessions, and inspect a session.',
  configFields: [],

  async listInstances(_ctx: InternalMcpProviderContext): Promise<InternalMcpInstanceOption[]> {
    return [
      {
        key: INSTANCE_KEY,
        label: 'Agent Observability',
        description: 'Reporting tools over this project\'s agent tracing sessions.',
      },
    ];
  },

  async validateInstance(_ctx, instanceKey) {
    if (instanceKey !== INSTANCE_KEY) {
      throw new Error(`Unknown Agent Observability instance "${instanceKey}"`);
    }
  },

  async buildTools() {
    return {
      tools: [
        {
          name: TOOL_LIST_AGENTS,
          description:
            'List agents that have recorded tracing sessions in this project, with session '
            + 'counts and the most recent session status/time per agent.',
          inputSchema: {
            type: 'object',
            properties: {
              from: { type: 'string', format: 'date-time', description: 'ISO start timestamp (inclusive).' },
              to: { type: 'string', format: 'date-time', description: 'ISO end timestamp (inclusive).' },
              limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Max agents to return.' },
            },
            additionalProperties: false,
          },
        },
        {
          name: TOOL_LIST_SESSIONS,
          description:
            'List recent agent tracing sessions. Supports filtering by agent name, status, and a '
            + 'free-text search across sessionId, threadId and agent name.',
          inputSchema: {
            type: 'object',
            properties: {
              agent: { type: 'string', description: 'Filter by exact or partial agent name.' },
              status: { type: 'string', enum: ['success', 'error', 'running'], description: 'Filter by session status.' },
              query: { type: 'string', description: 'Free-text search on sessionId, threadId or agent name.' },
              from: { type: 'string', format: 'date-time', description: 'ISO start timestamp (inclusive).' },
              to: { type: 'string', format: 'date-time', description: 'ISO end timestamp (inclusive).' },
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Max sessions to return.' },
            },
            additionalProperties: false,
          },
        },
        {
          name: TOOL_GET_SESSION_DETAIL,
          description:
            'Fetch one agent tracing session by sessionId — status, timing, token usage, '
            + 'models/tools used, and error summary (without per-event payloads).',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The sessionId to look up.' },
            },
            required: ['sessionId'],
            additionalProperties: false,
          },
        },
      ],
      suggestedName: 'Agent Observability',
      suggestedDescription: 'Read-only reporting over this project\'s agent tracing sessions.',
    };
  },

  async execute(ctx, _instanceKey, _config, toolName, args) {
    const projectId = requireProjectId(ctx);

    if (toolName === TOOL_LIST_AGENTS) {
      return AgentTracingService.listRecentAgents(ctx.tenantDbName, projectId, {
        from: optionalString(args.from),
        to: optionalString(args.to),
        limit: boundedInt(args.limit, 50, 200),
      });
    }

    if (toolName === TOOL_LIST_SESSIONS) {
      return AgentTracingService.listSessions(ctx.tenantDbName, projectId, {
        agent: optionalString(args.agent),
        status: optionalString(args.status),
        query: optionalString(args.query),
        from: optionalString(args.from),
        to: optionalString(args.to),
        limit: String(boundedInt(args.limit, 20, 100)),
      });
    }

    if (toolName === TOOL_GET_SESSION_DETAIL) {
      const sessionId = optionalString(args.sessionId);
      if (!sessionId) {
        throw new Error('"sessionId" is required');
      }
      const result = await AgentTracingService.getSessionDetail(ctx.tenantDbName, projectId, sessionId, {
        includeEventContent: false,
      });
      if (!result) {
        throw new Error(`Session ${sessionId} not found`);
      }
      return { session: result.session, eventCount: result.events.length };
    }

    throw new Error(`Unknown tool "${toolName}" on Agent Observability provider`);
  },
};
