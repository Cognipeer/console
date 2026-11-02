/**
 * Internal MCP provider: Agent Observability (reporting only).
 *
 * Read-only tools over agent tracing data for the project the MCP server
 * belongs to — list agents, list sessions, and inspect one session. No
 * mutation tools are exposed; this is strictly a reporting surface.
 */

import { runWithTenantScope } from '@/lib/database';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { restrictedKnowledgeTagsOf } from '@/lib/services/rag/access/exposure';
import { McpToolInputError } from '../errors';
import type {
  InternalMcpInstanceOption,
  InternalMcpProvider,
  InternalMcpProviderContext,
} from './types';

/** This provider isn't scoped to a per-instance resource (unlike a Knowledge
 *  Base module) — one MCP server covers all agent activity in the project. */
const INSTANCE_KEY = 'project';

/** Longest piece of a caller-supplied id an error repeats back. */
const ECHOED_ID_MAX_CHARS = 100;

const TOOL_LIST_AGENTS = 'list_agents';
const TOOL_LIST_SESSIONS = 'list_sessions';
const TOOL_GET_SESSION_DETAIL = 'get_session_detail';

/** Reporting only — no writes, no calls outside the console. */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Whether the session (or the agent session its thread is) carried passages of knowledge base documents not open to
 * everyone and the caller is not the person it was made for. A call through this server has no request to put the
 * admin exception to, so it is not applied here.
 */
async function isRestrictedForCaller(
  tenantDbName: string,
  projectId: string,
  sessionId: string,
  callerUserId: string | undefined,
): Promise<boolean> {
  const facts = await AgentTracingService.getSessionAccessFacts(tenantDbName, projectId, sessionId);
  if (!facts) return false;
  const askers = new Set<string>(facts.userId ? [facts.userId] : []);
  let restricted = restrictedKnowledgeTagsOf(facts.kbRestricted).length > 0;
  if (facts.threadId) {
    const [conversation] = await runWithTenantScope(tenantDbName, (db) => db.findRestrictedAgentConversations([facts.threadId!]));
    if (conversation) {
      restricted = true;
      if (conversation.createdBy) askers.add(String(conversation.createdBy));
    }
  }
  return restricted && !(callerUserId && askers.has(String(callerUserId)));
}

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
          annotations: { ...READ_ONLY_ANNOTATIONS, title: 'List agents' },
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
          annotations: { ...READ_ONLY_ANNOTATIONS, title: 'List sessions' },
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
          annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Get session detail' },
        },
      ],
      suggestedName: 'Agent Observability',
      suggestedDescription: 'Read-only reporting over this project\'s agent tracing sessions.',
      instructions:
        `Read-only reports over this project's agent tracing sessions. "${TOOL_LIST_AGENTS}" shows which `
        + `agents ran; "${TOOL_LIST_SESSIONS}" finds sessions by agent, status, time range or text; `
        + `"${TOOL_GET_SESSION_DETAIL}" takes a sessionId from that list and returns one session's timing, `
        + 'token usage and errors. Time ranges are ISO 8601 timestamps.',
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
        throw new McpToolInputError('"sessionId" is required');
      }
      const result = await AgentTracingService.getSessionDetail(ctx.tenantDbName, projectId, sessionId, {
        includeEventContent: false,
      });
      if (!result) {
        throw new McpToolInputError(`Session ${sessionId.slice(0, ECHOED_ID_MAX_CHARS)} not found`);
      }
      if (await isRestrictedForCaller(ctx.tenantDbName, projectId, sessionId, ctx.identity?.userId)) {
        // Passages of knowledge base documents not open to everyone went through it: its numbers, not its text.
        const { summary: _summary, metadata: _metadata, errors, ...stats } = result.session;
        void _summary; void _metadata;
        return { session: { ...stats, errorCount: errors?.length ?? 0 }, eventCount: result.events.length, restricted: true };
      }
      return { session: result.session, eventCount: result.events.length };
    }

    throw new Error(`Unknown tool "${toolName}" on Agent Observability provider`);
  },
};
