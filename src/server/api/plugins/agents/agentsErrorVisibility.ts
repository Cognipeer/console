/**
 * Who may read the raw message of an unrecognized agent-run failure.
 *
 * That message can describe internals (endpoints, deployment names, request
 * ids), so only a viewer who operates the workspace sees it: a tenant owner or
 * admin, or someone holding admin on the Agents service. Everyone else gets the
 * generic line and the detail stays in the server log. A request authenticated
 * with an API token never sees it, whoever owns the token. Provider secrets are
 * redacted from the message either way (`classifyAgentRunError`).
 */

import type { FastifyRequest } from 'fastify';
import { authorizeServiceForRequest } from '../../fastify-utils';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:agents:error-visibility');

export async function canSeeRawProviderErrors(request: FastifyRequest): Promise<boolean> {
  if (request.apiTokenContext) return false;
  const role = request.rbacUser?.role ?? request.apiContextHeaders?.['x-user-role'];
  if (role === 'owner' || role === 'admin') return true;
  try {
    return (await authorizeServiceForRequest(request, 'agents', { level: 'admin' })).allowed;
  } catch (error) {
    // An undecidable question is a "no": the generic message is always safe.
    logger.warn('Could not decide who may see raw provider errors', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
