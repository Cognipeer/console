/**
 * The connection URI of a MongoDB GridFS provider is held to the same network policy as a storage endpoint: checked
 * when the provider is saved or tested (`validateSettings`) and again when its runtime is created, so a stored row,
 * or a name that answers differently by the time the socket connects, cannot reach a private target either.
 *
 * Nothing here talks to a database. A loopback listener counts the connections that are made, and DNS is answered by a
 * mock; the on-prem cases connect to the listener on purpose, so a count of zero elsewhere means something.
 */
import net, { type AddressInfo } from 'node:net';
import { BSON } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { MongoGridFsFileProviderContract as contract } from '@/lib/providers/contracts/mongoGridFsFiles.contract';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';

// A name's answers, in order; the last one repeats. Anything not listed does not resolve.
const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>() }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const queue = dns.answers.get(host);
    if (!queue) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const address = queue.length > 1 ? queue.shift()! : queue[0];
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  }),
}));

const PUBLIC = '93.184.216.34';
const original = getConfigSource();
function use(overrides: Record<string, string>) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
const saas = { DEPLOYMENT_MODE: 'saas' };
const onprem = { DEPLOYMENT_MODE: 'onprem' };

const validate = async (uri: unknown, isOnPrem = false) =>
  contract.validateSettings!({ credentials: { uri } as never, settings: {}, isOnPrem });
const create = async (uri: string | undefined) =>
  contract.createRuntime({ tenantId: 't1', providerKey: 'p', credentials: { uri }, settings: {} });

let listener: net.Server;
let port = 0;
let connections = 0;

beforeAll(async () => {
  listener = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  port = (listener.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});
beforeEach(() => {
  connections = 0;
  dns.answers.clear();
  dns.answers.set('mongo.example.com', [PUBLIC]);
  dns.answers.set('db.corp.example', ['10.1.2.3']);
});
afterEach(() => setConfigSource(original));

/**
 * A replica-set member that answers every driver message with the same `hello`: enough protocol for the driver to
 * accept it as the primary and to learn the other members it announces.
 */
function fakeSeed(announce: (own: string) => string[]) {
  const sockets = new Set<net.Socket>();
  const state = { connections: 0, port: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 16) {
        const length = pending.readInt32LE(0);
        if (pending.length < length) break;
        const requestId = pending.readInt32LE(4);
        const opCode = pending.readInt32LE(12);
        pending = pending.subarray(length);
        const own = `localhost:${state.port}`;
        const doc = Buffer.from(BSON.serialize({
          ismaster: true, isWritablePrimary: true, helloOk: true, setName: 'rs0', setVersion: 1,
          hosts: announce(own), primary: own, me: own,
          maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, maxWriteBatchSize: 100000,
          localTime: new Date(), logicalSessionTimeoutMinutes: 30, connectionId: 1,
          minWireVersion: 0, maxWireVersion: 21, readOnly: false, ok: 1,
        }));
        // OP_QUERY (the first handshake) is answered with OP_REPLY, OP_MSG with OP_MSG
        const head = Buffer.alloc(opCode === 2004 ? 36 : 21);
        head.writeInt32LE(head.length + doc.length, 0);
        head.writeInt32LE(1, 4);
        head.writeInt32LE(requestId, 8);
        if (opCode === 2004) {
          head.writeInt32LE(1, 12);
          head.writeInt32LE(8, 16);
          head.writeInt32LE(1, 32);
        } else {
          head.writeInt32LE(2013, 12);
        }
        socket.write(Buffer.concat([head, doc]));
      }
    });
  });
  return {
    state,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      state.port = (server.address() as AddressInfo).port;
      return state.port;
    },
    async stop() {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Short driver timeouts, so a connection that never succeeds fails within the test (the driver reports its last error when they run out). */
const quickly = '?serverSelectionTimeoutMS=1000&connectTimeoutMS=1000';

const PRIVATE_URIS = [
  'mongodb://127.0.0.1:27017',
  'mongodb://localhost:27017/files',
  'mongodb://10.0.0.5:27017',
  'mongodb://app:s3cret-pw@169.254.169.254:27017/files',
  'mongodb://[::1]:27017',
  'mongodb://[fd00::1]:27017',
  // one private seed among public ones
  'mongodb://mongo.example.com:27017,10.0.0.5:27017/?replicaSet=rs0',
  // a name that answers with a private address
  'mongodb://db.corp.example:27017',
  // the same loopback address, written the other ways a resolver reads
  'mongodb://2130706433:27017',
  'mongodb://0x7f.1',
  'mongodb://%31%32%37.0.0.1',
  // the proxy is dialled as well
  'mongodb://mongo.example.com/?proxyHost=127.0.0.1&proxyPort=1080',
  'mongodb://mongo.example.com/?proxyHost=db.corp.example&proxyPort=1080',
];

describe('save and test: SaaS', () => {
  it('refuses a URI that names a private, loopback or metadata target', async () => {
    use(saas);
    for (const uri of PRIVATE_URIS) {
      await expect(validate(uri), uri).rejects.toMatchObject({
        name: 'ProviderEndpointError',
        code: 'provider_endpoint_not_allowed',
        field: 'uri',
      });
    }
  });

  it('refuses them even with the deployment switch off or the host allow-listed', async () => {
    use({ ...saas, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5,127.0.0.1' });
    await expect(validate('mongodb://10.0.0.5:27017')).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(validate('mongodb://127.0.0.1:27017')).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('refuses a form it cannot check: a +srv record, a local socket', async () => {
    use(saas);
    for (const uri of ['mongodb+srv://cluster0.example.com/files', 'mongodb://%2Ftmp%2Fmongodb-27017.sock']) {
      await expect(validate(uri), uri).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'uri' });
    }
  });

  it('refuses certificate files, which the driver would read from the server', async () => {
    use(saas);
    for (const option of ['tlsCAFile=/etc/hosts', 'tlsCertificateKeyFile=/etc/hosts']) {
      await expect(validate(`mongodb://mongo.example.com/?tls=true&${option}`), option).rejects.toMatchObject({
        name: 'ProviderSettingsError',
        code: 'provider_settings_invalid',
        field: 'uri',
      });
    }
  });

  it('accepts public hosts: names, addresses, several seeds, a public proxy', async () => {
    use(saas);
    for (const uri of [
      'mongodb://mongo.example.com:27017',
      'mongodb://user:pw@mongo.example.com:27017,mongo.example.com:27018/files?replicaSet=rs0&tls=true',
      `mongodb://${PUBLIC}:27017`,
      'mongodb://[2606:2800:220:1:248:1893:25c8:1946]:27017',
      'mongodb://mongo.example.com/?proxyHost=mongo.example.com&proxyPort=1080',
    ]) {
      await expect(validate(uri), uri).resolves.toBeUndefined();
    }
  });

  it('refuses what is not a MongoDB connection string, without quoting it: it holds a password', async () => {
    use(saas);
    for (const uri of ['http://mongo.example.com', 'not a uri', 'mongodb://', 'mongodb://user:topsecret-pw@', 'mongodb://mongo.example.com/?noSuchOption=1']) {
      const error = await validate(uri).catch((e: unknown) => e);
      expect(error, uri).toBeInstanceOf(ProviderSettingsError);
      expect((error as ProviderSettingsError).field).toBe('uri');
      expect((error as Error).message).toBe('Connection URI is not a valid MongoDB connection string.');
    }
  });

  it('refuses a host that is not a plain name or address, which a URL parser would read differently', async () => {
    use(saas);
    for (const uri of [
      'mongodb://mongo.example.com%23.other.example',
      'mongodb://a%40mongo.example.com',
      'mongodb://mongo.example.com%3Fx',
      'mongodb://mongo.example.com%5C.other.example',
      'mongodb://mongo.example.com%2Fx',
    ]) {
      await expect(validate(uri), uri).rejects.toBeInstanceOf(ProviderEndpointError);
    }
  });

  it('leaves an empty URI alone: it means the application\'s own connection', async () => {
    use(saas);
    for (const uri of [undefined, null, '', '   ']) {
      await expect(validate(uri), String(uri)).resolves.toBeUndefined();
    }
    await expect(contract.validateSettings!({ credentials: {}, settings: {}, isOnPrem: false })).resolves.toBeUndefined();
    await expect(validate(42)).rejects.toMatchObject({ name: 'ProviderSettingsError', field: 'uri' });
  });
});

describe('save and test: on-prem', () => {
  it('lets in-network targets through by default: a local mongod, a socket, a SRV record, certificate files', async () => {
    use(onprem);
    for (const uri of [
      'mongodb://127.0.0.1:27017',
      'mongodb://10.0.0.5:27017,10.0.0.6:27017/?replicaSet=rs0',
      'mongodb://db.corp.example:27017',
      'mongodb://%2Ftmp%2Fmongodb-27017.sock',
      'mongodb+srv://cluster0.corp.example/files',
      'mongodb://mongo.example.com/?tls=true&tlsCAFile=/etc/ssl/mongo-ca.pem',
      'mongodb://mongo.example.com/?proxyHost=10.0.0.9&proxyPort=1080',
    ]) {
      await expect(validate(uri, true), uri).resolves.toBeUndefined();
    }
  });

  it('still refuses a URI the driver cannot read', async () => {
    use(onprem);
    await expect(validate('not a uri', true)).rejects.toBeInstanceOf(ProviderSettingsError);
    await expect(validate('mongodb://a%23b.example.com', true)).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('with OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=true refuses private targets unless allow-listed, and what it cannot check', async () => {
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    for (const uri of [
      'mongodb://127.0.0.1:27017',
      'mongodb://10.0.0.5:27017',
      'mongodb://db.corp.example:27017',
      'mongodb+srv://cluster0.corp.example/files',
      'mongodb://%2Ftmp%2Fmongodb-27017.sock',
    ]) {
      await expect(validate(uri, true), uri).rejects.toBeInstanceOf(ProviderEndpointError);
    }
    await expect(validate('mongodb://mongo.example.com:27017', true)).resolves.toBeUndefined();

    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5,.corp.example' });
    await expect(validate('mongodb://10.0.0.5:27017', true)).resolves.toBeUndefined();
    await expect(validate('mongodb://db.corp.example:27017', true)).resolves.toBeUndefined();
    await expect(validate('mongodb://10.0.0.6:27017', true)).rejects.toBeInstanceOf(ProviderEndpointError);
    // a certificate file is a self-hosted option, whatever the network policy
    await expect(validate('mongodb://mongo.example.com/?tls=true&tlsCAFile=/etc/ssl/mongo-ca.pem', true)).resolves.toBeUndefined();
  });
});

describe('creating the runtime', () => {
  it('SaaS refuses a private target before any connection is made - a row saved earlier gets no further', async () => {
    use(saas);
    await expect(create(`mongodb://127.0.0.1:${port}/${quickly}`)).rejects.toMatchObject({
      name: 'ProviderEndpointError',
      field: 'uri',
    });
    await expect(create(`mongodb://mongo.example.com:27017,127.0.0.1:${port}/${quickly}`)).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(create(`mongodb://mongo.example.com/${quickly}&proxyHost=127.0.0.1&proxyPort=${port}`)).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(create('mongodb+srv://cluster0.example.com/files')).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(create('mongodb://mongo.example.com/?tls=true&tlsCAFile=/etc/hosts')).rejects.toBeInstanceOf(ProviderSettingsError);
    await expect(create('not a uri')).rejects.toBeInstanceOf(ProviderSettingsError);
    expect(connections).toBe(0);
  });

  it('the refusal is not retried and does not count against the storage breaker', async () => {
    use(saas);
    const error = await create('mongodb://10.0.0.5:27017').catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: false });
  });

  it('on-prem connects to an in-network target (the same URI the SaaS case refuses)', async () => {
    use(onprem);
    await expect(create(`mongodb://127.0.0.1:${port}/${quickly}`)).rejects.toThrow();
    // the listener saw the driver: it is what makes the zero counts above and below mean something
    expect(connections).toBeGreaterThan(0);
  });

  it('a member the servers announce by address is refused, and nothing is sent to it', async () => {
    // a self-hosted install that blocks private networks and trusts the seed's name; the announced member is a bare address
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: 'localhost' });
    dns.answers.set('localhost', ['127.0.0.1']);
    let memberBytes = 0;
    const member = net.createServer((socket) => {
      socket.on('data', (chunk) => { memberBytes += chunk.length; });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => member.listen(0, '127.0.0.1', resolve));
    const memberPort = (member.address() as AddressInfo).port;
    const seed = fakeSeed((own) => [own, `127.0.0.1:${memberPort}`]);
    try {
      const seedPort = await seed.start();
      const uri = `mongodb://localhost:${seedPort}/?replicaSet=rs0&serverSelectionTimeoutMS=2000&connectTimeoutMS=1500`;

      await expect(create(uri)).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'uri' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(memberBytes).toBe(0);

      // a client that was refused is not kept: the next attempt connects again, and is refused again
      const before = seed.state.connections;
      await expect(create(uri)).rejects.toMatchObject({ name: 'ProviderEndpointError' });
      expect(seed.state.connections).toBeGreaterThan(before);
      expect(memberBytes).toBe(0);
    } finally {
      await seed.stop();
      await new Promise<void>((resolve) => member.close(() => resolve()));
    }
  });

  it('a name that is public when the URI is checked and private when the socket connects does not get through', async () => {
    use(saas);
    // the checks at creation resolve the name twice (public); the driver's own lookup comes after and gets loopback
    dns.answers.set('moving.example.test', [PUBLIC, PUBLIC, '127.0.0.1']);
    const error = await create(`mongodb://moving.example.test:${port}/${quickly}`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/private\/loopback host: moving\.example\.test/);
    expect(connections).toBe(0);
  });
});
