/**
 * Smoke-test server bootstrap.
 *
 * Boots the REAL Fastify API surface (`fastifyApiPlugin`, mounted under `/api`)
 * over a real HTTP listener — the same plugin the production server registers in
 * `src/server/app.ts`. The only thing left out is the Next.js request handler,
 * because the smoke suite drives the backend API directly; it does not render
 * UI. Everything below the route layer (auth hook, RBAC, audit, services, the
 * SQLite database) is the production code path.
 *
 * The caller is expected to have already pointed the process at an isolated
 * data directory / JWT secret via environment variables BEFORE importing this
 * module (see `run.ts`), so that a smoke run never touches developer data.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { bootstrapApplication } from '@/server/bootstrap';
import { fastifyApiPlugin } from '@/server/api/plugin';

const logger = createLogger('smoke-server');

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

/**
 * Replicates `registerBodyParsers` from `src/server/app.ts`. The dashboard
 * handlers call `readJsonBody`, which expects the JSON body to arrive as a raw
 * string (not Fastify's default parsed object), so we must register the same
 * string/buffer parsers here or every POST handler would break.
 */
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

  app.addContentTypeParser(
    /^multipart\/form-data/i,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.addContentTypeParser(
    /^application\/octet-stream$/i,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.addContentTypeParser(
    /^audio\//i,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.addContentTypeParser(
    /^image\//i,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.addContentTypeParser(
    /^application\/pdf$/i,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
}

export interface SmokeServer {
  app: FastifyInstance;
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Build and start the API-only server on an ephemeral port (or `SMOKE_PORT`).
 * Returns the base URL (e.g. `http://127.0.0.1:54321`) plus a close handle.
 */
export async function startSmokeServer(): Promise<SmokeServer> {
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

  const host = '127.0.0.1';
  const port = Number.parseInt(process.env.SMOKE_PORT ?? '0', 10);
  await app.listen({ host, port });

  const address = app.server.address();
  const resolvedPort =
    typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://${host}:${resolvedPort}`;

  logger.info('Smoke server listening', { baseUrl });

  return {
    app,
    baseUrl,
    close: async () => {
      await app.close();
    },
  };
}
