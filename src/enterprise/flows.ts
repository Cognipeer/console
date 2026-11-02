/**
 * Flows seam — COMMUNITY (open-source) edition.
 *
 * The Flows module (visual flows, FlowBase agents, flows as agent tools) ships with the
 * Enterprise overlay. The community core keeps the agent records that can point at a flow
 * (`IAgentConfig.kind === 'flow'`, tool bindings with `source: 'flow'`, hidden agents with an
 * `owner`) and reaches the module only through this seam.
 *
 * Contract:
 *   - Nothing is registered in the community edition: `getFlowsHost()` answers null. A FlowBase
 *     turn then refuses with {@link FlowsUnavailableError}, flow tool bindings are left out, and
 *     the lookups below find nothing.
 *   - The overlay calls `registerFlowsHost(...)` once at load, from its `registry.ts`. This is a
 *     separate community file (NOT replaced by the overlay), so the `registry.ts` seam shape and
 *     SEAM_CONTRACT_VERSION do not change because of it.
 *   - Licensing is the host's job: it throws `FlowsUnavailableError('license')` for a tenant
 *     without an Enterprise license.
 *
 * Leaf module on purpose: no runtime imports, so the overlay registry can import it at load time
 * without creating a cycle. Shapes are structural, not imports of the module's own types.
 */
import type { IAgentConversationStep, IAgentTurnSubagentRun } from '@/lib/database/provider/types.domain';

/** Which tenant database and project a call is about. */
export interface FlowsScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}

/** A flow, as the agent code needs it (tags, usage labels, reference checks). */
export interface FlowRef {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'archived';
  /** True once the flow has a published version. */
  hasPublished: boolean;
  /** `conversation` flows can reply in a chat; `headless` ones run from the API, agents or schedules. */
  surface?: 'conversation' | 'headless';
}

/** The run behind a FlowBase reply; stored on the message as `metadata.flow`. */
export interface FlowsReplyMeta {
  runId: string;
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled';
  eventSeq?: number;
  wait?: { kind: string; prompt?: string; form?: { title?: string; fields: unknown[]; submitLabel?: string } };
  widgets?: Array<{ kind: 'form' | 'choices' | 'file' | 'card'; data: unknown }>;
}

export interface FlowAgentTurnInput extends FlowsScope {
  agentKey: string;
  /** `IAgentConfig.flow`. */
  flow: { entryFlowId: string; version?: 'published' | 'draft' };
  message: string;
  /** The Session. Absent for a stateless playground call. */
  conversationId?: string;
  userId?: string;
  tokenId?: string;
  accountableUserId?: string;
  unattended?: boolean;
  /** The event behind a webhook / connector trigger fire (`{ event, delivery_id, payload, connector }`), for the flow's trigger data. */
  triggerData?: Record<string, unknown>;
  /** The previous assistant message's flow metadata, when there is one. */
  previous?: { runId: string; eventSeq?: number };
}

/**
 * What the flow did for one FlowBase reply, in the assistant message's own fields, so the session
 * view, the playground and the portal show it the way they show any agent's turn: each agent step
 * is a sub-agent run with its own tool calls, every other step is a tool call named
 * `flow:<node key>` (see {@link FLOW_NODE_STEP_PREFIX}).
 */
export interface FlowAgentTurnActivity {
  steps?: IAgentConversationStep[];
  subagentRuns?: IAgentTurnSubagentRun[];
  subagentRunsDropped?: number;
  /** The agent steps' stored reasoning (each step agent's own Show reasoning already applied). */
  reasoning?: string;
}

export interface FlowAgentTurnResult {
  /** The reply text. Never empty. */
  content: string;
  /** Stored on the assistant message as `metadata.flow`. */
  meta?: FlowsReplyMeta;
  activity?: FlowAgentTurnActivity;
}

/** The tool name prefix of a flow step shown as a tool call (`flow:<node key>`). */
export const FLOW_NODE_STEP_PREFIX = 'flow:';

/** True for a stored tool call that stands for a flow step, not for a tool the agent called. */
export function isFlowNodeStep(name: string | undefined): boolean {
  return typeof name === 'string' && name.startsWith(FLOW_NODE_STEP_PREFIX);
}

export interface FlowToolBuildParams extends FlowsScope {
  binding: { sourceKey: string; toolNames?: string[]; config?: Record<string, unknown> };
  /** Wraps the agent SDK's `createTool`. */
  buildTool: (definition: { name: string; description: string; schema: unknown; func: (args: Record<string, unknown>, ...rest: unknown[]) => Promise<string> }) => unknown;
  guard: {
    protect<A extends Record<string, unknown>, R>(
      spec: { name: string; requestedName: string },
      execute: (safeArgs: A, ...rest: unknown[]) => Promise<R>,
    ): (args: A, ...rest: unknown[]) => Promise<R | string>;
  };
  caller?: {
    agentKey?: string;
    userId?: string;
    tokenId?: string;
    accountableUserId?: string;
    conversationId?: string;
    sessionId?: string;
    unattended?: boolean;
  };
}

export interface FlowToolBuildResult {
  tools: unknown[];
  definitions: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
}

export interface FlowsHost {
  /** One turn of a FlowBase agent. */
  runAgentTurn(input: FlowAgentTurnInput): Promise<FlowAgentTurnResult>;
  /** The model-callable tools of one `source: 'flow'` binding (empty when the flow is gone). */
  buildToolBindings(params: FlowToolBuildParams): Promise<FlowToolBuildResult>;
  /** A flow by id or key in the project, or null. History and attribution reads stay allowed without a license. */
  describeFlow(scope: FlowsScope, ref: { id?: string; key?: string }): Promise<FlowRef | null>;
  /** A flow step waiting on an agent session's answer continues now. */
  wakeAgentActionWaits(scope: FlowsScope, target: { flowId: string; sessionId: string }): Promise<void>;
}

/** Why Flows cannot be used: the build has no Flows module, or the tenant has no Enterprise license. */
export class FlowsUnavailableError extends Error {
  readonly code = 'flows_unavailable';
  constructor(readonly reason: 'edition' | 'license') {
    super(
      reason === 'license'
        ? 'Flows need an Enterprise license for this workspace.'
        : 'Flows are part of the Enterprise edition.',
    );
    this.name = 'FlowsUnavailableError';
  }
}

const flowsHost: { current: FlowsHost | null } = { current: null };

/** Called once by the enterprise overlay at load. */
export function registerFlowsHost(host: FlowsHost): void {
  flowsHost.current = host;
}

/** The registered host, or null in the community edition. */
export function getFlowsHost(): FlowsHost | null {
  return flowsHost.current;
}
