/**
 * A session that says it is "running" while nothing runs it.
 *
 * `runtimeStatus: 'running'` is written when a turn starts and replaced when it
 * ends. A process that dies in between never writes the replacement, so the
 * session would show "running" — and a client would follow it — forever. The
 * truth is cheap to check on READ: a turn that is really in flight holds the
 * conversation's single active-run slot (a queued/running AgentRun row; a
 * synchronous turn reserves one too), so a "running" conversation with no such
 * row that has also gone quiet for a couple of minutes is a dead turn.
 *
 * Every read the dashboard and the client API use for a session's state goes
 * through here (`getConversationById` / `listConversations`), so they all agree.
 */

import type { DatabaseProvider, IAgentConversation } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents:session-runtime');

/**
 * How long a "running" conversation may go without an update — and without an
 * active run — before it is reported as ended. Longer than any gap between the
 * run slot being taken and the turn marking the conversation running.
 */
export const STALE_RUNNING_AFTER_MS = 2 * 60 * 1000;

type RuntimeDb = Pick<DatabaseProvider, 'listAgentRuns' | 'updateAgentConversationRuntime'>;

/** What the stale check reads: a list row without its transcript qualifies. */
type RuntimeSubject = Pick<IAgentConversation, '_id' | 'tenantId' | 'projectId' | 'runtimeStatus' | 'stopReason' | 'createdAt' | 'updatedAt'>;

function lastUpdatedMs(conversation: RuntimeSubject): number {
  const value = conversation.updatedAt ?? conversation.createdAt;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The conversation as it should be reported: a stale "running" becomes `idle`
 * with `stopReason: 'error'` (and is corrected in storage, best effort).
 * Anything else is returned untouched. One indexed lookup, and only for a
 * conversation that says "running" and has been quiet for the threshold.
 */
export async function normalizeStaleRunningStatus<T extends RuntimeSubject>(
  db: RuntimeDb,
  conversation: T,
  now: Date = new Date(),
): Promise<T> {
  if (conversation.runtimeStatus !== 'running') return conversation;
  if (now.getTime() - lastUpdatedMs(conversation) <= STALE_RUNNING_AFTER_MS) return conversation;

  const conversationId = String(conversation._id);
  let active = true;
  try {
    const runs = await db.listAgentRuns({
      tenantId: conversation.tenantId,
      projectId: conversation.projectId,
      conversationId,
      status: ['queued', 'running'],
      limit: 1,
    });
    active = runs.length > 0;
  } catch (error) {
    // Cannot tell: leave what is stored rather than guess a turn dead.
    logger.warn('Could not check for an active run; session status left as stored', {
      conversationId, error: error instanceof Error ? error.message : String(error),
    });
  }
  if (active) return conversation;

  await db
    .updateAgentConversationRuntime(conversationId, { runtimeStatus: 'idle', stopReason: 'error' })
    .catch((error) => {
      logger.warn('Could not record the ended session status', {
        conversationId, error: error instanceof Error ? error.message : String(error),
      });
    });
  return { ...conversation, runtimeStatus: 'idle', stopReason: 'error' };
}

/** {@link normalizeStaleRunningStatus} over a list, keeping its order. */
export function normalizeStaleRunningStatuses<T extends RuntimeSubject>(
  db: RuntimeDb,
  conversations: T[],
  now: Date = new Date(),
): Promise<T[]> {
  return Promise.all(conversations.map((conversation) => normalizeStaleRunningStatus(db, conversation, now)));
}
