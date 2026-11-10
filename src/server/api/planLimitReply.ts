/**
 * Answers a plan-limit refusal (`PlanLimitError`) on the console and client routes that do their own error mapping:
 * the status and headers of the refusal and the `{ error, type, code, ... }` envelope. Returns null for any other
 * error, so a catch block can write `sendPlanLimitRefusal(reply, error) ?? <its own mapping>`.
 */
import type { FastifyReply } from 'fastify';
import { isPlanLimitError, planLimitErrorBody, planLimitHeaders } from '@/lib/limits/errors';

export function sendPlanLimitRefusal(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (!isPlanLimitError(error)) return null;
  reply.headers(planLimitHeaders(error));
  return reply.code(error.status).send(planLimitErrorBody(error));
}
