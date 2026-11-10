/**
 * Route handler bodies shared by the dashboard (`automations.ts`) and the
 * token-authenticated client (`client-automations.ts`) automation plugins.
 *
 * Each plugin keeps its own route registration (path literals, request-context
 * wrapper) and supplies `authenticate`, which resolves the surface's own
 * identity and throws when the caller is not allowed. Automations are
 * tenant-global; route-level authorization carries the access decision.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { createLogger } from '@/lib/core/logger';
import {
  getAutomation,
  isAutomationKey,
  listAutomations,
  pauseAutomation,
  resumeAutomation,
  runAutomation,
} from '@/lib/services/automations';

export interface AutomationHandlerDeps {
  /** Resolves the caller's identity for this surface; throws when unauthenticated. */
  authenticate: (request: FastifyRequest) => unknown | Promise<unknown>;
  logger: Pick<ReturnType<typeof createLogger>, 'error'>;
  /** Used in log lines, e.g. `automation` or `client automation`. */
  subject: string;
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface AutomationHandlers {
  list: Handler;
  get: Handler;
  run: Handler;
  pause: Handler;
  resume: Handler;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Internal server error';
}

export function automationHandlers(deps: AutomationHandlerDeps): AutomationHandlers {
  const { authenticate, logger, subject } = deps;

  return {
    async list(request, reply) {
      try {
        await authenticate(request);
        return reply.code(200).send({ automations: listAutomations() });
      } catch (error) {
        logger.error(`List ${subject}s failed`, { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },

    async get(request, reply) {
      try {
        await authenticate(request);
        const { key } = request.params as { key: string };
        if (!isAutomationKey(key)) {
          return reply.code(400).send({ error: 'Invalid automation key' });
        }

        const automation = getAutomation(key);
        if (!automation) {
          return reply.code(404).send({ error: 'Automation not found' });
        }

        return reply.code(200).send({ automation });
      } catch (error) {
        logger.error(`Get ${subject} failed`, { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },

    async run(request, reply) {
      try {
        await authenticate(request);
        const { key } = request.params as { key: string };
        if (!isAutomationKey(key)) {
          return reply.code(400).send({ error: 'Invalid automation key' });
        }

        const automation = await runAutomation(key);
        return reply.code(200).send({ automation });
      } catch (error) {
        logger.error(`Run ${subject} failed`, { error });
        return reply.code(500).send({ error: messageOf(error) });
      }
    },

    async pause(request, reply) {
      try {
        await authenticate(request);
        const { key } = request.params as { key: string };
        if (!isAutomationKey(key)) {
          return reply.code(400).send({ error: 'Invalid automation key' });
        }

        const automation = pauseAutomation(key);
        return reply.code(200).send({ automation });
      } catch (error) {
        logger.error(`Pause ${subject} failed`, { error });
        return reply.code(500).send({ error: messageOf(error) });
      }
    },

    async resume(request, reply) {
      try {
        await authenticate(request);
        const { key } = request.params as { key: string };
        if (!isAutomationKey(key)) {
          return reply.code(400).send({ error: 'Invalid automation key' });
        }

        const automation = resumeAutomation(key);
        return reply.code(200).send({ automation });
      } catch (error) {
        logger.error(`Resume ${subject} failed`, { error });
        return reply.code(500).send({ error: messageOf(error) });
      }
    },
  };
}
