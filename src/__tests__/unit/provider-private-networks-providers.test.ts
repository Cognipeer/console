/**
 * The providers that dial a customer-supplied address, on a deployment that blocks private targets (SaaS), with a
 * network opened for one organization: an S3-compatible endpoint, an Azure Blob connection string, a MongoDB GridFS
 * URI (and its SRV record), and an inference provider's base URL. Each is checked the way the provider service checks
 * it when a provider is saved, and again where its runtime is created.
 *
 * Organization A has opened 10.50.0.0/16; every organization has 100.64.10.0/24. Organization B has only the second.
 * DNS is answered by a mock, so a name can stand for any address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A name's addresses, all in one answer. `srv` holds the targets of an SRV record (an Error is a resolver failure);
// `srvCalls` the record names that were asked for. Anything not listed does not resolve.
const dns = vi.hoisted(() => ({
  answers: new Map<string, string[]>(),
  srv: new Map<string, string[] | Error>(),
  srvCalls: [] as string[],
}));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const addresses = dns.answers.get(host);
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }),
  resolveSrv: vi.fn(async (name: string) => {
    dns.srvCalls.push(name);
    const answer = dns.srv.get(name);
    if (answer === undefined) throw Object.assign(new Error(`querySrv ENODATA ${name}`), { code: 'ENODATA' });
    if (answer instanceof Error) throw answer;
    return answer.map((target) => ({ name: target, port: 27017, priority: 0, weight: 0 }));
  }),
}));

// The Azure SDK is the in-memory stand-in: the runtime of a connection-string provider is created for real, nothing is sent.
vi.mock('@azure/storage-blob', () => fakeSdkModule);

import { AzureBlobFileProviderContract } from '@/lib/providers/contracts/azureBlobFiles.contract';
import type { AzureBlobCredentials, AzureBlobSettings } from '@/lib/providers/contracts/azure/blobConfig';
import { MongoGridFsFileProviderContract } from '@/lib/providers/contracts/mongoGridFsFiles.contract';
import { S3CompatibleFileProviderContract } from '@/lib/providers/contracts/s3Compatible.contract';
import type { S3FileRuntime } from '@/lib/providers/contracts/s3/s3FileRuntime';
import { ProviderEndpointError, assertProviderEndpointsAllowed } from '@/lib/services/providers/providerEndpointGuard';
import { validateProviderSettings } from '@/lib/services/providers/providerSettingsValidation';
import { fakeSdkModule, resetFake } from '../helpers/fakeAzureBlobSdk';
import { ONPREM, restoreDeployment, SAAS, TENANT_A, TENANT_B, useDeployment } from '../helpers/providerNetworks';

const NETWORKS = `${TENANT_A}=10.50.0.0/16;*=100.64.10.0/24`;
const NEUTRAL = 'private network addresses are reachable only through networks the operator has opened for this organization';
const KEY = Buffer.alloc(64, 3).toString('base64');
const PUBLIC = '93.184.216.34';

let counter = 0;
const fresh = (label: string) => `${label}-${++counter}.corp.example`;
function resolveTo(host: string, ...addresses: string[]): string {
  dns.answers.set(host, addresses);
  return host;
}

const s3Credentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret-secret-secret' };
const runtimes: Array<{ close(): void }> = [];

beforeEach(() => {
  dns.answers.clear();
  dns.srv.clear();
  dns.srvCalls.length = 0;
  resetFake();
  useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: NETWORKS });
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  restoreDeployment();
});

/** What the provider service does before it stores a provider: the driver's own check, then the generic endpoint check. */
async function save(
  type: string,
  driver: string,
  credentials: Record<string, unknown>,
  settings: Record<string, unknown>,
  tenantId: string | undefined,
): Promise<void> {
  const scope = { tenantId };
  await validateProviderSettings(driver, credentials, settings, scope);
  await assertProviderEndpointsAllowed(type, scope, credentials, settings);
}

/** The refusal a person gets: HTTP 400 with this code and field, and a reason that names no address, URL or secret. */
function expectNeutralRefusal(error: unknown, field: string): void {
  expect(error).toBeInstanceOf(ProviderEndpointError);
  expect(error).toMatchObject({
    name: 'ProviderEndpointError',
    code: 'provider_endpoint_not_allowed',
    field,
    retryable: false,
    message: `Provider endpoint "${field}" is not allowed: ${NEUTRAL}`,
  });
}
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to be refused');
}

/* ------------------------------------------------------------------ */
/*  S3-compatible                                                     */
/* ------------------------------------------------------------------ */

describe('an S3-compatible endpoint', () => {
  const saveS3 = (endpoint: string, tenantId: string | undefined) =>
    save('file', 's3-compatible-files', s3Credentials, { endpoint, bucket: 'files-bkt' }, tenantId);
  const createRuntime = async (endpoint: string, tenantId: string | undefined) => {
    const runtime = (await S3CompatibleFileProviderContract.createRuntime({
      tenantId: tenantId as string,
      providerKey: 'minio-main',
      credentials: s3Credentials,
      settings: { endpoint, bucket: 'files-bkt' },
    })) as S3FileRuntime;
    runtimes.push(runtime);
    return runtime;
  };

  it('on a network opened for organization A: saved and created for A, refused for B', async () => {
    const endpoint = 'http://10.50.1.5:9000';
    await expect(saveS3(endpoint, TENANT_A)).resolves.toBeUndefined();
    await expect(createRuntime(endpoint, TENANT_A)).resolves.toBeDefined();

    expectNeutralRefusal(await refusal(() => saveS3(endpoint, TENANT_B)), 'endpoint');
    expectNeutralRefusal(await refusal(() => createRuntime(endpoint, TENANT_B)), 'endpoint');
    // no organization at all: nothing is opened
    expectNeutralRefusal(await refusal(() => saveS3(endpoint, undefined)), 'endpoint');
  });

  it('the refusal names neither the address, the URL, a range nor a credential', async () => {
    const error = (await refusal(() => saveS3('http://10.50.1.5:9000', TENANT_B))) as Error;
    for (const forbidden of ['10.50', '9000', 'http', 'AKIATEST', 'secret', '/16', 'minio-main', TENANT_A]) {
      expect(error.message, forbidden).not.toContain(forbidden);
    }
  });

  it('refuses an address outside the organization\'s network, even when another organization has opened it', async () => {
    expectNeutralRefusal(await refusal(() => saveS3('http://10.99.0.7:9000', TENANT_A)), 'endpoint');
    expectNeutralRefusal(await refusal(() => createRuntime('http://10.99.0.7:9000', TENANT_A)), 'endpoint');
  });

  it('a network opened for every organization (*) is open to both, and a public address is as it was', async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await expect(saveS3('http://100.64.10.9:9000', tenant)).resolves.toBeUndefined();
      await expect(createRuntime('http://100.64.10.9:9000', tenant)).resolves.toBeDefined();
      await expect(saveS3(`http://${PUBLIC}:9000`, tenant)).resolves.toBeUndefined();
    }
  });

  it('an IPv6 literal inside the network passes, and one outside does not', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=fd12:3456::/48` });
    await expect(saveS3('http://[fd12:3456::5]:9000', TENANT_A)).resolves.toBeUndefined();
    await expect(createRuntime('http://[fd12:3456::5]:9000', TENANT_A)).resolves.toBeDefined();
    expectNeutralRefusal(await refusal(() => saveS3('http://[fd12:3456::5]:9000', TENANT_B)), 'endpoint');
    expectNeutralRefusal(await refusal(() => saveS3('http://[fd99::5]:9000', TENANT_A)), 'endpoint');
  });

  it('a name that answers with an address of the network is decided by that address', async () => {
    const host = resolveTo(fresh('minio'), '10.50.1.5');
    const endpoint = `http://${host}:9000`;
    await expect(saveS3(endpoint, TENANT_A)).resolves.toBeUndefined();
    await expect(createRuntime(endpoint, TENANT_A)).resolves.toBeDefined();
    expectNeutralRefusal(await refusal(() => saveS3(endpoint, TENANT_B)), 'endpoint');
    expectNeutralRefusal(await refusal(() => createRuntime(endpoint, TENANT_B)), 'endpoint');
    // asked again for A after B was refused: the refusal was B's, not the name's
    await expect(saveS3(endpoint, TENANT_A)).resolves.toBeUndefined();

    // and the other way round: a name B was refused first is still A's to use
    const second = resolveTo(fresh('minio'), '10.50.1.5');
    expectNeutralRefusal(await refusal(() => saveS3(`http://${second}:9000`, TENANT_B)), 'endpoint');
    await expect(saveS3(`http://${second}:9000`, TENANT_A)).resolves.toBeUndefined();
    await expect(createRuntime(`http://${second}:9000`, TENANT_A)).resolves.toBeDefined();
  });

  it('a name that answers with an address of the network and another private one is refused for A', async () => {
    const host = resolveTo(fresh('mixed'), '10.50.1.5', '10.99.0.7');
    expectNeutralRefusal(await refusal(() => saveS3(`http://${host}:9000`, TENANT_A)), 'endpoint');
    expectNeutralRefusal(await refusal(() => createRuntime(`http://${host}:9000`, TENANT_A)), 'endpoint');
  });

  it('a name that answers with an address no network can open is refused whatever else it answers', async () => {
    for (const never of ['169.254.169.254', '127.0.0.1', '::1', 'fd00:ec2::254']) {
      const host = resolveTo(fresh('metadata'), '10.50.1.5', never);
      expectNeutralRefusal(await refusal(() => saveS3(`http://${host}:9000`, TENANT_A)), 'endpoint');
    }
  });

  it('a range that covers every address still leaves the metadata, loopback and link-local addresses refused', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=0.0.0.0/0,::/0` });
    for (const endpoint of ['http://169.254.169.254', 'http://127.0.0.1:9000', 'http://168.63.129.16', 'http://[::1]:9000', 'http://[fd00:ec2::254]', 'http://[fe80::1]:9000']) {
      expectNeutralRefusal(await refusal(() => saveS3(endpoint, TENANT_A)), 'endpoint');
      expectNeutralRefusal(await refusal(() => createRuntime(endpoint, TENANT_A)), 'endpoint');
    }
    await expect(saveS3('http://10.99.0.7:9000', TENANT_A)).resolves.toBeUndefined();
  });

  it('a bare host:port, which a file store\'s client reads as https, follows the same rule', async () => {
    const check = (endpoint: string, tenantId: string) => assertProviderEndpointsAllowed('file', { tenantId }, {}, { endpoint });
    await expect(check('10.50.1.5:9000', TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => check('10.50.1.5:9000', TENANT_B)), 'endpoint');
    const host = resolveTo(fresh('bare'), '10.50.1.5');
    await expect(check(`${host}:9000`, TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => check(`${host}:9000`, TENANT_B)), 'endpoint');
  });

  it('an inference provider\'s base URL is held to the same rule', async () => {
    const saveModel = (baseUrl: string, tenantId: string) => save('model', 'openai-compatible', {}, { baseUrl }, tenantId);
    await expect(saveModel('http://10.50.1.5:8000/v1', TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => saveModel('http://10.50.1.5:8000/v1', TENANT_B)), 'baseUrl');
  });
});

/* ------------------------------------------------------------------ */
/*  Azure Blob                                                        */
/* ------------------------------------------------------------------ */

describe('an Azure Blob connection string with a BlobEndpoint', () => {
  const connectionString = (blobEndpoint: string) => `AccountName=acctname1;AccountKey=${KEY};BlobEndpoint=${blobEndpoint}`;
  const settings = { authMethod: 'connectionString', container: 'files', createContainer: true };
  const saveAzure = (blobEndpoint: string, tenantId: string | undefined) =>
    save('file', 'azure-blob-files', { connectionString: connectionString(blobEndpoint) }, settings, tenantId);
  const createRuntime = async (blobEndpoint: string, tenantId: string) => {
    const runtime = await AzureBlobFileProviderContract.createRuntime({
      tenantId,
      providerKey: 'prov',
      credentials: { connectionString: connectionString(blobEndpoint) } as AzureBlobCredentials,
      settings: settings as AzureBlobSettings,
    });
    runtimes.push(runtime as unknown as { close(): void });
    return runtime;
  };

  it('on a network opened for organization A: saved and created for A, refused for B', async () => {
    const blobEndpoint = 'https://10.50.1.5/acctname1';
    await expect(saveAzure(blobEndpoint, TENANT_A)).resolves.toBeUndefined();
    await expect(createRuntime(blobEndpoint, TENANT_A)).resolves.toBeDefined();

    expectNeutralRefusal(await refusal(() => saveAzure(blobEndpoint, TENANT_B)), 'connectionString');
    expectNeutralRefusal(await refusal(() => saveAzure(blobEndpoint, undefined)), 'connectionString');
    // a stored provider is refused with the same neutral answer when its runtime is built, with the setting it came from
    expectNeutralRefusal(await refusal(() => createRuntime(blobEndpoint, TENANT_B)), 'connectionString');
  });

  it('the refusal does not quote the connection string or its key', async () => {
    const error = (await refusal(() => saveAzure('https://10.50.1.5/acctname1', TENANT_B))) as Error;
    for (const forbidden of [KEY, 'AccountKey', 'BlobEndpoint', '10.50', 'acctname1']) expect(error.message, forbidden).not.toContain(forbidden);
  });

  it('a name that answers with an address of the network is decided by that address', async () => {
    const host = resolveTo(fresh('blob'), '10.50.1.5');
    const blobEndpoint = `https://${host}/acctname1`;
    await expect(saveAzure(blobEndpoint, TENANT_A)).resolves.toBeUndefined();
    await expect(createRuntime(blobEndpoint, TENANT_A)).resolves.toBeDefined();
    expectNeutralRefusal(await refusal(() => saveAzure(blobEndpoint, TENANT_B)), 'connectionString');
    expectNeutralRefusal(await refusal(() => createRuntime(blobEndpoint, TENANT_B)), 'connectionString');
    await expect(saveAzure(blobEndpoint, TENANT_A)).resolves.toBeUndefined();
  });

  it('an address outside the organization\'s network is refused for it', async () => {
    expectNeutralRefusal(await refusal(() => saveAzure('https://10.99.0.7/acctname1', TENANT_A)), 'connectionString');
    const host = resolveTo(fresh('blob'), '10.50.1.5', '10.99.0.7');
    expectNeutralRefusal(await refusal(() => saveAzure(`https://${host}/acctname1`, TENANT_A)), 'connectionString');
  });

  it('an endpoint typed into the endpoint setting follows the same rule', async () => {
    const saveEndpoint = (endpoint: string, tenantId: string) =>
      save('file', 'azure-blob-files', { accountKey: KEY }, { accountName: 'acctname1', container: 'files', endpoint }, tenantId);
    await expect(saveEndpoint('https://10.50.1.5/acctname1', TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => saveEndpoint('https://10.50.1.5/acctname1', TENANT_B)), 'endpoint');
  });

  it('takes plain http inside an opened network too, for that organization only', async () => {
    const saveHttp = (tenantId: string) =>
      save('file', 'azure-blob-files', { accountKey: KEY }, { accountName: 'acctname1', container: 'files', endpoint: 'http://10.50.1.5/acctname1' }, tenantId);
    await expect(saveHttp(TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => saveHttp(TENANT_B)), 'endpoint');
  });
});

/* ------------------------------------------------------------------ */
/*  MongoDB GridFS                                                    */
/* ------------------------------------------------------------------ */

describe('a MongoDB GridFS connection URI', () => {
  const saveGridFs = (uri: string, tenantId: string | undefined) =>
    save('file', 'mongodb-gridfs-files', { uri }, {}, tenantId);
  const validate = async (uri: string, tenantId: string | undefined, isOnPrem = false) => {
    await MongoGridFsFileProviderContract.validateSettings!({ credentials: { uri }, settings: {}, isOnPrem, tenantId });
  };

  it('on a network opened for organization A: saved for A, refused for B', async () => {
    const uri = 'mongodb://10.50.1.5:27017/files';
    await expect(saveGridFs(uri, TENANT_A)).resolves.toBeUndefined();
    await expect(validate(uri, TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => saveGridFs(uri, TENANT_B)), 'uri');
    expectNeutralRefusal(await refusal(() => validate(uri, TENANT_B)), 'uri');
    expectNeutralRefusal(await refusal(() => saveGridFs(uri, undefined)), 'uri');
  });

  it('every host of a seed list must be inside the network', async () => {
    await expect(saveGridFs('mongodb://10.50.1.5:27017,10.50.1.6:27017/files?replicaSet=rs0', TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => saveGridFs('mongodb://10.50.1.5:27017,10.99.0.7:27017/files', TENANT_A)), 'uri');
    expectNeutralRefusal(await refusal(() => saveGridFs('mongodb://10.50.1.5:27017,127.0.0.1:27017/files', TENANT_A)), 'uri');
    await expect(saveGridFs(`mongodb://10.50.1.5:27017,${PUBLIC}:27017/files`, TENANT_A)).resolves.toBeUndefined();
  });

  it('a name that answers with an address of the network is decided by that address', async () => {
    const host = resolveTo(fresh('mongo'), '10.50.1.5');
    const uri = `mongodb://${host}:27017/files`;
    await expect(saveGridFs(uri, TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => saveGridFs(uri, TENANT_B)), 'uri');
    await expect(saveGridFs(uri, TENANT_A)).resolves.toBeUndefined();
    const mixed = resolveTo(fresh('mongo'), '10.50.1.5', '10.99.0.7');
    expectNeutralRefusal(await refusal(() => saveGridFs(`mongodb://${mixed}:27017/files`, TENANT_A)), 'uri');
  });

  it('the refusal does not quote the URI or its password', async () => {
    const error = (await refusal(() => saveGridFs('mongodb://appuser:hunter2-secret@10.50.1.5:27017/files', TENANT_B))) as Error;
    for (const forbidden of ['hunter2', 'appuser', 'mongodb', '10.50', '27017']) expect(error.message, forbidden).not.toContain(forbidden);
  });

  it('a local socket stays refused, and so do certificate files, inside an opened network', async () => {
    const socket = await refusal(() => saveGridFs('mongodb://%2Ftmp%2Fmongodb-27017.sock/files', TENANT_A));
    expect(socket).toBeInstanceOf(ProviderEndpointError);
    expect((socket as Error).message).not.toContain('/tmp');
    await expect(saveGridFs('mongodb://10.50.1.5/files?tlsCAFile=%2Fetc%2Fssl%2Fca.pem', TENANT_A)).rejects.toMatchObject({ field: 'uri' });
  });
});

describe('a MongoDB GridFS connection URI with an SRV record (mongodb+srv)', () => {
  const saveSrv = (uri: string, tenantId: string | undefined) => save('file', 'mongodb-gridfs-files', { uri }, {}, tenantId);
  /** A cluster name whose SRV record lists `targets`, each of which answers with the addresses given. */
  function cluster(targets: Array<[string, ...string[]]>): string {
    const name = fresh('cluster');
    dns.srv.set(`_mongodb._tcp.${name}`, targets.map(([target]) => target));
    for (const [target, ...addresses] of targets) dns.answers.set(target, addresses);
    return name;
  }
  const uriOf = (name: string) => `mongodb+srv://appuser:hunter2-secret@${name}/files?retryWrites=true`;

  it('every target inside the organization\'s network: saved for A, refused for B', async () => {
    const name = cluster([[fresh('shard'), '10.50.1.5'], [fresh('shard'), '10.50.1.6']]);
    await expect(saveSrv(uriOf(name), TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => saveSrv(uriOf(name), TENANT_B)), 'uri');
    expect(dns.srvCalls).toContain(`_mongodb._tcp.${name}`);
  });

  it('one target outside the network refuses the whole string', async () => {
    const name = cluster([[fresh('shard'), '10.50.1.5'], [fresh('shard'), '10.99.0.7']]);
    expectNeutralRefusal(await refusal(() => saveSrv(uriOf(name), TENANT_A)), 'uri');
    const never = cluster([[fresh('shard'), '10.50.1.5'], [fresh('shard'), '169.254.169.254']]);
    expectNeutralRefusal(await refusal(() => saveSrv(uriOf(never), TENANT_A)), 'uri');
  });

  it('public targets are as they were, for every organization', async () => {
    const name = cluster([[fresh('shard'), PUBLIC], [fresh('shard'), PUBLIC]]);
    for (const tenant of [TENANT_A, TENANT_B, undefined]) await expect(saveSrv(uriOf(name), tenant)).resolves.toBeUndefined();
  });

  it('a resolver failure, an empty record and a record that cannot be read refuse the string', async () => {
    const failing = fresh('cluster');
    dns.srv.set(`_mongodb._tcp.${failing}`, Object.assign(new Error('querySrv ETIMEOUT'), { code: 'ETIMEOUT' }));
    const missing = fresh('cluster');
    const empty = fresh('cluster');
    dns.srv.set(`_mongodb._tcp.${empty}`, []);
    const garbled = cluster([['bad host/name', '10.50.1.5']]);
    for (const name of [failing, missing, empty, garbled]) {
      const error = (await refusal(() => saveSrv(uriOf(name), TENANT_A))) as Error;
      expect(error, name).toBeInstanceOf(ProviderEndpointError);
      expect(error.message, name).not.toContain('hunter2');
      expect(error.message, name).not.toContain(name);
    }
  });

  it('the record is looked up under the service name the string asks for', async () => {
    const name = fresh('cluster');
    const target = resolveTo(fresh('shard'), '10.50.1.5');
    dns.srv.set(`_customsvc._tcp.${name}`, [target]);
    await expect(saveSrv(`mongodb+srv://${name}/files?srvServiceName=customsvc`, TENANT_A)).resolves.toBeUndefined();
    expect(dns.srvCalls).toContain(`_customsvc._tcp.${name}`);
    expect(dns.srvCalls).not.toContain(`_mongodb._tcp.${name}`);
  });

  it('a cluster whose target name is one of the private-use names is decided by address when the organization has a network', async () => {
    const name = cluster([['shard-1.internal', '10.50.1.5']]);
    await expect(saveSrv(uriOf(name), TENANT_A)).resolves.toBeUndefined();
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16` });
    expectNeutralRefusal(await refusal(() => saveSrv(uriOf(name), TENANT_B)), 'uri');
  });
});

/* ------------------------------------------------------------------ */
/*  Deployments that do not block private targets                     */
/* ------------------------------------------------------------------ */

describe('a self-hosted install', () => {
  const saveS3 = (endpoint: string, tenantId: string | undefined) =>
    save('file', 's3-compatible-files', s3Credentials, { endpoint, bucket: 'files-bkt' }, tenantId);

  it('that allows private targets (the default) accepts every one, whatever networks are configured', async () => {
    useDeployment({ ...ONPREM, PROVIDER_PRIVATE_NETWORKS: NETWORKS });
    for (const tenant of [TENANT_A, TENANT_B, undefined]) {
      await expect(saveS3('http://10.99.0.7:9000', tenant), `${tenant}`).resolves.toBeUndefined();
      await expect(saveS3('http://127.0.0.1:9000', tenant), `${tenant}`).resolves.toBeUndefined();
      await expect(save('file', 'mongodb-gridfs-files', { uri: 'mongodb://10.99.0.7:27017/files' }, {}, tenant), `${tenant}`).resolves.toBeUndefined();
    }
    const runtime = (await S3CompatibleFileProviderContract.createRuntime({
      tenantId: TENANT_B,
      providerKey: 'minio-main',
      credentials: s3Credentials,
      settings: { endpoint: 'http://10.99.0.7:9000', bucket: 'files-bkt' },
    })) as S3FileRuntime;
    runtimes.push(runtime);
  });

  it('that blocks private targets opens the networks the same way SaaS does', async () => {
    useDeployment({ ...ONPREM, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', PROVIDER_PRIVATE_NETWORKS: NETWORKS });
    await expect(saveS3('http://10.50.1.5:9000', TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => saveS3('http://10.50.1.5:9000', TENANT_B)), 'endpoint');
    await expect(saveS3('http://100.64.10.9:9000', TENANT_B)).resolves.toBeUndefined();
    await expect(save('file', 'mongodb-gridfs-files', { uri: 'mongodb://10.50.1.5:27017/files' }, {}, TENANT_A)).resolves.toBeUndefined();
    expectNeutralRefusal(await refusal(() => save('file', 'mongodb-gridfs-files', { uri: 'mongodb://10.50.1.5:27017/files' }, {}, TENANT_B)), 'uri');
  });

  it('that blocks private targets exempts a host on OUTBOUND_HTTP_ALLOWED_HOSTS for every organization', async () => {
    const exempt = resolveTo(fresh('exempt'), '10.99.0.7');
    useDeployment({ ...ONPREM, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: exempt, PROVIDER_PRIVATE_NETWORKS: NETWORKS });
    for (const tenant of [TENANT_A, TENANT_B, undefined]) await expect(saveS3(`http://${exempt}:9000`, tenant), `${tenant}`).resolves.toBeUndefined();
  });
});
