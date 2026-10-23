/**
 * The parts of the outbound dispatcher that unit tests with a mocked `fetch`
 * cannot prove: that the undici connector contract this code relies on is
 * actually satisfied by the installed Node/undici at runtime.
 *
 * `outboundDispatcher` hands undici a custom `lookup` that answers with an
 * ARRAY of `{address, family}` records, and a TLS trust of the caller's. If
 * either shape were wrong for this runtime, every guarded outbound call in
 * the product would fail at connect time - and no mock-fetch test would ever
 * notice, because a mocked fetch never reaches the connector. So these tests
 * open a real server on loopback and make real requests through the real
 * dispatcher.
 *
 * The pinning tests do not go through `safeFetch` on purpose: `safeFetch`
 * rejects loopback by design (that is the SSRF guard working), so a live
 * end-to-end test of it would have to disable the very thing under test. What
 * is verified there is the connector plumbing; the guard's own decisions are
 * covered in outbound-fetch.test.ts. The TLS tests also go through `safeFetch`
 * with `allowPrivate`, the way an operator-configured target is fetched.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { fetch as undiciFetch } from 'undici';
import { outboundDispatcher, safeFetch } from '@/lib/security/outboundFetch';

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

describe('pinned dispatcher - real connection', () => {
  it('connects to the pinned address even though the URL hostname resolves elsewhere', async () => {
    const port = await startServer();
    const dispatcher = outboundDispatcher([{ address: '127.0.0.1', family: 4 }]);

    try {
      // `example.invalid` can never resolve in DNS (RFC 2606) - reaching the
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
    const dispatcher = outboundDispatcher([
      // TEST-NET-1 (RFC 5737): routable-looking, never actually answers.
      { address: '192.0.2.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    try {
      const response = await undiciFetch(`http://example.invalid:${port}/`, { dispatcher });
      expect(response.status).toBe(200);
    } finally {
      await dispatcher.destroy();
    }
  }, 15_000);
});

function openSslAvailable(): boolean {
  try {
    return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * A target behind a certificate of its own: the case of a storage service or an identity provider that a private CA
 * signed. Default roots do not know it, so a request trusts it only when the caller says so.
 */
describe.runIf(openSslAvailable())('outbound dispatcher - TLS against a server with a private certificate', () => {
  let certDir: string;
  let tlsServer: https.Server;
  let port = 0;
  let trusted: SecureContext;
  let unrelated: SecureContext;
  const pinned = [{ address: '127.0.0.1', family: 4 as const }];
  const dispatchers: Array<{ destroy(): Promise<void> }> = [];

  /** The way the failure arrives: undici's `fetch failed`, with the TLS error as its cause. */
  const refusedFor = (code: string) => ({ message: 'fetch failed', cause: { code } });

  function dispatcherFor(addresses: typeof pinned, tls?: Parameters<typeof outboundDispatcher>[1]) {
    const dispatcher = outboundDispatcher(addresses, tls);
    dispatchers.push(dispatcher);
    return dispatcher;
  }

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'outbound-tls-'));
    const keyPath = join(certDir, 'key.pem');
    const certPath = join(certDir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    const certPem = readFileSync(certPath, 'utf8');
    trusted = createSecureContext({ ca: certPem });

    // Another throwaway CA: trusting it must not make the first certificate valid.
    const otherKey = join(certDir, 'other-key.pem');
    const otherCert = join(certDir, 'other-cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', otherKey, '-out', otherCert, '-days', '1', '-subj', '/CN=another-ca',
    ], { stdio: 'ignore' });
    unrelated = createSecureContext({ ca: readFileSync(otherCert, 'utf8') });

    tlsServer = https.createServer({ key: readFileSync(keyPath), cert: certPem }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('private-store');
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    port = (tlsServer.address() as AddressInfo).port;
  }, 30_000);

  afterEach(async () => {
    await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.destroy()));
  });

  afterAll(async () => {
    tlsServer.closeAllConnections();
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    rmSync(certDir, { recursive: true, force: true });
  });

  describe('the dispatcher', () => {
    it('does not trust a certificate that the default roots do not know', async () => {
      await expect(undiciFetch(`https://localhost:${port}/`, { dispatcher: dispatcherFor(pinned) }))
        .rejects.toMatchObject(refusedFor('DEPTH_ZERO_SELF_SIGNED_CERT'));
    });

    it('trusts it once the caller hands over a context that holds it, pinned or not', async () => {
      for (const addresses of [pinned, []]) {
        const response = await undiciFetch(`https://localhost:${port}/`, { dispatcher: dispatcherFor(addresses, { secureContext: trusted }) });
        expect(await response.text()).toBe('private-store');
      }
    });

    it('does not trust it because some other CA was handed over', async () => {
      await expect(undiciFetch(`https://localhost:${port}/`, { dispatcher: dispatcherFor(pinned, { secureContext: unrelated }) }))
        .rejects.toMatchObject(refusedFor('DEPTH_ZERO_SELF_SIGNED_CERT'));
    });

    it('skips verification when it is told to, and only then', async () => {
      const response = await undiciFetch(`https://localhost:${port}/`, { dispatcher: dispatcherFor(pinned, { rejectUnauthorized: false }) });
      expect(await response.text()).toBe('private-store');

      // An empty option object changes nothing about the default.
      await expect(undiciFetch(`https://localhost:${port}/`, { dispatcher: dispatcherFor(pinned, {}) }))
        .rejects.toMatchObject(refusedFor('DEPTH_ZERO_SELF_SIGNED_CERT'));
    });

    it('checks the certificate against the NAME in the URL, not against the address it is pinned to', async () => {
      // The certificate is for localhost / 127.0.0.1. The address is the right one; the name is not.
      await expect(undiciFetch(`https://example.invalid:${port}/`, { dispatcher: dispatcherFor(pinned, { secureContext: trusted }) }))
        .rejects.toMatchObject(refusedFor('ERR_TLS_CERT_ALTNAME_INVALID'));
    });
  });

  describe('safeFetch with the trust of the target', () => {
    it('refuses the certificate without it', async () => {
      await expect(safeFetch(`https://localhost:${port}/`, undefined, { allowPrivate: true }))
        .rejects.toMatchObject(refusedFor('DEPTH_ZERO_SELF_SIGNED_CERT'));
    });

    it('reaches a host name, and a literal address, once the context is given', async () => {
      for (const host of ['localhost', '127.0.0.1']) {
        const response = await safeFetch(`https://${host}:${port}/`, undefined, { allowPrivate: true, tls: { secureContext: trusted } });
        expect(await response.text(), host).toBe('private-store');
      }
    });

    it('reaches it with verification off', async () => {
      const response = await safeFetch(`https://127.0.0.1:${port}/`, undefined, { allowPrivate: true, tls: { rejectUnauthorized: false } });
      expect(await response.text()).toBe('private-store');
    });

    it('still refuses a loopback target the guard blocks: the trust never opens the network', async () => {
      await expect(safeFetch(`https://127.0.0.1:${port}/`, undefined, { tls: { secureContext: trusted } }))
        .rejects.toThrow(/private\/loopback host/);
      await expect(safeFetch(`https://127.0.0.1:${port}/`, undefined, { tls: { rejectUnauthorized: false } }))
        .rejects.toThrow(/private\/loopback host/);
    });
  });
});
