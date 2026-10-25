/**
 * Who may test an agent, asked from inside the evaluation and red-team routes.
 *
 * A test drives the agent the way chat does - its tools, its knowledge, its
 * guardrails, under the caller's project - so it takes Write on Agents, the
 * level of Studio chat and of invoking the agent through the client API. It
 * does not matter which configuration is tested (published, a pinned version,
 * the draft): all of them can call the agent's tools.
 *
 * Saving a target or campaign that points at an agent asks it too, because a
 * saved one runs later (a scheduled scan) and nobody's permission is checked
 * then; the one that saved it is the one who may spend the agent.
 *
 * Only agent targets ask. Viewing tests and results, deleting them, and testing
 * a model, a Knowledge Engine module or an external endpoint stay under
 * Evaluations / Red team.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  authorizationRefusalOf,
  authorizeServiceForRequest,
  sendProjectContextError,
  serviceRefusalError,
} from '../fastify-utils';

/**
 * Throws the gate's refusal (403 `forbidden` naming `agents` / `write`, or the
 * `service_disabled` answer when Agents is switched off) unless the caller may
 * write to Agents; the engine's own outage throws the 503 itself.
 */
export async function requireAgentTestAccess(request: FastifyRequest): Promise<void> {
  const result = await authorizeServiceForRequest(request, 'agents', { level: 'write' });
  if (!result.allowed) throw serviceRefusalError(request, result);
}

/**
 * Answers a refusal thrown by `requireAgentTestAccess` with the body the gates
 * send, and returns null for any other error. A handler that maps messages to
 * statuses ('not found' -> 404) calls this first, so a refusal can never be read
 * as one of them.
 */
export function sendAgentTestRefusal(reply: FastifyReply, error: unknown): FastifyReply | null {
  return authorizationRefusalOf(error) ? sendProjectContextError(reply, error) : null;
}
