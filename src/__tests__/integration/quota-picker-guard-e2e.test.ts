/**
 * What the Limits pickers STORE is what the quota guard COMPARES, end to end,
 * against both real backends.
 *
 * A wrong value does not fail loudly: the limit is saved, listed, and never
 * applies to anything. So this test walks the whole chain with the code the
 * editor itself runs:
 *
 *   1. `searchTargetOptions` (the picker's own client) asks the real
 *      GET /api/resources/search for what a person would type,
 *   2. the option's `value` is stored through the real POST /api/quota/policies,
 *      in the project the pick adopted,
 *   3. the guard (`checkRateLimit`) refuses the second call inside the window for
 *      the context each service builds, and for a few services the REAL client
 *      routes (chat/completions, vector query, file upload, tracing stream) answer
 *      429, while the same call for another model / index / agent still passes.
 *
 * Negative controls: the registry row id, the display name (the key is stored
 * for models, indexes, buckets and providers) and, for tracing, the agent KEY
 * (the NAME is stored) do not match anything. Only the model / vector / file /
 * tracing routes are driven here; the other services are held to the same
 * contexts by the source reading in unit/quota-targets.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

process.env.QUOTA_POLICY_CACHE_TTL_SECONDS = '0';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
  handleChatCompletion: vi.fn(),
  queryVectorIndex: vi.fn(),
}));

import type { DatabaseProvider } from '@/lib/database';
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db: DatabaseProvider = await hoisted.getDatabase();
      return db.runWithTenant?.(tenantDbName, () => fn(db));
    },
  };
});

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: async (header: string | null) => {
      const ctx = hoisted.tokens.get(String(header).replace(/^Bearer /, ''));
      if (!ctx) throw new ApiTokenAuthError('Invalid API token', 401);
      return ctx;
    },
  };
});

// Everything up to the model / the vector store runs for real; only the upstream call is stubbed.
vi.mock('@/lib/services/models/inferenceService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/inferenceService')>()),
  handleChatCompletion: hoisted.handleChatCompletion,
}));
vi.mock('@/lib/services/vector/vectorService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/vector/vectorService')>()),
  queryVectorIndex: hoisted.queryVectorIndex,
}));

import { reloadConfig } from '@/lib/core/config';
import { searchTargetOptions, type FetchLike, type TargetOption } from '@/components/quota/pickerSources';
import { checkRateLimit, resetQuotaGroupCacheForTests, type QuotaContext } from '@/lib/quota/quotaGuard';
import { quotaTargetSource } from '@/lib/quota/targets';
import { QUOTA_DOMAINS, type QuotaDomain } from '@/lib/quota/types';
import { clearResourceCache } from '@/lib/resources/service';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';
import { clientTracingApiPlugin } from '@/server/api/plugins/client-tracing';
import { clientVectorApiPlugin } from '@/server/api/plugins/client-vector';
import { quotaApiPlugin } from '@/server/api/plugins/quota';
import { resourcesApiPlugin } from '@/server/api/plugins/resources';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';

beforeAll(() => reloadConfig());
afterAll(() => {
  delete process.env.QUOTA_POLICY_CACHE_TTL_SECONDS;
  reloadConfig();
});

/** One request per minute: the first call passes, the second inside the window is refused. */
const oneRequestPerMinute = { rateLimit: { requests: { perMinute: 1 } } };

type TargetScope = 'resource' | 'provider';

describeForEachProvider('a limit made from the pickers applies to the calls it names', (getDb) => {
  let db: DatabaseProvider;
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let dbName: string;
  let tenantId: string;
  let ownerId: string;
  let sessionHeaders: Record<string, string>;
  let projectMain: string;
  let projectOther: string;
  let sequence = 0;

  const seedModel = (key: string, name: string, category: string, projectId: string) =>
    db.createModel({
      tenantId,
      projectId,
      name,
      key,
      providerKey: 'mock-llm',
      providerDriver: 'openai-compatible',
      category: category as never,
      modelId: key,
      settings: {},
      pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
      createdBy: 'seed',
    } as never);

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    hoisted.handleChatCompletion.mockReset().mockRejectedValue(new Error('upstream stubbed'));
    hoisted.queryVectorIndex.mockReset().mockResolvedValue({ matches: [] });
    hoisted.tokens.clear();
    db = getDb();
    clearResourceCache();
    resetQuotaGroupCacheForTests();

    sequence += 1;
    const slug = `pick-${Date.now()}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
    dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Picker', slug, dbName, licenseType: 'ENTERPRISE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    const owner = await db.createUser({
      tenantId, email: 'owner@x.io', name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'ENTERPRISE', features: [],
    });
    ownerId = String(owner._id);
    projectMain = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'test' }))._id);
    projectOther = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'test' }))._id);

    // One model of every category the runtime enforces, in the main project...
    await seedModel('chat-alpha', 'Alpha chat', 'llm', projectMain);
    await seedModel('embed-alpha', 'Alpha embeddings', 'embedding', projectMain);
    await seedModel('image-alpha', 'Alpha images', 'image', projectMain);
    await seedModel('stt-alpha', 'Alpha speech to text', 'stt', projectMain);
    await seedModel('tts-alpha', 'Alpha text to speech', 'tts', projectMain);
    await seedModel('ocr-alpha', 'Alpha ocr', 'ocr', projectMain);
    await seedModel('decide-alpha', 'Alpha decisions', 'decision', projectMain);
    await seedModel('mod-alpha', 'Alpha moderation', 'moderation', projectMain);
    // ...and a chat model of another project, which a limit on the first must leave alone.
    await seedModel('chat-beta', 'Beta chat', 'llm', projectOther);

    for (const provider of [
      { key: 'vec-prov', type: 'vector', driver: 'dummy-vector', label: 'Vector provider alpha' },
      { key: 'file-prov', type: 'file', driver: 'local-filesystem', label: 'File provider alpha' },
      { key: 'model-prov', type: 'model', driver: 'openai-compatible', label: 'Model provider alpha' },
    ]) {
      await db.createProvider({
        tenantId, key: provider.key, type: provider.type as never, driver: provider.driver, label: provider.label,
        status: 'active', credentialsEnc: 'x', settings: {}, projectIds: [projectMain], createdBy: 'seed',
      } as never);
    }
    await db.createVectorIndex({
      tenantId, projectId: projectMain, providerKey: 'vec-prov', key: 'kb-alpha', name: 'Knowledge alpha',
      externalId: 'EXT-OPAQUE-1', dimension: 3, metric: 'cosine', createdBy: 'seed',
    } as never);
    await db.createFileBucket({
      tenantId, projectId: projectMain, key: 'bucket-alpha', name: 'Bucket alpha', providerKey: 'file-prov', status: 'active', createdBy: 'seed',
    } as never);
    await db.createAgent({
      tenantId, projectId: projectMain, key: 'agent-alpha-k1', name: 'Agent Alpha Name', status: 'active',
      config: { modelKey: 'chat-alpha' }, createdBy: 'seed',
    } as never);

    sessionHeaders = {
      'content-type': 'application/json',
      'x-license-type': 'ENTERPRISE',
      'x-tenant-db-name': dbName,
      'x-tenant-id': tenantId,
      'x-tenant-slug': slug,
      'x-user-email': 'owner@x.io',
      'x-user-id': ownerId,
      'x-user-role': 'owner',
    };
    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(resourcesApiPlugin);
      await instance.register(quotaApiPlugin);
      await instance.register(clientInferenceApiPlugin);
      await instance.register(clientVectorApiPlugin);
      await instance.register(clientFilesApiPlugin);
      await instance.register(clientTracingApiPlugin);
    });
    await app.ready();

    // The owner's API token, bound to the project the picker adopts for the picked rows.
    hoisted.tokens.set('tok-main', {
      token: 'tok-main',
      tokenRecord: { _id: 'tok-main-id', userId: ownerId, servicePermissions: null, projectId: projectMain },
      tenant: { licenseType: 'ENTERPRISE' },
      tenantId,
      tenantSlug: slug,
      tenantDbName: dbName,
      projectId: projectMain,
      user: owner,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  /** The picker's `fetch`, wired to the real Fastify app (the session of the owner). */
  const fetcher: FetchLike = async (url) => {
    const headers = { ...sessionHeaders };
    delete headers['content-type'];
    const res = await app.inject({ method: 'GET', url, headers });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(res.body) };
  };

  /** What the editor does: search with what was typed and pick the row that carries `label`. */
  async function pick(domain: QuotaDomain, scope: TargetScope, typed: string, label: string): Promise<TargetOption> {
    const source = quotaTargetSource(domain, scope);
    if (!source) throw new Error(`${domain}/${scope} has no target source`);
    const result = await searchTargetOptions(source, typed, fetcher);
    if (result.status !== 'ok') throw new Error(`${domain}/${scope}: the picker search answered "${result.status}"`);
    const option = result.options.find((candidate) => candidate.label === label);
    if (!option) {
      throw new Error(`${domain}/${scope}: typing "${typed}" did not offer "${label}": ${JSON.stringify(result.options.map((o) => [o.label, o.value]))}`);
    }
    return option;
  }

  /** What the editor submits: the stored value, in the project the pick adopted. */
  async function saveLimit(domain: QuotaDomain, scope: TargetScope, option: TargetOption) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/quota/policies?projectId=${option.projectId ?? projectMain}`,
      headers: sessionHeaders,
      payload: JSON.stringify({ scope, scopeId: option.value, domain, label: `limit ${domain}/${scope}`, limits: oneRequestPerMinute }),
    });
    expect(res.statusCode, res.body).toBe(201);
    return parseJsonBody<{ policy: { scopeId: string } }>(res.body).policy;
  }

  const contextFor = (domain: QuotaDomain, extra: Partial<QuotaContext>): QuotaContext => ({
    tenantDbName: dbName, tenantId, projectId: projectMain, userId: ownerId, tokenId: 'tok-main-id', domain, ...extra,
  });

  /** Two calls in a row: the limit is one per minute, so only a limit that applies refuses the second. */
  const twoCalls = async (context: QuotaContext) => {
    const first = await checkRateLimit(context, { requests: 1 });
    const second = await checkRateLimit(context, { requests: 1 });
    return { first: first.allowed, second: second.allowed, reason: second.reason };
  };

  // ── every service with a resource target ────────────────────────────────

  const RESOURCE_SERVICES: Array<{ domain: QuotaDomain; typed: string; label: string; stored: string }> = [
    { domain: 'llm', typed: 'alpha', label: 'Alpha chat', stored: 'chat-alpha' },
    { domain: 'embedding', typed: 'alpha', label: 'Alpha embeddings', stored: 'embed-alpha' },
    { domain: 'image', typed: 'alpha', label: 'Alpha images', stored: 'image-alpha' },
    { domain: 'stt', typed: 'alpha', label: 'Alpha speech to text', stored: 'stt-alpha' },
    { domain: 'tts', typed: 'alpha', label: 'Alpha text to speech', stored: 'tts-alpha' },
    { domain: 'ocr', typed: 'alpha', label: 'Alpha ocr', stored: 'ocr-alpha' },
    { domain: 'decision', typed: 'alpha', label: 'Alpha decisions', stored: 'decide-alpha' },
    { domain: 'moderation', typed: 'alpha', label: 'Alpha moderation', stored: 'mod-alpha' },
    { domain: 'vector', typed: 'knowledge', label: 'Knowledge alpha', stored: 'kb-alpha' },
    { domain: 'file', typed: 'bucket', label: 'Bucket alpha', stored: 'bucket-alpha' },
    { domain: 'agent', typed: 'alpha', label: 'Agent Alpha Name', stored: 'agent-alpha-k1' },
    // Tracing is the one that stores the NAME: that is what an SDK client reports.
    { domain: 'tracing', typed: 'alpha', label: 'Agent Alpha Name', stored: 'Agent Alpha Name' },
  ];

  it.each(RESOURCE_SERVICES)('$domain: the picked value is what the guard compares, and nothing else is', async ({ domain, typed, label, stored }) => {
    const option = await pick(domain, 'resource', typed, label);
    expect(option.value).toBe(stored);
    expect((await saveLimit(domain, 'resource', option)).scopeId).toBe(stored);

    // Wrong values (the row's id, the id with its type, another key, and the other of name / key) stay unlimited.
    const rowId = option.id.split(':').slice(1).join(':');
    const otherField = domain === 'tracing' ? 'agent-alpha-k1' : label;
    for (const wrong of [rowId, option.id, 'another-key', otherField]) {
      expect(await twoCalls(contextFor(domain, { resourceKey: wrong })), `${domain} with "${wrong}"`).toMatchObject({ first: true, second: true });
    }
    // The value the picker stored is refused on the second call, with the policy's own limit in the reason.
    const applied = await twoCalls(contextFor(domain, { resourceKey: stored }));
    expect(applied).toMatchObject({ first: true, second: false });
    expect(applied.reason).toMatch(/\(2\/1\)/);
  });

  it('a limit on a model of the main project is left alone by the same key in another project', async () => {
    const option = await pick('llm', 'resource', 'alpha', 'Alpha chat');
    // the pick adopts the project the model lives in, which is where the guard will read the limit
    expect(option.projectId).toBe(projectMain);
    await saveLimit('llm', 'resource', option);
    expect(await twoCalls(contextFor('llm', { resourceKey: 'chat-alpha', projectId: projectOther }))).toMatchObject({ second: true });
    expect(await twoCalls(contextFor('llm', { resourceKey: 'chat-alpha' }))).toMatchObject({ first: true, second: false });
  });

  it('a global limit on the picked model meets that model\'s calls in every service but agent runs', async () => {
    const option = await pick('global', 'resource', 'alpha', 'Alpha chat');
    expect(option.value).toBe('chat-alpha');
    await saveLimit('global', 'resource', option);
    expect(await twoCalls(contextFor('llm', { resourceKey: 'chat-alpha' }))).toMatchObject({ first: true, second: false });
    expect(await twoCalls(contextFor('embedding', { resourceKey: 'chat-alpha' }))).toMatchObject({ first: true, second: false });
    expect(await twoCalls(contextFor('agent', { resourceKey: 'chat-alpha' }))).toMatchObject({ second: true });
  });

  // ── what the pickers offer ───────────────────────────────────────────────

  it('offers only the models of the service\'s category', async () => {
    for (const [domain, key] of [['embedding', 'embed-alpha'], ['image', 'image-alpha'], ['decision', 'decide-alpha']] as const) {
      const result = await searchTargetOptions(quotaTargetSource(domain, 'resource')!, '', fetcher);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.options.map((o) => o.value), domain).toEqual([key]);
    }
    const chat = await searchTargetOptions(quotaTargetSource('llm', 'resource')!, '', fetcher);
    if (chat.status === 'ok') expect(chat.options.map((o) => o.value).sort()).toEqual(['chat-alpha', 'chat-beta']);
  });

  it('offers vector and file providers for a global limit, never a model provider', async () => {
    const result = await searchTargetOptions(quotaTargetSource('global', 'provider')!, '', fetcher);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.options.map((o) => o.value).sort()).toEqual(['file-prov', 'vec-prov']);
  });

  // ── providers ────────────────────────────────────────────────────────────

  it('vector provider: the picked provider KEY is what vector calls report', async () => {
    const option = await pick('vector', 'provider', 'vector', 'Vector provider alpha');
    expect(option.value).toBe('vec-prov');
    await saveLimit('vector', 'provider', option);
    expect(await twoCalls(contextFor('vector', { providerKey: 'other-prov', resourceKey: 'kb-alpha' }))).toMatchObject({ second: true });
    expect(await twoCalls(contextFor('vector', { providerKey: 'vec-prov', resourceKey: 'kb-alpha' }))).toMatchObject({ first: true, second: false });
  });

  it('file provider: the picked provider KEY is what dashboard uploads report', async () => {
    const option = await pick('file', 'provider', 'file', 'File provider alpha');
    expect(option.value).toBe('file-prov');
    await saveLimit('file', 'provider', option);
    expect(await twoCalls(contextFor('file', { providerKey: 'file-prov', resourceKey: 'bucket-alpha' }))).toMatchObject({ first: true, second: false });
  });

  it('global provider limit meets vector calls through the picked provider key', async () => {
    const option = await pick('global', 'provider', 'vector', 'Vector provider alpha');
    await saveLimit('global', 'provider', option);
    expect(await twoCalls(contextFor('vector', { providerKey: 'vec-prov', resourceKey: 'kb-alpha' }))).toMatchObject({ first: true, second: false });
  });

  // ── the real client routes ───────────────────────────────────────────────

  const clientPost = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer tok-main', 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

  it('chat/completions: a limit on the picked model answers 429 on the second call, another model is untouched', async () => {
    const option = await pick('llm', 'resource', 'alpha', 'Alpha chat');
    expect(option.value).toBe('chat-alpha');
    await saveLimit('llm', 'resource', option);
    // the caller names the model by its key, which is what `model` carries
    const body = { model: 'chat-alpha', messages: [{ role: 'user', content: 'hi' }] };
    const first = await clientPost('/api/client/v1/chat/completions', body);
    expect(first.statusCode, first.body).not.toBe(429);
    const second = await clientPost('/api/client/v1/chat/completions', body);
    expect(second.statusCode, second.body).toBe(429);
    const other = await clientPost('/api/client/v1/chat/completions', { ...body, model: 'chat-beta' });
    expect(other.statusCode, other.body).not.toBe(429);
  });

  it('chat/completions: a global limit on the picked model applies to the same route', async () => {
    const option = await pick('global', 'resource', 'alpha', 'Alpha chat');
    expect(option.value).toBe('chat-alpha');
    await saveLimit('global', 'resource', option);
    const body = { model: 'chat-alpha', messages: [{ role: 'user', content: 'hi' }] };
    expect((await clientPost('/api/client/v1/chat/completions', body)).statusCode).not.toBe(429);
    expect((await clientPost('/api/client/v1/chat/completions', body)).statusCode).toBe(429);
  });

  it('vector query: a limit on the picked index KEY answers 429 on the second call', async () => {
    const option = await pick('vector', 'resource', 'knowledge', 'Knowledge alpha');
    expect(option.value).toBe('kb-alpha');
    await saveLimit('vector', 'resource', option);
    // the URL segment is called externalId, and it carries the index KEY (not the provider's own id for it)
    const url = '/api/client/v1/vector/providers/vec-prov/indexes/kb-alpha/query';
    const query = { query: { vector: [0, 0, 1], topK: 1 } };
    expect((await clientPost(url, query)).statusCode).not.toBe(429);
    const second = await clientPost(url, query);
    expect(second.statusCode, second.body).toBe(429);
  });

  it('vector query: a limit on the picked provider KEY answers 429 on the second call', async () => {
    const option = await pick('vector', 'provider', 'vector', 'Vector provider alpha');
    expect(option.value).toBe('vec-prov');
    await saveLimit('vector', 'provider', option);
    const url = '/api/client/v1/vector/providers/vec-prov/indexes/kb-alpha/query';
    const query = { query: { vector: [0, 0, 1], topK: 1 } };
    expect((await clientPost(url, query)).statusCode).not.toBe(429);
    const second = await clientPost(url, query);
    expect(second.statusCode, second.body).toBe(429);
  });

  it('file upload through the API: a limit on the picked bucket KEY is enforced', async () => {
    const bucket = await pick('file', 'resource', 'bucket', 'Bucket alpha');
    expect(bucket.value).toBe('bucket-alpha');
    await saveLimit('file', 'resource', bucket);
    const upload = () =>
      clientPost('/api/client/v1/files/buckets/bucket-alpha/objects', { fileName: 'a.txt', data: Buffer.from('hello').toString('base64') });
    // the storage behind the stub bucket is not reachable here, so the calls that pass the guard fail later, never with 429
    const statuses = [(await upload()).statusCode, (await upload()).statusCode, (await upload()).statusCode];
    expect(statuses[0]).not.toBe(429);
    expect(statuses.slice(1)).toContain(429);
  });

  it('file upload through the API reports no provider, so a FILE PROVIDER limit reaches dashboard uploads only', async () => {
    // Documents the current contract the editor can not see: the client route puts the bucket key in the
    // quota context but not the bucket's provider (the dashboard route puts both).
    const provider = await pick('file', 'provider', 'file', 'File provider alpha');
    await saveLimit('file', 'provider', provider);
    const upload = () =>
      clientPost('/api/client/v1/files/buckets/bucket-alpha/objects', { fileName: 'a.txt', data: Buffer.from('hello').toString('base64') });
    for (let call = 0; call < 3; call += 1) expect((await upload()).statusCode).not.toBe(429);
  });

  it('tracing: a limit on the picked agent NAME is enforced on the stream start, the agent KEY is not limited', async () => {
    const option = await pick('tracing', 'resource', 'alpha', 'Agent Alpha Name');
    expect(option.value).toBe('Agent Alpha Name');
    await saveLimit('tracing', 'resource', option);
    const start = (sessionId: string, agentName: string) =>
      clientPost(`/api/client/v1/tracing/sessions/stream/${sessionId}/start`, {
        sessionId, agent: { name: agentName }, startedAt: new Date().toISOString(),
      });
    expect((await start('s1', 'agent-alpha-k1')).statusCode).not.toBe(429);
    expect((await start('s2', 'agent-alpha-k1')).statusCode).not.toBe(429);
    // an SDK client reports the agent's NAME
    expect((await start('s3', 'Agent Alpha Name')).statusCode).not.toBe(429);
    const second = await start('s4', 'Agent Alpha Name');
    expect(second.statusCode, second.body).toBe(429);
  });

  it('is written for every service there is', () => {
    expect([...RESOURCE_SERVICES.map((s) => s.domain), 'global'].sort()).toEqual([...QUOTA_DOMAINS].sort());
  });
});
