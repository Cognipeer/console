/**
 * Request-level tests - the real @azure/storage-blob SDK against small local HTTP(S) servers.
 *
 * Nothing about the SDK is mocked: what is asserted is what goes on the wire (headers, signature, query,
 * redirects, deadlines, TLS) and how the SDK's real error shapes come out of the provider. The servers are plain
 * `node:http(s)` listeners on an ephemeral loopback port, so no emulator is needed; the same flows run against
 * Azurite in the integration test.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { AzureBlobFileProviderContract } from '@/lib/providers/contracts/azureBlobFiles.contract';
import { ENTRA_TIMEOUT_MS } from '@/lib/providers/contracts/azure/blobEntra';
import { AzureBlobError } from '@/lib/providers/contracts/azure/blobErrors';
import type { AzureBlobCredentials, AzureBlobSettings } from '@/lib/providers/contracts/azure/blobConfig';
import type { FileConnectionCheck, FileProviderRuntime } from '@/lib/providers/domains/file';
import { OutboundNetworkError } from '@/lib/security/outboundFetch';
import { startBlobServer, type BlobServer, type BlobServerOptions, type SeenRequest } from '../helpers/fakeAzureBlobServer';

// What the guarded agent's lookup answers: the tests of the connect-time check change it after the runtime exists.
const dns = vi.hoisted(() => ({ answer: '20.60.1.1', lookups: [] as string[] }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    dns.lookups.push(host);
    if (/\.blob\.core\.windows\.net$/.test(host)) return [{ address: dns.answer, family: 4 }];
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }),
}));

const ACCOUNT = 'devstoreaccount1';
// The public, well-known Azurite development key (not a secret).
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const SAS_SIG = 'ab%2Bc%2Fd%3D';
const SAS = `sv=2022-11-02&sr=c&sp=racwdl&se=2099-01-01T00:00:00Z&sig=${SAS_SIG}`;
const CLIENT = '66666666-7777-8888-9999-000000000000';
const logs: unknown[][] = [];
const logger = {
  debug() {},
  info: (...a: unknown[]) => { logs.push(a); },
  warn: (...a: unknown[]) => { logs.push(a); },
  error: (...a: unknown[]) => { logs.push(a); },
};

type Runtime = FileProviderRuntime & {
  close(): void;
  checkConnection(options?: { signal?: AbortSignal; write?: boolean }): Promise<FileConnectionCheck>;
};

const original = getConfigSource();
function mode(overrides: Record<string, string> = {}) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}

const servers: BlobServer[] = [];
const closers: Array<() => void> = [];

async function serve(options: Partial<BlobServerOptions> = {}): Promise<BlobServer> {
  const server = await startBlobServer({ account: ACCOUNT, ...options });
  servers.push(server);
  return server;
}

interface RuntimeOverrides {
  credentials?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  tenantId?: string;
}

async function runtimeFor(endpoint: string, overrides: RuntimeOverrides = {}): Promise<Runtime> {
  const runtime = await AzureBlobFileProviderContract.createRuntime({
    tenantId: overrides.tenantId ?? 't1',
    providerKey: 'prov',
    logger,
    credentials: { accountKey: KEY, ...(overrides.credentials ?? {}) } as AzureBlobCredentials,
    settings: {
      accountName: ACCOUNT,
      endpoint,
      container: 'cont1',
      authMethod: 'accountKey',
      ...(overrides.settings ?? {}),
    } as AzureBlobSettings,
  }) as Runtime;
  closers.push(() => runtime.close());
  return runtime;
}

beforeEach(() => {
  logs.length = 0;
  dns.answer = '20.60.1.1';
  dns.lookups.length = 0;
  mode({ DEPLOYMENT_MODE: 'onprem' });
});

afterEach(async () => {
  setConfigSource(original);
  for (const close of closers.splice(0)) close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The Shared Key signature the service would compute for a request it received (https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key). */
function sharedKeySignature(request: SeenRequest, account: string, key: string): string {
  const header = (name: string): string => {
    const value = request.headers[name];
    const text = Array.isArray(value) ? value.join(', ') : value ?? '';
    return name === 'content-length' && text === '0' ? '' : text;
  };
  const canonicalHeaders = Object.keys(request.headers)
    .filter((name) => name.startsWith('x-ms-'))
    .sort()
    .map((name) => `${name}:${String(request.headers[name]).trim()}\n`)
    .join('');
  const [path, query = ''] = request.url.split('?');
  const queries = new Map<string, string>();
  for (const pair of query.split('&').filter(Boolean)) {
    const at = pair.indexOf('=');
    queries.set((at === -1 ? pair : pair.slice(0, at)).toLowerCase(), decodeURIComponent(at === -1 ? '' : pair.slice(at + 1)));
  }
  const resource = `/${account}${path}${[...queries.keys()].sort().map((name) => `\n${name}:${queries.get(name)}`).join('')}`;
  const stringToSign = `${[
    request.method,
    header('content-language'),
    header('content-encoding'),
    header('content-length'),
    header('content-md5'),
    header('content-type'),
    header('date'),
    header('if-modified-since'),
    header('if-match'),
    header('if-none-match'),
    header('if-unmodified-since'),
    header('range'),
  ].join('\n')}\n${canonicalHeaders}${resource}`;
  return createHmac('sha256', Buffer.from(key, 'base64')).update(stringToSign, 'utf8').digest('base64');
}

const EMPTY_LIST = (marker = '') =>
  `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="http://x/${ACCOUNT}" ContainerName="cont1"><Blobs /><NextMarker>${marker}</NextMarker></EnumerationResults>`;

describe('what the SDK puts on the wire', () => {
  it('signs every request with the shared key, identifies the product and never sends the key', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const rt = await runtimeFor(server.endpoint);
    await rt.uploadFile({ key: 'a.txt', name: 'Şirket.txt', data: Buffer.from('a'), contentType: 'text/plain', metadata: { 'doc-id': 'x' } });
    await rt.listFiles({ prefix: 'a', limit: 3 });
    await rt.getFileMetadata('a.txt');
    await rt.downloadFile('a.txt');
    await rt.deleteFile('a.txt');
    expect(server.seen.map((r) => r.method)).toEqual(['PUT', 'GET', 'HEAD', 'GET', 'DELETE']);

    for (const request of server.seen) {
      expect(request.headers.authorization, request.method).toBe(`SharedKey ${ACCOUNT}:${sharedKeySignature(request, ACCOUNT, KEY)}`);
      expect(request.headers['x-ms-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(request.headers['user-agent']).toContain('cognipeer-console');
      expect(JSON.stringify(request.headers)).not.toContain(KEY);
      expect(request.url).not.toContain(KEY);
    }
    const put = server.seen[0];
    expect(put.url).toMatch(new RegExp(`^/${ACCOUNT}/cont1/t1/prov/a\\.txt`));
    expect(put.headers['x-ms-blob-content-type']).toBe('text/plain');
    expect(put.headers['x-ms-meta-cp_name']).toBe(encodeURIComponent('Şirket.txt'));
    expect(put.headers['x-ms-meta-cp_checksum']).toMatch(/^[a-f0-9]{64}$/);
    expect(put.headers['x-ms-meta-cp_meta']).toMatch(/^b64u:[A-Za-z0-9_-]+$/);
    // every metadata name is an identifier and every value plain ASCII, whatever the caller sent
    for (const [name, value] of Object.entries(put.headers).filter(([n]) => n.startsWith('x-ms-meta-'))) {
      expect(name.slice('x-ms-meta-'.length)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(String(value)).toMatch(/^[\x20-\x7e]*$/);
    }
    const list = server.seen[1];
    expect(list.url).toContain('prefix=t1%2Fprov%2Fa');
    expect(list.url).toContain('maxresults=3');
    expect(list.url).toContain('include=metadata');
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it('sends the API version from settings on every request, signed with it; otherwise the SDK default', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const pinned = await runtimeFor(server.endpoint, { settings: { apiVersion: '2023-11-03' } });
    await pinned.uploadFile({ key: 'v.txt', name: 'v', data: Buffer.from('v') });
    await pinned.listFiles({ limit: 1 });
    await pinned.getFileMetadata('v.txt');
    expect(server.seen.length).toBe(3);
    for (const request of server.seen) {
      expect(request.headers['x-ms-version']).toBe('2023-11-03');
      // the version is part of what is signed: a header changed after signing would not verify
      expect(request.headers.authorization).toBe(`SharedKey ${ACCOUNT}:${sharedKeySignature(request, ACCOUNT, KEY)}`);
    }

    server.seen.length = 0;
    const plain = await runtimeFor(server.endpoint);
    await plain.listFiles({ limit: 1 });
    expect(server.seen[0].headers['x-ms-version']).not.toBe('2023-11-03');
    expect(server.seen[0].headers['x-ms-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(server.seen[0].headers.authorization).toBe(`SharedKey ${ACCOUNT}:${sharedKeySignature(server.seen[0], ACCOUNT, KEY)}`);
  });

  it('puts a SAS in the query exactly as issued and sends no Authorization header', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const rt = await runtimeFor(server.endpoint, { credentials: { accountKey: undefined, sasToken: `?${SAS}` }, settings: { authMethod: 'sas' } });
    await rt.uploadFile({ key: 'sas.txt', name: 'sas', data: Buffer.from('via sas') });
    expect((await rt.downloadFile('sas.txt')).data.toString()).toBe('via sas');
    await rt.listFiles({ limit: 1 });
    await rt.getFileMetadata('sas.txt');
    await rt.deleteFile('sas.txt');
    expect(server.seen.length).toBe(5);
    for (const request of server.seen) {
      expect(request.url).toContain(SAS); // byte for byte: re-encoding the query would invalidate the signature
      expect(request.headers.authorization).toBeUndefined();
    }
    expect(JSON.stringify(logs)).not.toContain(SAS_SIG);
  });

  it('writes a literal = in a SAS value as %3D, so list and create-container requests carry the whole signature', async () => {
    // a signature pasted with its padding unencoded: the SDK cuts a value at its second = when it rebuilds a query
    const pasted = 'sv=2022-11-02&sr=c&sp=racwdl&se=2099-01-01T00:00:00Z&sig=ab%2Bc%2Fd==';
    const sent = 'sig=ab%2Bc%2Fd%3D%3D';
    const server = await serve();
    const rt = await runtimeFor(server.endpoint, { credentials: { accountKey: undefined, sasToken: pasted }, settings: { authMethod: 'sas', createContainer: true } });
    await rt.listFiles({ limit: 1 });
    await rt.uploadFile({ key: 'sas.txt', name: 'sas', data: Buffer.from('via sas') });
    expect((await rt.downloadFile('sas.txt')).data.toString()).toBe('via sas');
    await rt.getFileMetadata('sas.txt');
    await rt.listFiles({ limit: 1 });
    await rt.deleteFile('sas.txt');
    const kindOf = (request: SeenRequest) => {
      const query = new URL(request.url, 'http://x').searchParams;
      return query.get('comp') === 'list' ? 'list' : query.get('restype') === 'container' ? 'container' : 'blob';
    };
    const kinds = server.seen.map((request) => `${request.method} ${kindOf(request)}`);
    // the requests that carry their own parameters are the ones the SDK rebuilds
    expect(kinds).toEqual(expect.arrayContaining(['GET list', 'PUT container', 'PUT blob', 'GET blob']));
    for (const request of server.seen) {
      expect(request.url, `${request.method} ${request.url}`).toContain(sent);
      expect(request.url).not.toContain('sig=ab%2Bc%2Fd&');
    }
    expect(JSON.stringify(logs)).not.toContain('ab%2Bc%2Fd');
  });

  it('does not follow redirects: the answer is reported with its status and the target is never contacted', async () => {
    const target = await serve();
    const redirecting = await serve({
      override: (_request, response) => {
        response.writeHead(307, { location: `${target.endpoint}/cont1/other` });
        response.end();
        return true;
      },
    });
    const rt = await runtimeFor(redirecting.endpoint);
    const listing = await rt.listFiles({ limit: 1 }).catch((e) => e);
    expect(listing).toBeInstanceOf(AzureBlobError);
    expect(listing).toMatchObject({ statusCode: 307, retryable: false });
    await expect(rt.uploadFile({ key: 'x', name: 'x', data: Buffer.from('x') })).rejects.toMatchObject({ statusCode: 307 });
    expect(target.seen).toEqual([]);
  });

  it('carries concurrent traffic over keep-alive sockets without mixing answers up', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const rt = await runtimeFor(server.endpoint);
    const keys = Array.from({ length: 24 }, (_, i) => `k/${i}.txt`);
    await Promise.all(keys.map((key) => rt.uploadFile({ key, name: key, data: Buffer.from(`body-${key}`) })));
    const bodies = await Promise.all(keys.map(async (key) => (await rt.downloadFile(key)).data.toString()));
    expect(bodies).toEqual(keys.map((key) => `body-${key}`));
  });

  it('on-prem with the private-network block refuses a loopback endpoint unless the host is allow-listed', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    mode({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(runtimeFor(server.endpoint)).rejects.toBeInstanceOf(OutboundNetworkError);
    expect(server.seen).toEqual([]);
    mode({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '127.0.0.1' });
    const rt = await runtimeFor(server.endpoint);
    expect((await rt.listFiles()).items).toEqual([]);
    expect(server.seen.length).toBeGreaterThan(0);
  });
});

describe('a full cycle through the SDK', () => {
  it('round-trips bytes, content type, a Turkish name, emoji metadata, checksum and the etag', async () => {
    const server = await serve();
    const rt = await runtimeFor(server.endpoint, { settings: { createContainer: true } });
    const meta = { 'doc-id': 'x1', nested: { a: [1, 2, { b: null }] }, n: 42, 'ünï': 'çödé 😀', text: 'line1\nline2' };
    const name = 'Şirket Raporu - 日本語 😀.pdf';
    const { handle } = await rt.uploadFile({ key: 'docs/rapor.pdf', name, contentType: 'application/pdf', data: Buffer.from('%PDF-1.7'), metadata: meta });
    expect(server.containers.has('cont1')).toBe(true);
    expect(handle.etag).toMatch(/^"0x/);

    const dl = await rt.downloadFile('docs/rapor.pdf');
    expect(dl.data.toString()).toBe('%PDF-1.7');
    expect(dl).toMatchObject({ contentType: 'application/pdf', size: 8, metadata: meta, etag: handle.etag });
    expect(await rt.getFileMetadata('docs/rapor.pdf')).toMatchObject({ key: 'docs/rapor.pdf', name, size: 8, contentType: 'application/pdf', checksum: handle.checksum, metadata: meta });

    const listed = await rt.listFiles();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ key: 'docs/rapor.pdf', name, size: 8, checksum: handle.checksum, etag: handle.etag, metadata: meta });

    await rt.deleteFile('docs/rapor.pdf');
    await rt.deleteFile('docs/rapor.pdf');
    expect(await rt.getFileMetadata('docs/rapor.pdf')).toBeNull();
  });

  it('stores an empty file', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const rt = await runtimeFor(server.endpoint);
    await rt.uploadFile({ key: 'empty', name: 'empty', data: Buffer.alloc(0) });
    const dl = await rt.downloadFile('empty');
    expect(dl.data.length).toBe(0);
    expect((await rt.getFileMetadata('empty'))?.size).toBe(0);
  });

  it('pages a listing with the continuation marker the service hands out', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const rt = await runtimeFor(server.endpoint);
    for (const key of ['p/1', 'p/2', 'p/3', 'p/4', 'p/5', 'q/1']) await rt.uploadFile({ key, name: key, data: Buffer.from(key) });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await rt.listFiles({ prefix: 'p/', limit: 2, cursor });
      seen.push(...page.items.map((i) => i.key));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['p/1', 'p/2', 'p/3', 'p/4', 'p/5']);
    expect(pages).toBe(3);
  });

  it('follows list pages that are empty but still carry a continuation marker, and hides directory markers', async () => {
    const server = await serve({
      override: (request, response) => {
        if (request.method !== 'GET') return false;
        const marker = new URL(request.url, 'http://x').searchParams.get('marker');
        response.writeHead(200, { 'content-type': 'application/xml' });
        if (!marker) response.end(EMPTY_LIST('m1'));
        else if (marker === 'm1') response.end(EMPTY_LIST('m2'));
        else {
          response.end(`<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="http://x/${ACCOUNT}" ContainerName="cont1"><Blobs>`
            + '<Blob><Name>t1/prov/later.txt</Name><Properties><Last-Modified>Mon, 19 Oct 2026 10:00:00 GMT</Last-Modified><Etag>0x8DCAFE</Etag><Content-Length>5</Content-Length><Content-Type>text/plain</Content-Type><BlobType>BlockBlob</BlobType></Properties>'
            + '<Metadata><cp_name>%C5%9Eirket.txt</cp_name></Metadata></Blob>'
            + '<Blob><Name>t1/prov/dir</Name><Properties><Content-Length>0</Content-Length><BlobType>BlockBlob</BlobType></Properties><Metadata><hdi_isfolder>true</hdi_isfolder></Metadata></Blob>'
            + '</Blobs><NextMarker /></EnumerationResults>');
        }
        return true;
      },
    });
    const rt = await runtimeFor(server.endpoint);
    const listed = await rt.listFiles({ limit: 10 });
    expect(server.seen.filter((r) => r.method === 'GET')).toHaveLength(3);
    expect(listed.nextCursor).toBeUndefined();
    expect(listed.items.map((i) => i.key)).toEqual(['later.txt']);
    expect(listed.items[0]).toMatchObject({ name: 'Şirket.txt', size: 5, contentType: 'text/plain', etag: '"0x8DCAFE"' });
  });

  it('keeps tenants apart inside one container', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const a = await runtimeFor(server.endpoint, { tenantId: 'tenantA' });
    const b = await runtimeFor(server.endpoint, { tenantId: 'tenantB' });
    await b.uploadFile({ key: 'secret.txt', name: 's', data: Buffer.from('b-secret') });
    for (const probe of ['../tenantB/prov/secret.txt', 'x/../../../tenantB/prov/secret.txt', '..', '.', 'a/./b', '\\..\\tenantB\\prov\\secret.txt']) {
      await expect(a.downloadFile(probe), probe).rejects.toThrow(/Invalid file key/);
    }
    expect(await a.getFileMetadata('secret.txt')).toBeNull();
    expect((await a.listFiles()).items).toEqual([]);
    expect([...server.containers.get('cont1')!.keys()]).toEqual(['tenantB/prov/secret.txt']);
    // no request for a rejected key was ever made
    expect(server.seen.every((r) => !r.url.includes('..'))).toBe(true);
  });
});

describe('Test connection through the SDK', () => {
  const steps = (result: FileConnectionCheck) => result.steps?.map((s) => [s.step, s.ok]);

  it('lists with a page of one, writes under the reserved prefix, reads back, deletes, and leaves nothing', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const rt = await runtimeFor(server.endpoint);
    const result = await rt.checkConnection();
    expect(result).toMatchObject({ ok: true, message: 'Connected to container "cont1".' });
    expect(steps(result)).toEqual([['list', true], ['write', true], ['read', true], ['delete', true]]);
    expect(server.seen.map((r) => r.method)).toEqual(['GET', 'PUT', 'GET', 'HEAD', 'DELETE']);
    expect(server.seen[0].url).toContain('maxresults=1');
    expect(server.seen[0].url).not.toContain('include=metadata');
    expect(server.seen[1].url).toMatch(new RegExp(`^/${ACCOUNT}/cont1/t1/prov/\\.cognipeer-connection-test/[0-9a-f-]{36}\\.txt`));
    expect(server.containers.get('cont1')!.size).toBe(0);
  });

  it('a container that is not there is reported, or created by the write when the provider is set to', async () => {
    const strict = await serve();
    const noCreate = await runtimeFor(strict.endpoint);
    const missing = await noCreate.checkConnection();
    expect(missing.ok).toBe(false);
    expect(missing.message).toBe(`The container "cont1" is missing in storage account "${ACCOUNT}". Create it or enable "Create container if missing".`);
    expect(steps(missing)).toEqual([['list', false]]);
    expect(strict.seen.map((r) => r.method)).toEqual(['GET']);

    const lenient = await serve();
    const create = await runtimeFor(lenient.endpoint, { settings: { createContainer: true } });
    const created = await create.checkConnection();
    expect(created.ok).toBe(true);
    expect(lenient.containers.has('cont1')).toBe(true);
    expect(lenient.containers.get('cont1')!.size).toBe(0);
  });

  it('a container SAS without the list permission says so and still proves write, read and delete', async () => {
    const server = await serve({
      authorize: (request) => (request.url.includes('comp=list')
        ? { status: 403, code: 'AuthorizationPermissionMismatch' }
        : undefined),
    });
    server.containers.set('cont1', new Map());
    const rt = await runtimeFor(server.endpoint, { credentials: { accountKey: undefined, sasToken: SAS }, settings: { authMethod: 'sas' } });
    const result = await rt.checkConnection();
    expect(result.ok).toBe(false);
    expect(steps(result)).toEqual([['list', false], ['write', true], ['read', true], ['delete', true]]);
    expect(result.steps?.[0].message).toContain('l (list)');
    expect(result.message).toContain('Writing, reading and deleting still work.');
    expect(JSON.stringify(result)).not.toContain(SAS_SIG);
    expect(server.containers.get('cont1')!.size).toBe(0);
  });

  it('a wrong key stops at the list with the hint and without the signature', async () => {
    const server = await serve({
      override: (_request, response) => {
        response.writeHead(403, { 'x-ms-error-code': 'AuthenticationFailed', 'content-type': 'application/xml' });
        response.end('<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthenticationFailed</Code><Message>Server failed to authenticate the request.\nRequestId:rid\nTime:t</Message>'
          + '<AuthenticationErrorDetail>The MAC signature found in the HTTP request \'SECRETSIG=\' is not the same as any computed signature. Server used following string to sign: \'PUT\n\n1\'</AuthenticationErrorDetail></Error>');
        return true;
      },
    });
    const rt = await runtimeFor(server.endpoint);
    const result = await rt.checkConnection();
    expect(result.ok).toBe(false);
    expect(steps(result)).toEqual([['list', false]]);
    expect(result.message).toContain('wrong or rotated account key');
    expect(JSON.stringify(result)).not.toMatch(/SECRETSIG|string to sign|RequestId/);
  });
});

describe('what the SDK reports back', () => {
  it('HEAD of a missing blob has no body and still reads as "no such file"', async () => {
    const server = await serve();
    server.containers.set('cont1', new Map());
    const rt = await runtimeFor(server.endpoint);
    expect(await rt.getFileMetadata('nope')).toBeNull();
    await expect(rt.downloadFile('nope')).rejects.toMatchObject({ message: 'File not found: nope', statusCode: 404 });
    await expect(rt.deleteFile('nope')).resolves.toBeUndefined();
  });

  it('a 404 that carries no Azure error code is a wrong endpoint, not a missing file', async () => {
    // a gateway page, a proxy or another storage protocol's answer: 404 for everything, in every shape
    for (const answer of [
      { type: 'text/html', body: '<html><body>404 Not Found</body></html>' },
      { type: 'application/xml', body: '<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>' },
      { type: 'text/plain', body: '' },
    ]) {
      const server = await serve({
        override: (_request, response) => {
          response.writeHead(404, { 'content-type': answer.type });
          response.end(answer.body);
          return true;
        },
      });
      const rt = await runtimeFor(server.endpoint, { settings: { createContainer: true } });
      for (const call of [
        () => rt.listFiles({ limit: 1 }),
        () => rt.getFileMetadata('a'),
        () => rt.downloadFile('a'),
        () => rt.deleteFile('a'),
      ]) {
        const error = await call().catch((e) => e);
        expect(error).toBeInstanceOf(AzureBlobError);
        expect(error).toMatchObject({ statusCode: 404, retryable: false });
        // not "File not found": the download route would turn that into a plain missing file
        expect(error.message).not.toMatch(/^File not found/);
        expect(error.message).toMatch(/HTTP 404/);
      }

      const listOnly = await rt.checkConnection({ write: false });
      expect(listOnly.ok).toBe(false);
      expect(listOnly.message).not.toMatch(/created on the first upload/);
      expect(listOnly.steps).toEqual([{ step: 'list', ok: false, message: expect.stringMatching(/HTTP 404/) }]);
    }
  });

  it('a missing container is reported as configuration, for HEAD and for bodies alike', async () => {
    const server = await serve();
    const rt = await runtimeFor(server.endpoint);
    for (const call of [
      () => rt.getFileMetadata('a'),
      () => rt.downloadFile('a'),
      () => rt.listFiles({ limit: 1 }),
      () => rt.deleteFile('a'),
      () => rt.uploadFile({ key: 'a', name: 'a', data: Buffer.from('a') }),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ statusCode: 404, code: 'ContainerNotFound', retryable: false });
      expect(error.message).toContain('cont1');
      expect(error.message).not.toMatch(/not found|does not exist/i);
    }
  });

  it('with "create container" a missing container is an empty store until the first upload', async () => {
    const server = await serve();
    const rt = await runtimeFor(server.endpoint, { settings: { createContainer: true } });
    expect((await rt.listFiles({ limit: 1 })).items).toEqual([]);
    expect(await rt.getFileMetadata('a')).toBeNull();
    await expect(rt.downloadFile('a')).rejects.toMatchObject({ message: 'File not found: a' });
    await expect(rt.deleteFile('a')).resolves.toBeUndefined();
    expect(server.containers.size).toBe(0);
    await Promise.all([1, 2, 3].map((i) => rt.uploadFile({ key: `c${i}`, name: 'c', data: Buffer.from('c') })));
    expect(server.containers.get('cont1')!.size).toBe(3);
    // a container created by another pod in the meantime (409) is not a failure
    const second = await runtimeFor(server.endpoint, { settings: { createContainer: true }, tenantId: 't2' });
    await expect(second.uploadFile({ key: 'x', name: 'x', data: Buffer.from('x') })).resolves.toBeDefined();
  });

  it('turns an authorization failure into the sentence that fixes it, and does not carry the request', async () => {
    const server = await serve({ authorize: () => ({ status: 403, code: 'KeyBasedAuthenticationNotPermitted' }) });
    const rt = await runtimeFor(server.endpoint);
    const error = await rt.uploadFile({ key: 'x', name: 'x', data: Buffer.from('x') }).catch((e) => e);
    expect(error).toBeInstanceOf(AzureBlobError);
    expect(error).toMatchObject({ statusCode: 403, code: 'KeyBasedAuthenticationNotPermitted' });
    expect(error.message).toBe('Key-based access is turned off for this storage account. Use a SAS token or Microsoft Entra ID.');
    expect(Object.keys(error)).not.toContain('request');
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it('AuthenticationFailed becomes a hint; the request signature and string-to-sign never come back', async () => {
    const server = await serve({
      override: (_request, response) => {
        response.writeHead(403, { 'x-ms-error-code': 'AuthenticationFailed', 'content-type': 'application/xml' });
        response.end('<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthenticationFailed</Code><Message>Server failed to authenticate the request.\nRequestId:rid\nTime:t</Message>'
          + '<AuthenticationErrorDetail>The MAC signature found in the HTTP request \'SECRETSIG=\' is not the same as any computed signature. Server used following string to sign: \'PUT\n\n1\'</AuthenticationErrorDetail></Error>');
        return true;
      },
    });
    const rt = await runtimeFor(server.endpoint);
    const error = await rt.uploadFile({ key: 'x', name: 'x', data: Buffer.from('x') }).catch((e) => e);
    expect(error).toBeInstanceOf(AzureBlobError);
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('wrong or rotated account key');
    expect(error.message).not.toMatch(/SECRETSIG|string to sign|RequestId/);
    expect(JSON.stringify(error)).not.toContain('SECRETSIG');
  });

  it('a server error is retried by the SDK once and then reported with its status', async () => {
    let attempts = 0;
    const server = await serve({
      override: (_request, response) => {
        attempts += 1;
        response.writeHead(503, { 'x-ms-error-code': 'ServerBusy', 'content-type': 'application/xml' });
        response.end('<?xml version="1.0" encoding="utf-8"?><Error><Code>ServerBusy</Code><Message>The server is busy.</Message></Error>');
        return true;
      },
    });
    const rt = await runtimeFor(server.endpoint);
    const error = await rt.listFiles({ limit: 1 }).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 503, code: 'ServerBusy', retryable: true });
    expect(error.message).toBe('Azure Blob Storage is busy or timing out (ServerBusy); try again.');
    expect(attempts).toBe(2);
  }, 15_000);

  it('an endpoint that refuses connections gives a readable error', async () => {
    const server = await serve();
    const dead = server.endpoint;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const rt = await runtimeFor(dead);
    const error = await rt.listFiles({ limit: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(AzureBlobError);
    expect(error.message).toMatch(/^Could not reach 127\.0\.0\.1 \(ECONNREFUSED\)/);
    expect(error.retryable).toBe(true);
  }, 15_000);

  it('never carries the account key or the SAS signature into an error, whatever failed', async () => {
    const dead = await serve();
    const endpoint = dead.endpoint;
    await dead.close();
    servers.splice(servers.indexOf(dead), 1);
    const keyed = await runtimeFor(endpoint);
    const sas = await runtimeFor(endpoint, { credentials: { accountKey: undefined, sasToken: SAS }, settings: { authMethod: 'sas' } });
    for (const runtime of [keyed, sas]) {
      for (const error of [
        await runtime.listFiles({ limit: 1 }).catch((e) => e),
        await runtime.getFileMetadata('x').catch((e) => e),
      ]) {
        expect(String(error.message)).not.toContain(KEY);
        expect(String(error.message)).not.toContain(SAS_SIG);
        expect(JSON.stringify(error)).not.toContain(SAS_SIG);
      }
    }
    expect(JSON.stringify(logs)).not.toContain(KEY);
  }, 30_000);
});

describe('deadlines', () => {
  it('abandons a request that never gets an answer, and a body that stops mid-stream', async () => {
    mode({ DEPLOYMENT_MODE: 'onprem', GATEWAY_REQUEST_TIMEOUT_MS: '7000' }); // budget: 7 s - 2 s, never below 5 s
    const silent = await serve({ override: () => true });
    const stalling = await serve({
      override: (request, response) => {
        if (request.method !== 'GET') return false;
        response.writeHead(200, { 'content-length': '1000', 'content-type': 'application/octet-stream', etag: '"0x1"' });
        response.write(Buffer.alloc(10, 1)); // 10 of 1000 bytes, then silence
        return true;
      },
    });
    stalling.containers.set('cont1', new Map([['t1/prov/x', { data: Buffer.alloc(1000), contentType: 'x', metadata: {}, etag: '"0x1"', lastModified: new Date() }]]));
    const started = Date.now();
    const [upload, download] = await Promise.all([
      (await runtimeFor(silent.endpoint)).uploadFile({ key: 'x', name: 'x', data: Buffer.from('x') }).catch((e) => e),
      (await runtimeFor(stalling.endpoint)).downloadFile('x').catch((e) => e),
    ]);
    for (const error of [upload, download]) {
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error.message).toMatch(/did not answer in time/);
      expect(error.retryable).toBe(true);
    }
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 20_000);

  it('stops a Test connection at the caller\'s limit', async () => {
    const silent = await serve({ override: () => true });
    const rt = await runtimeFor(silent.endpoint);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const result = await rt.checkConnection({ signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([{ step: 'list', ok: false, message: 'Azure Blob Storage did not answer in time (list).' }]);
  });
});

describe('the network policy on real sockets', () => {
  it('SaaS: refuses a loopback endpoint when the runtime is built, before any request', async () => {
    mode({ DEPLOYMENT_MODE: 'saas' });
    const server = await serve();
    // plain http is refused as plain http; an https spelling of the same address is refused as a private one
    await expect(runtimeFor(server.endpoint)).rejects.toMatchObject({ field: 'endpoint', code: 'provider_settings_invalid' });
    await expect(runtimeFor(server.endpoint.replace('http://', 'https://'))).rejects.toBeInstanceOf(OutboundNetworkError);
    expect(server.seen).toEqual([]);
  });

  it('SaaS: validateSettings refuses it too, and a self-hosted deployment accepts it', async () => {
    const server = await serve();
    const input = {
      credentials: { accountKey: KEY },
      settings: { accountName: ACCOUNT, endpoint: server.endpoint, container: 'cont1' },
    };
    mode({ DEPLOYMENT_MODE: 'saas' });
    // plain http is refused first on SaaS; an https spelling of the same address is refused as private
    await expect(AzureBlobFileProviderContract.validateSettings!({ ...input, isOnPrem: false })).rejects.toMatchObject({ field: 'endpoint' });
    await expect(AzureBlobFileProviderContract.validateSettings!({
      ...input,
      settings: { ...input.settings, endpoint: server.endpoint.replace('http://', 'https://') },
      isOnPrem: false,
    })).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint' });
    mode({ DEPLOYMENT_MODE: 'onprem' });
    await expect(AzureBlobFileProviderContract.validateSettings!({ ...input, isOnPrem: true })).resolves.toBeUndefined();
  });

  it('SaaS: a name that answered with a public address at build time and answers with a private one at connect time is not dialled', async () => {
    mode({ DEPLOYMENT_MODE: 'saas' });
    const rt = await runtimeFor('https://acctname1.blob.core.windows.net', { settings: { accountName: 'acctname1' } });
    dns.answer = '127.0.0.1'; // the record changed after the endpoint was vetted
    dns.lookups.length = 0;
    const error = await rt.listFiles({ limit: 1 }).catch((e) => e);
    expect(dns.lookups).toContain('acctname1.blob.core.windows.net');
    expect(error).toBeInstanceOf(AzureBlobError);
    expect(error.message).toBe('acctname1.blob.core.windows.net resolves to a private or loopback address, which this deployment does not allow.');
    expect(error.retryable).toBe(false);
  }, 15_000);

  it('SaaS: the same change to a link-local address is refused the same way', async () => {
    mode({ DEPLOYMENT_MODE: 'saas' });
    const rt = await runtimeFor('https://acctname1.blob.core.windows.net', { settings: { accountName: 'acctname1' } });
    dns.answer = '169.254.169.254';
    const error = await rt.getFileMetadata('x').catch((e) => e);
    expect(error.message).toContain('resolves to a private or loopback address');
  }, 15_000);
});

function openSslAvailable(): boolean {
  try {
    return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

describe.runIf(openSslAvailable())('TLS and Microsoft Entra against a server with a private certificate', () => {
  let certDir = '';
  let key = '';
  let cert = '';

  beforeAll(() => {
    certDir = mkdtempSync(join(tmpdir(), 'azure-blob-tls-'));
    const keyPath = join(certDir, 'key.pem');
    const certPath = join(certDir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    key = readFileSync(keyPath, 'utf8');
    cert = readFileSync(certPath, 'utf8');
  }, 30_000);

  afterAll(() => {
    rmSync(certDir, { recursive: true, force: true });
  });

  async function secureServer(options: Partial<BlobServerOptions> = {}): Promise<BlobServer> {
    const server = await serve({ tls: { key, cert }, ...options });
    server.containers.set('cont1', new Map());
    return server;
  }

  it('does not trust the certificate by default, and says what to add', async () => {
    const server = await secureServer();
    const rt = await runtimeFor(server.endpoint);
    const error = await rt.listFiles({ limit: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(AzureBlobError);
    expect(error.message).toContain('"CA certificate" setting');
    expect(error.message).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(error.message).toContain('Skip TLS verification'); // self-hosted: the escape hatch is named
    expect(error.retryable).toBe(false);
    expect(server.seen).toEqual([]);

    mode({ DEPLOYMENT_MODE: 'onprem' });
    const check = await rt.checkConnection();
    expect(check.ok).toBe(false);
    expect(check.steps).toHaveLength(1);
  });

  it('trusts it once it is the provider\'s CA certificate, for every operation including Test connection', async () => {
    const server = await secureServer();
    const rt = await runtimeFor(server.endpoint, { settings: { caCertificate: cert } });
    const check = await rt.checkConnection();
    expect(check).toMatchObject({ ok: true, message: 'Connected to container "cont1".' });
    await rt.uploadFile({ key: 'tls.txt', name: 'tls', data: Buffer.from('over tls') });
    expect((await rt.downloadFile('tls.txt')).data.toString()).toBe('over tls');
    expect(server.seen.length).toBeGreaterThan(5);
    for (const request of server.seen) {
      expect(request.headers.authorization).toBe(`SharedKey ${ACCOUNT}:${sharedKeySignature(request, ACCOUNT, KEY)}`);
    }
  });

  it('does not trust it because some other CA certificate was given', async () => {
    const other = (await import('node:tls')).rootCertificates[0];
    const server = await secureServer();
    const rt = await runtimeFor(server.endpoint, { settings: { caCertificate: other } });
    const error = await rt.listFiles({ limit: 1 }).catch((e) => e);
    expect(error.message).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('skips verification on a self-hosted deployment when asked to, and keeps verifying for anything but true', async () => {
    const server = await secureServer();
    const insecure = await runtimeFor(server.endpoint, { settings: { allowInsecureTls: true } });
    expect((await insecure.listFiles({ limit: 1 })).items).toEqual([]);
    const lenient = await runtimeFor(server.endpoint, { settings: { allowInsecureTls: 'false' } });
    await expect(lenient.listFiles({ limit: 1 })).rejects.toThrow(/DEPTH_ZERO_SELF_SIGNED_CERT/);
  });

  it('Microsoft Entra: the service principal gets a token once, and the SDK sends it as a bearer token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' }), { status: 200 }));
    try {
      const server = await secureServer({
        authorize: (request) => (request.headers.authorization === 'Bearer tok-1' ? undefined : { status: 403, code: 'AuthenticationFailed' }),
      });
      const rt = await runtimeFor(server.endpoint, {
        credentials: { accountKey: undefined, clientSecret: 'super-secret-value' },
        settings: { authMethod: 'entra', entraTenantId: 'contoso.onmicrosoft.com', clientId: CLIENT, caCertificate: cert },
      });
      const check = await rt.checkConnection();
      expect(check).toMatchObject({ ok: true });
      expect(server.seen.every((r) => r.headers.authorization === 'Bearer tok-1')).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
      expect(init.redirect).toBe('manual');
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      expect(form).toEqual({ grant_type: 'client_credentials', client_id: CLIENT, client_secret: 'super-secret-value', scope: 'https://storage.azure.com/.default' });
      expect(JSON.stringify(server.seen)).not.toContain('super-secret-value');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('Microsoft Entra: a challenge that names another tenant and resource changes neither where the secret goes nor what it is asked for', async () => {
    // a lifetime of one second keeps the cached token from answering, so the SDK's second request for a token reaches the authority
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 1 }), { status: 200 }));
    try {
      let challenged = false;
      const server = await secureServer({
        authorize: () => {
          if (challenged) return undefined;
          challenged = true;
          return {
            status: 401,
            code: 'InvalidAuthenticationInfo',
            headers: { 'www-authenticate': 'Bearer authorization_uri=https://login.other.example/11111111-2222-3333-4444-555555555555/oauth2/authorize resource_id=https://graph.microsoft.com' },
          };
        },
      });
      const rt = await runtimeFor(server.endpoint, {
        credentials: { accountKey: undefined, clientSecret: 'super-secret-value' },
        settings: { authMethod: 'entra', entraTenantId: 'contoso.onmicrosoft.com', clientId: CLIENT, caCertificate: cert },
      });
      expect((await rt.listFiles({ limit: 1 })).items).toEqual([]);
      expect(challenged).toBe(true);
      // the SDK asked for a token again because of the challenge: it was the configured authority and scope both times
      expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const call of fetchSpy.mock.calls) {
        const [url, init] = call as unknown as [URL, RequestInit];
        expect(String(url)).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
        expect(new URLSearchParams(String(init.body)).get('scope')).toBe('https://storage.azure.com/.default');
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('Microsoft Entra: an authority that answers the headers and then goes silent fails the operation, and its request is aborted', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    // the credential's deadline is ten seconds; the test shortens that one clock and no other
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => real(ms === ENTRA_TIMEOUT_MS ? 300 : ms));
    let requestSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestSignal = (init as RequestInit).signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"access_to')); } }), { status: 200 });
    });
    try {
      const server = await secureServer();
      const rt = await runtimeFor(server.endpoint, {
        credentials: { accountKey: undefined, clientSecret: 'super-secret-value' },
        settings: { authMethod: 'entra', entraTenantId: 'contoso.onmicrosoft.com', clientId: CLIENT, caCertificate: cert },
      });
      const started = Date.now();
      const error = await rt.listFiles({ limit: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ code: 'EntraTokenRequestFailed', retryable: true });
      expect(error.message).toMatch(/^Microsoft Entra at https:\/\/login\.microsoftonline\.com did not finish answering within 10 seconds\./);
      expect(Date.now() - started).toBeLessThan(5000);
      // the request was aborted, not merely abandoned: the signal safeFetch gives fetch stays linked after the headers
      expect(requestSignal?.aborted).toBe(true);
      expect(server.seen).toEqual([]);
      expect(JSON.stringify(error.message)).not.toContain('super-secret-value');
    } finally {
      fetchSpy.mockRestore();
      timeout.mockRestore();
    }
  }, 20_000);

  it('Microsoft Entra: a rejected service principal is reported without the secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: 'invalid_client',
      error_codes: [7000215],
      error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: t',
    }), { status: 401 }));
    try {
      const server = await secureServer();
      const rt = await runtimeFor(server.endpoint, {
        credentials: { accountKey: undefined, clientSecret: 'super-secret-value' },
        settings: { authMethod: 'entra', entraTenantId: CLIENT, clientId: CLIENT, caCertificate: cert },
      });
      const error = await rt.listFiles({ limit: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error.message).toContain('Microsoft Entra rejected the service principal (invalid_client AADSTS7000215)');
      expect(error.message).not.toContain('super-secret-value');
      expect(server.seen).toEqual([]);
      const check = await rt.checkConnection();
      expect(check.ok).toBe(false);
      expect(JSON.stringify(check)).not.toContain('super-secret-value');
    } finally {
      fetchSpy.mockRestore();
    }
  }, 20_000);
});
