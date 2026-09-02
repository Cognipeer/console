/**
 * Fix 3 / #9, #10 — THE AGENT ROUTES, dashboard and client API.
 *
 *   #9  A CONNECTED (external) agent keeps its guardrail bindings through
 *       `normalizeAgentConfig` on create and update, and they are validated
 *       exactly like a native agent's — so the external enforcement branch in
 *       `agentService` is reachable from a stored config.
 *   #10 A guardrail refusal answers 400 with the inference routes'
 *       `guardrail_block` envelope, not 500 `Internal server error`.
 *
 * The agent service is mocked at the module boundary (the routes are what is
 * under test); `prepareConnectionForStorage` and the binding validator are
 * real, with the guardrail record reader stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MockAgentGuardrailBlockedError = vi.hoisted(() => {
  class AgentGuardrailBlockedError extends Error {
    readonly guardrailKey: string | undefined;
    readonly reason: string;
    readonly hook: string | undefined;
    constructor(message: string, detail: { guardrailKey?: string; reason: string; hook?: string }) {
      super(message);
      this.name = 'AgentGuardrailBlockedError';
      this.guardrailKey = detail.guardrailKey;
      this.reason = detail.reason;
      this.hook = detail.hook;
    }
    get status(): number {
      return 400;
    }
  }
  return AgentGuardrailBlockedError;
});

const hoisted = vi.hoisted(() => ({
  createAgentRecord: vi.fn(),
  updateAgentRecord: vi.fn(),
  getAgentById: vi.fn(),
  getAgentByKey: vi.fn(),
  executePlaygroundChat: vi.fn(),
  executeAgentChat: vi.fn(),
  createConversation: vi.fn(),
  guardrailByKeyInScope: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  resolveProjectContext: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn().mockReturnValue('agents'),
  authorizeServiceRequest: vi.fn().mockReturnValue({ allowed: true, service: 'agents', required: 'write' }),
}));

vi.mock('@/lib/services/projects/projectContext', () => ({
  resolveProjectContext: hoisted.resolveProjectContext,
  ProjectContextError: class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: hoisted.requireApiTokenFromHeader };
});

// Every name the `@/lib/services/agents` barrel re-exports from the service,
// so the barrel links; only the ones the routes under test call are scripted.
vi.mock('@/lib/services/agents/agentService', () => ({
  AgentGuardrailBlockedError: MockAgentGuardrailBlockedError,
  createAgentRecord: hoisted.createAgentRecord,
  updateAgentRecord: hoisted.updateAgentRecord,
  deleteAgentRecord: vi.fn(),
  getAgentById: hoisted.getAgentById,
  getAgentByKey: hoisted.getAgentByKey,
  listAgents: vi.fn(),
  countAgents: vi.fn(),
  publishAgent: vi.fn(),
  getAgentVersion: vi.fn(),
  listAgentVersions: vi.fn(),
  resolveAgentConfig: vi.fn(),
  createConversation: hoisted.createConversation,
  getConversationById: vi.fn(),
  listConversations: vi.fn(),
  deleteConversation: vi.fn(),
  executeAgentChat: hoisted.executeAgentChat,
  executePlaygroundChat: hoisted.executePlaygroundChat,
}));

vi.mock('@/server/api/plugins/guardrails', () => ({
  guardrailByKeyInScope: hoisted.guardrailByKeyInScope,
  toGuardrailRecord: (view: unknown) => view,
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';

const DASHBOARD_HEADERS = {
  'x-license-type': 'ENTERPRISE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

const TOKEN_HEADERS = { authorization: 'Bearer tok_abc' };

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'ENTERPRISE' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
};

const CONNECTION = { protocol: 'openai-chat', url: 'https://partner.example/v1', model: 'gpt-4o-mini' };

/** A guardrail with a PII policy on input.pre, bound. */
const PII_VIEW = {
  id: 'gr-in',
  tenantId: 'tenant-1',
  key: 'gr-in',
  name: 'PII',
  type: 'custom',
  target: 'input',
  action: 'block',
  enabled: true,
  createdBy: 'user-1',
  hooksVersion: 1,
  hooks: {
    contractVersion: 2,
    policies: [{ id: 'p1', family: 'pii', enabled: true, hooks: ['input.pre'], schedule: { timing: 'sync', onFail: 'block' }, known: true }],
    bindings: { 'input.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } } },
  },
};

function storedExternalAgent(config: Record<string, unknown> = {}) {
  return {
    _id: 'agent-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'partner-agent',
    name: 'Partner',
    status: 'active',
    config: { kind: 'external', connection: CONNECTION, ...config },
    createdBy: 'user-1',
  };
}

let dashboard: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let client: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  const db = createMockDb();
  db.findUserById.mockResolvedValue({ _id: 'user-1', role: 'owner', tenantId: 'tenant-1' } as never);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  hoisted.resolveProjectContext.mockResolvedValue({
    projectId: 'proj-1',
    project: { _id: 'proj-1' },
    user: { _id: 'user-1', role: 'owner', projectIds: ['proj-1'] },
  });
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.guardrailByKeyInScope.mockImplementation(async (_db: string, key: string) => (key === 'gr-in' ? PII_VIEW : null));
  hoisted.createAgentRecord.mockImplementation(async (_db: string, _t: string, _p: string, _u: string, input: { config: unknown }) =>
    storedExternalAgent(input.config as Record<string, unknown>),
  );
  hoisted.updateAgentRecord.mockImplementation(async (_db: string, _id: string, body: { config?: unknown }) =>
    storedExternalAgent((body.config ?? {}) as Record<string, unknown>),
  );
  hoisted.getAgentById.mockResolvedValue(storedExternalAgent());
  hoisted.getAgentByKey.mockResolvedValue(storedExternalAgent());
  hoisted.createConversation.mockResolvedValue({ _id: 'conv-1' });

  dashboard = await createFastifyApiTestApp(agentsApiPlugin);
  client = await createFastifyApiTestApp(clientAgentsApiPlugin);
});

afterEach(async () => {
  await dashboard.close();
  await client.close();
});

const EXTERNAL_WITH_BINDING = {
  kind: 'external',
  connection: CONNECTION,
  guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }],
};

describe('#9 connected agents keep their guardrail bindings (dashboard)', () => {
  it('create: stores the validated binding list and the projected legacy slot', async () => {
    const res = await dashboard.inject({
      method: 'POST',
      url: '/api/agents',
      headers: DASHBOARD_HEADERS,
      payload: { name: 'Partner', config: EXTERNAL_WITH_BINDING },
    });
    expect(res.statusCode).toBe(201);

    const [, , , , input] = hoisted.createAgentRecord.mock.calls[0] as [string, string, string, string, { config: Record<string, unknown> }];
    expect(input.config).toMatchObject({
      kind: 'external',
      guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }],
      inputGuardrailKey: 'gr-in',
    });
    expect(input.config.connection).toMatchObject({ protocol: 'openai-chat', url: CONNECTION.url });
  });

  it('create: 400s an unknown guardrail on a connected agent instead of saving it silently', async () => {
    const res = await dashboard.inject({
      method: 'POST',
      url: '/api/agents',
      headers: DASHBOARD_HEADERS,
      payload: { name: 'Partner', config: { ...EXTERNAL_WITH_BINDING, guardrails: [{ key: 'gr-nope' }] } },
    });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toContain('gr-nope');
    expect(hoisted.createAgentRecord).not.toHaveBeenCalled();
  });

  it('update: carries the binding list onto the rebuilt external config', async () => {
    const res = await dashboard.inject({
      method: 'PATCH',
      url: '/api/agents/agent-1',
      headers: DASHBOARD_HEADERS,
      payload: { config: EXTERNAL_WITH_BINDING },
    });
    expect(res.statusCode).toBe(200);

    const [, , body] = hoisted.updateAgentRecord.mock.calls[0] as [string, string, { config: Record<string, unknown> }];
    expect(body.config).toMatchObject({
      kind: 'external',
      guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }],
      inputGuardrailKey: 'gr-in',
    });
  });

  it('update: an external config without `guardrails` clears the binding (config replaces wholesale)', async () => {
    const res = await dashboard.inject({
      method: 'PATCH',
      url: '/api/agents/agent-1',
      headers: DASHBOARD_HEADERS,
      payload: { config: { kind: 'external', connection: CONNECTION } },
    });
    expect(res.statusCode).toBe(200);
    const [, , body] = hoisted.updateAgentRecord.mock.calls[0] as [string, string, { config: Record<string, unknown> }];
    expect(body.config).not.toHaveProperty('guardrails');
  });
});

describe('#9 connected agents keep their guardrail bindings (client API)', () => {
  it('create: stores the validated binding list', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/agents',
      headers: TOKEN_HEADERS,
      payload: { name: 'Partner', config: EXTERNAL_WITH_BINDING },
    });
    expect(res.statusCode).toBe(201);
    const [, , , , input] = hoisted.createAgentRecord.mock.calls[0] as [string, string, string, string, { config: Record<string, unknown> }];
    expect(input.config).toMatchObject({ kind: 'external', guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }] });
  });

  it('update: carries the binding list, and 400s an unknown key', async () => {
    const ok = await client.inject({
      method: 'PATCH',
      url: '/api/client/v1/agents/partner-agent',
      headers: TOKEN_HEADERS,
      payload: { config: EXTERNAL_WITH_BINDING },
    });
    expect(ok.statusCode).toBe(200);
    const [, , body] = hoisted.updateAgentRecord.mock.calls[0] as [string, string, { config: Record<string, unknown> }];
    expect(body.config).toMatchObject({ guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }], inputGuardrailKey: 'gr-in' });

    const bad = await client.inject({
      method: 'PATCH',
      url: '/api/client/v1/agents/partner-agent',
      headers: TOKEN_HEADERS,
      payload: { config: { ...EXTERNAL_WITH_BINDING, guardrails: [{ key: 'gr-nope' }] } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('#10 a guardrail block is a 4xx policy answer, not a 500', () => {
  const blocked = () =>
    new MockAgentGuardrailBlockedError('Agent response blocked by guardrail: This looks like personal information.', {
      guardrailKey: 'gr-in',
      reason: 'This looks like personal information.',
      hook: 'prompt.pre',
    });

  it('dashboard playground chat', async () => {
    hoisted.executePlaygroundChat.mockRejectedValue(blocked());
    const res = await dashboard.inject({
      method: 'POST',
      url: '/api/agents/agent-1/chat',
      headers: DASHBOARD_HEADERS,
      payload: { message: 'my email is a@corp.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toEqual({
      type: 'guardrail_block',
      action: 'block',
      message: 'Agent response blocked by guardrail: This looks like personal information.',
      reason: 'This looks like personal information.',
      guardrail_key: 'gr-in',
      hook: 'prompt.pre',
    });
  });

  it('client API /responses', async () => {
    hoisted.executeAgentChat.mockRejectedValue(blocked());
    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'partner-agent', input: 'my email is a@corp.com' },
    });
    expect(res.statusCode).toBe(400);
    const body = parseJsonBody<{ error: Record<string, unknown> }>(res.body);
    expect(body.error.type).toBe('guardrail_block');
    expect(body.error.guardrail_key).toBe('gr-in');
    expect(body.error.reason).toBe('This looks like personal information.');
    expect(body.error).not.toHaveProperty('findings');
  });

  it('an unrelated failure is still a 500 on the client API', async () => {
    hoisted.executeAgentChat.mockRejectedValue(new Error('upstream exploded'));
    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'partner-agent', input: 'hi' },
    });
    expect(res.statusCode).toBe(500);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Internal server error');
  });
});
