/**
 * Config warnings (validation findings that do not stop a save) come back on the client API's
 * agent create and update exactly as the dashboard routes return them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createAgentRecord: vi.fn(),
  updateAgentRecord: vi.fn(),
  getAgentById: vi.fn(),
  getAgentByKey: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  resolveProjectContext: vi.fn(),
  canName: vi.fn(),
  hasRead: vi.fn(),
  bucketOptions: vi.fn(),
  listBuckets: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  // The gate reads the caller (and the engine its policies) through the tenant scope.
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
  createConversation: vi.fn(),
  getConversationById: vi.fn(),
  listConversations: vi.fn(),
  deleteConversation: vi.fn(),
  executeAgentChat: vi.fn(),
  executePlaygroundChat: vi.fn(),
}));
// The whole config validation (model, tools, bucket health) is its own subject; here it passes.
vi.mock('@/lib/services/agents/agentConfigValidation', () => ({
  validateAgentConfig: vi.fn(async () => ({ errors: [], warnings: [{ field: 'summarization', message: 'Summarization is configured but the agent has no tools.' }] })),
  invalidConfigBody: (validation: unknown) => ({ error: 'invalid', validation }),
}));
vi.mock('@/lib/services/agents/sessionFilesBucket', () => ({ listAttachmentBuckets: hoisted.listBuckets }));
vi.mock('@/server/api/plugins/files-permission', () => ({
  requestCanNameBucket: hoisted.canName,
  requestHasFilesRead: hoisted.hasRead,
  requestBucketOptions: hoisted.bucketOptions,
  FILES_READ_REQUIRED_MESSAGE: 'Listing the buckets needs read access to Files.',
  FILES_WRITE_REQUIRED_MESSAGE: 'Choosing where an agent keeps its files needs write access to that bucket in Files.',
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { RbacAuthorizationError } from '@/server/api/fastify-utils';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { agentSessionFilesApiPlugin } from '@/server/api/plugins/agent-session-files';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';

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

const storedAgent = (attachments?: Record<string, unknown>) => ({
  _id: 'agent-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'docs', name: 'Docs', status: 'active', createdBy: 'user-1',
  config: { modelKey: 'm', ...(attachments ? { attachments } : {}) },
});
const files = (bucketKey: string, extra: Record<string, unknown> = {}) => ({ modelKey: 'm', attachments: { enabled: true, bucketKey, ...extra } });

let dashboard: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let client: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  const db = createMockDb();
  db.findUserById.mockResolvedValue({ _id: 'user-1', role: 'user', tenantId: 'tenant-1' } as never);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  hoisted.resolveProjectContext.mockResolvedValue({
    projectId: 'proj-1', project: { _id: 'proj-1' }, user: { _id: 'user-1', role: 'user', projectIds: ['proj-1'] },
  });
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.createAgentRecord.mockImplementation(async (_d: string, _t: string, _p: string, _u: string, input: { config: unknown }) => ({ ...storedAgent(), config: input.config }));
  hoisted.updateAgentRecord.mockImplementation(async (_d: string, _id: string, body: { config?: unknown }) => ({ ...storedAgent(), config: body.config }));
  hoisted.getAgentById.mockResolvedValue(storedAgent({ enabled: true, bucketKey: 'docs' }));
  hoisted.getAgentByKey.mockResolvedValue(storedAgent({ enabled: true, bucketKey: 'docs' }));
  hoisted.canName.mockResolvedValue({ allowed: true });
  hoisted.hasRead.mockResolvedValue(false);
  hoisted.listBuckets.mockResolvedValue([{ key: 'docs', name: 'Docs' }]);
  hoisted.bucketOptions.mockImplementation(async (_request: unknown, _projectId: string, options: Array<Record<string, unknown>>) => options.map((o) => ({ ...o, canChoose: true })));

  dashboard = await createFastifyApiTestApp(async (instance) => {
    await instance.register(agentsApiPlugin);
    await instance.register(agentSessionFilesApiPlugin);
  });
  client = await createFastifyApiTestApp(clientAgentsApiPlugin);
});

afterEach(async () => {
  await dashboard.close();
  await client.close();
});

const WARNING = { field: 'summarization', message: 'Summarization is configured but the agent has no tools.' };

describe('agent config warnings', () => {
  it('dashboard and client API create return the same warnings', async () => {
    const config = { modelKey: 'm' };
    const dash = await dashboard.inject({ method: 'POST', url: '/api/agents', headers: DASHBOARD_HEADERS, payload: { name: 'Docs', config } });
    const cli = await client.inject({ method: 'POST', url: '/api/client/v1/agents', headers: TOKEN_HEADERS, payload: { name: 'Docs', config } });
    expect(dash.statusCode).toBe(201);
    expect(cli.statusCode).toBe(201);
    expect(parseJsonBody<{ warnings: unknown }>(dash.body).warnings).toEqual([WARNING]);
    expect(parseJsonBody<{ warnings: unknown }>(cli.body).warnings).toEqual([WARNING]);
  });

  it('client API update returns them too, an update without a config none', async () => {
    const withConfig = await client.inject({ method: 'PATCH', url: '/api/client/v1/agents/docs', headers: TOKEN_HEADERS, payload: { config: { modelKey: 'm' } } });
    expect(withConfig.statusCode).toBe(200);
    expect(parseJsonBody<{ warnings: unknown }>(withConfig.body).warnings).toEqual([WARNING]);
    const plain = await client.inject({ method: 'PATCH', url: '/api/client/v1/agents/docs', headers: TOKEN_HEADERS, payload: { description: 'x' } });
    expect(parseJsonBody<{ warnings: unknown }>(plain.body).warnings).toEqual([]);
  });
});
