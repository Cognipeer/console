/**
 * The few shapes of the Flows module that the agent records carry.
 *
 * An agent can be backed by a conversation flow (`IAgentConfig.kind === 'flow'`), can bind a flow as a
 * tool (`IAgentToolBinding.source === 'flow'`), and stores the run behind a flow reply on its messages.
 * Those are persisted agent shapes, so they live here in the community tree; the Flows module itself
 * (enterprise overlay) re-exports them from its own types.
 */

export type FlowRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled';

/**
 * FlowBase agents (`IAgentConfig.kind === 'flow'`): a conversation flow drives
 * the chat instead of the model loop. Stored as `IAgentConfig.flow`.
 */
export interface AgentFlowConfig {
  /** Flow (id) that handles each conversation turn. */
  entryFlowId: string;
  /** Run the published version (default) or the draft (testing). */
  version?: 'published' | 'draft';
}

/**
 * `IAgentToolBinding` with `source: 'flow'` exposes a flow as a model-callable
 * tool: `sourceKey` = flow key, `toolNames[0]` = tool name (default
 * `flow_<key>`), `config` = this shape.
 */
export interface FlowToolBindingConfig {
  version?: 'published' | 'draft';
  /** Overrides the flow description shown to the model. */
  description?: string;
  /** How long the agent waits for the run before returning `{status:'running', runId}`. */
  waitMs?: number;
}

/** What a flow-backed reply records on `IAgentConversationMessage.metadata.flow`. */
export interface AgentFlowReplyMeta {
  runId: string;
  status: FlowRunStatus;
  /** Last run event already delivered to the chat; the next turn reads on from here. */
  eventSeq?: number;
  wait?: { kind: string; prompt?: string; form?: { title?: string; fields: unknown[]; submitLabel?: string } };
  widgets?: Array<{ kind: 'form' | 'choices' | 'file' | 'card'; data: unknown }>;
}
