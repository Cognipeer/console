/**
 * Regression test for a gap in the BROWSER_IGNORE_CERTIFICATE_ERRORS escape
 * hatch: it only ever set Chromium's own launch-level `--ignore-certificate-
 * errors` CLI flag. Playwright enforces its own, independent context-level
 * TLS check (`contextOptions.ignoreHTTPSErrors`) that flag never touched, so
 * an operator who set the env var and expected every certificate error to be
 * ignored would still see navigation fail against any host presenting an
 * untrusted cert — exactly what happened diagnosing a live incident against
 * a customer network that terminates TLS with a private CA.
 *
 * Real Chromium against a real self-signed HTTPS server on purpose: the
 * defect is specifically about what Playwright's own context enforces on
 * top of whatever the underlying browser process decided.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// 127.0.0.1 is private address space — set BEFORE config is read, or the
// egress guard blocks navigation regardless of the certificate outcome.
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'false';

import { browserManager } from '@/lib/services/browser/browserManager';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { chromiumAvailable } from '../helpers/browserAvailability';

const originalSource = getConfigSource();

function sourceWith(overrides: Record<string, string>): ConfigSource {
  return {
    get: (key: string) => overrides[key] ?? process.env[key],
  } as ConfigSource;
}

let server: Server;
let baseUrl = '';
let certDir: string;
let openSessions: string[] = [];

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'browser-cert-test-'));
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  server = createServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}, 30_000);

afterEach(async () => {
  setConfigSource(originalSource);
  const keys = openSessions;
  openSessions = [];
  await Promise.all(keys.map((key) => browserManager.closeSession(key, 'test').catch(() => undefined)));
});

afterAll(async () => {
  await browserManager.shutdown().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(certDir, { recursive: true, force: true });
});

describe.skipIf(!chromiumAvailable())('BROWSER_IGNORE_CERTIFICATE_ERRORS — context-level enforcement', () => {
  it('fails to navigate to a self-signed-cert host by default (proves the test host is genuinely untrusted)', async () => {
    const { sessionKey } = await browserManager.openSession({
      tenantId: 'test-tenant-cert',
      config: { headless: true, navigationTimeoutMs: 8_000 },
    });
    openSessions.push(sessionKey);
    const result = await browserManager.runAction(sessionKey, { type: 'goto', url: baseUrl });
    expect(result.ok).toBe(false);
  });

  it('navigates successfully when the deployment-wide toggle is on, with no per-session override needed', async () => {
    setConfigSource(sourceWith({ BROWSER_IGNORE_CERTIFICATE_ERRORS: 'true' }));
    const { sessionKey } = await browserManager.openSession({
      tenantId: 'test-tenant-cert',
      config: { headless: true, navigationTimeoutMs: 8_000 },
    });
    openSessions.push(sessionKey);
    const result = await browserManager.runAction(sessionKey, { type: 'goto', url: baseUrl });
    expect(result.ok).toBe(true);
  });
});
