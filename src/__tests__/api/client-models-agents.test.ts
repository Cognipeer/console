/**
 * `GET /client/v1/models` lists the project's models AND its active agents (`agent:<key>`) to a caller who may
 * read the agents service, and only the models to one who may not; a caller who reads agents but not models is
 * admitted and sees only the agents. `GET /client/v1/models/agent:<key>` retrieves one under the same condition,
 * a model needs `models` (§5.5). The REAL routes, gate and policy engine over a real SQLite provider; only
 * the token's own authentication is stood in for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
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

import type { FastifyInstance } from 'fastify';
import type { IUser } from '@/lib/database';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { reloadConfig } from '@/lib/core/config';
import { clearServiceAvailabilityMemo } from '@/lib/services/availability/serviceAvailability';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { clientModelsApiPlugin } from '@/server/api/plugins/client-models';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let env: IamTestDb;
let app: FastifyInstance;
let projectId: string;

const token = (name: string, owner: IUser, scope: Record<string, string>) => hoisted.tokens.set(name, {
  token: name,
  tokenRecord: { _id: name, userId: String(owner._id), servicePermissions: scope, projectId },
  tenant: { licenseType: 'FREE' },
  tenantId: env.tenantId,
  tenantSlug: 'models-agents',
  tenantDbName: env.tenantDbName,
  projectId,
  user: owner,
});

const get = async (url: string, tok: string) => {
  const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${tok}` } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, body: parseJsonBody<any>(res.body) };
};

beforeAll(async () => {
  env = await createIamTestDb('tenant_models_agents');
  hoisted.getDatabase.mockImplementation(async () => env.db);
  const user = (await env.db.createUser({
    tenantId: env.tenantId, email: 'dev@x.io', name: 'Dev', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [],
  })) as IUser;
  projectId = String((await env.db.createProject({ tenantId: env.tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  const otherProjectId = String((await env.db.createProject({ tenantId: env.tenantId, key: 'other', name: 'Other', createdBy: 'x' }))._id);
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(user._id), projectId, role: 'member' });
  await env.db.createModel({
    tenantId: env.tenantId, projectId, name: 'Alpha chat', key: 'chat-alpha', providerKey: 'mock-llm', providerDriver: 'openai-compatible',
    category: 'llm', modelId: 'chat-alpha', settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 }, createdBy: 'seed',
  } as never);
  const agent = (key: string, name: string, extra: Record<string, unknown> = {}) => env.db.createAgent({
    tenantId: env.tenantId, projectId, key, name, config: { modelKey: 'chat-alpha' }, status: 'active', createdBy: 'x', ...extra,
  } as never);
  await agent('support', 'Support', { description: 'Answers customer questions' });
  await agent('retired', 'Retired', { status: 'inactive' });
  await env.db.createAgent({
    tenantId: env.tenantId, projectId: otherProjectId, key: 'elsewhere', name: 'Elsewhere', config: { modelKey: 'chat-alpha' }, status: 'active', createdBy: 'x',
  } as never);
  token('tok-both', user, { models: 'read', agents: 'read' });
  token('tok-models', user, { models: 'read' });
  token('tok-agents', user, { agents: 'read' });
  token('tok-none', user, { prompts: 'read' });

  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientModelsApiPlugin);
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await drainPendingTasks();
  await env?.cleanup();
});

beforeEach(() => {
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
});

describe('GET /client/v1/models', () => {
  it('lists the project\'s models and its active agents to a caller who may read agents', async () => {
    const res = await get('/client/v1/models', 'tok-both');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.object).toBe('list');
    expect(res.body.data.map((entry: { id: string }) => entry.id)).toEqual(['chat-alpha', 'agent:support']);
    expect(res.body.data[1]).toEqual({
      id: 'agent:support',
      object: 'model',
      created: expect.any(Number),
      owned_by: 'cognipeer-agent',
      name: 'Support',
      description: 'Answers customer questions',
      cognipeer: { kind: 'agent', key: 'support' },
    });
    // the console's own `models` list stays models only
    expect(res.body.models.map((model: { key: string }) => model.key)).toEqual(['chat-alpha']);
  });

  it('lists only the models to a caller who may not read agents (no refusal, the agents are just not there)', async () => {
    const res = await get('/client/v1/models', 'tok-models');
    expect(res.status).toBe(200);
    expect(res.body.data.map((entry: { id: string }) => entry.id)).toEqual(['chat-alpha']);
  });

  it('lists only the agents to a token that holds agents but not models (no models, no providers)', async () => {
    const res = await get('/client/v1/models?includeProviders=true', 'tok-agents');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.map((entry: { id: string }) => entry.id)).toEqual(['agent:support']);
    expect(res.body.models).toEqual([]);
    expect(res.body.providers).toBeUndefined();
  });

  it('is refused at the gate for a token that holds neither', async () => {
    expect((await get('/client/v1/models', 'tok-none')).status).toBe(403);
  });

  it('adds no agents when the query narrows to a category other than llm, or to a provider', async () => {
    for (const query of ['category=embedding', 'providerKey=mock-llm', 'providerDriver=openai-compatible']) {
      const res = await get(`/client/v1/models?${query}`, 'tok-both');
      expect(res.status, query).toBe(200);
      expect(res.body.data.some((entry: { id: string }) => entry.id.startsWith('agent:')), query).toBe(false);
    }
    const llm = await get('/client/v1/models?category=llm', 'tok-both');
    expect(llm.body.data.map((entry: { id: string }) => entry.id)).toContain('agent:support');
  });
});

describe('GET /client/v1/models/agent:<key>', () => {
  it('retrieves an active agent of the project, also with a token that holds agents but not models', async () => {
    for (const tok of ['tok-both', 'tok-agents']) {
      const res = await get('/client/v1/models/agent:support', tok);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: 'agent:support', object: 'model', owned_by: 'cognipeer-agent', name: 'Support', cognipeer: { kind: 'agent', key: 'support' } });
    }
  });

  it('a model needs models: 403 for a token that holds only agents, 200 for one that holds models', async () => {
    const id = String((await env.db.findModelByKey('chat-alpha', projectId))!._id);
    expect((await get(`/client/v1/models/${id}`, 'tok-agents')).status).toBe(403);
    expect((await get(`/client/v1/models/${id}`, 'tok-models')).status).toBe(200);
    expect((await get(`/client/v1/models/${id}`, 'tok-none')).status).toBe(403);
  });

  it('is 404 for an agent that is not active, one of another project, an unknown key, and for a caller who may not read agents', async () => {
    expect((await get('/client/v1/models/agent:retired', 'tok-both')).status).toBe(404);
    expect((await get('/client/v1/models/agent:elsewhere', 'tok-both')).status).toBe(404);
    expect((await get('/client/v1/models/agent:nobody', 'tok-both')).status).toBe(404);
    expect((await get('/client/v1/models/agent:support', 'tok-models')).status).toBe(404);
  });
});

describe('with the agents service switched off (CONSOLE_DISABLED_SERVICES)', () => {
  beforeEach(() => {
    process.env.CONSOLE_DISABLED_SERVICES = 'agents';
    reloadConfig();
    clearServiceAvailabilityMemo();
  });
  afterEach(() => {
    delete process.env.CONSOLE_DISABLED_SERVICES;
    reloadConfig();
    clearServiceAvailabilityMemo();
  });

  it('the list answers with the models only, whichever service let the caller in', async () => {
    const both = await get('/client/v1/models', 'tok-both');
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect(both.body.data.map((entry: { id: string }) => entry.id)).toEqual(['chat-alpha']);
    // let in on agents (models is on, so the gate passes the route): no agents, and no models it may not read
    const agentsOnly = await get('/client/v1/models', 'tok-agents');
    expect(agentsOnly.status, JSON.stringify(agentsOnly.body)).toBe(200);
    expect(agentsOnly.body.data).toEqual([]);
  });

  it('an agent is not found, a model is still served', async () => {
    expect((await get('/client/v1/models/agent:support', 'tok-both')).status).toBe(404);
    expect((await get('/client/v1/models/agent:support', 'tok-agents')).status).toBe(404);
    const id = String((await env.db.findModelByKey('chat-alpha', projectId))!._id);
    expect((await get(`/client/v1/models/${id}`, 'tok-both')).status).toBe(200);
  });
});
