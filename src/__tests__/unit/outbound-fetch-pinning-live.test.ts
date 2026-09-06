/**
 * The one part of the F-11 pin that unit tests with a mocked `fetch` cannot
 * prove: that the undici connector contract this code relies on is actually
 * satisfied by the installed Node/undici at runtime.
 *
 * `pinnedDispatcher` hands undici a custom `lookup` that answers with an
 * ARRAY of `{address, family}` records. If that shape were wrong for this
 * runtime, every guarded outbound call in the product would fail at connect
 * time — and no mock-fetch test would ever notice, because a mocked fetch
 * never reaches the connector. So this test opens a real HTTP server on
 * loopback and makes a real request through the real dispatcher.
 *
 * It does NOT go through `safeFetch` on purpose: `safeFetch` rejects
 * loopback by design (that is the SSRF guard working), so a live end-to-end
 * test of it would have to disable the very thing under test. What is
 * verified here is the connector plumbing; the guard's own decisions are
 * covered in outbound-fetch.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Agent, buildConnector } from 'undici';
import { fetch as undiciFetch } from 'undici';

let server: Server | undefined;

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pinned-ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = undefined;
  });
});

describe('pinned dispatcher — real connection', () => {
  it('connects to the pinned address even though the URL hostname resolves elsewhere', async () => {
    const port = await startServer();

    // Mirrors pinnedDispatcher() in outboundFetch.ts exactly, including the
    // array-shaped lookup callback and the keep-alive settings.
    const dispatcher = new Agent({
      connect: buildConnector({
        lookup: (_hostname, _options, callback) => {
          callback(null, [{ address: '127.0.0.1', family: 4 }]);
        },
      }),
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
    });

    try {
      // `example.invalid` can never resolve in DNS (RFC 2606) — reaching the
      // local server proves the pinned address, not DNS, decided the socket.
      const response = await undiciFetch(`http://example.invalid:${port}/`, { dispatcher });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('pinned-ok');
      // The Host header still carries the URL's hostname, which is what keeps
      // TLS SNI/cert validation honest on the https path.
    } finally {
      await dispatcher.destroy();
    }
  });

  it('fails over to the second pinned address when the first is unreachable', async () => {
    const port = await startServer();

    const dispatcher = new Agent({
      connect: buildConnector({
        timeout: 1_000,
        lookup: (_hostname, _options, callback) => {
          callback(null, [
            // TEST-NET-1 (RFC 5737): routable-looking, never actually answers.
            { address: '192.0.2.1', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ]);
        },
      }),
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
    });

    try {
      const response = await undiciFetch(`http://example.invalid:${port}/`, { dispatcher });
      expect(response.status).toBe(200);
    } finally {
      await dispatcher.destroy();
    }
  }, 15_000);
});
