/**
 * Sandbox secrets whose stored ciphertext cannot be opened (the encryption key changed), on the
 * dashboard and the client API alike:
 *
 *   reads    carry `config.sandbox.secretsUnreadable: true` (the secrets list is empty)
 *   a save   that mixes masked values with other values answers 409 `sandbox_secrets_unreadable`
 *            and stores nothing; masks only keep the ciphertext; no masks replace it
 *
 * The agent service and the config validator are faked at the module boundary; the sealing and the
 * masking are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  updateAgentRecord: vi.fn(),
  getAgentById: vi.fn(),
  getAgentByKey: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  resolveProjectContext: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
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
vi.mock('@/lib/services/agents/agentService', () => ({
  AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
  createAgentRecord: vi.fn(),
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
  createConversation: vi.fn(),
  getConversationById: vi.fn(),
  listConversations: vi.fn(),
  deleteConversation: vi.fn(),
  executeAgentChat: vi.fn(),
  executePlaygroundChat: vi.fn(),
}));
vi.mock('@/lib/services/agents/agentConfigValidation', () => ({
  validateAgentConfig: vi.fn(async () => ({ errors: [], warnings: [] })),
  invalidConfigBody: (validation: unknown) => ({ error: 'invalid', validation }),
}));
vi.mock('@/server/api/plugins/files-permission', () => ({
  requestCanNameBucket: vi.fn(async () => ({ allowed: true })),
  requestHasFilesRead: vi.fn(async () => true),
  requestBucketOptions: vi.fn(async () => []),
  FILES_READ_REQUIRED_MESSAGE: 'Listing the buckets needs read access to Files.',
  FILES_WRITE_REQUIRED_MESSAGE: 'Choosing where an agent keeps its files needs write access to that bucket in Files.',
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
import { AGENT_SANDBOX_SECRET_MASK as MASK, openAgentSandboxSecrets, sealAgentSandboxConfig } from '@/lib/services/agents/agentSandboxSecrets';

const DASHBOARD_HEADERS = {
  'x-license-type': 'ENTERPRISE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'user',
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
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};

const UNREADABLE = { enabled: true, secretsSealed: 'not-a-valid-ciphertext' };
const READABLE = sealAgentSandboxConfig({ enabled: true, secrets: { A: 'alpha-1' } }, undefined)!;

const storedAgent = (sandbox: object) => ({
  _id: 'agent-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'docs', name: 'Docs', status: 'active', createdBy: 'user-1',
  config: { modelKey: 'm', sandbox },
});
const withSecrets = (secrets: Record<string, string>) => ({ modelKey: 'm', sandbox: { enabled: true, secrets } });

let dashboard: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let client: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

function store(sandbox: object) {
  hoisted.getAgentById.mockResolvedValue(storedAgent(sandbox));
  hoisted.getAgentByKey.mockResolvedValue(storedAgent(sandbox));
}

beforeEach(async () => {
  vi.clearAllMocks();
  const db = createMockDb();
  db.findUserById.mockResolvedValue({ _id: 'user-1', role: 'user', tenantId: 'tenant-1' } as never);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  hoisted.resolveProjectContext.mockResolvedValue({
    projectId: 'proj-1', project: { _id: 'proj-1' }, user: { _id: 'user-1', role: 'user', projectIds: ['proj-1'] },
  });
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.updateAgentRecord.mockImplementation(async (_d: string, _id: string, body: { config?: unknown }) => ({ ...storedAgent({}), config: body.config }));
  store(UNREADABLE);
  dashboard = await createFastifyApiTestApp(agentsApiPlugin);
  client = await createFastifyApiTestApp(clientAgentsApiPlugin);
});

afterEach(async () => {
  await dashboard.close();
  await client.close();
});

const patchDashboard = (config: unknown) => dashboard.inject({ method: 'PATCH', url: '/api/agents/agent-1', headers: DASHBOARD_HEADERS, payload: { config } });
const patchClient = (config: unknown) => client.inject({ method: 'PATCH', url: '/api/client/v1/agents/docs', headers: TOKEN_HEADERS, payload: { config } });
type Body = { agent: { config: { sandbox: Record<string, unknown> } } };
const sandboxOf = (res: { body: string }) => parseJsonBody<Body>(res.body).agent.config.sandbox;

describe('reads of an agent whose stored sandbox secrets cannot be decrypted', () => {
  it('carry secretsUnreadable: true, with no secrets and no ciphertext (dashboard read and client write response)', async () => {
    const dash = await dashboard.inject({ method: 'GET', url: '/api/agents/agent-1', headers: DASHBOARD_HEADERS });
    expect(dash.statusCode).toBe(200);
    expect(sandboxOf(dash)).toEqual({ enabled: true, secretsUnreadable: true });

    // The client API returns the agent from its authoring calls (the GET is the run-time view and carries no sandbox).
    hoisted.updateAgentRecord.mockResolvedValueOnce(storedAgent(UNREADABLE));
    const api = await patchClient(withSecrets({ A: MASK }));
    expect(api.statusCode).toBe(200);
    expect(sandboxOf(api)).toEqual({ enabled: true, secretsUnreadable: true });
  });

  it('do not carry it when the secrets can be opened, or when there are none', async () => {
    store(READABLE);
    const readable = await dashboard.inject({ method: 'GET', url: '/api/agents/agent-1', headers: DASHBOARD_HEADERS });
    expect(sandboxOf(readable)).toEqual({ enabled: true, secrets: { A: MASK } });

    store({ enabled: true });
    const none = await dashboard.inject({ method: 'GET', url: '/api/agents/agent-1', headers: DASHBOARD_HEADERS });
    expect(sandboxOf(none)).toEqual({ enabled: true });
  });
});

describe.each([
  ['dashboard', patchDashboard],
  ['client API', patchClient],
])('%s: saving over secrets that cannot be decrypted', (_name, patch) => {
  it('masked values mixed with a new value or an emptied one: 409 sandbox_secrets_unreadable, nothing stored', async () => {
    for (const secrets of [{ A: MASK, B: 'fresh-value' }, { A: MASK, B: '' }]) {
      const res = await patch(withSecrets(secrets));
      expect(res.statusCode).toBe(409);
      expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
        code: 'sandbox_secrets_unreadable', type: 'sandbox_secrets_unreadable', field: 'config.sandbox.secrets', error: expect.stringContaining('cannot be decrypted'),
      });
    }
    expect(hoisted.updateAgentRecord).not.toHaveBeenCalled();
  });

  it('only masked values: accepted, the stored ciphertext is kept as it is', async () => {
    const res = await patch(withSecrets({ A: MASK, B: MASK }));
    expect(res.statusCode).toBe(200);
    expect(hoisted.updateAgentRecord).toHaveBeenCalledTimes(1);
  });

  it('no masked value (every value entered again): accepted, replaces them', async () => {
    const res = await patch(withSecrets({ A: 'fresh-value' }));
    expect(res.statusCode).toBe(200);
    expect(hoisted.updateAgentRecord).toHaveBeenCalledTimes(1);
  });

  it('a config without secrets (or with the read flag echoed back) is not a conflict', async () => {
    expect((await patch({ modelKey: 'm', sandbox: { enabled: true, secretsUnreadable: true } })).statusCode).toBe(200);
    expect((await patch({ modelKey: 'm' })).statusCode).toBe(200);
  });

  it('secrets that can be opened still merge masked values with new ones', async () => {
    store(READABLE);
    const res = await patch(withSecrets({ A: MASK, B: 'fresh-value' }));
    expect(res.statusCode).toBe(200);
  });
});

describe('what a save does to the stored secrets', () => {
  it('a mixed save of readable secrets keeps the masked one and adds the new one; the read flag is never stored', () => {
    const next = sealAgentSandboxConfig({ enabled: true, secrets: { A: MASK, B: 'fresh-value' }, secretsUnreadable: true }, READABLE)!;
    expect(openAgentSandboxSecrets(next)).toEqual({ A: 'alpha-1', B: 'fresh-value' });
    expect(next).not.toHaveProperty('secretsUnreadable');
  });
});
