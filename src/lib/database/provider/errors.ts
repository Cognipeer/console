/**
 * Typed database-layer errors that call sites need to distinguish from a
 * generic thrown error, so they can map them to a specific HTTP status
 * instead of a 500.
 */

/**
 * Thrown when an `AgentRun` insert violates the partial unique index on
 * `conversationId` for active (`queued`/`running`) statuses (§6/§12.14 of
 * docs/guide/agent-background-execution.md). Both database providers must
 * catch their driver-specific unique-constraint violation and re-throw this
 * instead of letting the raw driver error propagate, so `createAgentRun`
 * callers can map it directly to `409 Conflict` without inspecting
 * driver-specific error shapes.
 */
export class AgentRunConflictError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(
      `An active AgentRun already exists for conversationId "${conversationId}"`,
    );
    this.name = 'AgentRunConflictError';
    this.conversationId = conversationId;
  }
}
