/**
 * `/responses` and `/chat/completions` serve models AND agents (§5.8), at the REAL routes, the REAL gate and the REAL
 * policy engine over a real SQLite provider: a token holding either service gets in, and what `model` resolved to
 * decides what it needs - `agents` for an agent (`agent:<key>` before it is even looked up), `models` for a model.
 * Only the token's own authentication and the upstream model call are stood in for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
  handleChatCompletion: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
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
vi.mock('@/lib/services/models/inferenceService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/inferenceService')>()),
  handleChatCompletion: hoisted.handleChatCompletion,
}));

import type { FastifyInstance } from 'fastify';
import type { IUser } from '@/lib/database';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { clientAgentRunsApiPlugin } from '@/server/api/plugins/client-agent-runs';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';
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
  tenantSlug: 'targets',
  tenantDbName: env.tenantDbName,
  projectId,
  user: owner,
});

const call = async (method: 'GET' | 'POST', url: string, tok: string, body?: unknown) => {
  const res = await app.inject({
    method,
    url: `/api${url}`,
    headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, body: parseJsonBody<any>(res.body) };
};

const refusedFor = (res: { status: number; body: any }, service: 'agents' | 'models') => {
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(res.body.error).toMatchObject({
    type: 'permission_error', code: 'forbidden', message: `Forbidden: ${service} requires write permission`, decision_id: expect.any(String),
  });
};

beforeAll(async () => {
  env = await createIamTestDb('tenant_invocation_targets');
  hoisted.getDatabase.mockImplementation(async () => env.db);
  const user = (await env.db.createUser({
    tenantId: env.tenantId, email: 'dev@x.io', name: 'Dev', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [],
  })) as IUser;
  projectId = String((await env.db.createProject({ tenantId: env.tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(user._id), projectId, role: 'member' });
  await env.db.createAgent({ tenantId: env.tenantId, projectId, key: 'support', name: 'Support', config: { modelKey: 'chat-alpha' }, status: 'active', createdBy: 'x' } as never);
  await env.db.createModel({
    tenantId: env.tenantId, projectId, name: 'Alpha chat', key: 'chat-alpha', providerKey: 'mock-llm', providerDriver: 'openai-compatible',
    category: 'llm', modelId: 'chat-alpha', settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 }, createdBy: 'seed',
  } as never);
  token('tok-agents', user, { agents: 'write' });
  token('tok-models', user, { models: 'write' });
  token('tok-neither', user, { tracing: 'read' });

  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientAgentsApiPlugin);
    await instance.register(clientAgentRunsApiPlugin);
    await instance.register(clientInferenceApiPlugin);
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await drainPendingTasks();
  await env?.cleanup();
});

beforeEach(() => {
  hoisted.handleChatCompletion.mockReset().mockResolvedValue({
    requestId: 'req-1',
    response: { id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'chat-alpha', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] },
  });
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
});

describe('POST /client/v1/responses', () => {
  const respond = (tok: string, model: string, extra: Record<string, unknown> = {}) =>
    call('POST', '/client/v1/responses', tok, { model, input: 'hello', ...extra });

  it('runs an agent for a token that holds agents (and only agents)', async () => {
    // an invalid version is refused AFTER the target was authorized: the token got that far
    for (const model of ['agent:support', 'support']) {
      const res = await respond('tok-agents', model, { version: 'bogus' });
      expect(res.status, model).toBe(400);
      expect(res.body.error.code).toBe('invalid_version');
    }
  });

  it('needs agents for an agent target and models for a model target', async () => {
    refusedFor(await respond('tok-models', 'agent:support'), 'agents');
    refusedFor(await respond('tok-models', 'support'), 'agents');
    refusedFor(await respond('tok-agents', 'chat-alpha'), 'models');
    // a models token gets past the check to the model: one gateway call, answered as a Response object
    const ok = await respond('tok-models', 'chat-alpha');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ object: 'response', status: 'completed', model: 'chat-alpha', output_text: 'hi' });
    expect(hoisted.handleChatCompletion).toHaveBeenCalledTimes(1);
    expect(hoisted.handleChatCompletion.mock.calls[0][0]).toMatchObject({ modelKey: 'chat-alpha', route: 'responses' });
  });

  it('refuses a token with neither at the gate, and answers an unknown name with 404', async () => {
    refusedFor(await respond('tok-neither', 'agent:support'), 'models');
    const missing = await respond('tok-models', 'nothing-here');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('model_not_found');
  });
});

describe('GET/cancel /client/v1/responses/{id}', () => {
  it('a stored response is an agent run: an unknown id is 404 for any caller the gate admits', async () => {
    for (const tok of ['tok-models', 'tok-agents']) {
      const res = await call('GET', '/client/v1/responses/resp_000000000000000000000000', tok);
      expect(res.status, tok).toBe(404);
      expect(res.body.error.code).toBe('response_not_found');
    }
    refusedFor(await call('POST', '/client/v1/responses/resp_000000000000000000000000/cancel', 'tok-models'), 'agents');
  });
});

describe('POST /client/v1/chat/completions', () => {
  const complete = (tok: string, model: string) =>
    call('POST', '/client/v1/chat/completions', tok, { model, messages: [{ role: 'user', content: 'hello' }] });

  it('a model needs models', async () => {
    const ok = await complete('tok-models', 'chat-alpha');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(hoisted.handleChatCompletion).toHaveBeenCalledTimes(1);
    refusedFor(await complete('tok-agents', 'chat-alpha'), 'models');
    expect(hoisted.handleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('an agent needs agents: `agent:<key>` before it is looked up, a bare key once it resolved to one', async () => {
    refusedFor(await complete('tok-models', 'agent:support'), 'agents');
    refusedFor(await complete('tok-models', 'support'), 'agents');
    const missing = await complete('tok-agents', 'agent:nobody');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('model_not_found');
    refusedFor(await complete('tok-neither', 'chat-alpha'), 'models');
    expect(hoisted.handleChatCompletion).not.toHaveBeenCalled();
  });
});
