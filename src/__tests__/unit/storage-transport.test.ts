/**
 * Transport shared by the storage providers: the CA bundle a provider can add to Node's trust, and the
 * http / https agents their clients connect through.
 *
 * The bundle tests use Node's own root certificates as real PEM input. The TLS block talks to a loopback
 * HTTPS server with a throwaway certificate made by openssl (skipped where openssl is not installed).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { OutboundNetworkError } from '@/lib/security/outboundFetch';
import {
  buildTrustedCaList,
  CA_BUNDLE_MAX_BYTES,
  CA_BUNDLE_MAX_CERTIFICATES,
  createStorageAgents,
  parseCaBundle,
  validateStorageTlsSettings,
} from '@/lib/security/storageTransport';

const original = getConfigSource();
function use(overrides: Record<string, string> = {}) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
afterEach(() => setConfigSource(original));

const ROOTS = tls.rootCertificates;
const ROOT_A = ROOTS[0];
const ROOT_B = ROOTS[1];
const ROOT_C = ROOTS[2];
/** The shortest PEM Node ships, so dozens of copies still fit under the size limit. */
const SMALL_ROOT = [...ROOTS].sort((a, b) => a.length - b.length)[0];
const BEGIN = '-----BEGIN CERTIFICATE-----';
const END = '-----END CERTIFICATE-----';

function fingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

/** The ProviderSettingsError a call throws, or a failure naming what was thrown instead. */
function settingsError(run: () => unknown): ProviderSettingsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderSettingsError);
    return error as ProviderSettingsError;
  }
  throw new Error('expected a ProviderSettingsError, nothing was thrown');
}

function elapsedMs(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('parseCaBundle', () => {
  it('returns nothing for an unset or empty value', () => {
    expect(parseCaBundle(undefined)).toBeUndefined();
    expect(parseCaBundle('')).toBeUndefined();
    expect(parseCaBundle('  \n\t ')).toBeUndefined();
  });

  it('reads one certificate and hands back PEM text for the same certificate', () => {
    const parsed = parseCaBundle(ROOT_A);
    expect(parsed).toHaveLength(1);
    expect(parsed![0].startsWith(`${BEGIN}\n`)).toBe(true);
    expect(parsed![0].endsWith(`${END}\n`)).toBe(true);
    expect(fingerprint(parsed![0])).toBe(fingerprint(ROOT_A));
  });

  it('reads a bundle in order, ignoring text between the blocks', () => {
    const bundle = [
      '# issued by the corporate root',
      ROOT_A,
      'Subject: CN=Intermediate (comment line)',
      '',
      ROOT_B,
      '   trailing note   ',
      ROOT_C,
      '',
    ].join('\n');
    const parsed = parseCaBundle(bundle)!;
    expect(parsed.map(fingerprint)).toEqual([ROOT_A, ROOT_B, ROOT_C].map(fingerprint));
    // The blocks are rebuilt from the parsed certificates: no comments, no stray whitespace.
    for (const block of parsed) expect(block.trim().split('\n').filter((line) => !line.startsWith('-----')).every((line) => /^[A-Za-z0-9+/=]{1,64}$/.test(line))).toBe(true);
  });

  it('accepts Windows line endings and surrounding whitespace', () => {
    const parsed = parseCaBundle(`\r\n  ${ROOT_A.replace(/\n/g, '\r\n')}\r\n\r\n`)!;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).not.toContain('\r');
    expect(fingerprint(parsed[0])).toBe(fingerprint(ROOT_A));
  });

  it('rejects text that holds no certificate', () => {
    for (const garbage of ['hello', 'not a certificate at all', 'MIIBkTCCATegAwIBAgIUBase64WithoutMarkers', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----']) {
      const error = settingsError(() => parseCaBundle(garbage));
      expect(error.field).toBe('caCertificate');
      expect(error.code).toBe('provider_settings_invalid');
      expect(error.message).toMatch(/at least one PEM certificate/);
    }
  });

  it('rejects a value that is not text', () => {
    expect(settingsError(() => parseCaBundle(42 as unknown as string)).field).toBe('caCertificate');
    expect(settingsError(() => parseCaBundle({ pem: ROOT_A } as unknown as string)).field).toBe('caCertificate');
  });

  it('rejects a certificate block that does not parse, and says which one', () => {
    const corrupt = `${BEGIN}\n${'AAAA'.repeat(40)}\n${END}`;
    const error = settingsError(() => parseCaBundle(`${ROOT_A}\n${corrupt}`));
    expect(error.field).toBe('caCertificate');
    expect(error.message).toMatch(/Certificate 2 of the CA certificate cannot be read/);

    const truncated = ROOT_B.slice(0, Math.floor(ROOT_B.length / 2)).replace(/\n[^\n]*$/, '') + `\n${END}\n`;
    expect(settingsError(() => parseCaBundle(truncated)).message).toMatch(/Certificate 1 /);
  });

  it('rejects a block with no END line, even after valid ones', () => {
    expect(settingsError(() => parseCaBundle(`${ROOT_A}\n${BEGIN}\nMIIB`)).message).toMatch(/without a matching/);
    expect(settingsError(() => parseCaBundle(ROOT_A.replace(END, ''))).message).toMatch(/without a matching/);
  });

  it('rejects any text that carries a private key, without echoing it', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7secretsecretsecret';
    for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
      const key = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
      for (const text of [key, `${ROOT_A}\n${key}`, `${key}\n${ROOT_A}`]) {
        const error = settingsError(() => parseCaBundle(text));
        expect(error.message).toMatch(/private key/);
        expect(error.message).not.toContain(body);
      }
    }
    expect(settingsError(() => parseCaBundle(`${ROOT_A}\n-----begin private key-----\nAAAA\n-----end private key-----`)).message).toMatch(/private key/);
  });

  it('rejects an oversized value before reading it', () => {
    const error = settingsError(() => parseCaBundle(`${ROOT_A}\n${'#'.repeat(CA_BUNDLE_MAX_BYTES)}`));
    expect(error.message).toMatch(/larger than 64 KiB/);
    // Counted in bytes: 22 000 three-byte characters are under the limit as characters and over it as bytes.
    expect(settingsError(() => parseCaBundle(`${ROOT_A}\n${'€'.repeat(22_000)}`)).message).toMatch(/larger than 64 KiB/);
  });

  it('accepts a bundle that is exactly at the size limit', () => {
    const padded = `${ROOT_A}\n${'#'.repeat(CA_BUNDLE_MAX_BYTES - ROOT_A.length - 1)}`;
    expect(padded).toHaveLength(CA_BUNDLE_MAX_BYTES);
    expect(parseCaBundle(padded)).toHaveLength(1);
  });

  it('caps the number of certificates', () => {
    const copies = (count: number) => Array.from({ length: count }, () => SMALL_ROOT).join('\n');
    expect(copies(CA_BUNDLE_MAX_CERTIFICATES + 1).length).toBeLessThan(CA_BUNDLE_MAX_BYTES);
    expect(parseCaBundle(copies(CA_BUNDLE_MAX_CERTIFICATES))).toHaveLength(CA_BUNDLE_MAX_CERTIFICATES);
    expect(settingsError(() => parseCaBundle(copies(CA_BUNDLE_MAX_CERTIFICATES + 1))).message).toMatch(/more than 50 certificates/);
  });

  describe('long values built from markers', () => {
    const BUDGET_MS = 200;
    const markersOnly = (chars: number) => `${BEGIN}\n`.repeat(Math.ceil(chars / (BEGIN.length + 1)));

    it('a 500 KB value is refused at once', () => {
      const text = markersOnly(500_000);
      expect(text.length).toBeGreaterThan(500_000);
      expect(elapsedMs(() => expect(settingsError(() => parseCaBundle(text)).message).toMatch(/larger than 64 KiB/))).toBeLessThan(BUDGET_MS);
    });

    it('a bundle at the size limit made of BEGIN markers with no END is refused within the budget', () => {
      const text = markersOnly(CA_BUNDLE_MAX_BYTES + 100).slice(0, CA_BUNDLE_MAX_BYTES);
      expect(text.length).toBe(CA_BUNDLE_MAX_BYTES);
      expect(elapsedMs(() => expect(settingsError(() => parseCaBundle(text)).message).toMatch(/without a matching/))).toBeLessThan(BUDGET_MS);
    });

    it('a certificate followed by a long run of unterminated markers is refused within the budget', () => {
      const text = `${ROOT_A}\n${markersOnly(CA_BUNDLE_MAX_BYTES)}`.slice(0, CA_BUNDLE_MAX_BYTES);
      expect(text.length).toBe(CA_BUNDLE_MAX_BYTES);
      expect(elapsedMs(() => expect(settingsError(() => parseCaBundle(text)).message).toMatch(/without a matching/))).toBeLessThan(BUDGET_MS);
    });

    it('a run of empty BEGIN/END pairs and one huge unterminated body are refused within the budget', () => {
      const pairs = `${BEGIN}\n${END}\n`.repeat(Math.floor(CA_BUNDLE_MAX_BYTES / (BEGIN.length + END.length + 2)));
      expect(elapsedMs(() => expect(() => parseCaBundle(pairs)).toThrow(ProviderSettingsError))).toBeLessThan(BUDGET_MS);
      const body = `${BEGIN}\n${'A'.repeat(CA_BUNDLE_MAX_BYTES - 100)}`;
      expect(elapsedMs(() => expect(() => parseCaBundle(body)).toThrow(ProviderSettingsError))).toBeLessThan(BUDGET_MS);
    });

    it('a long value with no marker at all is refused within the budget', () => {
      const text = 'x'.repeat(CA_BUNDLE_MAX_BYTES);
      expect(elapsedMs(() => expect(() => parseCaBundle(text)).toThrow(ProviderSettingsError))).toBeLessThan(BUDGET_MS);
    });
  });
});

describe('buildTrustedCaList', () => {
  const store = tls as unknown as { getCACertificates?: unknown };
  const originalGetCACertificates = store.getCACertificates;
  afterEach(() => {
    store.getCACertificates = originalGetCACertificates;
  });

  it('is undefined when the provider has no CA certificate, so the default trust stays untouched', () => {
    expect(buildTrustedCaList(undefined)).toBeUndefined();
    expect(buildTrustedCaList('')).toBeUndefined();
    expect(buildTrustedCaList('  ')).toBeUndefined();
  });

  it('is the default trust followed by the bundle, so public endpoints keep working', () => {
    const list = buildTrustedCaList(`${ROOT_B}\n${ROOT_C}`)!;
    const defaults = typeof originalGetCACertificates === 'function'
      ? (originalGetCACertificates as (type: string) => string[]).call(tls, 'default')
      : ROOTS;
    expect(defaults.length).toBeGreaterThan(50);
    expect(list).toHaveLength(defaults.length + 2);
    expect(list.slice(0, defaults.length)).toEqual([...defaults]);
    expect(list.slice(-2).map(fingerprint)).toEqual([ROOT_B, ROOT_C].map(fingerprint));
  });

  it('takes the runtime\'s own default trust when it can name it (NODE_EXTRA_CA_CERTS included)', () => {
    store.getCACertificates = vi.fn((type: string) => (type === 'default' ? ['EXTRA-1', 'DEFAULT-2'] : []));
    expect(buildTrustedCaList(ROOT_A)!.slice(0, 2)).toEqual(['EXTRA-1', 'DEFAULT-2']);
    expect(store.getCACertificates).toHaveBeenCalledWith('default');
  });

  it('falls back to the bundled roots on a Node that cannot', () => {
    store.getCACertificates = undefined;
    const list = buildTrustedCaList(ROOT_A)!;
    expect(list.slice(0, ROOTS.length)).toEqual([...ROOTS]);
    expect(list).toHaveLength(ROOTS.length + 1);
  });

  it('refuses a bad bundle the way parseCaBundle does', () => {
    expect(settingsError(() => buildTrustedCaList('nope')).field).toBe('caCertificate');
  });
});

describe('validateStorageTlsSettings', () => {
  it('accepts no TLS settings, a CA bundle, and the insecure switch', () => {
    expect(() => validateStorageTlsSettings({})).not.toThrow();
    expect(() => validateStorageTlsSettings({ caCertificate: ROOT_A, allowInsecureTls: false })).not.toThrow();
    expect(() => validateStorageTlsSettings({ caCertificate: '', allowInsecureTls: true })).not.toThrow();
  });

  it('names the field that is wrong', () => {
    expect(settingsError(() => validateStorageTlsSettings({ caCertificate: 'nope' })).field).toBe('caCertificate');
    const insecure = settingsError(() => validateStorageTlsSettings({ allowInsecureTls: 'yes' }));
    expect(insecure.field).toBe('allowInsecureTls');
    expect(insecure.code).toBe('provider_settings_invalid');
  });

  it('says the same thing createStorageAgents does', () => {
    const fromValidation = settingsError(() => validateStorageTlsSettings({ caCertificate: 'not pem' }));
    const fromAgents = settingsError(() => createStorageAgents({ caCertificate: 'not pem' }));
    expect(fromValidation.message).toBe(fromAgents.message);
  });

  // Provider settings are free-form JSON, so the switch can arrive as anything. Only the booleans are an answer.
  const NOT_A_BOOLEAN: Array<[string, unknown]> = [
    ['the string "false"', 'false'],
    ['the string "true"', 'true'],
    ['the string "0"', '0'],
    ['the string "no"', 'no'],
    ['an empty string', ''],
    ['the number 1', 1],
    ['the number 0', 0],
    ['an empty array', []],
    ['an empty object', {}],
  ];

  it.each(NOT_A_BOOLEAN)('refuses %s as the insecure switch, naming the field', (_label, value) => {
    const error = settingsError(() => validateStorageTlsSettings({ allowInsecureTls: value }));
    expect(error.field).toBe('allowInsecureTls');
    expect(error.code).toBe('provider_settings_invalid');
    expect(error.message).toMatch(/true or false/);
  });

  it('treats an unset switch (undefined, null) as off and accepts both booleans', () => {
    for (const allowInsecureTls of [undefined, null, false, true]) {
      expect(() => validateStorageTlsSettings({ allowInsecureTls })).not.toThrow();
    }
  });
});

type AgentOptions = Record<string, unknown>;
const optionsOf = (agent: http.Agent): AgentOptions => (agent as unknown as { options: AgentOptions }).options;

describe('createStorageAgents', () => {
  const created: Array<{ destroy(): void }> = [];
  function make(input: Partial<Parameters<typeof createStorageAgents>[0]> = {}) {
    const agents = createStorageAgents({ guard: { allowPrivate: true }, guardHost: 'minio.example.com', ...input });
    created.push(agents);
    return agents;
  }
  afterEach(() => {
    for (const agents of created.splice(0)) agents.destroy();
  });

  it('builds an http and an https agent instance with keep-alive and a socket limit', () => {
    use();
    const { httpAgent, httpsAgent } = make();
    expect(httpAgent).toBeInstanceOf(http.Agent);
    expect(httpsAgent).toBeInstanceOf(https.Agent);
    for (const agent of [httpAgent, httpsAgent]) {
      expect(agent.maxSockets).toBe(50);
      expect(optionsOf(agent)).toMatchObject({ keepAlive: true, timeout: 60_000 });
    }
  });

  it('takes keep-alive, socket limit and idle timeout from the caller', () => {
    use();
    const { httpAgent, httpsAgent } = make({ keepAlive: false, maxSockets: 7, timeoutMs: 1_500 });
    for (const agent of [httpAgent, httpsAgent]) {
      expect(agent.maxSockets).toBe(7);
      expect(optionsOf(agent)).toMatchObject({ keepAlive: false, timeout: 1_500 });
    }
  });

  it('installs the guarded lookup on both agents only where the policy blocks private targets', () => {
    use();
    for (const agent of Object.values(make({ guard: { forceBlock: true } })).filter((v) => v instanceof http.Agent)) {
      expect(typeof optionsOf(agent as http.Agent).lookup).toBe('function');
    }
    const open = make({ guard: { allowPrivate: true } });
    expect(optionsOf(open.httpAgent).lookup).toBeUndefined();
    expect(optionsOf(open.httpsAgent).lookup).toBeUndefined();

    // The deployment default blocks; its allow-list exempts a host.
    expect(typeof optionsOf(make({ guard: undefined }).httpsAgent).lookup).toBe('function');
    use({ OUTBOUND_HTTP_ALLOWED_HOSTS: 'minio.example.com' });
    expect(optionsOf(make({ guard: undefined }).httpsAgent).lookup).toBeUndefined();
    use({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
    expect(optionsOf(make({ guard: undefined }).httpsAgent).lookup).toBeUndefined();
  });

  it('guards the connection even when the endpoint host is not known up front', () => {
    use();
    expect(typeof optionsOf(make({ guard: { forceBlock: true }, guardHost: undefined }).httpsAgent).lookup).toBe('function');
  });

  it('refuses a private literal-IP host the policy blocks, because a literal never reaches the lookup', () => {
    use();
    for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', '[fd00::5]', '192.168.1.10']) {
      expect(() => createStorageAgents({ guard: { forceBlock: true }, guardHost: host }), host).toThrow(OutboundNetworkError);
    }
    expect(() => createStorageAgents({ guard: { forceBlock: true }, guardHost: '93.184.216.34' }).destroy()).not.toThrow();
    // Where private targets are allowed, or the host is on the allow-list, a literal is fine.
    make({ guard: { allowPrivate: true }, guardHost: '10.0.0.5' });
    use({ OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5' });
    make({ guard: undefined, guardHost: '10.0.0.5' });
  });

  it('skips certificate verification when the provider asks for it, and the network policy still applies', () => {
    use();
    expect(optionsOf(make({ allowInsecureTls: true }).httpsAgent).rejectUnauthorized).toBe(false);
    expect(optionsOf(make().httpsAgent).rejectUnauthorized).toBeUndefined();
    // Where the policy blocks private targets, skipping verification does not open them.
    expect(() => createStorageAgents({ allowInsecureTls: true, guard: { forceBlock: true }, guardHost: '10.0.0.5' })).toThrow(OutboundNetworkError);
    const blocked = make({ allowInsecureTls: true, guard: { forceBlock: true } });
    expect(typeof optionsOf(blocked.httpsAgent).lookup).toBe('function');
    expect(optionsOf(blocked.httpsAgent).rejectUnauthorized).toBe(false);
  });

  it('skips verification only for the boolean true: a stored "false", "0", 1 or {} leaves it on', () => {
    use();
    for (const value of ['false', 'true', '0', 'no', '', 1, 0, [], {}] as unknown as boolean[]) {
      const agents = make({ allowInsecureTls: value });
      expect(optionsOf(agents.httpsAgent).rejectUnauthorized, JSON.stringify(value)).toBeUndefined();
    }
    expect(optionsOf(make({ allowInsecureTls: false }).httpsAgent).rejectUnauthorized).toBeUndefined();
    expect(optionsOf(make({ allowInsecureTls: true }).httpsAgent).rejectUnauthorized).toBe(false);
  });

  it('hands the trust back as `tls` for the provider\'s other requests, whatever the network policy is', () => {
    use();
    // skipped verification is carried the same under a policy that blocks private targets (SaaS) as under one that does not
    expect(make({ allowInsecureTls: true, guard: { forceBlock: true } }).tls).toEqual({ rejectUnauthorized: false });
    expect(make({ allowInsecureTls: true, guard: { allowPrivate: true } }).tls).toEqual({ rejectUnauthorized: false });
    // a CA certificate is one context, and does not switch verification off
    const withCa = make({ caCertificate: ROOT_A, guard: { forceBlock: true } }).tls;
    expect(withCa?.secureContext).toBeDefined();
    expect(withCa).not.toHaveProperty('rejectUnauthorized');
    const both = make({ caCertificate: ROOT_A, allowInsecureTls: true, guard: { forceBlock: true } }).tls;
    expect(both?.secureContext).toBeDefined();
    expect(both?.rejectUnauthorized).toBe(false);
    // nothing set, or a value that is not the boolean true: no trust of its own, so those requests keep Node's defaults
    expect(make().tls).toBeUndefined();
    for (const value of ['false', 'true', '0', '', 0, 1, [], {}] as unknown as boolean[]) {
      expect(make({ allowInsecureTls: value, guard: { forceBlock: true } }).tls, JSON.stringify(value)).toBeUndefined();
    }
  });

  it('builds one secure context from a CA certificate, and none without one', () => {
    use();
    const withCa = make({ caCertificate: ROOT_A });
    expect(optionsOf(withCa.httpsAgent).secureContext).toBeDefined();
    expect(optionsOf(withCa.httpsAgent).ca).toBeUndefined();
    expect(optionsOf(withCa.httpAgent).secureContext).toBeUndefined();
    expect(optionsOf(make().httpsAgent).secureContext).toBeUndefined();
  });

  it('reports a bad CA certificate as a settings error on the caCertificate field', () => {
    use();
    const error = settingsError(() => createStorageAgents({ caCertificate: 'not pem' }));
    expect(error.field).toBe('caCertificate');
  });

  it('destroy() closes both agents and may be called twice', () => {
    use();
    const agents = make();
    const httpDestroy = vi.spyOn(agents.httpAgent, 'destroy');
    const httpsDestroy = vi.spyOn(agents.httpsAgent, 'destroy');
    agents.destroy();
    agents.destroy();
    expect(httpDestroy).toHaveBeenCalledTimes(2);
    expect(httpsDestroy).toHaveBeenCalledTimes(2);
  });

  describe('a request that reaches a destroyed agent (over a real socket)', () => {
    let server: http.Server;
    let port: number;
    let open = 0;
    let opened = 0;

    beforeAll(async () => {
      server = http.createServer((_request, response) => response.end('ok'));
      server.on('connection', (socket) => {
        open += 1;
        opened += 1;
        socket.on('close', () => { open -= 1; });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const get = (agent: http.Agent) => new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, agent, path: '/' }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve(body));
      }).on('error', reject);
    });

    const settled = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    };

    it('does not leave its socket open: with keep-alive off the connection closes when the response ends', async () => {
      use();
      const agents = make();
      open = 0;
      opened = 0;

      agents.destroy();
      expect(await get(agents.httpAgent)).toBe('ok');
      await settled(() => open === 0);

      expect(opened).toBe(1);
      expect(open).toBe(0);
      expect(Object.keys(agents.httpAgent.freeSockets)).toEqual([]);
    });

    it('is the difference destroy() makes: an agent that is not destroyed keeps the connection for the next request', async () => {
      use();
      const agents = make();
      open = 0;
      opened = 0;

      expect(await get(agents.httpAgent)).toBe('ok');
      expect(await get(agents.httpAgent)).toBe('ok');

      expect(opened).toBe(1);
      expect(open).toBe(1);
      agents.destroy();
      await settled(() => open === 0);
      expect(open).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Real sockets                                                      */
/* ------------------------------------------------------------------ */

function openSslAvailable(): boolean {
  try {
    return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function fetchText(url: string, agent: http.Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { agent }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    request.on('error', reject);
  });
}

describe.runIf(openSslAvailable())('createStorageAgents — TLS against a server with a private certificate', () => {
  let certDir: string;
  let server: https.Server;
  let url = '';
  let certPem = '';
  const created: Array<{ destroy(): void }> = [];

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'storage-transport-'));
    const keyPath = join(certDir, 'key.pem');
    const certPath = join(certDir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    certPem = readFileSync(certPath, 'utf8');
    server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('private-store');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }, 30_000);

  afterEach(() => {
    for (const agents of created.splice(0)) agents.destroy();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(certDir, { recursive: true, force: true });
  });

  function agentsFor(input: Partial<Parameters<typeof createStorageAgents>[0]>) {
    const agents = createStorageAgents({ guard: { allowPrivate: true }, guardHost: '127.0.0.1', ...input });
    created.push(agents);
    return agents;
  }

  it('does not trust a certificate that Node\'s default trust does not know', async () => {
    use();
    await expect(fetchText(url, agentsFor({}).httpsAgent)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  it('trusts it once it is the provider\'s CA certificate', async () => {
    use();
    expect(parseCaBundle(certPem)).toHaveLength(1);
    await expect(fetchText(url, agentsFor({ caCertificate: certPem }).httpsAgent)).resolves.toBe('private-store');
    // The same agent keeps working for a second request (keep-alive socket reuse).
    const agents = agentsFor({ caCertificate: `# our CA\n${certPem}` });
    await expect(fetchText(url, agents.httpsAgent)).resolves.toBe('private-store');
    await expect(fetchText(url, agents.httpsAgent)).resolves.toBe('private-store');
  });

  it('does not trust it because some other CA certificate was given', async () => {
    use();
    await expect(fetchText(url, agentsFor({ caCertificate: ROOT_A }).httpsAgent)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  it('skips verification when asked to', async () => {
    use();
    await expect(fetchText(url, agentsFor({ allowInsecureTls: true }).httpsAgent)).resolves.toBe('private-store');
  });

  it('keeps verifying when the switch is stored as anything but true (a JSON "false" is not "on")', async () => {
    use();
    for (const value of ['false', '0', 'no', 1, [], {}, false] as unknown as boolean[]) {
      await expect(
        fetchText(url, agentsFor({ allowInsecureTls: value }).httpsAgent),
        JSON.stringify(value),
      ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    }
  });
});

describe('createStorageAgents — guarded lookup on real sockets', () => {
  let server: http.Server;
  let port = 0;
  const created: Array<{ destroy(): void }> = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('local-store'));
    // Bound through the name the tests dial, so the address `localhost` resolves to is the one listening.
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    for (const agents of created.splice(0)) agents.destroy();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function agentsFor(guard: Parameters<typeof createStorageAgents>[0]['guard']) {
    const agents = createStorageAgents({ guard, guardHost: 'localhost' });
    created.push(agents);
    return agents;
  }

  it('refuses localhost where the policy blocks private targets', async () => {
    use();
    await expect(fetchText(`http://localhost:${port}/`, agentsFor({ forceBlock: true }).httpAgent)).rejects.toBeInstanceOf(OutboundNetworkError);
  });

  it('refuses it under the deployment default too, and lets it through once the host is allow-listed', async () => {
    use();
    await expect(fetchText(`http://localhost:${port}/`, agentsFor(undefined).httpAgent)).rejects.toBeInstanceOf(OutboundNetworkError);
    use({ OUTBOUND_HTTP_ALLOWED_HOSTS: 'localhost' });
    await expect(fetchText(`http://localhost:${port}/`, agentsFor(undefined).httpAgent)).resolves.toBe('local-store');
  });

  it('connects to localhost where private targets are allowed', async () => {
    use();
    await expect(fetchText(`http://localhost:${port}/`, agentsFor({ allowPrivate: true }).httpAgent)).resolves.toBe('local-store');
  });
});
