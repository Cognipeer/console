/**
 * How a failed agent call is logged.
 *
 * A route that answers a client with an error used to log every failure at
 * `error` with its stack — including a session that reached its budget, a
 * session waiting on an approval, a busy conversation or a rejected upload.
 * Those are the API doing what it was configured to do; they should not page
 * anyone or bury the real faults. Only a server-side failure keeps the stack.
 */

import type { Logger } from 'winston';
import { AGENT_QUOTA_EXCEEDED_CODE, classifyAgentRunError, type ClassifiedAgentRunError } from './agentErrors';

/** Refusals that are part of the flow (a spent budget, a wait for a person, a busy session): info, not even a warning. */
const FLOW_REFUSAL_TYPES = new Set(['budget_reached', 'pending_action', 'agent_run_conflict']);

/**
 * A caller over an agent-run usage limit: policy working as configured, and it repeats on
 * every request for as long as a person stays over it. Keyed by code, because its type
 * (`rate_limit_error`) is shared with a provider rate limit, which does deserve a warning.
 */
const FLOW_REFUSAL_CODES = new Set<string>([AGENT_QUOTA_EXCEEDED_CODE]);

/**
 * Logs `error` at the level its classification deserves and returns the
 * classification, so the caller answers with it:
 *  - flow refusals (`budget_reached`, `pending_action`, `agent_run_conflict`, a spent
 *    agent usage limit): `info`;
 *  - any other 4xx (not found, a rejected attachment, a spend limit, a provider
 *    rejecting the request): `warn`;
 *  - everything else: `error`, with the stack.
 * The first two log one line (status, type, code, message) and no stack.
 */
export function logAgentRouteError(
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  message: string,
  error: unknown,
  context: Record<string, unknown> = {},
): ClassifiedAgentRunError {
  const classified = classifyAgentRunError(error);
  if (classified.status >= 500) {
    log.error(message, { error, ...context });
    return classified;
  }
  const detail = {
    ...context,
    status: classified.status,
    type: classified.error.type,
    code: classified.error.code ?? undefined,
    reason: classified.error.message,
  };
  const isFlowRefusal = FLOW_REFUSAL_TYPES.has(classified.error.type)
    || (classified.error.code != null && FLOW_REFUSAL_CODES.has(classified.error.code));
  if (isFlowRefusal) log.info(message, detail);
  else log.warn(message, detail);
  return classified;
}
