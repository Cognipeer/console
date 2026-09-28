/**
 * Group D/E route-layer wiring (docs/guide/agent-background-execution.md
 * §13) — proves `client-agents.ts`'s responses handler and the new
 * `client-agent-runs.ts` endpoints wire the background signal, conflict/
 * timeout outcomes, and idempotency-key rejection to the right HTTP status
 * and envelope. Service-level behavior (claim/finalize CAS, the race
 * itself) is already covered by `agent-run-sync-ceiling.test.ts` and
 * `agent-run-background-execution.test.ts` — this file replaces every
 * DB/queue-touching function of `agentRunService.ts` (keeping its pure
 * serializer/envelope helpers real) and asserts only on the route wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getAgentByKey: vi.fn(),
  getConversationById: vi.fn(),
  createConversation: vi.fn(),
  runSyncAgentTurn: vi.fn(),
  createBackgroundAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  requestAgentRunCancellation: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  lookupIdempotentAgentRun: vi.fn(),
  resolveAgentExecutionLimits: vi.fn(),
  validateCallbackRequest: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: hoisted.getDatabase }));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

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
  updateAgentRecord: vi.fn(),
  deleteAgentRecord: vi.fn(),
  getAgentById: vi.fn(),
  getAgentByKey: hoisted.getAgentByKey,
  listAgents: vi.fn(),
  countAgents: vi.fn(),
  publishAgent: vi.fn(),
  getAgentVersion: vi.fn(),
  listAgentVersions: vi.fn(),
  resolveAgentConfig: vi.fn(),
  createConversation: hoisted.createConversation,
  getConversationById: hoisted.getConversationById,
  listConversations: vi.fn(),
  deleteConversation: vi.fn(),
  executeAgentChat: vi.fn(),
  executePlaygroundChat: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => {
  // The real module for the pure helpers (serializeAgentRun, error bodies,
  // background-signal detection, callback validation); only the functions
  // that touch the DB/queue are replaced, so the route wiring is asserted
  // against the SAME serializer and envelopes production uses.
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentRunService')>();
  return {
    ...actual,
    runSyncAgentTurn: hoisted.runSyncAgentTurn,
    createBackgroundAgentRun: hoisted.createBackgroundAgentRun,
    getAgentRunStatus: hoisted.getAgentRunStatus,
    requestAgentRunCancellation: hoisted.requestAgentRunCancellation,
    lookupIdempotentAgentRun: hoisted.lookupIdempotentAgentRun,
    resolveAgentExecutionLimits: hoisted.resolveAgentExecutionLimits,
    validateCallbackRequest: hoisted.validateCallbackRequest,
  };
});

import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createMockDb } from '../helpers/db.mock';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
import { clientAgentRunsApiPlugin } from '@/server/api/plugins/client-agent-runs';

const TOKEN_HEADERS = { authorization: 'Bearer tok_abc', 'content-type': 'application/json' };

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

function activeAgent() {
  return {
    _id: 'agent-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'support-agent',
    name: 'Support',
    status: 'active',
    config: { modelKey: 'gpt-4o' },
    createdBy: 'user-1',
  };
}

const DEFAULT_LIMITS = {
  syncTimeoutMs: 60_000,
  backgroundEnabled: true,
  backgroundMaxDurationMs: 1_800_000,
  defaultMode: 'sync' as const,
  maxConcurrentRunsPerTenant: 10,
  maxConcurrentRunsPerProject: 0,
};

let client: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let runsApp: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  const db = createMockDb();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.getAgentByKey.mockResolvedValue(activeAgent());
  hoisted.createConversation.mockResolvedValue({ _id: 'conv-1' });
  hoisted.resolveAgentExecutionLimits.mockResolvedValue(DEFAULT_LIMITS);
  hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'none' });
  hoisted.validateCallbackRequest.mockImplementation(async (url: unknown, secret: unknown) => (
    url ? { ok: true, url, secret } : { ok: true }
  ));

  client = await createFastifyApiTestApp(clientAgentsApiPlugin);
  runsApp = await createFastifyApiTestApp(clientAgentRunsApiPlugin);
});

afterEach(async () => {
  await client.close();
  await runsApp.close();
});

describe('POST /responses — background signal (§4) and idempotency (§9/§12.15)', () => {
  it('X-Cognipeer-Background: true creates a background run and returns 202 with a pollable id', async () => {
    hoisted.createBackgroundAgentRun.mockResolvedValue({
      kind: 'created',
      run: { _id: 'run-1', status: 'queued', createdAt: new Date('2024-01-01T00:00:00Z') },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(202);
    const body = parseJsonBody<{ id: string; object: string; status: string }>(res.body);
    expect(body.id).toBe('run_run-1');
    expect(body.object).toBe('agent.run');
    expect(body.status).toBe('queued');
    expect(hoisted.runSyncAgentTurn).not.toHaveBeenCalled();
  });

  it('"background": true in the body works the same as the header (OpenAI SDK compatibility)', async () => {
    hoisted.createBackgroundAgentRun.mockResolvedValue({
      kind: 'created',
      run: { _id: 'run-2', status: 'queued', createdAt: new Date('2024-01-01T00:00:00Z') },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello', background: true },
    });

    expect(res.statusCode).toBe(202);
  });

  it('a background request against a conversation with an active run gets 409', async () => {
    hoisted.createBackgroundAgentRun.mockResolvedValue({ kind: 'conflict' });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('agent_run_conflict');
  });

  it('a background request past the tenant concurrency cap gets 429 (§12.8)', async () => {
    hoisted.createBackgroundAgentRun.mockResolvedValue({ kind: 'concurrency_limit', limit: 10, scope: 'tenant' });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(429);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('rate_limit_error');
  });

  it('a background request past the PROJECT cap gets 429 naming the project scope', async () => {
    hoisted.createBackgroundAgentRun.mockResolvedValue({ kind: 'concurrency_limit', limit: 2, scope: 'project' });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(429);
    const body = parseJsonBody<{ error: { code: string; message: string } }>(res.body);
    expect(body.error.code).toBe('agent_run_concurrency_limit');
    expect(body.error.message).toContain('project');
    expect(body.error.message).toContain('2');
  });

  it('passes the resolved limits, callback and idempotency scope to createBackgroundAgentRun', async () => {
    hoisted.createBackgroundAgentRun.mockResolvedValue({
      kind: 'created',
      run: { _id: 'run-1', mode: 'background', status: 'queued', createdAt: new Date() },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true', 'idempotency-key': 'idem-9' },
      payload: {
        model: 'support-agent',
        input: 'hello',
        callback_url: 'https://hooks.example.com/run',
        callback_secret: 'a-very-long-secret-value',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(hoisted.validateCallbackRequest).toHaveBeenCalledWith('https://hooks.example.com/run', 'a-very-long-secret-value');
    const [input] = hoisted.createBackgroundAgentRun.mock.calls[0] as [Record<string, unknown>];
    expect(input.limits).toEqual(DEFAULT_LIMITS);
    expect(input.callbackUrl).toBe('https://hooks.example.com/run');
    expect(input.callbackSecret).toBe('a-very-long-secret-value');
    expect(input.idempotencyKey).toBe('idem-9');
    // A new conversation: the hash must not depend on the fresh id.
    expect(input.idempotencyConversationScope).toBeNull();
    // 202 body is the single §8 shape — never the sealed secret.
    expect(res.body).not.toContain('a-very-long-secret-value');
  });

  it('an invalid callback is rejected at submit time with 400 invalid_callback, before anything is created', async () => {
    hoisted.validateCallbackRequest.mockResolvedValue({ ok: false, message: 'callback_url must resolve to a public address' });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true' },
      payload: { model: 'support-agent', input: 'hello', callback_url: 'http://169.254.169.254/latest' },
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_callback');
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.createBackgroundAgentRun).not.toHaveBeenCalled();
  });

  it('background on an agent with background disabled gets 400 agent_background_disabled', async () => {
    hoisted.resolveAgentExecutionLimits.mockResolvedValue({ ...DEFAULT_LIMITS, backgroundEnabled: false });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('agent_background_disabled');
    expect(hoisted.createBackgroundAgentRun).not.toHaveBeenCalled();
  });

  it("an agent whose defaultMode is 'background' runs a call that says neither in the background", async () => {
    hoisted.resolveAgentExecutionLimits.mockResolvedValue({ ...DEFAULT_LIMITS, defaultMode: 'background' });
    hoisted.createBackgroundAgentRun.mockResolvedValue({
      kind: 'created',
      run: { _id: 'run-3', mode: 'background', status: 'queued', createdAt: new Date() },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(202);
    expect(hoisted.runSyncAgentTurn).not.toHaveBeenCalled();
  });

  it('the sync path gets the resolved (min) ceiling, not the env default', async () => {
    hoisted.resolveAgentExecutionLimits.mockResolvedValue({ ...DEFAULT_LIMITS, syncTimeoutMs: 12_000 });
    hoisted.runSyncAgentTurn.mockResolvedValue({
      kind: 'ok',
      response: { id: 'resp_conv-1', object: 'response', model: 'support-agent', output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    const [arg] = hoisted.runSyncAgentTurn.mock.calls[0] as [{ syncTimeoutMs: number }];
    expect(arg.syncTimeoutMs).toBe(12_000);
  });

  it('a background request reusing an Idempotency-Key with a different body gets 409 idempotency_key_conflict (§12.15)', async () => {
    hoisted.createBackgroundAgentRun.mockResolvedValue({ kind: 'idempotency_conflict' });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true', 'idempotency-key': 'idem-1' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('idempotency_key_conflict');
  });

  it('a background request replaying an Idempotency-Key with the SAME body gets 200 with the existing run (§12.15)', async () => {
    hoisted.createBackgroundAgentRun.mockResolvedValue({
      kind: 'idempotent_replay',
      run: { _id: 'run-1', mode: 'background', status: 'succeeded', createdAt: new Date('2024-01-01T00:00:00Z') },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true', 'idempotency-key': 'idem-1' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ id: string; status: string }>(res.body);
    expect(body.id).toBe('run_run-1');
    expect(body.status).toBe('succeeded');
  });
  it('REGRESSION: a replayed Idempotency-Key is answered BEFORE a conversation is created (no orphan per retry)', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({
      kind: 'replay',
      run: { _id: 'run-1', mode: 'background', status: 'running', conversationId: 'conv-original', createdAt: new Date() },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true', 'idempotency-key': 'idem-1' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ id: string; conversation_id: string }>(res.body);
    expect(body.id).toBe('run_run-1');
    expect(body.conversation_id).toBe('conv-original');
    expect(hoisted.lookupIdempotentAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'idem-1',
      idempotencyConversationScope: null,
      userMessage: 'hello',
    }));
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.createBackgroundAgentRun).not.toHaveBeenCalled();
  });

  it('REGRESSION: a pre-conversation idempotency conflict gets 409 without creating a conversation', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'conflict' });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'x-cognipeer-background': 'true', 'idempotency-key': 'idem-1' },
      payload: { model: 'support-agent', input: 'something else' },
    });

    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('idempotency_key_conflict');
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });


  it('Idempotency-Key on a synchronous (non-background) request is rejected with 400', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: { ...TOKEN_HEADERS, 'idempotency-key': 'idem-1' },
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('invalid_request_error');
    expect(hoisted.runSyncAgentTurn).not.toHaveBeenCalled();
    expect(hoisted.createBackgroundAgentRun).not.toHaveBeenCalled();
  });

  it('a synchronous request timing out returns 504 with the side-effects disclosure', async () => {
    hoisted.runSyncAgentTurn.mockResolvedValue({ kind: 'timeout' });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(504);
    const body = parseJsonBody<{ error: { type: string; side_effects_possible: boolean; retryable: boolean } }>(res.body);
    expect(body.error.type).toBe('timeout');
    expect(body.error.side_effects_possible).toBe(true);
    expect(body.error.retryable).toBe(false);
  });

  it('a synchronous request against a conversation with an active run gets 409, never runs inline', async () => {
    hoisted.runSyncAgentTurn.mockResolvedValue({ kind: 'conflict' });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('a normal synchronous request still returns 200 with the turn result (unchanged behavior)', async () => {
    hoisted.runSyncAgentTurn.mockResolvedValue({
      kind: 'ok',
      response: { id: 'resp_conv-1', object: 'response', model: 'support-agent', output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ id: string }>(res.body).id).toBe('resp_conv-1');
  });
});

describe('previous_response_id dual-mode resolution (§8, §12.3)', () => {
  it('resolves a resp_<runId> previous_response_id via the AgentRun lookup first', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue({ _id: 'run-9', conversationId: 'conv-from-run' });
    hoisted.getConversationById.mockResolvedValue({ _id: 'conv-from-run', agentKey: 'support-agent', projectId: 'proj-1' });
    hoisted.runSyncAgentTurn.mockResolvedValue({
      kind: 'ok',
      response: { id: 'resp_conv-from-run', object: 'response', model: 'support-agent', output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello', previous_response_id: 'resp_run-9' },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.getAgentRunStatus).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-9');
    const [{ request: sentRequest }] = hoisted.runSyncAgentTurn.mock.calls[0] as [{ request: { conversationId: string } }];
    expect(sentRequest.conversationId).toBe('conv-from-run');
  });

  it('falls back to raw-conversationId behavior when no AgentRun matches (unchanged sync scheme)', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(null);
    hoisted.getConversationById.mockResolvedValue({ _id: 'conv-legacy', agentKey: 'support-agent', projectId: 'proj-1' });
    hoisted.runSyncAgentTurn.mockResolvedValue({
      kind: 'ok',
      response: { id: 'resp_conv-legacy', object: 'response', model: 'support-agent', output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello', previous_response_id: 'resp_conv-legacy' },
    });

    expect(res.statusCode).toBe(200);
    const [{ request: sentRequest }] = hoisted.runSyncAgentTurn.mock.calls[0] as [{ request: { conversationId: string } }];
    expect(sentRequest.conversationId).toBe('conv-legacy');
  });

  it('accepts a run_<runId> previous_response_id — the run-status envelope id a caller most naturally copies back', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue({ _id: 'run-9', conversationId: 'conv-from-run' });
    hoisted.getConversationById.mockResolvedValue({ _id: 'conv-from-run', agentKey: 'support-agent', projectId: 'proj-1' });
    hoisted.runSyncAgentTurn.mockResolvedValue({
      kind: 'ok',
      response: { id: 'resp_conv-from-run', object: 'response', model: 'support-agent', output: [], status: 'completed', usage: {}, created_at: 0, previous_response_id: null, version: null },
    });

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello', previous_response_id: 'run_run-9' },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.getAgentRunStatus).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-9');
  });

  it('a run_<runId> that does not resolve to any AgentRun gets 404 — no raw-conversationId fallback for this scheme', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(null);

    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello', previous_response_id: 'run_does-not-exist' },
    });

    expect(res.statusCode).toBe(404);
    expect(hoisted.runSyncAgentTurn).not.toHaveBeenCalled();
  });

  it('an unrecognized previous_response_id prefix gets 404 — never silently starts a new conversation', async () => {
    const res = await client.inject({
      method: 'POST',
      url: '/api/client/v1/responses',
      headers: TOKEN_HEADERS,
      payload: { model: 'support-agent', input: 'hello', previous_response_id: 'garbage-id-no-prefix' },
    });

    expect(res.statusCode).toBe(404);
    expect(hoisted.runSyncAgentTurn).not.toHaveBeenCalled();
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });
});

describe('GET/POST /client/v1/agents/runs/:runId — tenant+project scoping (§12.11)', () => {
  it('GET returns the serialized run status', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue({
      _id: 'run-1',
      mode: 'background',
      agentKey: 'support-agent',
      conversationId: 'conv-1',
      status: 'running',
      result: null,
      errorReason: null,
      errorMessage: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      startedAt: new Date('2024-01-01T00:00:01Z'),
      completedAt: null,
    });

    const res = await runsApp.inject({
      method: 'GET',
      url: '/api/client/v1/agents/runs/run-1',
      headers: TOKEN_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.getAgentRunStatus).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-1');
    const body = parseJsonBody<{ id: string; object: string; status: string }>(res.body);
    expect(body.id).toBe('run_run-1');
    expect(body.object).toBe('agent.run');
    expect(body.status).toBe('running');
  });

  it('GET returns 404 when the run does not belong to this tenant+project', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(null);

    const res = await runsApp.inject({
      method: 'GET',
      url: '/api/client/v1/agents/runs/someone-elses-run',
      headers: TOKEN_HEADERS,
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST cancel requests cancellation scoped by tenantId+projectId', async () => {
    hoisted.requestAgentRunCancellation.mockResolvedValue({
      kind: 'accepted',
      run: {
        _id: 'run-1',
        agentKey: 'support-agent',
        conversationId: 'conv-1',
        status: 'running',
        cancelRequestedAt: new Date(),
        result: null,
        errorReason: null,
        errorMessage: null,
        createdAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
      },
    });

    const res = await runsApp.inject({
      method: 'POST',
      url: '/api/client/v1/agents/runs/run-1/cancel',
      headers: { authorization: TOKEN_HEADERS.authorization },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.requestAgentRunCancellation).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-1');
  });

  it('POST cancel on an already-terminal run gets 409, distinct from 404 not-found', async () => {
    hoisted.requestAgentRunCancellation.mockResolvedValue({
      kind: 'already_terminal',
      run: { _id: 'run-1', status: 'succeeded' },
    });

    const res = await runsApp.inject({
      method: 'POST',
      url: '/api/client/v1/agents/runs/run-1/cancel',
      headers: { authorization: TOKEN_HEADERS.authorization },
    });

    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('agent_run_already_terminal');
  });

  it('POST cancel on a nonexistent run gets 404', async () => {
    hoisted.requestAgentRunCancellation.mockResolvedValue({ kind: 'not_found' });

    const res = await runsApp.inject({
      method: 'POST',
      url: '/api/client/v1/agents/runs/does-not-exist/cancel',
      headers: { authorization: TOKEN_HEADERS.authorization },
    });

    expect(res.statusCode).toBe(404);
  });
});
