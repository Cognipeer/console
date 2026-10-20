import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const db = {
  switchToTenant: vi.fn(),
  findProviderById: vi.fn(),
  findProviderByKey: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
};
vi.mock('@/lib/database', () => ({ getDatabase: async () => db }));
// No name resolves except the one host of the SRV record below, which answers with a private address.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'db-0.cluster0.example.com') return [{ address: '10.0.0.5', family: 4 }];
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }),
  resolveSrv: vi.fn(async (name: string) => {
    if (name === '_mongodb._tcp.cluster0.example.com') return [{ name: 'db-0.cluster0.example.com', port: 27017, priority: 0, weight: 0 }];
    throw Object.assign(new Error(`querySrv ENODATA ${name}`), { code: 'ENODATA' });
  }),
}));

import { createProviderConfig, updateProviderConfig } from '@/lib/services/providers/providerService';
import { encryptObject } from '@/lib/utils/crypto';

const original = getConfigSource();
beforeEach(() => vi.clearAllMocks());
afterEach(() => setConfigSource(original));
function deployment(mode: 'saas' | 'onprem', extra: Record<string, string> = {}) {
  setConfigSource({ get: (k: string) => (k === 'DEPLOYMENT_MODE' ? mode : extra[k] ?? process.env[k]) } as ConfigSource);
}
function saas() {
  deployment('saas');
}

describe('provider service endpoint validation', () => {
  it('create rejects a private baseUrl before touching the database', async () => {
    saas();
    await expect(createProviderConfig('t', 'tenant', {
      key: 'k', type: 'model', driver: 'openai-compatible', label: 'x',
      credentials: { apiKey: 'a', baseUrl: 'http://127.0.0.1:9/v1' }, createdBy: 'u',
    } as never)).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed' });
    expect(db.createProvider).not.toHaveBeenCalled();
  });

  it('update rejects a private baseUrl', async () => {
    saas();
    db.findProviderById.mockResolvedValue({ type: 'model', driver: 'openai-compatible' });
    await expect(updateProviderConfig('t', 'p1', {
      credentials: { baseUrl: 'http://169.254.169.254/' },
    } as never)).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed' });
    expect(db.updateProvider).not.toHaveBeenCalled();
  });
});

describe('provider service endpoint validation for file stores', () => {
  const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example-secret-value' };
  const create = (endpoint: string) => createProviderConfig('t', 'tenant', {
    key: 'files', type: 'file', driver: 'aws-s3-files', label: 'Files',
    credentials, settings: { region: 'us-east-1', bucket: 'cp-files-test', endpoint }, createdBy: 'u',
  } as never);

  it('create rejects a private or loopback endpoint on SaaS before touching the database', async () => {
    saas();
    for (const endpoint of ['https://10.0.0.5:9000', 'https://127.0.0.1:9000', 'https://169.254.169.254', 'https://localhost:9000']) {
      await expect(create(endpoint), endpoint).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint' });
    }
    expect(db.createProvider).not.toHaveBeenCalled();
  });

  it('create on SaaS judges a plain-http endpoint by where it points, like an https one', async () => {
    saas();
    await expect(create('http://10.0.0.5:9000')).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint' });
    expect(db.createProvider).not.toHaveBeenCalled();
    db.createProvider.mockResolvedValue({ _id: 'p1', key: 'files', type: 'file', driver: 'aws-s3-files', credentialsEnc: 'x' });
    await expect(create('http://93.184.216.34:9000')).resolves.toMatchObject({ _id: 'p1' });
    expect(db.createProvider).toHaveBeenCalledTimes(1);
  });

  it('create saves a file store with a public endpoint, or none (Amazon S3), on SaaS', async () => {
    saas();
    db.createProvider.mockResolvedValue({ _id: 'p1', key: 'files', type: 'file', driver: 'aws-s3-files', credentialsEnc: 'x' });
    await expect(create('https://93.184.216.34:9000')).resolves.toMatchObject({ _id: 'p1' });
    await expect(create('')).resolves.toMatchObject({ _id: 'p1' });
    expect(db.createProvider).toHaveBeenCalledTimes(2);
  });

  it('create saves an in-network endpoint on-prem, and refuses it when the deployment blocks private targets', async () => {
    db.createProvider.mockResolvedValue({ _id: 'p2', key: 'files', type: 'file', driver: 'aws-s3-files', credentialsEnc: 'x' });
    deployment('onprem');
    await expect(create('http://10.0.0.5:9000')).resolves.toMatchObject({ _id: 'p2' });
    deployment('onprem', { OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(create('http://10.0.0.5:9000')).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed' });
    deployment('onprem', { OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5' });
    await expect(create('http://10.0.0.5:9000')).resolves.toMatchObject({ _id: 'p2' });
    expect(db.createProvider).toHaveBeenCalledTimes(2);
  });

  it('update rejects a private endpoint on SaaS before writing anything', async () => {
    saas();
    db.findProviderById.mockResolvedValue({
      type: 'file', driver: 'aws-s3-files', credentialsEnc: encryptObject(credentials),
      settings: { region: 'us-east-1', bucket: 'cp-files-test' },
    });
    await expect(updateProviderConfig('t', 'p1', {
      settings: { region: 'us-east-1', bucket: 'cp-files-test', endpoint: 'https://169.254.169.254' },
    } as never)).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint' });
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('update lets a settings edit without an endpoint through', async () => {
    saas();
    db.findProviderById.mockResolvedValue({
      _id: 'p1', type: 'file', driver: 'aws-s3-files', credentialsEnc: encryptObject(credentials),
      settings: { region: 'us-east-1', bucket: 'cp-files-test' },
    });
    db.updateProvider.mockResolvedValue({ _id: 'p1', type: 'file', driver: 'aws-s3-files', credentialsEnc: 'x' });
    await expect(updateProviderConfig('t', 'p1', {
      settings: { region: 'eu-central-1', bucket: 'cp-files-test' },
    } as never)).resolves.toMatchObject({ _id: 'p1' });
    expect(db.updateProvider).toHaveBeenCalledTimes(1);
  });
});

describe('provider service endpoint validation for a MongoDB GridFS store', () => {
  const create = (credentials: Record<string, unknown>) => createProviderConfig('t', 'tenant', {
    key: 'gridfs', type: 'file', driver: 'mongodb-gridfs-files', label: 'GridFS',
    credentials, settings: { database: 'files_db' }, createdBy: 'u',
  } as never);

  it('create rejects a connection URI that names a private, loopback or metadata host on SaaS, before touching the database', async () => {
    saas();
    for (const uri of [
      'mongodb://127.0.0.1:27017',
      'mongodb://app:pw@10.0.0.5:27017/files',
      'mongodb://169.254.169.254:27017',
      'mongodb://[::1]:27017',
      'mongodb://93.184.216.34:27017,10.0.0.5:27017/?replicaSet=rs0',
      // an SRV record that names a private host, and one that names nothing
      'mongodb+srv://cluster0.example.com/files',
      'mongodb+srv://nothing.example.com/files',
    ]) {
      await expect(create({ uri }), uri).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'uri' });
    }
    expect(db.createProvider).not.toHaveBeenCalled();
  });

  it('create saves a public host, and an empty URI (the application\'s own database), on SaaS', async () => {
    saas();
    db.createProvider.mockResolvedValue({ _id: 'p1', key: 'gridfs', type: 'file', driver: 'mongodb-gridfs-files', credentialsEnc: 'x' });
    await expect(create({ uri: 'mongodb://app:pw@93.184.216.34:27017/files' })).resolves.toMatchObject({ _id: 'p1' });
    await expect(create({})).resolves.toMatchObject({ _id: 'p1' });
    expect(db.createProvider).toHaveBeenCalledTimes(2);
  });

  it('create saves an in-network URI on-prem, and refuses it when the deployment blocks private targets', async () => {
    db.createProvider.mockResolvedValue({ _id: 'p2', key: 'gridfs', type: 'file', driver: 'mongodb-gridfs-files', credentialsEnc: 'x' });
    deployment('onprem');
    await expect(create({ uri: 'mongodb://10.0.0.5:27017' })).resolves.toMatchObject({ _id: 'p2' });
    deployment('onprem', { OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(create({ uri: 'mongodb://10.0.0.5:27017' })).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'uri' });
    expect(db.createProvider).toHaveBeenCalledTimes(1);
  });

  it('update checks the stored URI as well when the edit leaves it out', async () => {
    saas();
    db.findProviderById.mockResolvedValue({
      _id: 'p1', type: 'file', driver: 'mongodb-gridfs-files',
      credentialsEnc: encryptObject({ uri: 'mongodb://10.0.0.5:27017' }),
      settings: { database: 'files_db' },
    });
    await expect(updateProviderConfig('t', 'p1', { settings: { database: 'other_db' } } as never))
      .rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'uri' });
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('update refuses a new private URI', async () => {
    saas();
    db.findProviderById.mockResolvedValue({
      _id: 'p1', type: 'file', driver: 'mongodb-gridfs-files',
      credentialsEnc: encryptObject({ uri: 'mongodb://93.184.216.34:27017' }),
      settings: { database: 'files_db' },
    });
    await expect(updateProviderConfig('t', 'p1', { credentials: { uri: 'mongodb://127.0.0.1:27017' } } as never))
      .rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'uri' });
    expect(db.updateProvider).not.toHaveBeenCalled();
  });
});
