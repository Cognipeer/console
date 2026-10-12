/**
 * Picking the bucket an agent keeps its session files in is a Files decision about THAT bucket:
 * saving `attachments.bucketKey` (create, or a change on update) needs `file-bucket.update` on it,
 * the bucket picker needs read access to Files and lists the buckets the caller may look at, and
 * re-saving the bucket already stored (any other edit of the agent) asks nothing of Files - on the
 * dashboard and on the client API alike. (The real policy-engine questions are
 * unit/agent-bucket-authz.test.ts; the routes and the wiring are what is under test here.)
 *
 * The agent service and the config validator are faked at the module boundary; the permission
 * lookups are scripted per test.
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
  validateAgentConfig: vi.fn(async () => ({ errors: [], warnings: [] })),
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
  hoisted.canName.mockResolvedValue({ allowed: false, decisionId: 'dec-1' });
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

const post = (config: unknown) => dashboard.inject({ method: 'POST', url: '/api/agents', headers: DASHBOARD_HEADERS, payload: { name: 'Docs', config } });
const patch = (config: unknown) => dashboard.inject({ method: 'PATCH', url: '/api/agents/agent-1', headers: DASHBOARD_HEADERS, payload: { config } });

describe('dashboard: choosing the bucket', () => {
  it('create: names a bucket only with write access to THAT bucket, else 403 with the reason and the decision', async () => {
    const refused = await post(files('docs'));
    expect(refused.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(refused.body)).toMatchObject({
      code: 'files_write_required', field: 'attachments.bucketKey', decisionId: 'dec-1', error: expect.stringContaining('write access to that bucket'),
    });
    expect(hoisted.createAgentRecord).not.toHaveBeenCalled();

    hoisted.canName.mockResolvedValue({ allowed: true });
    expect((await post(files('docs'))).statusCode).toBe(201);
    // asked about the bucket the config names, in the project it is saved in
    expect(hoisted.canName).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: 'tenant-1', projectId: 'proj-1' }), 'docs');
  });

  it('create: an agent that takes no files asks nothing of Files', async () => {
    expect((await post({ modelKey: 'm' })).statusCode).toBe(201);
    expect((await post({ modelKey: 'm', attachments: { enabled: false } })).statusCode).toBe(201);
    expect(hoisted.canName).not.toHaveBeenCalled();
  });

  it('update: changing the bucket needs write access to the new bucket; re-saving the same one does not', async () => {
    const changed = await patch(files('reports'));
    expect(changed.statusCode).toBe(403);
    expect(hoisted.updateAgentRecord).not.toHaveBeenCalled();

    // Any other edit keeps the stored bucket: a user without Files access can still save it.
    const same = await patch(files('docs', { maxFiles: 3 }));
    expect(same.statusCode).toBe(200);
    expect(hoisted.canName).toHaveBeenCalledTimes(1); // only the refused change asked
    expect(hoisted.canName).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'reports');

    hoisted.canName.mockResolvedValue({ allowed: true });
    expect((await patch(files('reports'))).statusCode).toBe(200);
  });

  it('update: switching files on for an agent that had none, with a bucket, is choosing one', async () => {
    hoisted.getAgentById.mockResolvedValue(storedAgent());
    expect((await patch(files('docs'))).statusCode).toBe(403);
  });

  it('update: clearing the bucket or turning files off asks nothing of Files', async () => {
    expect((await patch({ modelKey: 'm', attachments: { enabled: false } })).statusCode).toBe(200);
    expect((await patch({ modelKey: 'm' })).statusCode).toBe(200);
    expect(hoisted.canName).not.toHaveBeenCalled();
  });
});

describe('client API: choosing the bucket', () => {
  it('create and update: decided as the token\'s owner within its scope (the engine\'s principal), by bucket', async () => {
    const refused = await client.inject({ method: 'POST', url: '/api/client/v1/agents', headers: TOKEN_HEADERS, payload: { name: 'Docs', config: files('docs') } });
    expect(refused.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(refused.body)).toMatchObject({ code: 'files_write_required' });

    const changed = await client.inject({ method: 'PATCH', url: '/api/client/v1/agents/docs', headers: TOKEN_HEADERS, payload: { config: files('reports') } });
    expect(changed.statusCode).toBe(403);

    const same = await client.inject({ method: 'PATCH', url: '/api/client/v1/agents/docs', headers: TOKEN_HEADERS, payload: { config: files('docs', { retentionDays: 7 }) } });
    expect(same.statusCode).toBe(200);

    hoisted.canName.mockResolvedValue({ allowed: true });
    const allowed = await client.inject({ method: 'POST', url: '/api/client/v1/agents', headers: TOKEN_HEADERS, payload: { name: 'Docs', config: files('docs') } });
    expect(allowed.statusCode).toBe(201);
    expect(hoisted.canName).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: 'tenant-1', projectId: 'proj-1' }), 'docs');
  });

  it('an engine that cannot decide is a 503 with the decision (never an allow, never a 500)', async () => {
    hoisted.canName.mockRejectedValue(new RbacAuthorizationError('Authorization is temporarily unavailable', 503, { error: 'x', code: 'authorization_unavailable', decisionId: 'dec-503' }));
    const res = await client.inject({ method: 'POST', url: '/api/client/v1/agents', headers: TOKEN_HEADERS, payload: { name: 'Docs', config: files('docs') } });
    expect(res.statusCode).toBe(503);
    expect(parseJsonBody<{ error: { code: string; decision_id: string } }>(res.body).error).toMatchObject({ code: 'authorization_unavailable', decision_id: 'dec-503' });
    expect(hoisted.createAgentRecord).not.toHaveBeenCalled();
    const dash = await dashboard.inject({ method: 'POST', url: '/api/agents', headers: DASHBOARD_HEADERS, payload: { name: 'Docs', config: files('docs') } });
    expect(dash.statusCode).toBe(503);
    expect(hoisted.createAgentRecord).not.toHaveBeenCalled();
  });
});

describe('dashboard: the bucket picker', () => {
  it('lists the buckets the caller may look at, each marked with whether they may name it', async () => {
    hoisted.hasRead.mockResolvedValue(true);
    hoisted.bucketOptions.mockImplementation(async (_request: unknown, _projectId: string, options: Array<{ key: string }>) => (
      options.filter((o) => o.key !== 'secret-bucket').map((o) => ({ ...o, canChoose: false }))));
    hoisted.listBuckets.mockResolvedValue([{ key: 'docs', name: 'Docs' }, { key: 'secret-bucket', name: 'Secret' }]);
    const res = await dashboard.inject({ method: 'GET', url: '/api/agents/attachments/buckets', headers: DASHBOARD_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ buckets: unknown[] }>(res.body).buckets).toEqual([{ key: 'docs', name: 'Docs', canChoose: false }]);
    expect(hoisted.bucketOptions).toHaveBeenCalledWith(expect.anything(), 'proj-1', expect.any(Array));
  });

  it('is a 403 with a reason the Configure → Files section can show, without listing anything', async () => {
    const res = await dashboard.inject({ method: 'GET', url: '/api/agents/attachments/buckets', headers: DASHBOARD_HEADERS });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'files_read_required', error: expect.stringContaining('read access to Files') });
    expect(hoisted.listBuckets).not.toHaveBeenCalled();
  });
});
