/**
 * A published version freezes the agent's config, so the publish response (client API) is redacted
 * like the agent itself: no sealed sandbox secrets, no sealed callback secret, no encrypted key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getAgentByKey: vi.fn(),
  publishAgent: vi.fn(),
  validateAgentConfig: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: hoisted.getDatabase,
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await hoisted.getDatabase()),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status = 401;
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: hoisted.requireApiTokenFromHeader };
});
vi.mock('@/lib/services/agents/agentService', () => ({
  AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
  getAgentByKey: hoisted.getAgentByKey,
  publishAgent: hoisted.publishAgent,
  createAgentRecord: vi.fn(),
  updateAgentRecord: vi.fn(),
  deleteAgentRecord: vi.fn(),
  getAgentById: vi.fn(),
  listAgents: vi.fn(),
  countAgents: vi.fn(),
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
vi.mock('@/lib/services/agents/agentConfigValidation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/agentConfigValidation')>()),
  validateAgentConfig: hoisted.validateAgentConfig,
}));

import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createMockDb } from '../helpers/db.mock';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';

let client: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.getDatabase.mockResolvedValue(createMockDb());
  hoisted.requireApiTokenFromHeader.mockResolvedValue({
    token: 'tok_abc',
    tokenRecord: { _id: 'tok-1', userId: 'user-1' },
    tenant: { licenseType: 'ENTERPRISE' },
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
  });
  hoisted.getAgentByKey.mockResolvedValue({ _id: 'agent-1', projectId: 'proj-1', key: 'support-agent', status: 'active', config: { modelKey: 'gpt-4o' } });
  hoisted.validateAgentConfig.mockResolvedValue({ errors: [], warnings: [] });
  client = await createFastifyApiTestApp(clientAgentsApiPlugin);
});

afterEach(async () => {
  await client.close();
});

describe('POST /client/v1/agents/:agentKey/publish', () => {
  it('returns the new version without sealed secrets or the encrypted connection key', async () => {
    hoisted.publishAgent.mockResolvedValue({
      agentKey: 'support-agent',
      version: 3,
      snapshot: {
        name: 'Support',
        status: 'active',
        config: {
          modelKey: 'gpt-4o',
          sandbox: { enabled: true, secretsSealed: 'sealed-sandbox-blob' },
          callback: { url: 'https://hooks.example.com/a', secretSealed: 'sealed-callback-blob' },
          connection: { protocol: 'openai', url: 'https://agent.example.com', apiKeyEnc: 'sealed-key-blob' },
        },
      },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/agents/support-agent/publish',
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).not.toMatch(/sealed-(sandbox|callback|key)-blob|secretsSealed|secretSealed|apiKeyEnc/);
    const { version } = parseJsonBody<{ version: { version: number; snapshot: { config: Record<string, any> } } }>(res.body);
    expect(version.version).toBe(3);
    expect(version.snapshot.config.callback).toEqual({ url: 'https://hooks.example.com/a', secret: '••••••' });
    expect(version.snapshot.config.connection.hasApiKey).toBe(true);
  });
});
