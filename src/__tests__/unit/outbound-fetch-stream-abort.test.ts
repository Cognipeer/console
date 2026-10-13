/**
 * An abort that arrives AFTER the response headers must still cut the body.
 *
 * `safeFetch` runs its own AbortController (it enforces a time-to-headers
 * timeout) and detaches the caller's signal once it returns. A model call that
 * streams then keeps reading a silent upstream (a reasoning model thinking
 * before its first token) with a stop button that does nothing, because the SDK
 * relies on the fetch signal to error the pending `reader.read()`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { safeFetch } from '@/lib/security/outboundFetch';

let server: Server | undefined;

function startSilentStream(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      // ...then nothing: the model is "thinking".
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function readUntilSettled(body: ReadableStream<Uint8Array>, ms: number): Promise<'errored' | 'pending'> {
  const reader = body.getReader();
  await reader.read(); // the first frame
  const pending = reader.read().then(() => 'errored' as const, () => 'errored' as const);
  const timer = new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms));
  return Promise.race([pending, timer]);
}

describe('safeFetch with keepAbortLinked', () => {
  it('aborting the caller signal after the headers errors a pending body read', async () => {
    const port = await startSilentStream();
    const controller = new AbortController();
    const res = await safeFetch(
      `http://127.0.0.1:${port}/`,
      { signal: controller.signal },
      { allowPrivate: true, keepAbortLinked: true },
    );
    setTimeout(() => controller.abort(new Error('stop')), 50);
    expect(await readUntilSettled(res.body!, 1500)).toBe('errored');
  });

  it('without the option the signal is detached once the headers arrive (default, unchanged)', async () => {
    const port = await startSilentStream();
    const controller = new AbortController();
    const res = await safeFetch(`http://127.0.0.1:${port}/`, { signal: controller.signal }, { allowPrivate: true });
    setTimeout(() => controller.abort(new Error('stop')), 50);
    expect(await readUntilSettled(res.body!, 600)).toBe('pending');
    void res.body!.cancel().catch(() => undefined);
  });
});
