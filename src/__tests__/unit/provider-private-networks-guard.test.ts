/**
 * The outbound guard with the private networks opened for one organization: the URL check, the connect-time lookup of
 * the storage agents, the literal-IP check, the `.internal` / `.local` name rule, `safeFetch` pinning, and the
 * deployment modes the options come from. DNS is answered by a mock; every name is used by one test only unless a test
 * asks two organizations about the same name on purpose (the host cache lives for 30 seconds).
 */
import type { LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A name's answer sets, in order; the last one repeats. The guard asks twice per name it checks (the verdict, then
// the pin) and once more when a socket connects. Anything not listed does not resolve.
const dns = vi.hoisted(() => ({ answers: new Map<string, string[][]>(), calls: [] as string[] }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    dns.calls.push(host);
    const queue = dns.answers.get(host);
    if (!queue) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const addresses = queue.length > 1 ? queue.shift()! : queue[0]!;
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }),
}));

import {
  assertPublicUrl,
  createGuardedLookup,
  OutboundDnsError,
  OutboundNetworkError,
  OutboundPrivateTargetError,
  safeFetch,
} from '@/lib/security/outboundFetch';
import { createStorageAgents } from '@/lib/security/storageTransport';
import { endpointGuardOptions } from '@/lib/services/providers/providerEndpointGuard';
import { ONPREM, restoreDeployment, SAAS, TENANT_A, TENANT_B, useDeployment } from '../helpers/providerNetworks';

const ONLY_A = `${TENANT_A}=10.50.0.0/16,fd12:3456::/48`;
const NETWORKS = `${ONLY_A};*=100.64.10.0/24`;
const PUBLIC = '93.184.216.34';

let counter = 0;
/** A name no other test uses, so the host cache cannot carry an answer over. */
const fresh = (label: string, suffix = 'corp.example') => `${label}-${++counter}.${suffix}`;
function answer(host: string, ...sets: string[][]): string {
  dns.answers.set(host, sets);
  return host;
}

beforeEach(() => {
  dns.answers.clear();
  dns.calls.length = 0;
  useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: NETWORKS });
});
afterEach(() => {
  restoreDeployment();
  vi.unstubAllGlobals();
});

const refusal = (host: string) => `Refusing outbound request to private/loopback host: ${host}`;

describe('endpointGuardOptions', () => {
  it('SaaS forces the block, and carries the organization\'s networks only when it has some', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: ONLY_A });
    expect(endpointGuardOptions(TENANT_B)).toStrictEqual({ forceBlock: true });
    expect(endpointGuardOptions(undefined)).toStrictEqual({ forceBlock: true });
    expect(endpointGuardOptions(TENANT_A)).toMatchObject({ forceBlock: true, privateNetworks: { hasRanges: true } });
  });

  it('a network opened for every organization (*) reaches an organization the entries never named, but not a caller with no organization', () => {
    expect(endpointGuardOptions(TENANT_B)).toMatchObject({ forceBlock: true, privateNetworks: { hasRanges: true } });
    expect(endpointGuardOptions('some-other-org')).toMatchObject({ forceBlock: true, privateNetworks: { hasRanges: true } });
    expect(endpointGuardOptions(undefined)).toStrictEqual({ forceBlock: true });
  });

  it('SaaS without any networks configured is what it always was', () => {
    useDeployment(SAAS);
    for (const tenant of [TENANT_A, TENANT_B, undefined]) expect(endpointGuardOptions(tenant)).toStrictEqual({ forceBlock: true });
  });

  it('a self-hosted install that allows private targets (the default) is unchanged, whatever is configured', () => {
    useDeployment({ ...ONPREM, PROVIDER_PRIVATE_NETWORKS: NETWORKS });
    for (const tenant of [TENANT_A, TENANT_B, undefined]) expect(endpointGuardOptions(tenant)).toStrictEqual({ allowPrivate: true });
  });

  it('a self-hosted install that blocks private targets gets the networks too, and no options without them', () => {
    useDeployment({ ...ONPREM, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16` });
    expect(endpointGuardOptions(TENANT_A)).toMatchObject({ privateNetworks: { hasRanges: true } });
    expect(endpointGuardOptions(TENANT_A)).not.toHaveProperty('forceBlock');
    expect(endpointGuardOptions(TENANT_B)).toBeUndefined();
    expect(endpointGuardOptions(undefined)).toBeUndefined();
  });
});

describe('a URL (assertPublicUrl)', () => {
  it('passes an address inside the organization\'s network, and refuses it for another organization', async () => {
    await expect(assertPublicUrl('http://10.50.1.5:9000', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://[fd12:3456::5]:9000', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://100.64.10.9', endpointGuardOptions(TENANT_B))).resolves.toBeInstanceOf(URL);

    const refused = await assertPublicUrl('http://10.50.1.5:9000', endpointGuardOptions(TENANT_B)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OutboundPrivateTargetError);
    expect(refused).toBeInstanceOf(OutboundNetworkError);
    // the message and the name are the ones every refusal of this kind has always had
    expect(refused).toMatchObject({ name: 'OutboundNetworkError', message: refusal('10.50.1.5'), retryable: false });
    await expect(assertPublicUrl('http://10.50.1.5:9000', endpointGuardOptions(undefined))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
  });

  it('refuses a private address outside every opened range, and the ones no range can open', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=0.0.0.0/0,::/0` });
    for (const url of [
      'http://127.0.0.1:9000', 'http://169.254.169.254/latest', 'http://168.63.129.16', 'http://100.100.100.200',
      'http://[::1]:9000', 'http://[fd00:ec2::254]/latest', 'http://[fe80::1]', 'http://0.0.0.0', 'http://224.0.0.1',
      'http://[::ffff:127.0.0.1]', 'http://[64:ff9b::10.50.1.5]', 'http://[2002:a32:105::]',
    ]) {
      await expect(assertPublicUrl(url, endpointGuardOptions(TENANT_A)), url).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    }
    await expect(assertPublicUrl('http://10.99.1.1', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://[::ffff:10.99.1.1]:9000', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });

  it('passes a name that answers with an opened address for the organization that opened it', async () => {
    const host = answer(fresh('minio'), ['10.50.1.5']);
    await expect(assertPublicUrl(`http://${host}:9000`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    const other = answer(fresh('minio'), ['10.50.1.5']);
    await expect(assertPublicUrl(`http://${other}:9000`, endpointGuardOptions(TENANT_B))).rejects.toMatchObject({ message: refusal(other) });
  });

  it('refuses a name that answers with one opened address and one other private address', async () => {
    const host = answer(fresh('mixed'), ['10.50.1.5', '10.99.0.7']);
    await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    const reversed = answer(fresh('mixed'), ['10.99.0.7', '10.50.1.5']);
    await expect(assertPublicUrl(`http://${reversed}`, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
  });

  it('refuses a name that answers with an opened address and one that is never opened', async () => {
    for (const never of ['169.254.169.254', '127.0.0.1', 'fd00:ec2::254', '::1']) {
      const host = answer(fresh('metadata'), ['10.50.1.5', never]);
      await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A)), never).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    }
  });

  it('passes a name that answers with an opened address and a public one: the public one was never refused', async () => {
    const host = answer(fresh('both'), ['10.50.1.5', PUBLIC]);
    await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });

  it('a name that answers with an IPv4-mapped form of an opened address passes; the translator forms do not', async () => {
    const mapped = answer(fresh('mapped'), ['::ffff:10.50.1.5']);
    await expect(assertPublicUrl(`http://${mapped}`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    for (const form of ['64:ff9b::a32:105', '2002:a32:105::', '::10.50.1.5', '::ffff:0:a32:105', '2001:0:4136:e378:8000:63bf:f5cd:fefa']) {
      const host = answer(fresh('translated'), [form]);
      await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A)), form).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    }
  });

  it('never serves one organization\'s verdict to another: the host cache keeps addresses, not answers', async () => {
    const host = answer(fresh('shared'), ['10.50.1.5']);
    const url = `http://${host}:9000`;

    // allowed first, then refused for the other organization within the cache lifetime ...
    await expect(assertPublicUrl(url, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl(url, endpointGuardOptions(TENANT_B))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    await expect(assertPublicUrl(url, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);

    // ... and the other way round: a refusal is not remembered for the organization that opened the network
    const second = answer(fresh('shared'), ['10.50.1.5']);
    await expect(assertPublicUrl(`http://${second}`, endpointGuardOptions(TENANT_B))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    await expect(assertPublicUrl(`http://${second}`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl(`http://${second}`, endpointGuardOptions(undefined))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
  });

  it('asks the resolver once for the verdict and once for the pin, as it always did', async () => {
    const host = answer(fresh('count'), ['10.50.1.5']);
    await assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A));
    expect(dns.calls).toEqual([host, host]);
  });

  it('refuses a name that answers differently by the time it is pinned: the second answer is vetted too', async () => {
    const host = answer(fresh('moving'), ['10.50.1.5'], ['10.99.0.7']);
    await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    const toMetadata = answer(fresh('moving'), ['10.50.1.5'], ['169.254.169.254']);
    await expect(assertPublicUrl(`http://${toMetadata}`, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    const stable = answer(fresh('moving'), ['10.50.1.5'], ['10.50.1.6']);
    await expect(assertPublicUrl(`http://${stable}`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });

  it('keeps a resolver outage the retryable error it is, and does not cache it', async () => {
    const host = fresh('down');
    const error = await assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboundDnsError);
    expect(error).toMatchObject({ retryable: true });
    answer(host, ['10.50.1.5']);
    await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });

  it('is what it was without networks: public passes, private is refused, for everyone', async () => {
    useDeployment(SAAS);
    await expect(assertPublicUrl(`http://${PUBLIC}`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    for (const url of ['http://10.50.1.5', 'http://100.64.10.9', 'http://[fd12:3456::5]']) {
      await expect(assertPublicUrl(url, endpointGuardOptions(TENANT_A)), url).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    }
  });
});

describe('the names .internal and .local', () => {
  it('stay refused without asking DNS for an organization that has no network', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: ONLY_A });
    for (const suffix of ['internal', 'local']) {
      const host = answer(fresh('db', suffix), ['10.50.1.5']);
      await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_B)), host).rejects.toMatchObject({ message: refusal(host) });
      await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(undefined)), host).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    }
    expect(dns.calls).toEqual([]);
  });

  it('are resolved and decided by address for an organization that has a network', async () => {
    for (const suffix of ['internal', 'local']) {
      const inside = answer(fresh('db', suffix), ['10.50.1.5']);
      await expect(assertPublicUrl(`http://${inside}`, endpointGuardOptions(TENANT_A)), inside).resolves.toBeInstanceOf(URL);
      const elsewhere = answer(fresh('db', suffix), ['10.99.0.7']);
      await expect(assertPublicUrl(`http://${elsewhere}`, endpointGuardOptions(TENANT_A)), elsewhere).rejects.toBeInstanceOf(OutboundPrivateTargetError);
      const loopback = answer(fresh('db', suffix), ['127.0.0.1']);
      await expect(assertPublicUrl(`http://${loopback}`, endpointGuardOptions(TENANT_A)), loopback).rejects.toBeInstanceOf(OutboundPrivateTargetError);
      const unknown = fresh('db', suffix);
      await expect(assertPublicUrl(`http://${unknown}`, endpointGuardOptions(TENANT_A)), unknown).rejects.toBeInstanceOf(OutboundDnsError);
    }
  });

  it('are resolved for any organization once a network is opened for every organization (*)', async () => {
    const host = answer(fresh('db', 'internal'), ['100.64.10.20']);
    await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_B))).resolves.toBeInstanceOf(URL);
  });

  it('localhost and the names under it are refused without DNS, networks or not', async () => {
    for (const host of ['localhost', 'x.localhost', 'a.b.localhost', 'localhost.localdomain']) {
      answer(host, ['10.50.1.5']);
      await expect(assertPublicUrl(`http://${host}:9000`, endpointGuardOptions(TENANT_A)), host).rejects.toMatchObject({ message: refusal(host) });
    }
    expect(dns.calls).toEqual([]);
  });
});

/** Runs a `lookup` function the way a socket does. */
function runLookup(fn: LookupFunction, hostname: string, options: LookupOptions = {}) {
  return new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family: number | undefined }>((resolve) => {
    fn(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

describe('the lookup of a storage client\'s sockets (createGuardedLookup)', () => {
  it('hands the socket an opened address for the organization that opened it, in both callback shapes', async () => {
    const host = answer(fresh('minio'), ['10.50.1.5']);
    const lookup = createGuardedLookup(endpointGuardOptions(TENANT_A));

    const all = await runLookup(lookup, host, { all: true });
    expect(all.error).toBeNull();
    expect(all.address).toEqual([{ address: '10.50.1.5', family: 4 }]);
    const one = await runLookup(lookup, host);
    expect(one.error).toBeNull();
    expect(one).toMatchObject({ address: '10.50.1.5', family: 4 });
  });

  it('refuses the same name for another organization, with the refusal every caller already knows', async () => {
    const host = answer(fresh('minio'), ['10.50.1.5']);
    for (const options of [{ all: true }, {}] as LookupOptions[]) {
      const result = await runLookup(createGuardedLookup(endpointGuardOptions(TENANT_B)), host, options);
      expect(result.error).toBeInstanceOf(OutboundPrivateTargetError);
      expect(result.error?.message).toBe(refusal(host));
      expect(result.address).toEqual([]);
    }
  });

  it('refuses when one answer is opened and another is not, in either order, or is never opened', async () => {
    const lookup = createGuardedLookup(endpointGuardOptions(TENANT_A));
    for (const answers of [['10.50.1.5', '10.99.0.7'], ['10.99.0.7', '10.50.1.5'], ['10.50.1.5', '169.254.169.254'], ['10.50.1.5', '::1']]) {
      const host = answer(fresh('mixed'), answers);
      expect((await runLookup(lookup, host, { all: true })).error, answers.join()).toBeInstanceOf(OutboundPrivateTargetError);
      expect((await runLookup(lookup, host)).error, answers.join()).toBeInstanceOf(OutboundPrivateTargetError);
    }
  });

  it('answers a public address as before, whoever asks', async () => {
    const host = answer(fresh('public'), [PUBLIC]);
    expect((await runLookup(createGuardedLookup(endpointGuardOptions(TENANT_B)), host)).error).toBeNull();
    expect((await runLookup(createGuardedLookup(endpointGuardOptions(undefined)), host)).error).toBeNull();
  });

  it('applies the .internal rule when the socket connects, not only when the URL is checked', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: ONLY_A });
    const host = answer(fresh('db', 'internal'), ['10.50.1.5']);
    const refused = await runLookup(createGuardedLookup(endpointGuardOptions(TENANT_B)), host, { all: true });
    expect(refused.error).toBeInstanceOf(OutboundPrivateTargetError);
    expect(dns.calls).toEqual([]);
    const allowed = await runLookup(createGuardedLookup(endpointGuardOptions(TENANT_A)), host, { all: true });
    expect(allowed.error).toBeNull();
    expect(dns.calls).toEqual([host]);
  });

  it('does not change what it does for a caller with no networks', async () => {
    const lookup = createGuardedLookup({ forceBlock: true });
    const host = answer(fresh('minio'), ['10.50.1.5']);
    expect((await runLookup(lookup, host, { all: true })).error).toBeInstanceOf(OutboundPrivateTargetError);
  });
});

describe('a literal address in the storage agents (createStorageAgents)', () => {
  const agentsFor = (tenantId: string | undefined, guardHost: string) =>
    createStorageAgents({ guard: endpointGuardOptions(tenantId), guardHost, isOnPrem: false });

  it('is accepted inside the organization\'s network and refused for another organization', () => {
    agentsFor(TENANT_A, '10.50.1.5').destroy();
    agentsFor(TENANT_A, '[fd12:3456::5]').destroy();
    agentsFor(TENANT_B, '100.64.10.9').destroy();

    for (const [tenant, host] of [[TENANT_B, '10.50.1.5'], [undefined, '10.50.1.5'], [TENANT_B, '[fd12:3456::5]'], [TENANT_A, '10.99.0.7']] as const) {
      expect(() => agentsFor(tenant, host), `${tenant} ${host}`).toThrow(OutboundPrivateTargetError);
    }
    expect(() => agentsFor(TENANT_B, '10.50.1.5')).toThrow(refusal('10.50.1.5'));
  });

  it('refuses the addresses no network can open, even for the organization whose range covers them', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=0.0.0.0/0,::/0` });
    for (const host of ['127.0.0.1', '169.254.169.254', '168.63.129.16', '[::1]', '[fd00:ec2::254]', '[::ffff:127.0.0.1]']) {
      expect(() => agentsFor(TENANT_A, host), host).toThrow(OutboundPrivateTargetError);
    }
    agentsFor(TENANT_A, '10.1.2.3').destroy();
  });

  it('gives the sockets a lookup that carries the same organization\'s networks', async () => {
    const host = answer(fresh('minio'), ['10.50.1.5']);
    for (const [tenant, ok] of [[TENANT_A, true], [TENANT_B, false]] as const) {
      const agents = agentsFor(tenant, host);
      try {
        const lookup = (agents.httpsAgent as unknown as { options: { lookup: LookupFunction } }).options.lookup;
        expect(typeof lookup).toBe('function');
        const result = await runLookup(lookup, host, { all: true });
        expect(result.error === null, `${tenant}`).toBe(ok);
      } finally {
        agents.destroy();
      }
    }
  });

  it('the application\'s own address and every address of the machine are refused even inside a range', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16` }, ['10.50.1.77']);
    expect(() => agentsFor(TENANT_A, '10.50.1.77')).toThrow(OutboundPrivateTargetError);
    agentsFor(TENANT_A, '10.50.1.78').destroy();
  });
});

describe('safeFetch (the probe of "Test connection")', () => {
  it('is unchanged without networks: a private target is refused before any request is made', async () => {
    useDeployment(SAAS);
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('http://10.50.1.5:8000/v1/models', undefined, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(safeFetch('http://10.50.1.5:8000/v1/models', undefined, { forceBlock: true })).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the request to an address inside the organization\'s network, and not for another organization', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await safeFetch('http://10.50.1.5:8000/v1/models', undefined, { ...endpointGuardOptions(TENANT_A), followRedirects: false });
    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(safeFetch('http://10.50.1.5:8000/v1/models', undefined, endpointGuardOptions(TENANT_B))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pins the connection to the opened addresses a name resolved to', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const host = answer(fresh('vllm'), ['10.50.1.5']);

    await safeFetch(`http://${host}:8000/v1/models`, undefined, endpointGuardOptions(TENANT_A));
    const init = (fetchMock.mock.calls[0] as unknown as [URL, { dispatcher?: unknown }])[1];
    expect(init.dispatcher).toBeDefined();
  });

  it('checks a redirect hop with the same networks: into the network passes, out of it does not', async () => {
    const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectTo('http://10.50.2.2:8000/next'))
      .mockResolvedValueOnce(new Response('done'));
    vi.stubGlobal('fetch', fetchMock);
    const done = await safeFetch('http://10.50.1.5:8000/start', undefined, endpointGuardOptions(TENANT_A));
    expect(await done.text()).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const leaving = vi.fn().mockResolvedValueOnce(redirectTo('http://10.99.0.7:8000/elsewhere')).mockResolvedValue(new Response('never'));
    vi.stubGlobal('fetch', leaving);
    await expect(safeFetch('http://10.50.1.5:8000/start', undefined, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    expect(leaving).toHaveBeenCalledTimes(1);

    const toMetadata = vi.fn().mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest')).mockResolvedValue(new Response('never'));
    vi.stubGlobal('fetch', toMetadata);
    await expect(safeFetch('http://10.50.1.5:8000/start', undefined, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    expect(toMetadata).toHaveBeenCalledTimes(1);
  });
});

describe('a self-hosted install', () => {
  it('that allows private targets (the default) keeps allowing every one: the networks change nothing', async () => {
    useDeployment({ ...ONPREM, PROVIDER_PRIVATE_NETWORKS: NETWORKS });
    for (const tenant of [TENANT_A, TENANT_B, undefined]) {
      for (const url of ['http://10.99.0.7:9000', 'http://127.0.0.1:9000', 'http://[fd00::1]:9000', 'http://10.50.1.5:9000']) {
        await expect(assertPublicUrl(url, endpointGuardOptions(tenant)), `${tenant} ${url}`).resolves.toBeInstanceOf(URL);
      }
    }
    createStorageAgents({ guard: endpointGuardOptions(TENANT_B), guardHost: '10.99.0.7', isOnPrem: true }).destroy();
    // nothing was resolved: no check applies, so no name is looked up
    expect(dns.calls).toEqual([]);
  });

  it('that blocks private targets reaches an opened address for the organization that opened it, and for no one else', async () => {
    useDeployment({ ...ONPREM, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', PROVIDER_PRIVATE_NETWORKS: ONLY_A });
    await expect(assertPublicUrl('http://10.50.1.5:9000', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    for (const tenant of [TENANT_B, undefined]) {
      await expect(assertPublicUrl('http://10.50.1.5:9000', endpointGuardOptions(tenant)), `${tenant}`).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    }
    await expect(assertPublicUrl('http://10.99.0.7:9000', endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);

    const host = answer(fresh('minio'), ['10.50.1.5']);
    await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl(`http://${host}`, endpointGuardOptions(TENANT_B))).rejects.toBeInstanceOf(OutboundPrivateTargetError);

    createStorageAgents({ guard: endpointGuardOptions(TENANT_A), guardHost: '10.50.1.5', isOnPrem: true }).destroy();
    expect(() => createStorageAgents({ guard: endpointGuardOptions(TENANT_B), guardHost: '10.50.1.5', isOnPrem: true })).toThrow(OutboundPrivateTargetError);
  });

  it('that blocks private targets and has no network is what it was', async () => {
    useDeployment({ ...ONPREM, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    expect(endpointGuardOptions(TENANT_A)).toBeUndefined();
    await expect(assertPublicUrl('http://10.50.1.5:9000', endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    await expect(assertPublicUrl(`http://${PUBLIC}`, endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });

  it('that blocks private targets still refuses the addresses no network can open', async () => {
    useDeployment({ ...ONPREM, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=0.0.0.0/0` });
    for (const url of ['http://127.0.0.1', 'http://169.254.169.254', 'http://168.63.129.16']) {
      await expect(assertPublicUrl(url, endpointGuardOptions(TENANT_A)), url).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    }
    await expect(assertPublicUrl('http://10.99.0.7', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });

  it('that blocks private targets still exempts a host on OUTBOUND_HTTP_ALLOWED_HOSTS, whichever organization asks', async () => {
    const exempt = fresh('exempt');
    useDeployment({ ...ONPREM, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: exempt, PROVIDER_PRIVATE_NETWORKS: ONLY_A });
    answer(exempt, ['10.99.0.7']);
    for (const tenant of [TENANT_A, TENANT_B, undefined]) {
      await expect(assertPublicUrl(`http://${exempt}`, endpointGuardOptions(tenant)), `${tenant}`).resolves.toBeInstanceOf(URL);
    }
    const listed = answer(fresh('other'), ['10.99.0.7']);
    await expect(assertPublicUrl(`http://${listed}`, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
  });
});

describe('the addresses of this machine', () => {
  it('stay refused inside an opened network, for a URL and for a socket', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: ONLY_A }, ['10.50.1.77', 'fd12:3456::77']);
    for (const url of ['http://10.50.1.77:9000', 'http://[fd12:3456::77]:9000', 'http://[::ffff:10.50.1.77]:9000']) {
      await expect(assertPublicUrl(url, endpointGuardOptions(TENANT_A)), url).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    }
    const own = answer(fresh('self'), ['10.50.1.77']);
    expect((await runLookup(createGuardedLookup(endpointGuardOptions(TENANT_A)), own, { all: true })).error).toBeInstanceOf(OutboundPrivateTargetError);
    await expect(assertPublicUrl('http://10.50.1.78:9000', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });

  it('include the cluster\'s API server address (KUBERNETES_SERVICE_HOST)', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: ONLY_A, KUBERNETES_SERVICE_HOST: '10.50.0.1' });
    await expect(assertPublicUrl('http://10.50.0.1:443', endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    const named = answer(fresh('apiserver'), ['10.50.0.1']);
    await expect(assertPublicUrl(`http://${named}`, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    await expect(assertPublicUrl('http://10.50.0.2:443', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });

  it('are refused for a deny-listed range too: the deny list wins inside an opened network', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: ONLY_A, PROVIDER_PRIVATE_NETWORKS_DENY: '10.50.9.0/24' });
    await expect(assertPublicUrl('http://10.50.9.9:9000', endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    const denied = answer(fresh('denied'), ['10.50.1.5', '10.50.9.9']);
    await expect(assertPublicUrl(`http://${denied}`, endpointGuardOptions(TENANT_A))).rejects.toBeInstanceOf(OutboundPrivateTargetError);
    await expect(assertPublicUrl('http://10.50.1.5:9000', endpointGuardOptions(TENANT_A))).resolves.toBeInstanceOf(URL);
  });
});
