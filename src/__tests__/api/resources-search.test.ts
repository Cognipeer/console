/**
 * GET /api/resources/search: the bounded type-ahead the quota and IAM pickers
 * use. Same registry snapshot, tenant guard and RBAC gate as the list; what is
 * new is several types per query, the attribute filter, best-match-first order
 * and the hard cap of SEARCH_MAX_LIMIT rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));

import { getDatabase, runWithTenantScope } from '@/lib/database';
import { resourcesApiPlugin } from '@/server/api/plugins/resources';
import { clearResourceCache, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from '@/lib/resources/service';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const baseHeaders = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'u-admin',
};
const adminHeaders = { ...baseHeaders, 'x-user-role': 'admin' };
const ownerHeaders = { ...baseHeaders, 'x-user-id': 'u-owner', 'x-user-role': 'owner' };
const userHeaders = { ...baseHeaders, 'x-user-id': 'u-user', 'x-user-role': 'user' };
const grantedHeaders = { ...baseHeaders, 'x-user-id': 'u-granted', 'x-user-role': 'user' };
const projectAdminHeaders = { ...baseHeaders, 'x-user-id': 'u-padmin', 'x-user-role': 'project_admin' };

const at = (day: number) => new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`);

const model = (id: string, key: string, name: string, category: string, projectId: string, day: number, extra: Record<string, unknown> = {}) => ({
  _id: id, tenantId: 'tenant-1', projectId, key, name, category, providerKey: 'openai-prod', providerDriver: 'openai',
  modelId: key, settings: { apiKey: 'MODEL-SECRET' }, replicas: [], createdBy: 'u-admin', updatedAt: at(day), ...extra,
});

const MODELS = [
  model('m-4o', 'gpt-4o', 'GPT-4o', 'llm', 'proj-1', 3),
  model('m-4o-mini', 'gpt-4o-mini', 'GPT-4o mini', 'llm', 'proj-1', 5),
  model('m-claude', 'claude-sonnet', 'Claude Sonnet', 'llm', 'proj-2', 4),
  model('m-embed', 'text-embedding-3', 'Embedding 3', 'embedding', 'proj-2', 2),
  model('m-stt', 'whisper', 'Whisper', 'stt', 'proj-1', 1),
];

const index = (id: string, key: string, providerKey: string, projectId: string, day: number) => ({
  _id: id, tenantId: 'tenant-1', projectId, providerKey, key, name: `Index ${key}`, externalId: `ext-${id}`,
  dimension: 1536, metric: 'cosine', metadata: { handOff: 'INDEX-SECRET' }, createdBy: 'u-admin', updatedAt: at(day),
});

const provider = (id: string, key: string, label: string, type: string, driver: string, projectIds: string[], day: number) => ({
  _id: id, tenantId: 'tenant-1', key, label, type, driver, status: 'active', projectIds,
  credentialsEnc: 'PROVIDER-SECRET', settings: { token: 'PROVIDER-SECRET' }, updatedAt: at(day),
});

/** One answer row, as far as these tests look at it. */
interface Row {
  type: string;
  id: string;
  key: string | null;
  name: string;
  projectId: string | null;
  projectName: string | null;
  projectDisplay: { kind: string; [field: string]: unknown };
  status: string | null;
  attributes: Array<{ key: string; value: unknown }>;
}

describe('GET /api/resources/search', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  const get = (url: string, headers: Record<string, string> = adminHeaders) => app.inject({ method: 'GET', url, headers });
  const search = async (qs: string, headers: Record<string, string> = adminHeaders) => {
    const res = await get(`/api/resources/search?${qs}`, headers);
    expect(res.statusCode, `${qs}: ${res.body}`).toBe(200);
    return parseJsonBody<{
      items: Row[];
      total: number;
      errors: Array<{ type: string; message: string }>;
      truncated: Array<{ type: string; limit: number }>;
    }>(res.body);
  };
  const keys = (body: { items: Row[] }) => body.items.map((i) => i.key);

  beforeEach(async () => {
    vi.clearAllMocks();
    clearResourceCache();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (runWithTenantScope as ReturnType<typeof vi.fn>).mockImplementation(
      async (_name: string, fn: (d: unknown) => unknown) => fn(db),
    );
    db.findUserById.mockImplementation((async (id: string) => {
      const users: Record<string, unknown> = {
        'u-admin': { _id: 'u-admin', role: 'admin', tenantId: 'tenant-1' },
        'u-owner': { _id: 'u-owner', role: 'owner', tenantId: 'tenant-1' },
        'u-user': { _id: 'u-user', role: 'user', tenantId: 'tenant-1' },
        'u-padmin': { _id: 'u-padmin', role: 'project_admin', tenantId: 'tenant-1' },
        'u-granted': { _id: 'u-granted', role: 'user', tenantId: 'tenant-1', servicePermissions: { resources: 'read' } },
        'u-admin-2': { _id: 'u-admin-2', role: 'admin', tenantId: 'tenant-2' },
      };
      return users[id] ?? null;
    }) as never);
    db.listGroupMembersByUser.mockResolvedValue([] as never);
    db.listProjects.mockResolvedValue([
      { _id: 'proj-1', name: 'Retail', tenantId: 'tenant-1' },
      { _id: 'proj-2', name: 'Wholesale', tenantId: 'tenant-1' },
    ] as never);
    db.listUsers.mockResolvedValue([] as never);
    db.listModels.mockResolvedValue(MODELS as never);
    db.listVectorIndexes.mockResolvedValue([
      index('vi-1', 'docs', 'pg-main', 'proj-1', 6),
      index('vi-2', 'docs', 'pg-other', 'proj-2', 7),
      index('vi-3', 'faq', 'pg-main', 'proj-1', 8),
    ] as never);
    db.listFileBuckets.mockResolvedValue([
      { _id: 'fb-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'uploads', name: 'Uploads', providerKey: 'disk', status: 'active', updatedAt: at(9) },
    ] as never);
    db.listProviders.mockResolvedValue([
      provider('p-pg', 'pg-main', 'Postgres main', 'vector', 'pgvector', ['proj-1'], 10),
      provider('p-pg2', 'pg-other', 'Postgres other', 'vector', 'pgvector', ['proj-2'], 11),
      provider('p-disk', 'disk', 'Local disk', 'file', 'local', ['proj-1', 'proj-2'], 12),
      provider('p-openai', 'openai-prod', 'OpenAI production', 'model', 'openai', ['proj-1'], 13),
    ] as never);
    db.listAgents.mockResolvedValue([
      { _id: 'ag-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'sales-ab12cd', name: 'Sales agent', status: 'active', config: { modelKey: 'gpt-4o' }, updatedAt: at(14) },
    ] as never);
    app = await createFastifyApiTestApp(resourcesApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('authorization (the same gate as the registry list)', () => {
    it.each([['admin', adminHeaders], ['owner', ownerHeaders]])('%s may search', async (_label, headers) => {
      expect((await get('/api/resources/search?types=model', headers)).statusCode).toBe(200);
    });

    it.each([['user', userHeaders], ['project_admin', projectAdminHeaders]])('role %s is refused by default', async (_label, headers) => {
      const res = await get('/api/resources/search?types=model', headers);
      expect(res.statusCode).toBe(403);
      // Nothing about the tenant leaks into the refusal.
      expect(res.body).not.toContain('gpt-4o');
    });

    it('a user with an explicit resources:read grant may search', async () => {
      expect((await get('/api/resources/search?types=model', grantedHeaders)).statusCode).toBe(200);
    });
  });

  describe('what it returns', () => {
    it('returns the picker shape: type, id, key, name, project and the safe display attributes', async () => {
      const body = await search('types=model&q=gpt-4o-mini');
      expect(body.items[0]).toEqual({
        type: 'model',
        id: 'm-4o-mini',
        key: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        projectId: 'proj-1',
        projectName: 'Retail',
        projectDisplay: { kind: 'project', projectId: 'proj-1', projectName: 'Retail' },
        status: null,
        attributes: expect.arrayContaining([
          { key: 'category', value: 'llm' },
          { key: 'providerKey', value: 'openai-prod' },
        ]),
      });
      expect(body.total).toBe(1);
      expect(body.errors).toEqual([]);
      expect(body.truncated).toEqual([]);
    });

    it('says which projects a provider is assigned to', async () => {
      const body = await search('types=provider&q=disk');
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        type: 'provider',
        key: 'disk',
        name: 'Local disk',
        projectDisplay: { kind: 'multi-project', projectIds: ['proj-1', 'proj-2'], projectNames: ['Retail', 'Wholesale'] },
        attributes: expect.arrayContaining([{ key: 'type', value: 'file' }, { key: 'driver', value: 'local' }]),
      });
    });

    it('never leaks a secret, an internal edge or an audit column', async () => {
      const bodies = [
        await get('/api/resources/search?types=model,vector-index,file-bucket,provider,agent'),
        await get('/api/resources/search?types=provider'),
        await get('/api/resources/search?types=vector-index&q=docs'),
      ];
      for (const res of bodies) {
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toMatch(/MODEL-SECRET|INDEX-SECRET|PROVIDER-SECRET|credentialsEnc|"edges"|"toType"|createdBy|"crn"|apiKey/);
      }
    });
  });

  describe('which rows', () => {
    it('searches several types together and keeps each row\'s own type', async () => {
      const body = await search('types=model,vector-index,file-bucket&limit=50');
      expect(new Set(body.items.map((i) => i.type))).toEqual(new Set(['model', 'vector-index', 'file-bucket']));
      expect(body.total).toBe(MODELS.length + 3 + 1);
    });

    it('accepts repeated types and attr parameters as well as comma lists', async () => {
      const commas = await search('types=model,provider&attr=category:llm,embedding');
      const repeated = await search('types=model&types=provider&attr=category:llm&attr=category:embedding');
      expect(keys(repeated)).toEqual(keys(commas));
      expect(keys(commas).sort()).toEqual(['claude-sonnet', 'gpt-4o', 'gpt-4o-mini', 'text-embedding-3']);
    });

    it('filters on a model category', async () => {
      expect(keys(await search('types=model&attr=category:llm')).sort()).toEqual(['claude-sonnet', 'gpt-4o', 'gpt-4o-mini']);
      expect(keys(await search('types=model&attr=category:embedding'))).toEqual(['text-embedding-3']);
      expect(keys(await search('types=model&attr=category:stt'))).toEqual(['whisper']);
      expect((await search('types=model&attr=category:ocr')).items).toEqual([]);
    });

    it('filters providers by their type, one or several', async () => {
      expect(keys(await search('types=provider&attr=type:vector')).sort()).toEqual(['pg-main', 'pg-other']);
      expect(keys(await search('types=provider&attr=type:file'))).toEqual(['disk']);
      expect(keys(await search('types=provider&attr=type:vector,file')).sort()).toEqual(['disk', 'pg-main', 'pg-other']);
    });

    it('requires EVERY attribute filter to match', async () => {
      expect(keys(await search('types=provider&attr=type:vector&attr=driver:pgvector')).sort()).toEqual(['pg-main', 'pg-other']);
      expect((await search('types=provider&attr=type:vector&attr=driver:local')).items).toEqual([]);
      // A record without the attribute never matches it.
      expect((await search('types=agent&attr=category:llm')).items).toEqual([]);
    });

    it('lets two rows share a key when they live in different projects', async () => {
      const docs = await search('types=vector-index&q=docs');
      expect(docs.items.map((i) => [i.key, i.projectId]).sort()).toEqual([['docs', 'proj-1'], ['docs', 'proj-2']]);
      expect(new Set(docs.items.map((i) => i.id)).size).toBe(2);
    });
  });

  describe('ordering', () => {
    it('puts an exact key first, then prefixes, then the rest by recency', async () => {
      const body = await search('types=model&q=gpt-4o');
      // gpt-4o is the exact key although gpt-4o-mini changed more recently.
      expect(keys(body)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    });

    it('matches names and keys case-insensitively, exact case first', async () => {
      expect(keys(await search('types=model&q=GPT-4O'))).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(keys(await search('types=model&q=claude'))).toEqual(['claude-sonnet']);
      expect(keys(await search('types=model&q=Sonnet'))).toEqual(['claude-sonnet']);
    });

    it('reads a query the way the browser encodes it', async () => {
      // URLSearchParams writes a space as "+" and ":" / "," as %3A / %2C: this is what the picker sends.
      const params = new URLSearchParams({ types: 'model,provider', q: '4o mini' });
      params.append('attr', 'category:llm');
      expect(params.toString()).toBe('types=model%2Cprovider&q=4o+mini&attr=category%3Allm');
      expect(keys(await search(params.toString()))).toEqual(['gpt-4o-mini']);
    });

    it('ranks a name or key hit above one in the id only', async () => {
      db.listModels.mockResolvedValue([
        model('whisper-id', 'other', 'Other model', 'stt', 'proj-1', 9),
        model('m-w', 'whisper', 'Whisper', 'stt', 'proj-1', 1),
      ] as never);
      clearResourceCache();
      expect(keys(await search('types=model&q=whisper'))).toEqual(['whisper', 'other']);
    });

    it('lists the most recently changed first when nothing was typed', async () => {
      expect(keys(await search('types=model'))).toEqual(['gpt-4o-mini', 'claude-sonnet', 'gpt-4o', 'text-embedding-3', 'whisper']);
    });
  });

  describe('bounds', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => model(`bulk-${i}`, `bulk-${i}`, `Bulk ${i}`, 'llm', 'proj-1', 1 + (i % 28)));

    beforeEach(() => {
      db.listModels.mockResolvedValue(many(120) as never);
      clearResourceCache();
    });

    it('answers a screenful by default and reports how many matched', async () => {
      const body = await search('types=model');
      expect(body.items).toHaveLength(SEARCH_DEFAULT_LIMIT);
      expect(body.total).toBe(120);
    });

    it('honours a smaller limit', async () => {
      expect((await search('types=model&limit=5')).items).toHaveLength(5);
    });

    it('never returns more than the cap, whatever limit is asked for', async () => {
      for (const limit of ['51', '200', '100000']) {
        const body = await search(`types=model&limit=${limit}`);
        expect(body.items, `limit=${limit}`).toHaveLength(SEARCH_MAX_LIMIT);
        expect(body.total).toBe(120);
      }
      expect(SEARCH_MAX_LIMIT).toBe(50);
    });

    it('clips a very long query instead of refusing or scanning with it', async () => {
      const res = await get(`/api/resources/search?types=model&q=${'x'.repeat(5000)}`);
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<{ items: unknown[] }>(res.body).items).toEqual([]);
    });

    it.each([
      'limit=0', 'limit=abc', 'limit=-1', 'limit=1.5',
    ])('returns 400 for %s', async (qs) => {
      expect((await get(`/api/resources/search?types=model&${qs}`)).statusCode).toBe(400);
    });

    it('refuses to search more than a handful of types at once', async () => {
      const types = ['agent', 'tool', 'model', 'provider', 'prompt', 'guardrail', 'rag-module', 'reranker', 'vector-index'];
      expect((await get(`/api/resources/search?types=${types.join(',')}`)).statusCode).toBe(400);
      expect((await get(`/api/resources/search?types=${types.slice(0, 8).join(',')}`)).statusCode).toBe(200);
    });

    it('refuses too many or too wide attribute filters', async () => {
      const attrs = ['a', 'b', 'c', 'd', 'e'].map((k) => `attr=${k}:x`).join('&');
      expect((await get(`/api/resources/search?types=model&${attrs}`)).statusCode).toBe(400);
      const values = Array.from({ length: 11 }, (_, i) => `v${i}`).join(',');
      expect((await get(`/api/resources/search?types=model&attr=category:${values}`)).statusCode).toBe(400);
    });
  });

  describe('bad input', () => {
    it.each([
      ['types is missing', ''],
      ['types is blank', 'types='],
      ['a type is unknown', 'types=model,not-a-type'],
      ['attr has no colon', 'types=model&attr=category'],
      ['attr has no name', 'types=model&attr=:llm'],
      ['attr has no value', 'types=model&attr=category:'],
      ['attr name is not a plain word', 'types=model&attr=bad%20name:x'],
      ['attr name tries the prototype', 'types=model&attr=__proto__:x'],
      ['attr name is too long', `types=model&attr=${'a'.repeat(41)}:x`],
    ])('returns 400 when %s', async (_why, qs) => {
      const res = await get(`/api/resources/search?${qs}`);
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toEqual(expect.any(String));
    });
  });

  describe('tenant isolation', () => {
    it('takes the tenant from the session, never from the query', async () => {
      const res = await get('/api/resources/search?types=model&tenantId=evil&tenantDbName=tenant_evil', adminHeaders);
      expect(res.statusCode).toBe(200);
      const scopes = (runWithTenantScope as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(scopes).toEqual(['tenant_acme']);
      expect(res.body).not.toContain('evil');
    });

    it('drops a row that claims another tenant', async () => {
      db.listModels.mockResolvedValue([...MODELS, model('m-x', 'stolen', 'Stolen', 'llm', 'proj-1', 20, { tenantId: 'tenant-2' })] as never);
      const body = await search('types=model&limit=50');
      expect(keys(body)).not.toContain('stolen');
      expect(body.total).toBe(MODELS.length);
    });

    it('refuses a person who claims a tenant they do not belong to', async () => {
      const res = await get('/api/resources/search?types=model', { ...adminHeaders, 'x-tenant-db-name': 'tenant_other', 'x-tenant-id': 'tenant-2' });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('gpt-4o');
    });

    it('keeps two tenants\' snapshots apart', async () => {
      await search('types=model');
      const other = { ...adminHeaders, 'x-user-id': 'u-admin-2', 'x-tenant-db-name': 'tenant_other', 'x-tenant-id': 'tenant-2' };
      db.listModels.mockResolvedValue([model('m-o', 'other-only', 'Other only', 'llm', 'proj-9', 1, { tenantId: 'tenant-2' })] as never);
      const body = await search('types=model', other);
      expect(keys(body)).toEqual(['other-only']);
      // ...and the first tenant still sees its own rows, from its own cached snapshot.
      expect(keys(await search('types=model&attr=category:stt'))).toEqual(['whisper']);
    });
  });

  describe('failure isolation', () => {
    it('reports a failing type among the searched ones, without its message', async () => {
      db.listModels.mockRejectedValue(new Error('password=hunter2'));
      const body = await search('types=model,vector-index');
      expect(body.errors).toEqual([{ type: 'model', message: expect.any(String) }]);
      expect(JSON.stringify(body)).not.toContain('hunter2');
      expect(body.items.every((i) => i.type === 'vector-index')).toBe(true);
    });

    it('says nothing about types that were not searched', async () => {
      db.listAgents.mockRejectedValue(new Error('boom'));
      expect((await search('types=model')).errors).toEqual([]);
    });

    it('reuses the cached snapshot between keystrokes', async () => {
      await search('types=model&q=g');
      await search('types=model&q=gp');
      await search('types=model&q=gpt');
      expect(db.listModels).toHaveBeenCalledTimes(1);
    });
  });
});
