import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { ProjectContextError } from '@/lib/services/projects/projectContext';
import { INTERNAL_ERROR_MESSAGE, sendRouteError } from '@/server/api/routeErrors';

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    code(status: number) {
      reply.statusCode = status;
      return reply;
    },
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
    header: vi.fn().mockReturnThis(),
  };
  return reply;
}

function makeLogger() {
  return { error: vi.fn() };
}

describe('sendRouteError', () => {
  it('answers an unexpected failure with a constant 500 body and logs the error', () => {
    const reply = makeReply();
    const logger = makeLogger();
    const error = new Error('connection refused at 10.0.0.5:27017');

    sendRouteError(reply as unknown as FastifyReply, error, { logger, log: 'List widgets error' });

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({ error: INTERNAL_ERROR_MESSAGE });
    expect(logger.error).toHaveBeenCalledWith('List widgets error', { error });
  });

  it('uses the given message for the 500 body', () => {
    const reply = makeReply();

    sendRouteError(reply as unknown as FastifyReply, new Error('boom'), {
      logger: makeLogger(),
      log: 'x',
      message: 'Failed to list widgets',
    });

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({ error: 'Failed to list widgets' });
  });

  it('answers a non-Error throw the same way', () => {
    const reply = makeReply();

    sendRouteError(reply as unknown as FastifyReply, 'plain string', { logger: makeLogger(), log: 'x' });

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({ error: INTERNAL_ERROR_MESSAGE });
  });

  it('answers a project-context failure with its own status', () => {
    const reply = makeReply();

    sendRouteError(reply as unknown as FastifyReply, new Error('Unauthorized'), { logger: makeLogger(), log: 'x' });

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Unauthorized' });
  });

  it('answers a ProjectContextError with its status and message', () => {
    const reply = makeReply();

    sendRouteError(reply as unknown as FastifyReply, new ProjectContextError('Project not found', 404), {
      logger: makeLogger(),
      log: 'x',
    });

    expect(reply.statusCode).toBe(404);
    expect(reply.body).toEqual({ error: 'Project not found' });
  });

  it('lets a typed mapper answer before the generic 500', () => {
    const reply = makeReply();
    class WidgetMissing extends Error {}
    const typed = (e: unknown) => (e instanceof WidgetMissing ? (reply.code(404).send({ error: 'Widget not found' }) as unknown as FastifyReply) : null);

    sendRouteError(reply as unknown as FastifyReply, new WidgetMissing('x'), { logger: makeLogger(), log: 'x', typed });

    expect(reply.statusCode).toBe(404);
    expect(reply.body).toEqual({ error: 'Widget not found' });
  });

  it('falls through to the 500 when the typed mapper does not recognise the error', () => {
    const reply = makeReply();

    sendRouteError(reply as unknown as FastifyReply, new Error('other'), { logger: makeLogger(), log: 'x', typed: () => null });

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({ error: INTERNAL_ERROR_MESSAGE });
  });
});
