/**
 * `privateNetworkBlockApplies` and `createGuardedLookup`: the private-network policy applied when a socket
 * connects, for clients that bring their own http(s) agent (the S3 and Azure Blob storage clients).
 *
 * DNS is answered by a mock so every address family and every policy switch can be exercised; the "real
 * sockets" block still connects to a loopback server, with the mock answering for names that point at it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const PUBLIC_V4 = { address: '93.184.216.34', family: 4 };
const PUBLIC_V6 = { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 };
const PRIVATE_V4 = { address: '10.1.2.3', family: 4 };
const LOOPBACK = { address: '127.0.0.1', family: 4 };

vi.mock('node:dns/promises', () => {
  const answers: Record<string, Array<{ address: string; family: number }>> = {
    'public.example.com': [{ address: '93.184.216.34', family: 4 }],
    'dual.example.com': [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }, { address: '93.184.216.34', family: 4 }],
    'internal.corp.example': [{ address: '10.1.2.3', family: 4 }],
    'mixed.example.com': [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }],
    'ula.example.com': [{ address: 'fd00::1', family: 6 }],
    'mapped.example.com': [{ address: '::ffff:10.0.0.5', family: 6 }],
    'empty.example.com': [],
    // Names that stand for a server on this machine (the real-socket tests).
    'store.example.test': [{ address: '127.0.0.1', family: 4 }],
  };
  return {
    lookup: vi.fn(async (host: string) => {
      if (host in answers) return answers[host];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    }),
  };
});

import {
  assertPublicUrl,
  createGuardedLookup,
  OutboundNetworkError,
  privateNetworkBlockApplies,
} from '@/lib/security/outboundFetch';

const original = getConfigSource();
function use(overrides: Record<string, string> = {}) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
afterEach(() => {
  setConfigSource(original);
  vi.mocked(lookup).mockClear();
});

/** `dns/promises`' overloaded `lookup` type infers the single-address overload; the guard asks for `all`. */
function mockLookupOnce(...results: Array<Array<{ address: string; family: number }>>): void {
  const mocked = lookup as unknown as { mockImplementationOnce: (fn: () => Promise<unknown>) => unknown };
  for (const result of results) mocked.mockImplementationOnce(async () => result);
}

interface LookupResult {
  error: NodeJS.ErrnoException | null;
  address: unknown;
  family: number | undefined;
}

function run(fn: LookupFunction, hostname: string, options: LookupOptions = {}): Promise<LookupResult> {
  return new Promise((resolve) => {
    fn(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

describe('privateNetworkBlockApplies', () => {
  it('blocks by default, and always under forceBlock', () => {
    use();
    expect(privateNetworkBlockApplies('minio.example.com')).toBe(true);
    use({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false', OUTBOUND_HTTP_ALLOWED_HOSTS: 'minio.example.com' });
    expect(privateNetworkBlockApplies('minio.example.com', { forceBlock: true })).toBe(true);
    expect(privateNetworkBlockApplies('minio.example.com', { forceBlock: true, allowPrivate: true })).toBe(true);
  });

  it('does not block when the deployment switch is off or the caller allows private targets', () => {
    use({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
    expect(privateNetworkBlockApplies('minio.example.com')).toBe(false);
    use();
    expect(privateNetworkBlockApplies('minio.example.com', { allowPrivate: true })).toBe(false);
  });

  it('exempts allow-listed hosts, by exact name or .suffix', () => {
    use({ OUTBOUND_HTTP_ALLOWED_HOSTS: 'minio.corp.example,.storage.example' });
    expect(privateNetworkBlockApplies('minio.corp.example')).toBe(false);
    expect(privateNetworkBlockApplies('MinIO.Corp.Example')).toBe(false);
    expect(privateNetworkBlockApplies('node1.storage.example')).toBe(false);
    expect(privateNetworkBlockApplies('storage.example')).toBe(false);
    expect(privateNetworkBlockApplies('other.corp.example')).toBe(true);
    expect(privateNetworkBlockApplies('xstorage.example')).toBe(true);
  });
});

describe('createGuardedLookup — answers', () => {
  it('hands a public answer to the socket in both callback shapes', async () => {
    use();
    const guarded = createGuardedLookup({ forceBlock: true });

    const all = await run(guarded, 'public.example.com', { all: true });
    expect(all.error).toBeNull();
    expect(all.address).toEqual([PUBLIC_V4]);

    const one = await run(guarded, 'public.example.com');
    expect(one.error).toBeNull();
    expect(one.address).toBe(PUBLIC_V4.address);
    expect(one.family).toBe(4);

    const dual = await run(guarded, 'dual.example.com', { all: true });
    expect(dual.address).toEqual([PUBLIC_V6, PUBLIC_V4]);
    expect((await run(guarded, 'dual.example.com')).address).toBe(PUBLIC_V6.address);
  });

  it('refuses a private answer in both shapes, with the refusal assertPublicUrl gives', async () => {
    use();
    const guarded = createGuardedLookup({ forceBlock: true });
    for (const options of [{ all: true }, {}] as LookupOptions[]) {
      const result = await run(guarded, 'internal.corp.example', options);
      expect(result.error).toBeInstanceOf(OutboundNetworkError);
      expect(result.error?.message).toBe('Refusing outbound request to private/loopback host: internal.corp.example');
      // Nothing usable is handed over alongside the error.
      expect(result.address).toEqual([]);
    }
  });

  it('refuses when ANY of the answers is private, not only the first', async () => {
    use();
    const guarded = createGuardedLookup({ forceBlock: true });
    expect((await run(guarded, 'mixed.example.com', { all: true })).error).toBeInstanceOf(OutboundNetworkError);
    expect((await run(guarded, 'mixed.example.com')).error).toBeInstanceOf(OutboundNetworkError);
  });

  it('recognises private IPv6 answers, including an IPv4-mapped one', async () => {
    use();
    const guarded = createGuardedLookup({ forceBlock: true });
    expect((await run(guarded, 'ula.example.com', { all: true })).error).toBeInstanceOf(OutboundNetworkError);
    expect((await run(guarded, 'mapped.example.com', { all: true })).error).toBeInstanceOf(OutboundNetworkError);
  });

  it('answers ENOTFOUND for a name with no address', async () => {
    use();
    const guarded = createGuardedLookup({ forceBlock: true });
    for (const options of [{ all: true }, {}] as LookupOptions[]) {
      const result = await run(guarded, 'empty.example.com', options);
      expect(result.error?.code).toBe('ENOTFOUND');
      expect(result.error).not.toBeInstanceOf(OutboundNetworkError);
    }
  });

  it('passes the resolver\'s own error through for a name that does not resolve', async () => {
    use();
    const result = await run(createGuardedLookup({ forceBlock: true }), 'nowhere.example.test', { all: true });
    expect(result.error?.code).toBe('ENOTFOUND');
    expect(result.error).not.toBeInstanceOf(OutboundNetworkError);
  });

  it('asks the resolver for every address, keeping the options Node passes', async () => {
    use();
    await run(createGuardedLookup({ forceBlock: true }), 'public.example.com', { family: 4, hints: 32 });
    expect(lookup).toHaveBeenLastCalledWith('public.example.com', expect.objectContaining({ all: true, family: 4, hints: 32, verbatim: true }));
  });
});

describe('createGuardedLookup — policy', () => {
  it('lets a private answer through where the policy does not block', async () => {
    use();
    const allowed = createGuardedLookup({ allowPrivate: true });
    expect((await run(allowed, 'internal.corp.example', { all: true })).address).toEqual([PRIVATE_V4]);
    expect((await run(allowed, 'internal.corp.example')).address).toBe(PRIVATE_V4.address);

    use({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
    expect((await run(createGuardedLookup(), 'internal.corp.example', { all: true })).error).toBeNull();
  });

  it('exempts allow-listed hosts and still refuses the others', async () => {
    use({ OUTBOUND_HTTP_ALLOWED_HOSTS: 'internal.corp.example' });
    const guarded = createGuardedLookup();
    expect((await run(guarded, 'internal.corp.example', { all: true })).error).toBeNull();
    expect((await run(guarded, 'mixed.example.com', { all: true })).error).toBeInstanceOf(OutboundNetworkError);
  });

  it('forceBlock ignores allowPrivate, the allow-list and the deployment switch', async () => {
    use({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false', OUTBOUND_HTTP_ALLOWED_HOSTS: 'internal.corp.example' });
    const guarded = createGuardedLookup({ forceBlock: true, allowPrivate: true });
    expect((await run(guarded, 'internal.corp.example', { all: true })).error).toBeInstanceOf(OutboundNetworkError);
  });

  it('refuses local names without asking DNS, and asks DNS once private targets are allowed', async () => {
    use();
    const guarded = createGuardedLookup({ forceBlock: true });
    for (const name of ['localhost', 'api.localhost', 'printer.local', 'db.internal', 'LOCALHOST']) {
      expect((await run(guarded, name, { all: true })).error, name).toBeInstanceOf(OutboundNetworkError);
    }
    expect(lookup).not.toHaveBeenCalled();

    expect((await run(createGuardedLookup({ allowPrivate: true }), 'db.internal', { all: true })).error?.code).toBe('ENOTFOUND');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the policy when the socket connects, not when the lookup is created', async () => {
    const guarded = createGuardedLookup();
    use({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
    expect((await run(guarded, 'internal.corp.example', { all: true })).error).toBeNull();
    use();
    expect((await run(guarded, 'internal.corp.example', { all: true })).error).toBeInstanceOf(OutboundNetworkError);
  });
});

describe('createGuardedLookup — real sockets', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('stored'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function get(agent: http.Agent, options: http.RequestOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: 'store.example.test', port, path: '/', agent, ...options }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      request.on('error', reject);
    });
  }

  /** Wraps a lookup to note whether Node asked for every address (`all`) or for one, per call. */
  function recording(inner: LookupFunction, asked: boolean[]): LookupFunction {
    return (hostname, options, callback) => {
      asked.push(options.all === true);
      inner(hostname, options, callback);
    };
  }

  it('refuses a name that points at this machine, whichever way Node asks for the address', async () => {
    use();
    const asked: boolean[] = [];
    const agent = new http.Agent({ lookup: recording(createGuardedLookup({ forceBlock: true }), asked), autoSelectFamily: true });
    try {
      await expect(get(agent)).rejects.toBeInstanceOf(OutboundNetworkError);
      await expect(get(agent, { family: 4 })).rejects.toBeInstanceOf(OutboundNetworkError);
      expect(asked).toEqual([true, false]); // the array form, then a single address
    } finally {
      agent.destroy();
    }
  });

  it('connects to the address it was given when private targets are allowed', async () => {
    use();
    const asked: boolean[] = [];
    const agent = new http.Agent({ lookup: recording(createGuardedLookup({ allowPrivate: true }), asked), autoSelectFamily: true });
    try {
      await expect(get(agent)).resolves.toBe('stored');
      await expect(get(agent, { family: 4 })).resolves.toBe('stored');
      expect(asked).toEqual([true, false]);
    } finally {
      agent.destroy();
    }
  });

  it('refuses at connect time a name that was public when the URL was checked', async () => {
    use();
    const url = `http://moving.example.test:${port}/`;
    // Two answers for the URL check (verdict + pinned addresses), then the one the socket asks for.
    mockLookupOnce([PUBLIC_V4], [PUBLIC_V4], [LOOPBACK]);
    await expect(assertPublicUrl(url, { forceBlock: true })).resolves.toBeInstanceOf(URL);

    const agent = new http.Agent({ lookup: createGuardedLookup({ forceBlock: true }) });
    try {
      await expect(get(agent, { host: 'moving.example.test' })).rejects.toBeInstanceOf(OutboundNetworkError);
    } finally {
      agent.destroy();
    }
  });
});
