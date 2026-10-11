/**
 * Session file routes — the dashboard's `/agents/:agentId/sessions/:sessionId/files`
 * and the client API's `/client/v1/agents/sessions/:conversationId/files`, the
 * chat bodies that name attachments, and the Responses `input_file` /
 * `input_image` parts. The service (limits, storage, assembly) is covered in
 * `integration/agent-session-files.test.ts`; faked here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});
vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    requireProjectContextForRequest: vi.fn(),
    sendProjectContextError: vi.fn().mockReturnValue(null),
  };
});
vi.mock('@/lib/database', async () => {
  const errors = await import('@/lib/database/provider/errors');
  return {
    getDatabase: vi.fn(),
    AgentRunConflictError: errors.AgentRunConflictError,
    AgentRunIdempotencyKeyTakenError: errors.AgentRunIdempotencyKeyTakenError,
  };
});
vi.mock('@/lib/services/agents', () => ({
  createAgentRecord: vi.fn(),
  createConversation: vi.fn(),
  deleteAgentRecord: vi.fn(),
  deleteConversation: vi.fn(),
  executePlaygroundChat: vi.fn(),
  getAgentById: vi.fn(),
  getAgentByKey: vi.fn(),
  getAgentVersion: vi.fn(),
  getConversationById: vi.fn(),
  listAgents: vi.fn(),
  listAgentVersions: vi.fn(),
  listConversations: vi.fn(),
  normalizeA2aMetadataUpdate: vi.fn(),
  prepareConnectionForStorage: vi.fn(),
  publishAgent: vi.fn(),
  updateAgentRecord: vi.fn(),
  runSyncAgentTurn: vi.fn(),
  createBackgroundAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  isBackgroundModeRequested: (header: string | null | undefined, body: Record<string, unknown> | undefined) =>
    header === 'true' || body?.background === true,
  agentRunConflictErrorBody: () => ({ error: 'conflict' }),
  agentSyncTimeoutErrorBody: () => ({ error: 'timeout' }),
  idempotencyKeyRequiresBackgroundErrorBody: () => ({ error: 'idem' }),
  idempotencyKeyConflictErrorBody: () => ({ error: 'idem' }),
  agentRunConcurrencyLimitErrorBody: () => ({ error: 'cap' }),
}));
vi.mock('@/lib/services/agents/agentService', () => ({
  executePlaygroundChatLocal: vi.fn(),
  executeAgentContinueLocal: vi.fn(),
  checkAgentModel: vi.fn(),
  AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));
vi.mock('@/lib/services/agents/agentActionResolution', () => ({
  resolveAgentPendingAction: vi.fn(),
  pendingActionsBlockingMessage: vi.fn(),
}));
vi.mock('@/lib/services/agents/agentSpendLimits', () => ({ assertQueuedTurnSpendAllowed: vi.fn() }));
vi.mock('@/lib/services/agents/agentAttachmentInfo', () => ({ describeAgentAttachments: vi.fn() }));
vi.mock('@/lib/services/agents/sessionBudgetService', () => ({ updateSessionBudget: vi.fn() }));
// Reading the bucket list needs read access to Files; granted here (the rule itself is covered in agent-files-bucket-permission.test.ts).
vi.mock('@/server/api/plugins/files-permission', () => ({
  sessionHasFilesPermission: vi.fn(async () => true),
  tokenHasFilesPermission: vi.fn(() => true),
  FILES_READ_REQUIRED_MESSAGE: 'read',
  FILES_WRITE_REQUIRED_MESSAGE: 'write',
}));
vi.mock('@/lib/services/agents/sessionFiles', async () => {
  const config = await import('@/lib/services/agents/sessionFilesConfig');
  return {
    ...config,
    uploadSessionFile: vi.fn(),
    listSessionFiles: vi.fn(),
    deleteSessionFile: vi.fn(),
    readSessionFileContent: vi.fn(),
  };
});
vi.mock('@/lib/services/agents/responseInputFiles', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/agents/responseInputFiles')>('@/lib/services/agents/responseInputFiles');
  return { ...actual, storeResponseInputFiles: vi.fn() };
});
vi.mock('@/lib/services/agents/agentRunService', () => ({
  apiErrorBody: (type: string, message: string, code = type, extra?: Record<string, unknown>) => ({ error: { type, message, code, ...extra } }),
  invalidRequestErrorBody: (message: string, code: string) => ({ error: { type: 'invalid_request_error', message, code } }),
  runWithTenantDb: vi.fn(),
  backgroundDisabledErrorBody: () => ({ error: { type: 'invalid_request_error', code: 'background_disabled' } }),
  isBackgroundModeRequested: (header: string | null | undefined, body: Record<string, unknown> | undefined) =>
    header === 'true' || body?.background === true,
  resolveAgentExecutionLimits: vi.fn(),
  queueAgentRunContinue: vi.fn(),
  serializeAgentRun: (run: { _id: string; status: string }) => ({ id: `run_${run._id}`, object: 'agent.run', status: run.status }),
  reserveConversationForSyncTurn: vi.fn(),
  getAgentRunStatus: vi.fn(),
  listAgentRuns: vi.fn(),
  requestAgentRunCancellation: vi.fn(),
  MAX_IDEMPOTENCY_KEY_LENGTH: 255,
  agentDefaultCallback: () => ({}),
  lookupIdempotentAgentRun: vi.fn(),
  validateCallbackRequest: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import {
  createConversation,
  createBackgroundAgentRun,
  getAgentById,
  getAgentByKey,
  getConversationById,
  runSyncAgentTurn,
} from '@/lib/services/agents';
import { executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { pendingActionsBlockingMessage } from '@/lib/services/agents/agentActionResolution';
import { deleteSessionFile, listSessionFiles, readSessionFileContent, uploadSessionFile } from '@/lib/services/agents/sessionFiles';
import { storeResponseInputFiles } from '@/lib/services/agents/responseInputFiles';
import { describeAgentAttachments } from '@/lib/services/agents/agentAttachmentInfo';
import { resolveAgentExecutionLimits, validateCallbackRequest } from '@/lib/services/agents/agentRunService';
import { AgentAttachmentError } from '@/lib/services/agents/agentErrors';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { agentSessionFilesApiPlugin } from '@/server/api/plugins/agent-session-files';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
import { reloadConfig } from '@/lib/core/config';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const SESSION_CTX = {
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'member', email: 'a@b.c' },
  userProject: { role: 'project_admin' },
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', licenseType: 'STARTER' },
};
// Files are off unless switched on with a bucket to keep them in.
const FILES_ON = { enabled: true, bucketKey: 'docs' };
const AGENT = { _id: 'agent-1', key: 'field-ops', name: 'Field Ops', status: 'active', projectId: 'proj-1', config: { modelKey: 'm', attachments: FILES_ON } };
const conversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1', tenantId: 'tenant-1', agentKey: 'field-ops', projectId: 'proj-1', messages: [], createdBy: 'user-1', metadata: { source: 'console' }, ...overrides,
});
const FILE = { id: 'f1', name: 'notes.txt', mimeType: 'text/plain', size: 5, conversionStatus: 'succeeded', bucketKey: 'docs', path: 'agent-sessions/field-ops/conv-1/notes-1.txt', createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-31T00:00:00Z') };

const DASH_URL = '/api/agents/agent-1/sessions/conv-1/files';
const CLIENT_URL = '/api/client/v1/agents/sessions/conv-1/files';
const dashHeaders = { authorization: 'Bearer t' };
const clientHeaders = { authorization: 'Bearer tok_abc' };
const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'admin', email: 'a@b.c', tenantId: 'tenant-1' },
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.FILE_UPLOAD_MAX_MB = '1';
  reloadConfig();
  mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
  mockFn(getAgentById).mockResolvedValue(AGENT);
  mockFn(getAgentByKey).mockResolvedValue({ ...AGENT, config: { modelKey: 'm', attachments: { ...FILES_ON, maxFiles: 3 } } });
  mockFn(getConversationById).mockResolvedValue(conversation());
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
  mockFn(getPermissionServiceForPath).mockReturnValue(null);
  mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true });
  // The client wrapper runs a request inside `runWithTenant`; a dashboard turn reserves the session's run slot.
  mockFn(getDatabase).mockResolvedValue({
    runWithTenant: <T>(_name: string, fn: () => T | Promise<T>) => fn(),
    createAgentRun: vi.fn(async () => ({ _id: 'res-1' })),
    deleteAgentRun: vi.fn(),
  });
  mockFn(uploadSessionFile).mockResolvedValue(FILE);
  mockFn(listSessionFiles).mockResolvedValue([FILE]);
  mockFn(deleteSessionFile).mockResolvedValue(true);
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(agentSessionFilesApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
  delete process.env.FILE_UPLOAD_MAX_MB;
  reloadConfig();
});

describe('dashboard: upload', () => {
  it('takes the file as the raw body (any mime type) with its name in ?name=', async () => {
    for (const type of ['text/plain', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv', 'image/png']) {
      mockFn(uploadSessionFile).mockClear();
      const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x00, 0xff]); // a BOM, a NUL, a byte that is not UTF-8
      const res = await app.inject({
        method: 'POST', url: `${DASH_URL}?name=${encodeURIComponent('Q1 report.bin')}`, headers: { ...dashHeaders, 'content-type': type }, payload: bytes,
      });

      expect(res.statusCode, type).toBe(201);
      expect(parseJsonBody<{ file: { id: string } }>(res.body).file.id).toBe('f1');
      const call = mockFn(uploadSessionFile).mock.calls[0]![0];
      expect(call.fileName).toBe('Q1 report.bin');
      expect(call.contentType).toBe(type);
      expect(Buffer.isBuffer(call.data)).toBe(true);
      expect(Buffer.compare(call.data, bytes)).toBe(0); // the bytes arrive exactly as sent
      expect(call).toMatchObject({
        scope: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' },
        agentConfig: AGENT.config,
        actor: { userId: 'user-1', licenseType: 'STARTER' },
      });
      expect(String(call.conversation._id)).toBe('conv-1');
    }
  });

  it('takes a small file as a JSON body with base64 data', async () => {
    const data = Buffer.from('hello').toString('base64');
    const res = await app.inject({
      method: 'POST', url: DASH_URL, headers: dashHeaders, payload: { name: 'hello.txt', contentType: 'text/plain', data },
    });
    expect(res.statusCode).toBe(201);
    expect(mockFn(uploadSessionFile).mock.calls[0]![0]).toMatchObject({ fileName: 'hello.txt', contentType: 'text/plain', data });
  });

  it('refuses a request that names no file or carries none', async () => {
    const noName = await app.inject({ method: 'POST', url: DASH_URL, headers: { ...dashHeaders, 'content-type': 'application/pdf' }, payload: Buffer.from('x') });
    expect(noName.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(noName.body).error).toContain('?name=');
    const noBody = await app.inject({ method: 'POST', url: `${DASH_URL}?name=a.pdf`, headers: { ...dashHeaders, 'content-type': 'application/pdf' } });
    expect(noBody.statusCode).toBe(400);
    const noData = await app.inject({ method: 'POST', url: DASH_URL, headers: dashHeaders, payload: { name: 'a.txt' } });
    expect(noData.statusCode).toBe(400);
    expect(uploadSessionFile).not.toHaveBeenCalled();
  });

  it('answers the service’s refusals with their own status and code', async () => {
    mockFn(uploadSessionFile).mockRejectedValue(new AgentAttachmentError(413, 'file_too_large', 'File exceeds the 1 MB limit of this agent.'));
    const res = await app.inject({ method: 'POST', url: `${DASH_URL}?name=a.pdf`, headers: { ...dashHeaders, 'content-type': 'application/pdf' }, payload: Buffer.from('x') });
    expect(res.statusCode).toBe(413);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'file_too_large', error: expect.stringContaining('1 MB') });
  });

  it('stops a body past the upload ceiling (FILE_UPLOAD_MAX_MB) before the service sees it', async () => {
    const res = await app.inject({
      method: 'POST', url: `${DASH_URL}?name=big.bin`, headers: { ...dashHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(res.statusCode).toBe(413);
    expect(uploadSessionFile).not.toHaveBeenCalled();
  });

  it('404s a session of another agent or project, and 409s a read-only (API) session', async () => {
    mockFn(getConversationById).mockResolvedValue(conversation({ agentKey: 'someone-else' }));
    let res = await app.inject({ method: 'POST', url: `${DASH_URL}?name=a.txt`, headers: { ...dashHeaders, 'content-type': 'text/plain' }, payload: 'x' });
    expect(res.statusCode).toBe(404);
    mockFn(getConversationById).mockResolvedValue(conversation({ projectId: 'proj-2' }));
    res = await app.inject({ method: 'POST', url: `${DASH_URL}?name=a.txt`, headers: { ...dashHeaders, 'content-type': 'text/plain' }, payload: 'x' });
    expect(res.statusCode).toBe(404);
    mockFn(getConversationById).mockResolvedValue(conversation({ metadata: { source: 'api' } }));
    res = await app.inject({ method: 'POST', url: `${DASH_URL}?name=a.txt`, headers: { ...dashHeaders, 'content-type': 'text/plain' }, payload: 'x' });
    expect(res.statusCode).toBe(409);
    expect(uploadSessionFile).not.toHaveBeenCalled();
  });
});

describe('dashboard: list and delete', () => {
  it('lists the session’s files', async () => {
    const res = await app.inject({ method: 'GET', url: DASH_URL, headers: dashHeaders });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ files: Array<{ id: string; name: string }> }>(res.body).files).toMatchObject([{ id: 'f1', name: 'notes.txt' }]);
    expect(listSessionFiles).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' }, 'conv-1');
  });

  it('deletes one file, and 404s a file that is not on this session', async () => {
    let res = await app.inject({ method: 'DELETE', url: `${DASH_URL}/f1`, headers: dashHeaders });
    expect(res.statusCode).toBe(200);
    expect(deleteSessionFile).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' }, 'conv-1', 'f1', 'user-1');
    mockFn(deleteSessionFile).mockResolvedValue(false);
    res = await app.inject({ method: 'DELETE', url: `${DASH_URL}/zzz`, headers: dashHeaders });
    expect(res.statusCode).toBe(404);
  });
});

const CONTENT = {
  data: Buffer.from('hello'), contentType: 'text/plain', disposition: 'attachment', size: 5,
  contentDisposition: 'attachment; filename="notes.txt"; filename*=UTF-8\'\'notes.txt',
};

describe('dashboard: file content', () => {
  it('serves the bytes with the type of the file, a sanitised disposition and the headers that make it safe from our origin', async () => {
    mockFn(readSessionFileContent).mockResolvedValue(CONTENT);
    const res = await app.inject({ method: 'GET', url: `${DASH_URL}/f1/content`, headers: dashHeaders });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello');
    expect(res.headers).toMatchObject({
      'content-type': 'text/plain',
      'content-length': '5',
      'content-disposition': CONTENT.contentDisposition,
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
    });
    expect(readSessionFileContent).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' }, 'conv-1', 'f1', {});
  });

  it('passes ?variant and ?disposition on, and refuses values it does not know', async () => {
    mockFn(readSessionFileContent).mockResolvedValue(CONTENT);
    await app.inject({ method: 'GET', url: `${DASH_URL}/f1/content?variant=markdown&disposition=inline`, headers: dashHeaders });
    expect(mockFn(readSessionFileContent).mock.calls[0]![3]).toEqual({ variant: 'markdown', disposition: 'inline' });
    mockFn(readSessionFileContent).mockClear();
    for (const bad of ['variant=text', 'disposition=download']) {
      const res = await app.inject({ method: 'GET', url: `${DASH_URL}/f1/content?${bad}`, headers: dashHeaders });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(readSessionFileContent).not.toHaveBeenCalled();
  });

  it('404s a file that is not on this session, answers a missing text version as 409, and checks the session first', async () => {
    mockFn(readSessionFileContent).mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: `${DASH_URL}/zzz/content`, headers: dashHeaders })).statusCode).toBe(404);
    mockFn(readSessionFileContent).mockRejectedValue(new AgentAttachmentError(409, 'markdown_unavailable', 'This file has no text version.'));
    const res = await app.inject({ method: 'GET', url: `${DASH_URL}/f1/content?variant=markdown`, headers: dashHeaders });
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'markdown_unavailable' });

    mockFn(readSessionFileContent).mockClear();
    mockFn(getConversationById).mockResolvedValue(conversation({ agentKey: 'someone-else' }));
    expect((await app.inject({ method: 'GET', url: `${DASH_URL}/f1/content`, headers: dashHeaders })).statusCode).toBe(404);
    // A session that came in over the API is readable (it is only read-only for uploads and deletes).
    mockFn(getConversationById).mockResolvedValue(conversation({ metadata: { source: 'api' } }));
    mockFn(readSessionFileContent).mockResolvedValue(CONTENT);
    expect((await app.inject({ method: 'GET', url: `${DASH_URL}/f1/content`, headers: dashHeaders })).statusCode).toBe(200);
  });
});

describe('client API: file content', () => {
  it('serves the same bytes and headers, in the token’s project only', async () => {
    mockFn(readSessionFileContent).mockResolvedValue(CONTENT);
    const res = await app.inject({ method: 'GET', url: `${CLIENT_URL}/f1/content`, headers: clientHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    expect(res.headers['content-disposition']).toBe(CONTENT.contentDisposition);
    expect(readSessionFileContent).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' }, 'conv-1', 'f1', {});

    mockFn(getConversationById).mockResolvedValue(conversation({ projectId: 'proj-2' }));
    expect((await app.inject({ method: 'GET', url: `${CLIENT_URL}/f1/content`, headers: clientHeaders })).statusCode).toBe(404);
  });

  it('answers a file that is not on the session as an error envelope, and bad query values as 400', async () => {
    mockFn(readSessionFileContent).mockResolvedValue(null);
    const missing = await app.inject({ method: 'GET', url: `${CLIENT_URL}/zzz/content`, headers: clientHeaders });
    expect(missing.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(missing.body).error.code).toBe('file_not_found');
    const bad = await app.inject({ method: 'GET', url: `${CLIENT_URL}/f1/content?variant=pdf`, headers: clientHeaders });
    expect(bad.statusCode).toBe(400);
  });
});

describe('client API: upload, list, delete', () => {
  it('uploads a raw body and answers the file resource in snake_case', async () => {
    const bytes = Buffer.from('%PDF-1.4 ...');
    const res = await app.inject({
      method: 'POST', url: `${CLIENT_URL}?name=contract.pdf`, headers: { ...clientHeaders, 'content-type': 'application/pdf' }, payload: bytes,
    });
    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toEqual({
      id: 'f1', object: 'agent.session.file', session_id: 'conv-1', name: 'notes.txt', mime_type: 'text/plain', size: 5,
      conversion_status: 'succeeded', bucket_key: 'docs', path: 'agent-sessions/field-ops/conv-1/notes-1.txt',
      created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-31T00:00:00.000Z',
      content_url: '/api/client/v1/agents/sessions/conv-1/files/f1/content',
    });
    const call = mockFn(uploadSessionFile).mock.calls[0]![0];
    expect(call).toMatchObject({
      fileName: 'contract.pdf', contentType: 'application/pdf',
      scope: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' },
      agentConfig: { attachments: { enabled: true, bucketKey: 'docs', maxFiles: 3 } },
      actor: { userId: 'user-1', licenseType: 'STARTER', tokenId: 'tok-1' },
    });
    expect(Buffer.compare(call.data, bytes)).toBe(0);
  });

  it('accepts the JSON base64 form too', async () => {
    const res = await app.inject({
      method: 'POST', url: CLIENT_URL, headers: clientHeaders, payload: { name: 'a.txt', contentType: 'text/plain', data: Buffer.from('a').toString('base64') },
    });
    expect(res.statusCode).toBe(201);
  });

  it('reads the JSON form in snake_case (content_type) as well as camelCase', async () => {
    const data = Buffer.from('a').toString('base64');
    const res = await app.inject({
      method: 'POST', url: CLIENT_URL, headers: clientHeaders, payload: { file_name: 'b.txt', content_type: 'text/plain', data },
    });
    expect(res.statusCode).toBe(201);
    expect(mockFn(uploadSessionFile).mock.calls.at(-1)![0]).toMatchObject({ fileName: 'b.txt', contentType: 'text/plain', data });
  });

  it('shapes refusals as API errors: bad request 400, limits at their own status', async () => {
    let res = await app.inject({ method: 'POST', url: CLIENT_URL, headers: { ...clientHeaders, 'content-type': 'application/pdf' }, payload: Buffer.from('x') });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('invalid_request_error');

    for (const [status, code, type] of [[413, 'file_too_large', 'invalid_request_error'], [415, 'unsupported_file_type', 'invalid_request_error'], [409, 'too_many_files', 'invalid_request_error'], [429, 'quota_exceeded', 'rate_limit_error'], [403, 'attachments_disabled', 'invalid_request_error']] as const) {
      mockFn(uploadSessionFile).mockRejectedValue(new AgentAttachmentError(status, code, 'refused'));
      res = await app.inject({ method: 'POST', url: `${CLIENT_URL}?name=a.txt`, headers: { ...clientHeaders, 'content-type': 'text/plain' }, payload: 'x' });
      expect(res.statusCode, code).toBe(status);
      expect(parseJsonBody<{ error: { code: string; type: string } }>(res.body).error).toMatchObject({ code, type });
    }
  });

  it('404s a session of another project (even with its id) and an unknown agent', async () => {
    mockFn(getConversationById).mockResolvedValue(conversation({ projectId: 'proj-2' }));
    const res = await app.inject({ method: 'GET', url: CLIENT_URL, headers: clientHeaders });
    expect(res.statusCode).toBe(404);
    expect(listSessionFiles).not.toHaveBeenCalled();
    mockFn(getConversationById).mockResolvedValue(conversation());
    mockFn(getAgentByKey).mockResolvedValue(null);
    const gone = await app.inject({ method: 'POST', url: `${CLIENT_URL}?name=a.txt`, headers: { ...clientHeaders, 'content-type': 'text/plain' }, payload: 'x' });
    expect(gone.statusCode).toBe(404);
  });

  it('lists and deletes', async () => {
    const list = await app.inject({ method: 'GET', url: CLIENT_URL, headers: clientHeaders });
    expect(parseJsonBody<{ object: string; data: Array<{ id: string }> }>(list.body)).toMatchObject({ object: 'list', data: [{ id: 'f1' }] });
    const del = await app.inject({ method: 'DELETE', url: `${CLIENT_URL}/f1`, headers: clientHeaders });
    expect(parseJsonBody<Record<string, unknown>>(del.body)).toEqual({ id: 'f1', object: 'agent.session.file', deleted: true });
    mockFn(deleteSessionFile).mockResolvedValue(false);
    expect((await app.inject({ method: 'DELETE', url: `${CLIENT_URL}/nope`, headers: clientHeaders })).statusCode).toBe(404);
  });
});

describe('dashboard chat bodies', () => {
  const chatApp = async () => createFastifyApiTestApp(agentsApiPlugin);
  beforeEach(() => {
    mockFn(pendingActionsBlockingMessage).mockResolvedValue(null);
    mockFn(executePlaygroundChatLocal).mockResolvedValue({ content: 'ok', steps: [], version: null });
  });

  it('hands the attachment ids to the turn', async () => {
    const chat = await chatApp();
    const res = await chat.inject({
      method: 'POST', url: '/api/agents/agent-1/chat/stream', headers: dashHeaders,
      payload: { message: 'read these', conversationId: 'conv-1', attachments: ['f1', 'f2'] },
    });
    expect(res.statusCode).toBe(200);
    expect(mockFn(executePlaygroundChatLocal).mock.calls[0]![0]).toMatchObject({ userMessage: 'read these', conversationId: 'conv-1', attachments: ['f1', 'f2'] });
    await chat.close();
  });

  it('a body without attachments is exactly what it was: no attachments key reaches the turn', async () => {
    const chat = await chatApp();
    await chat.inject({ method: 'POST', url: '/api/agents/agent-1/chat/stream', headers: dashHeaders, payload: { message: 'hi', conversationId: 'conv-1' } });
    expect(mockFn(executePlaygroundChatLocal).mock.calls[0]![0]).not.toHaveProperty('attachments');
    await chat.close();
  });

  it('refuses attachments that are not a list of ids', async () => {
    const chat = await chatApp();
    for (const attachments of ['f1', [1], [''], Array.from({ length: 101 }, (_, i) => `f${i}`)]) {
      const res = await chat.inject({ method: 'POST', url: '/api/agents/agent-1/chat', headers: dashHeaders, payload: { message: 'x', conversationId: 'conv-1', attachments } });
      expect(res.statusCode).toBe(400);
    }
    expect(executePlaygroundChatLocal).not.toHaveBeenCalled();
    await chat.close();
  });
});

describe('client Responses: input_file / input_image', () => {
  const responses = async () => createFastifyApiTestApp(clientAgentsApiPlugin);
  const syncOk = { kind: 'ok', response: { id: 'resp_conv-1', object: 'response', status: 'completed', output: [], _conversation_messages: [] } };

  beforeEach(() => {
    mockFn(getAgentByKey).mockResolvedValue({ ...AGENT, config: { modelKey: 'm', attachments: FILES_ON } });
    mockFn(createConversation).mockResolvedValue(conversation());
    mockFn(resolveAgentExecutionLimits).mockResolvedValue({ syncTimeoutMs: 60_000, backgroundEnabled: true, defaultMode: 'sync' });
    mockFn(runSyncAgentTurn).mockResolvedValue(syncOk);
    mockFn(storeResponseInputFiles).mockResolvedValue({ attachments: ['up1', 'up2'], named: [] });
  });

  const post = (app2: Awaited<ReturnType<typeof responses>>, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
    app2.inject({ method: 'POST', url: '/api/client/v1/agents/responses', headers: { ...clientHeaders, ...extraHeaders }, payload });

  it('is no longer dropped: the files are stored on the session and the turn attaches them', async () => {
    const r = await responses();
    const res = await post(r, {
      model: 'field-ops',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: 'compare' },
        { type: 'input_file', file_data: 'data:application/pdf;base64,QUJD', filename: 'a.pdf' },
        { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
      ] }],
    });

    expect(res.statusCode).toBe(200);
    expect(storeResponseInputFiles).toHaveBeenCalledWith(expect.objectContaining({
      files: [
        { kind: 'file', data: 'data:application/pdf;base64,QUJD', filename: 'a.pdf' },
        { kind: 'image', data: 'data:image/png;base64,QUJD' },
      ],
      actor: { userId: 'user-1', licenseType: 'STARTER', tokenId: 'tok-1' },
    }));
    expect(mockFn(runSyncAgentTurn).mock.calls[0]![0].request).toMatchObject({ userMessage: 'compare', attachments: ['up1', 'up2'], conversationId: 'conv-1' });
    await r.close();
  });

  it('a file alone, with no text, is a message', async () => {
    const r = await responses();
    const res = await post(r, { model: 'field-ops', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUJD' }] }] });
    expect(res.statusCode).toBe(200);
    expect(mockFn(runSyncAgentTurn).mock.calls[0]![0].request.userMessage).toBe('');
    await r.close();
  });

  it('a request without files is exactly what it was: nothing stored, no attachments on the turn', async () => {
    const r = await responses();
    await post(r, { model: 'field-ops', input: 'hello' });
    expect(storeResponseInputFiles).not.toHaveBeenCalled();
    expect(mockFn(runSyncAgentTurn).mock.calls[0]![0].request).not.toHaveProperty('attachments');
    await r.close();
  });

  it('an empty input is still a 400', async () => {
    const r = await responses();
    expect((await post(r, { model: 'field-ops', input: '' })).statusCode).toBe(400);
    expect((await post(r, { model: 'field-ops', input: [{ role: 'user', content: [{ type: 'input_file' }] }] })).statusCode).toBe(400);
    await r.close();
  });

  it('refuses files for an agent that takes none, before a session is created', async () => {
    const r = await responses();
    const files = [{ role: 'user', content: [{ type: 'input_file', file_data: 'QUJD', filename: 'a.txt' }] }];
    // Switched off, left at the default (off), or switched on without a bucket: none of them takes files.
    for (const [attachments, message] of [
      [{ enabled: false, bucketKey: 'docs' }, 'This agent does not take attachments.'],
      [undefined, 'This agent does not take attachments.'],
      [{ enabled: true }, 'Files are not set up for this agent.'],
    ] as const) {
      mockFn(getAgentByKey).mockResolvedValue({ ...AGENT, config: { modelKey: 'm', ...(attachments ? { attachments } : {}) } });
      const res = await post(r, { model: 'field-ops', input: files });
      expect(res.statusCode).toBe(403);
      expect(parseJsonBody<{ error: { code: string; message: string } }>(res.body).error).toMatchObject({ code: 'attachments_disabled', message });
    }
    expect(createConversation).not.toHaveBeenCalled();
    await r.close();
  });

  it('F2-03: file parts to an agent that takes none are refused loudly — nothing is stored or run — while the same agent still answers text (earlier releases ran the text and ignored the parts)', async () => {
    const r = await responses();
    mockFn(getAgentByKey).mockResolvedValue({ ...AGENT, config: { modelKey: 'm', attachments: { enabled: false, bucketKey: 'docs' } } });
    const parts: Array<Record<string, unknown>> = [
      { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
      { type: 'input_image', image_url: 'https://example.com/cat.png' },
      { type: 'input_file', file_data: 'QUJD', filename: 'a.txt' },
      { type: 'input_file', file_id: 'f1' },
    ];
    for (const part of parts) {
      const res = await post(r, { model: 'field-ops', input: [{ role: 'user', content: [{ type: 'input_text', text: 'describe it' }, part] }] });
      expect(res.statusCode, JSON.stringify(part)).toBe(403);
      expect(parseJsonBody<{ error: { code: string; message: string } }>(res.body).error).toMatchObject({
        code: 'attachments_disabled', message: 'This agent does not take attachments.',
      });
    }
    expect(createConversation).not.toHaveBeenCalled();
    expect(storeResponseInputFiles).not.toHaveBeenCalled();
    expect(runSyncAgentTurn).not.toHaveBeenCalled();

    // A request without file parts is untouched by the change.
    const text = await post(r, { model: 'field-ops', input: [{ role: 'user', content: [{ type: 'input_text', text: 'just text' }] }] });
    expect(text.statusCode).toBe(200);
    expect(mockFn(runSyncAgentTurn).mock.calls[0]![0].request).toMatchObject({ userMessage: 'just text' });
    await r.close();

    // The change is written down where clients look for it.
    const root = process.cwd();
    expect(readFileSync(join(root, 'docs/guide/session-files.md'), 'utf8')).toContain('now answers a request that carries such a part with `403 attachments_disabled`');
    expect(readFileSync(join(root, 'docs/public/openapi.yaml'), 'utf8')).toContain('earlier releases ignored those parts and ran the text');
  });

  it('a file_id needs the session it was uploaded to (session_id, conversation or previous_response_id)', async () => {
    const r = await responses();
    const res = await post(r, { model: 'field-ops', input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_file', file_id: 'f1' }] }] });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('attachment_not_found');
    expect(createConversation).not.toHaveBeenCalled();
    await r.close();
  });

  it('continues a session with a file already on it, and answers a refused upload with its own status', async () => {
    mockFn(getConversationById).mockResolvedValue(conversation({ agentKey: 'field-ops' }));
    mockFn(storeResponseInputFiles).mockResolvedValue({ attachments: ['f1'], named: ['f1'] });
    const r = await responses();
    const ok = await post(r, { model: 'field-ops', previous_response_id: 'resp_conv-1', input: [{ role: 'user', content: [{ type: 'input_text', text: 'again' }, { type: 'input_file', file_id: 'f1' }] }] });
    expect(ok.statusCode).toBe(200);
    expect(mockFn(runSyncAgentTurn).mock.calls[0]![0].request).toMatchObject({ conversationId: 'conv-1', attachments: ['f1'] });

    mockFn(storeResponseInputFiles).mockRejectedValue(new AgentAttachmentError(413, 'file_too_large', 'too big'));
    const refused = await post(r, { model: 'field-ops', previous_response_id: 'resp_conv-1', input: [{ role: 'user', content: [{ type: 'input_file', file_data: 'QUJD', filename: 'a.txt' }] }] });
    expect(refused.statusCode).toBe(413);
    expect(parseJsonBody<{ error: { code: string } }>(refused.body).error.code).toBe('file_too_large');
    await r.close();
  });

  it('a background run carries the attachments; only the ids the caller named identify it for idempotency', async () => {
    mockFn(storeResponseInputFiles).mockResolvedValue({ attachments: ['f1', 'up1'], named: ['f1'] });
    mockFn(getConversationById).mockResolvedValue(conversation({ agentKey: 'field-ops' }));
    mockFn(createBackgroundAgentRun).mockResolvedValue({ kind: 'created', run: { _id: 'run-1', status: 'queued' } });
    mockFn(validateCallbackRequest).mockResolvedValue({ ok: true });
    const r = await responses();
    const res = await post(r, {
      model: 'field-ops', background: true, previous_response_id: 'resp_conv-1',
      input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'f1' }, { type: 'input_file', file_data: 'QUJD', filename: 'b.txt' }] }],
    });
    expect(res.statusCode).toBe(202);
    expect(mockFn(createBackgroundAgentRun).mock.calls[0]![0]).toMatchObject({ attachments: ['f1', 'up1'], idempotencyAttachments: ['f1'] });
    await r.close();
  });
});

describe('client Responses: continuing a session with session_id / conversation', () => {
  const responses = async () => createFastifyApiTestApp(clientAgentsApiPlugin);
  const syncOk = { kind: 'ok', response: { id: 'resp_conv-1', object: 'response', status: 'completed', output: [], _conversation_messages: [] } };
  const post = (app2: Awaited<ReturnType<typeof responses>>, payload: Record<string, unknown>) =>
    app2.inject({ method: 'POST', url: '/api/client/v1/agents/responses', headers: clientHeaders, payload });
  const fileInput = [{ role: 'user', content: [{ type: 'input_text', text: 'read it' }, { type: 'input_file', file_id: 'f1' }] }];

  beforeEach(() => {
    mockFn(getAgentByKey).mockResolvedValue({ ...AGENT, config: { modelKey: 'm', attachments: FILES_ON } });
    mockFn(getConversationById).mockResolvedValue(conversation({ agentKey: 'field-ops', metadata: { source: 'api' } }));
    mockFn(createConversation).mockResolvedValue(conversation());
    mockFn(resolveAgentExecutionLimits).mockResolvedValue({ syncTimeoutMs: 60_000, backgroundEnabled: true, defaultMode: 'sync' });
    mockFn(runSyncAgentTurn).mockResolvedValue(syncOk);
    mockFn(pendingActionsBlockingMessage).mockResolvedValue(null);
    mockFn(storeResponseInputFiles).mockResolvedValue({ attachments: ['f1'], named: ['f1'] });
  });

  it('session_id continues that session (no new one is created), and a file_id then names a file already on it', async () => {
    const r = await responses();
    const res = await post(r, { model: 'field-ops', session_id: 'conv-1', input: fileInput });
    expect(res.statusCode).toBe(200);
    expect(getConversationById).toHaveBeenCalledWith('tenant_acme', 'conv-1');
    expect(createConversation).not.toHaveBeenCalled();
    expect(mockFn(runSyncAgentTurn).mock.calls[0]![0].request).toMatchObject({ conversationId: 'conv-1', userMessage: 'read it', attachments: ['f1'] });
    await r.close();
  });

  it('conversation is the OpenAI-style alias: a string, or { id }', async () => {
    const r = await responses();
    for (const conversationRef of ['conv-1', { id: 'conv-1' }]) {
      mockFn(runSyncAgentTurn).mockClear();
      const res = await post(r, { model: 'field-ops', conversation: conversationRef, input: 'hi' });
      expect(res.statusCode).toBe(200);
      expect(mockFn(runSyncAgentTurn).mock.calls[0]![0].request.conversationId).toBe('conv-1');
    }
    await r.close();
  });

  it('naming the session twice is fine when both say the same one, and a 400 when they differ', async () => {
    const r = await responses();
    expect((await post(r, { model: 'field-ops', session_id: 'conv-1', conversation: { id: 'conv-1' }, input: 'hi' })).statusCode).toBe(200);
    expect((await post(r, { model: 'field-ops', session_id: 'conv-1', previous_response_id: 'resp_conv-1', input: 'hi' })).statusCode).toBe(200);

    const apart = await post(r, { model: 'field-ops', session_id: 'conv-1', conversation: 'conv-2', input: 'hi' });
    expect(apart.statusCode).toBe(400);
    const conflict = await post(r, { model: 'field-ops', session_id: 'conv-2', previous_response_id: 'resp_conv-1', input: 'hi' });
    expect(conflict.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(conflict.body).error.code).toBe('session_conflict');
    await r.close();
  });

  it('a session id that is not a string, or names no session of this agent and project, is refused', async () => {
    const r = await responses();
    expect((await post(r, { model: 'field-ops', session_id: 5, input: 'hi' })).statusCode).toBe(400);
    expect((await post(r, { model: 'field-ops', conversation: { id: '' }, input: 'hi' })).statusCode).toBe(400);

    mockFn(getConversationById).mockResolvedValue(null);
    const gone = await post(r, { model: 'field-ops', session_id: 'nope', input: 'hi' });
    expect(gone.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(gone.body).error.code).toBe('session_not_found');

    for (const other of [{ agentKey: 'someone-else' }, { projectId: 'proj-2' }]) {
      mockFn(getConversationById).mockResolvedValue(conversation(other));
      expect((await post(r, { model: 'field-ops', session_id: 'conv-1', input: 'hi' })).statusCode).toBe(404);
    }
    expect(runSyncAgentTurn).not.toHaveBeenCalled();
    await r.close();
  });

  it('a session waiting on an answer refuses a new message the same way previous_response_id does', async () => {
    mockFn(pendingActionsBlockingMessage).mockResolvedValue(['act_1']);
    const r = await responses();
    const res = await post(r, { model: 'field-ops', session_id: 'conv-1', input: 'hi' });
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { type: string; pending_action_ids: string[] } }>(res.body).error).toMatchObject({ type: 'pending_action', pending_action_ids: ['act_1'] });
    await r.close();
  });
});

describe('the bucket picker', () => {
  it('lists the project’s buckets for whoever edits an agent, with whether each can take a file', async () => {
    const buckets = [{ key: 'docs', name: 'Docs', providerKey: 'local', providerLabel: 'Local disk', driver: 'local-filesystem', bucketStatus: 'active', providerStatus: 'active', usable: true, localDisk: true }];
    const db = {
      listFileBuckets: vi.fn(async () => [{ key: 'docs', name: 'Docs', providerKey: 'local', status: 'active' }]),
      listProviders: vi.fn(async () => [{ key: 'local', label: 'Local disk', driver: 'local-filesystem', type: 'file', status: 'active' }]),
      findProviderByKey: vi.fn(),
      switchToTenant: vi.fn(),
    };
    mockFn(getDatabase).mockResolvedValue(db);
    const res = await app.inject({ method: 'GET', url: '/api/agents/attachments/buckets', headers: dashHeaders });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ buckets: unknown[] }>(res.body).buckets).toEqual(buckets);
    expect(db.listFileBuckets).toHaveBeenCalledWith('tenant-1', 'proj-1');
    expect(db.listProviders).toHaveBeenCalledWith('tenant-1', { type: 'file', projectId: 'proj-1' });
  });

  it('is not mistaken for an agent called "attachments" when the agents routes are registered beside it', async () => {
    const db = { listFileBuckets: vi.fn(async () => []), listProviders: vi.fn(async () => []), findProviderByKey: vi.fn(), switchToTenant: vi.fn() };
    mockFn(getDatabase).mockResolvedValue(db);
    const both = await createFastifyApiTestApp(async (instance) => {
      await instance.register(agentsApiPlugin);
      await instance.register(agentSessionFilesApiPlugin);
    });
    const res = await both.inject({ method: 'GET', url: '/api/agents/attachments/buckets', headers: dashHeaders });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ buckets: unknown[] }>(res.body)).toEqual({ buckets: [] });
    expect(getAgentById).not.toHaveBeenCalled();
    await both.close();
  });
});

describe('what the agent lookup tells a client about files', () => {
  const lookup = async () => {
    const r = await createFastifyApiTestApp(clientAgentsApiPlugin);
    const res = await r.inject({ method: 'GET', url: '/api/client/v1/agents/field-ops', headers: clientHeaders });
    await r.close();
    return res;
  };

  it('says whether the agent takes files now, its limits and whether its model reads images', async () => {
    mockFn(getAgentByKey).mockResolvedValue({ ...AGENT, createdAt: new Date('2026-01-01T00:00:00Z'), config: { modelKey: 'm', attachments: FILES_ON } });
    mockFn(describeAgentAttachments).mockResolvedValue({ enabled: true, maxFiles: 5, maxFileSizeMb: 8, allowedMimeTypes: ['image/*'], acceptsImages: true });

    const res = await lookup();

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ agent: Record<string, unknown> }>(res.body).agent.attachments).toEqual({
      enabled: true, max_files: 5, max_file_size_mb: 8, allowed_mime_types: ['image/*'], accepts_images: true,
    });
    expect(describeAgentAttachments).toHaveBeenCalledWith({
      tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', config: { modelKey: 'm', attachments: FILES_ON },
    });
  });

  it('still answers the lookup when that cannot be worked out (the field is left out)', async () => {
    mockFn(getAgentByKey).mockResolvedValue(AGENT);
    mockFn(describeAgentAttachments).mockRejectedValue(new Error('storage lookup failed'));
    const res = await lookup();
    expect(res.statusCode).toBe(200);
    const agent = parseJsonBody<{ agent: Record<string, unknown> }>(res.body).agent;
    expect(agent).toMatchObject({ key: 'field-ops', status: 'active' });
    expect(agent).not.toHaveProperty('attachments');
  });
});
