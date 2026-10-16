/**
 * The hand-off of non-API requests to Next.js. Next reads the request body
 * itself (its middleware layer clones the stream and waits for it to end), so
 * Fastify must leave it unread on that route; the API keeps its own parsers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerBodyParsers, registerNextHandoff } from '@/server/app';

/**
 * Stands in for Next: reads the request stream the way its middleware layer
 * does — by waiting for the stream's own `end` — and answers with what it read.
 * A stream somebody else already consumed never ends again, so that case is
 * reported after a short wait instead of hanging the test.
 */
async function nextLike(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    const chunks: Buffer[] = [];
    let finished = false;
    const finish = (status: number, body: string) => {
      if (finished) return;
      finished = true;
      res.statusCode = status;
      res.setHeader('x-handled-by', 'next');
      res.end(body);
      resolve();
    };
    if (req.readableEnded) {
      // The body was consumed before it got here.
      setTimeout(() => finish(504, 'body already consumed'), 50);
      return;
    }
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => finish(200, `next saw: ${Buffer.concat(chunks).toString('utf8')}`));
    req.on('error', () => finish(500, 'stream error'));
  });
}

describe('handing requests to Next', () => {
  let app: FastifyInstance;

  async function build() {
    app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
    registerBodyParsers(app);
    await app.register(async (api) => {
      api.post('/echo', async (request) => ({ typeofBody: typeof request.body, body: request.body }));
      api.post('/other', async () => ({ ok: true }));
    }, { prefix: '/api' });
    await registerNextHandoff(app, nextLike);
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
  });

  it('leaves the body of a JSON POST to a page for Next to read', async () => {
    await build();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/agents',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-handled-by']).toBe('next');
    expect(response.body).toBe('next saw: {"a":1}');
  });

  it('does the same for every other content type', async () => {
    await build();
    for (const [contentType, payload] of [
      ['text/plain', 'hello'],
      ['application/x-www-form-urlencoded', 'a=1&b=2'],
      ['application/octet-stream', 'binary'],
      ['application/vnd.api+json', '{"b":2}'],
    ]) {
      const response = await app.inject({ method: 'POST', url: '/login', headers: { 'content-type': contentType }, payload });
      expect(response.statusCode, contentType).toBe(200);
      expect(response.body, contentType).toBe(`next saw: ${payload}`);
    }
  });

  it('still serves requests without a body', async () => {
    await build();
    const response = await app.inject({ method: 'GET', url: '/login' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('next saw: ');
  });

  it('hands over a path under /api that no route claims, with its body, too', async () => {
    await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/not-a-route',
      headers: { 'content-type': 'application/json' },
      payload: '{"c":3}',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('next saw: {"c":3}');
  });

  it('leaves the API on the parsers registered for it', async () => {
    await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"d":4}',
    });
    // Handlers get JSON bodies as text, which `readJsonBody` parses.
    expect(response.json()).toEqual({ typeofBody: 'string', body: '{"d":4}' });
  });

  it('still enforces the body limit on API routes', async () => {
    await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/other',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
  });

  it('still refuses an unsupported content type on API routes', async () => {
    await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/other',
      headers: { 'content-type': 'text/x-unknown' },
      payload: 'x',
    });
    expect(response.statusCode).toBe(415);
  });
});
