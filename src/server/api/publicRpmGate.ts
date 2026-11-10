/**
 * Plan request-rate gate for the public (unauthenticated) entry points: webhook
 * deliveries, public A2A and public MCP. Called after the tenant is resolved;
 * counts one request against the tenant's API requests per minute. A no-op
 * unless plan limits are active for the tenant (hosted deployments only).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  assertApiRequestRate,
  isPlanLimitError,
  planLimitErrorBody,
  planLimitHeaders,
  type PlanLimitSourceType,
} from '@/lib/limits';

const counted = new WeakSet<FastifyRequest>();

/**
 * Returns the sent refusal reply when the tenant is over its limit, otherwise
 * null (success headers are already on the reply). Other errors are not
 * turned into a refusal: the gate fails open, as the limit engine does.
 */
export async function gatePublicRequestRate(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { tenantId: string; sourceType: Extract<PlanLimitSourceType, 'webhook' | 'a2a' | 'mcp'>; sourceId?: string },
): Promise<FastifyReply | null> {
  if (counted.has(request)) return null;
  counted.add(request);
  try {
    const headers = await assertApiRequestRate({
      tenantId: input.tenantId,
      source: { type: input.sourceType, id: input.sourceId },
    });
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    return null;
  } catch (error) {
    if (!isPlanLimitError(error)) return null;
    for (const [name, value] of Object.entries(planLimitHeaders(error))) reply.header(name, value);
    return reply.code(error.status).send(planLimitErrorBody(error));
  }
}
