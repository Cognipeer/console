import { getConfig } from '@/lib/core/config';
import { registerShutdownHandler } from '@/lib/core/lifecycle';
import { createLogger } from '@/lib/core/logger';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import next from 'next';
import { fastifyApiPlugin } from './api/plugin';
import { bootstrapApplication } from './bootstrap';

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

  // Multipart and arbitrary binary payloads (audio uploads, OCR documents).
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

  if (dev) {
    // Next's Fast Refresh pushes recompiled-module notifications to the
    // browser over a WebSocket (/_next/webpack-hmr). A custom server (this
    // Fastify wrapper) doesn't forward HTTP upgrade requests to Next by
    // default, so without this the dev server still compiles changes fine
    // but the browser never gets told to hot-swap — it just shows stale
    // content until you manually refresh. `getUpgradeHandler()` is Next's
    // documented hook for exactly this case.
    const upgradeHandler = nextApp.getUpgradeHandler();

    // `@fastify/websocket` (registered by enterprise plugins — sandbox/GPU
    // terminal, realtime) attaches its own 'upgrade' listener on this same
    // server that unconditionally routes EVERY upgrade request through
    // Fastify's normal HTTP router, then destroys the socket once a
    // response is sent (its `onResponse` hook). Since no Fastify route
    // matches `/_next/webpack-hmr`, that request falls through to the Next
    // catch-all route as a plain GET, 404s, and the socket gets torn down —
    // breaking HMR and logging "GET /_next/webpack-hmr 404" whenever those
    // plugins are active. Node has no way to stop a later 'upgrade'
    // listener from also running, so we replace the listener set entirely:
    // claim Next-internal paths ourselves and forward every other upgrade
    // to whatever listener(s) were already registered.
    const existingUpgradeListeners = app.server.listeners('upgrade');
    app.server.removeAllListeners('upgrade');
    app.server.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith('/_next/')) {
        upgradeHandler(req, socket, head);
        return;
      }
      for (const listener of existingUpgradeListeners) {
        listener.apply(app.server, [req, socket, head]);
      }
    });
  }

  registerShutdownHandler('http-server', async () => {
    logger.info('Closing Fastify server');
    await app.close();
  });

  return app;
}
