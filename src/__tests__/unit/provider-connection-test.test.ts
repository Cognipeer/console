/**
 * "Test connection" of a provider: the cheapest authenticated request per driver, with a
 * mocked network. ok:true / ok:false / ok:null (unsupported), the 10 s limit, secrets never
 * echoed, every endpoint through the outbound guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import {
  foundCount,
  scrubMessage,
  testProviderConnection,
  type ProviderTestInput,
} from '@/lib/services/providers/providerConnectionTest';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';

const original = getConfigSource();
beforeEach(() => setConfigSource({ get: (k: string) => ({ DEPLOYMENT_MODE: 'saas' } as Record<string, string>)[k] ?? process.env[k] } as ConfigSource));
afterEach(() => setConfigSource(original));

const json = (status: number, body: unknown) => ({ status, json: async () => body }) as unknown as Response;
const fetchOf = (response: Response | Error | (() => Promise<Response>)) =>
  vi.fn(async () => {
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response() : response;
  });

const base = (overrides: Partial<ProviderTestInput>): ProviderTestInput => ({
  type: 'model',
  driver: 'openai',
  credentials: { apiKey: 'sk-live-secret-1234' },
  settings: {},
  tenantId: 't1',
  ...overrides,
});

describe('http probes of the inference drivers', () => {
  it('OpenAI: lists models with the key, ok:true with the names', async () => {
    const fetchImpl = fetchOf(json(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }));
    const result = await testProviderConnection(base({}), { fetchImpl: fetchImpl as never });
    expect(result).toMatchObject({ ok: true, details: { models: ['gpt-4o', 'gpt-4o-mini'] } });
    expect(result.message).toContain('2 models');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit, Record<string, unknown>];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-live-secret-1234');
    // SaaS: the guard is forced, redirects are not followed, the limit is passed down.
    expect(options).toMatchObject({ forceBlock: true, followRedirects: false, timeoutMs: 10_000 });
  });

  it('answers ok:false without echoing credentials when the key is rejected', async () => {
    const result = await testProviderConnection(base({}), { fetchImpl: fetchOf(json(401, { error: 'bad key sk-live-secret-1234' })) as never });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(JSON.stringify(result)).not.toContain('sk-live-secret');
  });

  it('answers ok:false on a server error', async () => {
    const result = await testProviderConnection(base({}), { fetchImpl: fetchOf(json(503, {})) as never });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('503');
  });

  it('openai-compatible: appends /models to the base URL, 404 means "cannot verify" (ok:null)', async () => {
    const fetchImpl = fetchOf(json(404, {}));
    const result = await testProviderConnection(
      base({ driver: 'openai-compatible', settings: { baseUrl: 'https://93.184.216.34/v1/' } }),
      { fetchImpl: fetchImpl as never },
    );
    expect(result.ok).toBeNull();
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://93.184.216.34/v1/models');
  });

  it('openai-compatible without a base URL has nothing to test', async () => {
    const result = await testProviderConnection(base({ driver: 'openai-compatible', settings: {} }), { fetchImpl: fetchOf(json(200, {})) as never });
    expect(result.ok).toBeNull();
  });

  it('Anthropic: x-api-key header and version', async () => {
    const fetchImpl = fetchOf(json(200, { data: [{ id: 'claude-x' }] }));
    const result = await testProviderConnection(base({ driver: 'anthropic' }), { fetchImpl: fetchImpl as never });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=20');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-live-secret-1234');
  });

  it('Together answers with a bare array', async () => {
    const result = await testProviderConnection(base({ driver: 'together' }), { fetchImpl: fetchOf(json(200, [{ id: 'llama' }])) as never });
    expect(result).toMatchObject({ ok: true, details: { models: ['llama'] } });
  });

  it('Azure: lists deployments and reports them as deployments', async () => {
    const fetchImpl = fetchOf(json(200, { data: [{ id: 'chat' }, { id: 'embed' }] }));
    const result = await testProviderConnection(
      base({ driver: 'azure', settings: { instanceName: 'my-res', deploymentName: 'chat', apiVersion: '2024-10-21' } }),
      { fetchImpl: fetchImpl as never },
    );
    expect(result).toMatchObject({ ok: true, details: { deployments: ['chat', 'embed'] } });
    expect(result.message).toContain('2 deployments');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://my-res.openai.azure.com/openai/deployments?api-version=2023-03-15-preview');
    expect(foundCount(result)).toBe(2);
  });

  it('Azure falls back to the model list when the deployments route is gone', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(404, {}))
      .mockResolvedValueOnce(json(200, { data: [{ id: 'gpt-4o' }] }));
    const result = await testProviderConnection(
      base({ driver: 'azure', settings: { instanceName: 'my-res', apiVersion: '2024-10-21' } }),
      { fetchImpl: fetchImpl as never },
    );
    expect(result).toMatchObject({ ok: true, details: { models: ['gpt-4o'] } });
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe('https://my-res.openai.azure.com/openai/models?api-version=2024-10-21');
  });

  it('a network failure is ok:false with a message that carries no secret', async () => {
    const result = await testProviderConnection(base({}), { fetchImpl: fetchOf(new Error('connect ECONNREFUSED while sending Bearer sk-live-secret-1234')) as never });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
    expect(result.message).not.toContain('sk-live-secret-1234');
    expect(result.message).toContain('***');
  });

  it('stops waiting after the limit', async () => {
    const never = vi.fn(() => new Promise<Response>(() => undefined));
    const result = await testProviderConnection(base({}), { fetchImpl: never as never, timeoutMs: 25 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Timed out/);
  });
});

describe('unsupported and local drivers', () => {
  it('has no test for drivers without a cheap probe (ok:null), and never dials', async () => {
    const fetchImpl = fetchOf(json(200, {}));
    for (const input of [
      base({ driver: 'bedrock', credentials: { accessKeyId: 'AKIAXXXX', secretAccessKey: 'xxxxxxxxxx' }, settings: { region: 'eu-west-1' } }),
      base({ type: 'websearch', driver: 'tavily' }),
      base({ type: 'ocr', driver: 'mistral-ocr' }),
    ]) {
      const result = await testProviderConnection(input, { fetchImpl: fetchImpl as never });
      expect(result.ok, input.driver).toBeNull();
      expect(result.message).toMatch(/not supported/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('local providers run inside the console', async () => {
    const createRuntime = vi.fn();
    const result = await testProviderConnection(base({ type: 'vector', driver: 'sqlite-vector', credentials: {} }), { createRuntime: createRuntime as never });
    expect(result.ok).toBeNull();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('SRV connection strings are not dialled', async () => {
    const createRuntime = vi.fn();
    const result = await testProviderConnection(
      base({ type: 'vector', driver: 'mongodb', credentials: { uri: 'mongodb+srv://u:p@cluster0.example.net/db' } }),
      { createRuntime: createRuntime as never },
    );
    expect(result.ok).toBeNull();
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

describe('runtime probes (vector, file)', () => {
  it('vector: lists indexes, closes the runtime, reports the names', async () => {
    const close = vi.fn();
    const runtime = { listIndexes: vi.fn(async () => [{ name: 'docs' }, { name: 'faq' }]), close };
    const createRuntime = vi.fn(async () => runtime);
    const result = await testProviderConnection(
      base({ type: 'vector', driver: 'elasticsearch', credentials: { apiKey: 'es-secret-key' }, settings: { url: 'https://93.184.216.34:9200' } }),
      { createRuntime: createRuntime as never },
    );
    expect(result).toMatchObject({ ok: true, details: { deployments: ['docs', 'faq'] } });
    expect(result.message).toContain('2 indexes');
    expect(close).toHaveBeenCalled();
    expect((createRuntime.mock.calls[0] as unknown as [string, { providerKey: string }])[1].providerKey).toBe('connection-test');
  });

  it('vector: a runtime that fails is ok:false, and the secret is scrubbed from its message', async () => {
    const createRuntime = vi.fn(async () => ({
      listIndexes: async () => { throw new Error('auth failed for es-secret-key'); },
      close: vi.fn(),
    }));
    const result = await testProviderConnection(
      base({ type: 'vector', driver: 'elasticsearch', credentials: { apiKey: 'es-secret-key' } }),
      { createRuntime: createRuntime as never },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe('auth failed for ***');
  });

  it('scrubs the password part of a connection string from a failure message', async () => {
    const createRuntime = vi.fn(async () => ({
      listIndexes: async () => { throw new Error('password authentication failed (p%40ss-w0rd)'); },
      close: vi.fn(),
    }));
    const result = await testProviderConnection(
      base({
        type: 'vector',
        driver: 'pgvector',
        credentials: { connectionString: 'postgres://app:p%40ss-w0rd@93.184.216.34:5432/vec' },
      }),
      { createRuntime: createRuntime as never },
    );
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('p%40ss-w0rd');
    expect(result.message).toContain('***');
  });

  it('scrubs that password in its decoded form too, and only the part after the first colon', async () => {
    const createRuntime = vi.fn(async () => ({
      listIndexes: async () => { throw new Error('rejected p@ss:w0rd for user app'); },
      close: vi.fn(),
    }));
    const result = await testProviderConnection(
      base({
        type: 'vector',
        driver: 'pgvector',
        credentials: { connectionString: 'postgres://app:p%40ss:w0rd@93.184.216.34:5432/vec' },
      }),
      { createRuntime: createRuntime as never },
    );
    expect(result.message).toBe('rejected *** for user app');
  });

  it('a value made of colons is read in time proportional to its length', async () => {
    // Looking for the password of "scheme://user:password@" must not try every colon in turn: a long run of them took
    // time quadratic in its length (a request body of a megabyte kept the process busy for minutes).
    const started = performance.now();
    const result = await testProviderConnection(
      base({ type: 'file', driver: 'local-filesystem', credentials: { note: `http://${':'.repeat(60_000)}` } }),
    );
    expect(result.ok).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('file: lists one object', async () => {
    const listFiles = vi.fn(async () => ({ items: [] }));
    const result = await testProviderConnection(
      base({ type: 'file', driver: 'aws-s3-files', credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret-abc-123' } }),
      { createRuntime: (async () => ({ listFiles })) as never },
    );
    expect(result.ok).toBe(true);
    expect(listFiles).toHaveBeenCalledWith({ limit: 1 });
  });
});

describe('the outbound guard', () => {
  it('refuses a private endpoint before anything is dialled (ProviderEndpointError)', async () => {
    const fetchImpl = fetchOf(json(200, {}));
    await expect(testProviderConnection(
      base({ driver: 'openai-compatible', settings: { baseUrl: 'http://10.0.0.5:8000/v1' } }),
      { fetchImpl: fetchImpl as never },
    )).rejects.toBeInstanceOf(ProviderEndpointError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('also guards non-inference domains: a vector host in a connection string', async () => {
    const createRuntime = vi.fn();
    await expect(testProviderConnection(
      base({ type: 'vector', driver: 'postgres', credentials: { connectionString: 'postgres://u:p@192.168.0.4:5432/db' } }),
      { createRuntime: createRuntime as never },
    )).rejects.toBeInstanceOf(ProviderEndpointError);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('a MongoDB GridFS connection URI is held to it too: a private host, and a +srv record it cannot check, are refused on SaaS', async () => {
    const createRuntime = vi.fn();
    for (const uri of ['mongodb://127.0.0.1:27017', 'mongodb://u:p@10.0.0.5:27017/files', 'mongodb+srv://u:p@cluster0.example.net/files']) {
      await expect(testProviderConnection(
        base({ type: 'file', driver: 'mongodb-gridfs-files', credentials: { uri } }),
        { createRuntime: createRuntime as never },
      ), uri).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'uri' });
    }
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

describe('scrubMessage', () => {
  it('removes secrets, folds whitespace and bounds the length', () => {
    expect(scrubMessage('bad  key\nabc123456 here', ['abc123456'])).toBe('bad key *** here');
    expect(scrubMessage('x'.repeat(500), []).length).toBe(300);
  });
});
