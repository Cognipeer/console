import next from 'next';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { getConfig } from '@/lib/core/config';
import { registerShutdownHandler } from '@/lib/core/lifecycle';
import { createLogger } from '@/lib/core/logger';
import { bootstrapApplication } from './bootstrap';
import { fastifyApiPlugin } from './api/plugin';

const logger = createLogger('server');

function parseBodySize(input: string): number {
  const normalized = input.trim().toLowerCase();
  const match = normalized.match(/^(\d+)(kb|mb|gb|b)?$/);

  if (!match) {
    return 10 * 1024 * 1024;
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2] ?? 'b';

  switch (unit) {
    case 'kb':
      return value * 1024;
    case 'mb':
      return value * 1024 * 1024;
    case 'gb':
      return value * 1024 * 1024 * 1024;
    default:
      return value;
  }
}

function registerBodyParsers(app: FastifyInstance): void {
  if (app.hasContentTypeParser('application/json')) {
    app.removeContentTypeParser('application/json');
  }

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  app.addContentTypeParser(
    /^application\/[\w.+-]+\+json$/,
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );
}

export async function createServer(dev: boolean): Promise<FastifyInstance> {
  await bootstrapApplication();

  const config = getConfig();
  const app = Fastify({
    bodyLimit: parseBodySize(config.limits.bodySize),
    logger: false,
    trustProxy: true,
  });

  await app.register(cookie);
  registerBodyParsers(app);
  await app.register(fastifyApiPlugin, { prefix: '/api' });

  const nextApp = next({
    dev,
    dir: process.cwd(),
  });

  await nextApp.prepare();
  const nextHandler = nextApp.getRequestHandler();

  app.all('/*', async (request, reply) => {
    await nextHandler(request.raw, reply.raw);
    reply.hijack();
  });

  registerShutdownHandler('http-server', async () => {
    logger.info('Closing Fastify server');
    await app.close();
  });

  return app;
}
