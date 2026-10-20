/**
 * The MongoDB GridFS driver keeps one client per connection URI, and the client of a URI typed into the provider form
 * dials through a lookup that carries the private networks opened for ONE organization. These tests pin the cache key
 * (two organizations never share a client for the same URI), what each client's lookup allows when a socket connects,
 * and what a member the servers announce is allowed to be.
 *
 * Nothing connects: `MongoClient.prototype.connect` is replaced by a promise the test settles, DNS is answered by a
 * mock, and the events a replica set would raise are emitted by hand. (The same checks against a real driver and real
 * sockets are in mongo-gridfs-endpoint-policy.test.ts.)
 */
import type { LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { MongoClient } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>() }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const addresses = dns.answers.get(host);
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }),
  resolveSrv: vi.fn(async (name: string) => {
    throw Object.assign(new Error(`querySrv ENODATA ${name}`), { code: 'ENODATA' });
  }),
}));

import { MongoGridFsFileProviderContract } from '@/lib/providers/contracts/mongoGridFsFiles.contract';
import { OutboundPrivateTargetError } from '@/lib/security/outboundFetch';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { ONPREM, restoreDeployment, SAAS, TENANT_A, TENANT_B, useDeployment } from '../helpers/providerNetworks';

// Organization A has opened 10.50.0.0/16 and fd12:3456::/48; every organization has 100.64.10.0/24.
const NETWORKS = `${TENANT_A}=10.50.0.0/16,fd12:3456::/48;*=100.64.10.0/24`;

interface Connect {
  client: MongoClient;
  settle(): void;
}
let connects: Connect[] = [];
let close: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dns.answers.clear();
  connects = [];
  vi.spyOn(MongoClient.prototype, 'connect').mockImplementation(function connect(this: MongoClient) {
    return new Promise<MongoClient>((resolve) => {
      connects.push({ client: this, settle: () => resolve(this) });
    }) as never;
  });
  close = vi.spyOn(MongoClient.prototype, 'close').mockResolvedValue(undefined as never);
  useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: NETWORKS });
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreDeployment();
});

let counter = 0;
/** A URI no other test uses: the driver module keeps its clients for the life of the process. */
const freshUri = (host: string) => `mongodb://${host}:27017/files-${++counter}`;
const freshName = () => `gridfs-${++counter}.corp.example`;

const create = async (uri: string, tenantId: string) =>
  MongoGridFsFileProviderContract.createRuntime({ tenantId, providerKey: 'p', credentials: { uri }, settings: {} });

/** What a replica set raises when the driver starts connecting to a member. */
function serverOpening(client: MongoClient, address: string): void {
  client.emit('serverOpening', { topologyId: 1, address } as never);
}

/** What a replica set raises when a server answers the driver's heartbeat: the answer is read into the topology right after. */
function heartbeatAnswer(client: MongoClient, reply: Record<string, unknown>): void {
  client.emit('serverHeartbeatSucceeded', { connectionId: 'seed:27017', duration: 1, reply, awaited: false } as never);
}

/** Starts a runtime, waits for the connection it starts, and returns both. */
async function start(uri: string, tenantId: string) {
  const before = connects.length;
  const result = create(uri, tenantId).then(
    (runtime) => ({ runtime }),
    (error: unknown) => ({ error }),
  );
  await vi.waitFor(() => expect(connects.length).toBe(before + 1));
  return { connect: connects[before]!, result };
}

function lookupOf(client: MongoClient): LookupFunction {
  const lookup = (client.options as unknown as { lookup?: LookupFunction }).lookup;
  if (typeof lookup !== 'function') throw new Error('the client has no lookup');
  return lookup;
}
function runLookup(fn: LookupFunction, hostname: string, options: LookupOptions = { all: true }) {
  return new Promise<NodeJS.ErrnoException | null>((resolve) => {
    fn(hostname, options, (error) => resolve(error));
  });
}

describe('the client of a connection URI typed into the provider form', () => {
  it('is kept per organization: the same URI gives two organizations two clients, and one organization one', async () => {
    const uri = freshUri('100.64.10.5');
    const a1 = create(uri, TENANT_A);
    const a2 = create(uri, TENANT_A);
    const b1 = create(uri, TENANT_B);
    await vi.waitFor(() => expect(connects.length).toBe(2));
    for (const connect of connects) connect.settle();
    await Promise.all([a1, a2, b1]);

    expect(connects).toHaveLength(2);
    expect(connects[0]!.client).not.toBe(connects[1]!.client);

    // later calls of either organization use the clients that exist
    await create(uri, TENANT_A);
    await create(uri, TENANT_B);
    expect(connects).toHaveLength(2);
  });

  it('is kept per URI as well: another URI of the same organization gets a client of its own', async () => {
    const uri = freshUri('100.64.10.6');
    const a = await start(uri, TENANT_A);
    a.connect.settle();
    await a.result;
    const other = await start(`${uri}?appName=other`, TENANT_A);
    other.connect.settle();
    await other.result;
    expect(connects).toHaveLength(2);
  });

  it('carries the networks of its own organization to the lookup of every socket', async () => {
    const host = freshName();
    dns.answers.set(host, ['100.64.10.5']);
    const uri = freshUri(host);
    const a = await start(uri, TENANT_A);
    a.connect.settle();
    await a.result;
    const b = await start(uri, TENANT_B);
    b.connect.settle();
    await b.result;

    // by the time the sockets open, the name answers with an address only A has opened
    dns.answers.set(host, ['10.50.1.5']);
    expect(await runLookup(lookupOf(a.connect.client), host)).toBeNull();
    expect(await runLookup(lookupOf(a.connect.client), host, {})).toBeNull();
    const refused = await runLookup(lookupOf(b.connect.client), host);
    expect(refused).toBeInstanceOf(OutboundPrivateTargetError);

    // an address neither has opened is refused for both, and so is one no network can open
    for (const address of ['10.99.0.7', '169.254.169.254', '127.0.0.1']) {
      dns.answers.set(host, [address]);
      expect(await runLookup(lookupOf(a.connect.client), host), `A ${address}`).toBeInstanceOf(OutboundPrivateTargetError);
      expect(await runLookup(lookupOf(b.connect.client), host), `B ${address}`).toBeInstanceOf(OutboundPrivateTargetError);
    }
    // one address of the network and one outside it
    dns.answers.set(host, ['10.50.1.5', '10.99.0.7']);
    expect(await runLookup(lookupOf(a.connect.client), host)).toBeInstanceOf(OutboundPrivateTargetError);
  });

  it('never dials a name that stands for this machine, whichever organization it belongs to', async () => {
    const host = freshName();
    dns.answers.set(host, ['100.64.10.5']);
    const a = await start(freshUri(host), TENANT_A);
    a.connect.settle();
    await a.result;
    for (const name of ['localhost', 'x.localhost', 'localhost.localdomain']) {
      expect(await runLookup(lookupOf(a.connect.client), name), name).toBeInstanceOf(OutboundPrivateTargetError);
    }
  });
});

describe('a member the servers announce', () => {
  /** Starts a runtime for `tenantId`, announces `address` while it connects, and settles the connection. */
  async function announce(address: string, tenantId: string) {
    const { connect, result } = await start(freshUri('100.64.10.5'), tenantId);
    serverOpening(connect.client, address);
    connect.settle();
    const outcome = await result;
    // a refusal closes the client on the next tick: let it happen inside this test
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { outcome, client: connect.client };
  }

  it('is accepted when it is a literal address inside the organization\'s network', async () => {
    for (const address of ['10.50.1.5:27017', '[fd12:3456::5]:27017', '100.64.10.9:27017']) {
      const { outcome } = await announce(address, TENANT_A);
      expect(outcome, address).toHaveProperty('runtime');
    }
    expect(close).not.toHaveBeenCalled();
  });

  it('is refused, and the client closed and dropped, when the organization has not opened it', async () => {
    const { outcome, client } = await announce('10.50.1.5:27017', TENANT_B);
    expect(outcome).toHaveProperty('error');
    const { error } = outcome as { error: unknown };
    expect(error).toBeInstanceOf(ProviderEndpointError);
    expect(error).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'uri', retryable: false });
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(close.mock.contexts).toContain(client);

    // the client was not kept: the next call connects a new one instead of getting the closed one
    const before = connects.length;
    const again = create(`mongodb://100.64.10.5:27017/files-${counter}`, TENANT_B).catch(() => undefined);
    await vi.waitFor(() => expect(connects.length).toBe(before + 1));
    connects[before]!.settle();
    await again;
  });

  it('is refused for every organization when no network can open it', async () => {
    for (const address of ['10.99.0.7:27017', '169.254.169.254:27017', '127.0.0.1:27017', '[::1]:27017', '[fd00:ec2::254]:27017', '[::ffff:10.99.0.7]:27017']) {
      const { outcome } = await announce(address, TENANT_A);
      expect(outcome, address).toHaveProperty('error');
    }
  });

  it('is left to the guarded lookup when it is a name', async () => {
    const { outcome } = await announce('shard-0.corp.example:27017', TENANT_B);
    expect(outcome).toHaveProperty('runtime');
    expect(close).not.toHaveBeenCalled();
  });

  it('is matched as its IPv4 address when it is written as an IPv4-mapped address', async () => {
    const { outcome } = await announce('[::ffff:10.50.1.5]:27017', TENANT_B);
    expect(outcome).toHaveProperty('error');
    const { outcome: allowed } = await announce('[::ffff:10.50.1.5]:27017', TENANT_A);
    expect(allowed).toHaveProperty('runtime');
  });
});

describe('the members a heartbeat answer announces', () => {
  /** Starts a runtime for `tenantId`, delivers `reply` as a server's answer while it connects, and settles the connection. */
  async function answer(reply: Record<string, unknown>, tenantId: string) {
    const { connect, result } = await start(freshUri('100.64.10.5'), tenantId);
    heartbeatAnswer(connect.client, reply);
    connect.settle();
    const outcome = await result;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { outcome, client: connect.client };
  }

  it('are taken out of the answer, in place, when the organization has not opened them: the driver never learns of them', async () => {
    const reply = {
      setName: 'rs0',
      primary: 'seed.corp.example:27017',
      hosts: ['seed.corp.example:27017', '10.50.1.5:27017', '127.0.0.1:27018', '100.64.10.7:27017'],
      passives: ['169.254.169.254:80', 'passive.corp.example:27017'],
      arbiters: ['[::1]:27017', '[fd12:3456::5]:27017'],
    };

    const { outcome, client } = await answer(reply, TENANT_B);

    // what the organization may dial, and the names, stay, in their order; everything else of the answer is untouched
    expect(reply).toEqual({
      setName: 'rs0',
      primary: 'seed.corp.example:27017',
      hosts: ['seed.corp.example:27017', '100.64.10.7:27017'],
      passives: ['passive.corp.example:27017'],
      arbiters: [],
    });
    // and the attempt ends with a refusal: the client is closed and not kept
    expect(outcome).toHaveProperty('error');
    expect((outcome as { error: unknown }).error).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'uri', retryable: false });
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(close.mock.contexts).toEqual([client]);
  });

  it('are kept when they are inside the organization\'s networks, and so are the names', async () => {
    const reply = {
      hosts: ['10.50.1.5:27017', '[fd12:3456::5]:27017', '100.64.10.9:27017', 'shard-0.corp.example:27017'],
      passives: ['10.50.2.2:27017'],
      arbiters: ['[::ffff:10.50.1.6]:27017'],
    };
    const before = structuredClone(reply);

    const { outcome } = await answer(reply, TENANT_A);

    expect(reply).toEqual(before);
    expect(outcome).toHaveProperty('runtime');
    expect(close).not.toHaveBeenCalled();
  });

  it('are all taken out, however many follow each other: none is skipped', async () => {
    const adjacent = Array.from({ length: 12 }, (_, i) => `10.99.0.${i + 1}:27017`);
    const reply = { hosts: ['a.corp.example:27017', ...adjacent, 'b.corp.example:27017', ...adjacent.map((address) => address.replace('10.99.', '10.98.'))] };

    const { outcome } = await answer(reply, TENANT_A);

    expect(reply.hosts).toEqual(['a.corp.example:27017', 'b.corp.example:27017']);
    expect(outcome).toHaveProperty('error');
  });

  it('are refused for every organization when no network can open them', async () => {
    for (const address of ['10.99.0.7:27017', '169.254.169.254:27017', '127.0.0.1:27017', '[::1]:27017', '[fd00:ec2::254]:27017', '[::ffff:10.99.0.7]:27017']) {
      const reply = { hosts: ['seed.corp.example:27017', address] };
      const { outcome } = await answer(reply, TENANT_A);
      expect(reply.hosts, address).toEqual(['seed.corp.example:27017']);
      expect(outcome, address).toHaveProperty('error');
    }
  });

  it('are not looked for in an answer that does not list members, or lists what is not an address', async () => {
    for (const reply of [{}, { ok: 1 }, { hosts: 'seed:27017' }, { hosts: null, passives: undefined }, { hosts: [5, null, {}, ['10.99.0.1:27017']], arbiters: 'x' }]) {
      const before = structuredClone(reply);
      const { outcome } = await answer(reply as Record<string, unknown>, TENANT_A);
      expect(reply, JSON.stringify(before)).toEqual(before);
      expect(outcome, JSON.stringify(before)).toHaveProperty('runtime');
    }
    expect(close).not.toHaveBeenCalled();
  });

  it('are no reason to fail the connection when the answer cannot be read', async () => {
    const reply = {};
    Object.defineProperty(reply, 'hosts', { get() { throw new Error('unreadable'); }, enumerable: true });

    const { outcome } = await answer(reply, TENANT_A);

    // the second line (the member the driver is about to open) is still there for this connection
    expect(outcome).toHaveProperty('runtime');
    expect(close).not.toHaveBeenCalled();
  });
});

describe('a self-hosted install', () => {
  it('that allows private targets (the default) shares one client per URI, as it always did, whatever is configured', async () => {
    useDeployment({ ...ONPREM, PROVIDER_PRIVATE_NETWORKS: NETWORKS });
    const uri = freshUri('10.99.0.7');
    const a = create(uri, TENANT_A);
    const b = create(uri, TENANT_B);
    await vi.waitFor(() => expect(connects.length).toBe(1));
    connects[0]!.settle();
    await Promise.all([a, b]);
    expect(connects).toHaveLength(1);
    expect((connects[0]!.client.options as unknown as { lookup?: unknown }).lookup).toBeUndefined();

    // nothing the servers announce is refused there either
    serverOpening(connects[0]!.client, '127.0.0.1:27017');
    const reply = { hosts: ['127.0.0.1:27017', '10.99.0.7:27017'] };
    heartbeatAnswer(connects[0]!.client, reply);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).not.toHaveBeenCalled();
    expect(reply.hosts).toEqual(['127.0.0.1:27017', '10.99.0.7:27017']);
  });

  it('that blocks private targets keeps a client per organization, like SaaS', async () => {
    useDeployment({ ...ONPREM, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', PROVIDER_PRIVATE_NETWORKS: NETWORKS });
    const uri = freshUri('100.64.10.5');
    const a = create(uri, TENANT_A);
    const b = create(uri, TENANT_B);
    await vi.waitFor(() => expect(connects.length).toBe(2));
    for (const connect of connects) connect.settle();
    await Promise.all([a, b]);
    expect(connects[0]!.client).not.toBe(connects[1]!.client);
  });
});

describe('the connection of the application itself', () => {
  it('is dialled and monitored as it always was, on a deployment that blocks private targets', async () => {
    const appUri = `mongodb://10.99.0.7:27017/?replicaSet=rs-${++counter}`;
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: NETWORKS, DB_PROVIDER: 'mongodb', MONGODB_URI: appUri });

    const result = MongoGridFsFileProviderContract.createRuntime({ tenantId: TENANT_B, providerKey: 'p', credentials: {}, settings: {} });
    await vi.waitFor(() => expect(connects.length).toBe(1));
    const reply = { hosts: ['10.99.0.7:27017', '10.99.0.8:27017', '127.0.0.1:27017'] };
    serverOpening(connects[0]!.client, '10.99.0.8:27017');
    heartbeatAnswer(connects[0]!.client, reply);
    connects[0]!.settle();

    await expect(result).resolves.toBeDefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reply.hosts).toEqual(['10.99.0.7:27017', '10.99.0.8:27017', '127.0.0.1:27017']);
    expect(close).not.toHaveBeenCalled();
    expect((connects[0]!.client.options as unknown as { lookup?: unknown }).lookup).toBeUndefined();
  });
});
