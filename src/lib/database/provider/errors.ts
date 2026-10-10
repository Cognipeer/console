/**
 * Typed database-layer errors that call sites need to distinguish from a
 * generic thrown error, so they can map them to a specific HTTP status
 * instead of a 500.
 */

/**
 * Thrown when an `AgentRun` insert reuses an `Idempotency-Key` another run in
 * the same tenant+project already holds. The service resolves it to a replay
 * (same request) or a 409 (different request); it exists so two CONCURRENT
 * requests with one key cannot both execute.
 */
export class AgentRunIdempotencyKeyTakenError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`Idempotency-Key "${idempotencyKey}" is already bound to another agent run`);
    this.name = 'AgentRunIdempotencyKeyTakenError';
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * Thrown when an `AgentRun` insert violates the one-active-run guard on
 * `conversationId` (SQLite: a partial unique index; Mongo: agent_run_locks
 * documents) for active (`queued`/`running`) statuses (§6/§12.14 of
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

/**
 * Thrown by `appendAgentSessionEvents` when an event's `(conversationId, seq)` is
 * already taken. The session event writer re-reads the conversation's max seq and
 * retries once; a second conflict surfaces as a dropped batch (events are best
 * effort — they must never fail the turn they describe).
 *
 * `writtenIds` lists the events of THIS call that were stored before the conflict
 * (an ordered Mongo insert keeps what precedes the failing document; SQLite rolls
 * the whole batch back, so it is empty there). A retry skips those instead of
 * storing them a second time under new seq numbers.
 */
export class AgentSessionEventSeqConflictError extends Error {
  readonly conversationId: string;
  readonly writtenIds: string[];

  constructor(conversationId: string, writtenIds: string[] = []) {
    super(`Session event sequence conflict on conversation "${conversationId}"`);
    this.name = 'AgentSessionEventSeqConflictError';
    this.conversationId = conversationId;
    this.writtenIds = writtenIds;
  }
}
