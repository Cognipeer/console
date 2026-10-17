/**
 * Route-layer wiring of the OpenAI Responses dialect (§5.3) and the runs
 * routes: `client-agents.ts`'s responses handler starts every agent turn
 * through `startAgentRun` and answers with the run's Response object (200
 * finished, 202 still going), `GET/POST /responses/:id(/cancel)` read and
 * cancel it, and the runs API's get/cancel are scoped to the token's project. Service-level behavior (claim/finalize CAS, the race
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
  startAgentRun: vi.fn(),
  waitForAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  cancelAgentRun: vi.fn(),
  getModelByKey: vi.fn(),
  resolveAgentConfig: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  lookupIdempotentAgentRun: vi.fn(),
  resolveAgentRunLimits: vi.fn(),
  validateCallbackRequest: vi.fn(),
  handleChatCompletion: vi.fn(),
}));

// The permission gate reads the caller inside a tenant scope: serve it from the same stubbed database.
vi.mock('@/lib/database', () => ({
  getDatabase: hoisted.getDatabase,
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await hoisted.getDatabase()),
}));
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
  resolveAgentConfig: hoisted.resolveAgentConfig,
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
    startAgentRun: hoisted.startAgentRun,
    waitForAgentRun: hoisted.waitForAgentRun,
    getAgentRunStatus: hoisted.getAgentRunStatus,
    cancelAgentRun: hoisted.cancelAgentRun,
    lookupIdempotentAgentRun: hoisted.lookupIdempotentAgentRun,
    resolveAgentRunLimits: hoisted.resolveAgentRunLimits,
    validateCallbackRequest: hoisted.validateCallbackRequest,
  };
});

// `/responses` resolves a bare name as a model first (§1.2).
vi.mock('@/lib/services/models/modelService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/modelService')>()),
  getModelByKey: hoisted.getModelByKey,
}));

// A model target is a gateway call; the gateway itself is stood in for.
vi.mock('@/lib/services/models/inferenceService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/inferenceService')>()),
  handleChatCompletion: hoisted.handleChatCompletion,
}));

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
  syncWaitMs: 60_000,
  maxDurationMs: 1_800_000,
  maxActivePerTenant: 10,
  maxActivePerProject: 0,
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
  hoisted.resolveAgentRunLimits.mockResolvedValue(DEFAULT_LIMITS);
  hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'none' });
  hoisted.getModelByKey.mockResolvedValue(null);
  hoisted.getAgentRunStatus.mockResolvedValue(null);
  hoisted.waitForAgentRun.mockImplementation(async () => null);
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

const RESPONSE = { id: 'resp_x', object: 'response', model: 'support-agent', output: [
  { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
], status: 'completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, created_at: 1_700_000_000, previous_response_id: null, version: null };

const run = (overrides: Record<string, unknown> = {}) => ({
  _id: 'run-1', mode: 'inline', status: 'succeeded', agentKey: 'support-agent', conversationId: 'conv-1',
  runClass: 'default', metadata: null, responseFormat: null, createdAt: new Date('2024-01-01T00:00:00Z'), ...overrides,
});

const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}, url = '/api/client/v1/responses') =>
  client.inject({ method: 'POST', url, headers: { ...TOKEN_HEADERS, ...headers }, payload });

const startInput = (index = 0) => hoisted.startAgentRun.mock.calls[index]![0] as Record<string, unknown>;

describe('POST /responses — an agent turn is a run, answered as its Response object (§5.3)', () => {
  it('a plain call that finishes in the window: 200 with a run-scoped id and the Response fields', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });

    const res = await post({ model: 'support-agent', input: 'hello' });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      id: 'resp_run-1',
      object: 'response',
      status: 'completed',
      model: 'support-agent',
      output_text: 'hi there',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      error: null,
      metadata: {},
      text: { format: { type: 'text' } },
      service_tier: 'default',
      background: false,
      previous_response_id: null,
      conversation: { id: 'conv-1' },
      cognipeer: { run_id: 'run_run-1', session_id: 'conv-1' },
    });
    expect(startInput()).toMatchObject({
      channel: 'responses',
      runClass: 'default',
      usePublished: true,
      limits: DEFAULT_LIMITS,
      execution: { kind: 'inline', waitMs: DEFAULT_LIMITS.syncWaitMs, cancelOnDisconnect: false },
    });
  });

  it('the window ends with the run still going: 202 in_progress with Location and Retry-After (it keeps going)', async () => {
    hoisted.startAgentRun.mockResolvedValue({
      kind: 'detached',
      run: run({ _id: 'run-8', status: 'running', result: null, detachedAt: new Date() }),
    });

    const res = await post({ model: 'support-agent', input: 'hello' });

    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe('/api/client/v1/agents/runs/run_run-8');
    expect(res.headers['retry-after']).toBe('2');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      id: 'resp_run-8', object: 'response', status: 'in_progress', output: [], output_text: '', cognipeer: { run_id: 'run_run-8' },
    });
  });

  it.each([
    ['the X-Cognipeer-Background header', { 'x-cognipeer-background': 'true' }, {}],
    ['"background": true in the body (OpenAI SDK)', {}, { background: true }],
  ])('%s queues the run: 202 queued, background true', async (_label, headers, extra) => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ mode: 'background', status: 'queued', result: null }) });

    const res = await post({ model: 'support-agent', input: 'hello', ...extra }, headers);

    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe('/api/client/v1/agents/runs/run_run-1');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ id: 'resp_run-1', status: 'queued', background: true });
    expect(startInput().execution).toEqual({ kind: 'queued' });
    expect(hoisted.waitForAgentRun).not.toHaveBeenCalled();
  });

  it('service_tier "flex" is a deferred run the call waits on like a plain one (200 once it finished)', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ mode: 'background', status: 'queued', runClass: 'deferred', result: null }) });
    hoisted.waitForAgentRun.mockResolvedValue(run({ mode: 'background', status: 'succeeded', runClass: 'deferred', result: { ...RESPONSE, id: 'resp_run-1' } }));

    const res = await post({ model: 'support-agent', input: 'hello', service_tier: 'flex' });

    expect(res.statusCode).toBe(200);
    expect(startInput()).toMatchObject({ runClass: 'deferred', execution: { kind: 'queued' } });
    expect(hoisted.waitForAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', projectId: 'proj-1' }), DEFAULT_LIMITS.syncWaitMs);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ status: 'completed', service_tier: 'flex', output_text: 'hi there' });
  });

  it('service_tier "flex" still queued when the window ends: 202 queued; with background it never waits', async () => {
    const queued = run({ mode: 'background', status: 'queued', runClass: 'deferred', result: null });
    hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: queued });
    hoisted.waitForAgentRun.mockResolvedValue(queued);
    expect((await post({ model: 'support-agent', input: 'hello', service_tier: 'flex' })).statusCode).toBe(202);

    hoisted.waitForAgentRun.mockClear();
    const res = await post({ model: 'support-agent', input: 'hello', service_tier: 'flex', background: true });
    expect(res.statusCode).toBe(202);
    expect(hoisted.waitForAgentRun).not.toHaveBeenCalled();
  });

  it('any other service_tier runs in the default class', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });
    await post({ model: 'support-agent', input: 'hello', service_tier: 'priority' });
    expect(startInput().runClass).toBe('default');
  });

  it('metadata is stored on the run and echoed; more than 16 keys is a 400', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run({ metadata: { ticket: 'OPS-12' } }), response: RESPONSE });
    const res = await post({ model: 'support-agent', input: 'hello', metadata: { ticket: 'OPS-12' } });
    expect(res.statusCode).toBe(200);
    expect(startInput().metadata).toEqual({ ticket: 'OPS-12' });
    expect(parseJsonBody<{ metadata: unknown }>(res.body).metadata).toEqual({ ticket: 'OPS-12' });

    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    const refused = await post({ model: 'support-agent', input: 'hello', metadata: tooMany });
    expect(refused.statusCode).toBe(400);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(refused.body).error).toMatchObject({ code: 'invalid_metadata', param: 'metadata', type: 'invalid_request_error' });
  });

  it('text.format is the run\'s structured output and comes back as text.format', async () => {
    const format = { type: 'json_schema', name: 'ticket', schema: { type: 'object', properties: { id: { type: 'string' } } }, strict: true };
    hoisted.startAgentRun.mockImplementation(async (input: Record<string, unknown>) => ({
      kind: 'completed', run: run({ responseFormat: input.responseFormat }), response: RESPONSE,
    }));
    const res = await post({ model: 'support-agent', input: 'hello', text: { format } });
    expect(startInput().responseFormat).toEqual({ type: 'json_schema', name: 'ticket', schema: format.schema, strict: true });
    expect(parseJsonBody<{ text: unknown }>(res.body).text).toEqual({ format });
  });

  it('a callback is accepted on a plain call too (it fires only if the run ends up async)', async () => {
    hoisted.validateCallbackRequest.mockResolvedValue({ ok: true, url: 'https://hooks.example.com/run', secret: 'a-very-long-secret-value' });
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });

    const res = await post({ model: 'support-agent', input: 'hello', callback_url: 'https://hooks.example.com/run', callback_secret: 'a-very-long-secret-value' });

    expect(res.statusCode).toBe(200);
    expect(startInput().callback).toEqual({ url: 'https://hooks.example.com/run', secret: 'a-very-long-secret-value' });
    expect(res.body).not.toContain('a-very-long-secret-value');
  });

  it('an invalid callback is rejected at submit time with 400 invalid_callback, before anything is created', async () => {
    hoisted.validateCallbackRequest.mockResolvedValue({ ok: false, message: 'callback_url must resolve to a public address' });

    const res = await post({ model: 'support-agent', input: 'hello', callback_url: 'http://169.254.169.254/latest' }, { 'x-cognipeer-background': 'true' });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_callback');
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('refusals use the OpenAI envelope: a busy conversation 409, a cap 429', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'conflict' });
    let res = await post({ model: 'support-agent', input: 'hello' });
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toMatchObject({ type: 'agent_run_conflict', code: 'agent_run_conflict', param: null });

    hoisted.startAgentRun.mockResolvedValue({ kind: 'concurrency_limit', limit: 2, scope: 'project', runClass: 'default' });
    res = await post({ model: 'support-agent', input: 'hello' });
    expect(res.statusCode).toBe(429);
    const error = parseJsonBody<{ error: { code: string; message: string; scope: string } }>(res.body).error;
    expect(error).toMatchObject({ code: 'agent_run_concurrency_limit', scope: 'project' });
    expect(error.message).toContain('project');
  });

  it('agent parameters it does not take are listed back in X-Cognipeer-Ignored-Params', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });
    const res = await post({ model: 'support-agent', input: 'hello', temperature: 0.2, instructions: 'be brief' });
    expect(res.headers['x-cognipeer-ignored-params']).toBe('instructions,temperature');
  });
});

describe('POST /responses — target and version (§1.2)', () => {
  beforeEach(() => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });
  });

  it('both routes run the published version by default; version "draft" runs the draft, version N pins', async () => {
    await post({ model: 'support-agent', input: 'hello' });
    await post({ model: 'support-agent', input: 'hello' }, {}, '/api/client/v1/agents/responses');
    expect(startInput(0).usePublished).toBe(true);
    expect(startInput(1).usePublished).toBe(true);

    await post({ model: 'support-agent', input: 'hello', version: 'draft' });
    expect(startInput(2).usePublished).toBe(false);

    hoisted.resolveAgentConfig.mockResolvedValue({ config: { modelKey: 'gpt-4o' }, version: 3 });
    await post({ model: 'support-agent', input: 'hello', version: 3 });
    expect(startInput(3)).toMatchObject({ version: 3, usePublished: true });

    const bad = await post({ model: 'support-agent', input: 'hello', version: 'latest' });
    expect(bad.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(bad.body).error.code).toBe('invalid_version');
  });

  it('a model key wins a bare-name collision on /responses (a model call, not a run), agent:<key> always means the agent', async () => {
    hoisted.getModelByKey.mockResolvedValue({ key: 'support-agent' });
    hoisted.handleChatCompletion.mockResolvedValue({
      requestId: 'req-1',
      response: { id: 'chatcmpl-1', object: 'chat.completion', model: 'support-agent', choices: [{ index: 0, message: { role: 'assistant', content: 'from the model' }, finish_reason: 'stop' }] },
    });

    const model = await post({ model: 'support-agent', input: 'hello' });
    expect(model.statusCode).toBe(200);
    expect(parseJsonBody<{ object: string; output_text: string }>(model.body)).toMatchObject({ object: 'response', output_text: 'from the model' });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();

    const agent = await post({ model: 'agent:support-agent', input: 'hello' });
    expect(agent.statusCode).toBe(200);
    expect(startInput().agentKey).toBe('support-agent');
    expect(parseJsonBody<{ model: string }>(agent.body).model).toBe('agent:support-agent');
    expect(hoisted.handleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('/agents/responses is agents only: no model lookup', async () => {
    hoisted.getModelByKey.mockResolvedValue({ key: 'support-agent' });
    const res = await post({ model: 'support-agent', input: 'hello' }, {}, '/api/client/v1/agents/responses');
    expect(res.statusCode).toBe(200);
    expect(hoisted.getModelByKey).not.toHaveBeenCalled();
  });

  it('a name that is neither a model nor an agent: 404 model_not_found', async () => {
    hoisted.getAgentByKey.mockResolvedValue(null);
    const res = await post({ model: 'nothing-here', input: 'hello' });
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toMatchObject({ code: 'model_not_found', param: 'model', type: 'invalid_request_error' });
  });
});

describe('POST /responses — Idempotency-Key on every mode (§4.6)', () => {
  it('a finished run is replayed (200, its stored answer), before a conversation is created', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({
      kind: 'replay',
      run: run({ _id: 'run-7', result: { ...RESPONSE, id: 'resp_run-7' } }),
    });

    const res = await post({ model: 'support-agent', input: 'hello' }, { 'idempotency-key': 'idem-1' });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ id: 'resp_run-7', status: 'completed', output_text: 'hi there' });
    expect(hoisted.lookupIdempotentAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'idem-1', idempotencyConversationScope: null, userMessage: 'hello',
    }));
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });

  it('a key with a reserved prefix (routine runs) is refused in the OpenAI envelope, before anything is looked up', async () => {
    const res = await post({ model: 'support-agent', input: 'hello' }, { 'idempotency-key': 'routine:r1:slot' });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { type: string; code: string; param: unknown } }>(res.body).error).toMatchObject({
      type: 'invalid_request_error', code: 'idempotency_key_reserved', param: null,
    });
    expect(hoisted.lookupIdempotentAgentRun).not.toHaveBeenCalled();
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('a run still going is waited on like a new call, then 202 when it is still going', async () => {
    const running = run({ _id: 'run-5', status: 'running', result: null });
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'replay', run: running });
    hoisted.waitForAgentRun.mockResolvedValue(running);

    const res = await post({ model: 'support-agent', input: 'hello' }, { 'idempotency-key': 'idem-1' });

    expect(hoisted.waitForAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-5' }), DEFAULT_LIMITS.syncWaitMs);
    expect(res.statusCode).toBe(202);
    expect(parseJsonBody<{ status: string }>(res.body).status).toBe('in_progress');
  });

  it('a background replay of a queued run answers at once (202 queued)', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'replay', run: run({ mode: 'background', status: 'queued', result: null }) });
    const res = await post({ model: 'support-agent', input: 'hello', background: true }, { 'idempotency-key': 'idem-1' });
    expect(res.statusCode).toBe(202);
    expect(hoisted.waitForAgentRun).not.toHaveBeenCalled();
  });

  it('the key with a different request is a 409 idempotency_key_conflict, before a conversation is created', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'conflict' });
    const res = await post({ model: 'support-agent', input: 'something else' }, { 'idempotency-key': 'idem-1' });
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('idempotency_key_conflict');
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });

  it('the key and the request reach the run (a race between two first attempts is settled there)', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });
    await post({ model: 'support-agent', input: 'hello' }, { 'idempotency-key': 'idem-sync' });
    expect(startInput()).toMatchObject({ idempotencyKey: 'idem-sync', idempotencyConversationScope: null });
  });
});

describe('previous_response_id resolution', () => {
  beforeEach(() => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run({ conversationId: 'conv-from-run' }), response: RESPONSE });
  });

  it.each([['resp_run-9'], ['run_run-9']])('%s resolves through the run to its session', async (previous) => {
    hoisted.getAgentRunStatus.mockResolvedValue({ _id: 'run-9', conversationId: 'conv-from-run' });
    hoisted.getConversationById.mockResolvedValue({ _id: 'conv-from-run', agentKey: 'support-agent', projectId: 'proj-1' });

    const res = await post({ model: 'support-agent', input: 'hello', previous_response_id: previous });

    expect(res.statusCode).toBe(200);
    expect(hoisted.getAgentRunStatus).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-9');
    expect(startInput().conversationId).toBe('conv-from-run');
    expect(startInput().idempotencyConversationScope).toBe('conv-from-run');
    expect(parseJsonBody<{ previous_response_id: string }>(res.body).previous_response_id).toBe(previous);
  });

  it('a legacy resp_<conversationId> still names its session when no run matches', async () => {
    hoisted.getConversationById.mockResolvedValue({ _id: 'conv-legacy', agentKey: 'support-agent', projectId: 'proj-1' });
    const res = await post({ model: 'support-agent', input: 'hello', previous_response_id: 'resp_conv-legacy' });
    expect(res.statusCode).toBe(200);
    expect(startInput().conversationId).toBe('conv-legacy');
  });

  it.each([['run_does-not-exist'], ['garbage-id-no-prefix']])('%s is a 404, never a new conversation', async (previous) => {
    const res = await post({ model: 'support-agent', input: 'hello', previous_response_id: previous });
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('previous_response_not_found');
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });
});

describe('GET /responses/:id and POST /responses/:id/cancel', () => {
  it.each([
    ['/api/client/v1/responses/resp_run-1'],
    ['/api/client/v1/agents/responses/resp_run-1'],
    ['/api/client/v1/responses/run_run-1'],
  ])('GET %s reads the run as its Response object', async (url) => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ mode: 'background', status: 'running', result: null, metadata: { a: 'b' } }));

    const res = await runsApp.inject({ method: 'GET', url, headers: TOKEN_HEADERS });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      id: 'resp_run-1', object: 'response', status: 'in_progress', background: true, metadata: { a: 'b' }, conversation: { id: 'conv-1' },
    });
  });

  it.each([
    ['queued', 'queued'], ['scheduled', 'queued'], ['requires_action', 'requires_action'], ['failed', 'failed'], ['canceled', 'cancelled'],
  ])('a %s run reads as status %s', async (status, expected) => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status, result: null, errorReason: status === 'failed' ? 'agent_error' : null, errorMessage: 'boom' }));
    const res = await runsApp.inject({ method: 'GET', url: '/api/client/v1/responses/resp_run-1', headers: TOKEN_HEADERS });
    const body = parseJsonBody<{ status: string; error: unknown }>(res.body);
    expect(body.status).toBe(expected);
    expect(body.error).toEqual(status === 'failed' ? { code: 'agent_error', message: 'boom' } : null);
  });

  it('an unknown id, a reservation row or an unprefixed id: 404 in the OpenAI envelope', async () => {
    for (const [url, row] of [
      ['/api/client/v1/responses/resp_nope', null],
      ['/api/client/v1/responses/resp_run-1', run({ mode: 'sync', status: 'running' })],
      ['/api/client/v1/responses/run-1', run()],
    ] as const) {
      hoisted.getAgentRunStatus.mockResolvedValue(row);
      const res = await runsApp.inject({ method: 'GET', url, headers: TOKEN_HEADERS });
      expect(res.statusCode, url).toBe(404);
      expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toMatchObject({ code: 'response_not_found', type: 'invalid_request_error', param: null });
    }
  });

  it('cancel goes through cancelAgentRun and answers the Response object (in_progress while the stop lands)', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'running', result: null }));
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'running', result: null, cancelRequestedAt: new Date() }) });

    const res = await runsApp.inject({ method: 'POST', url: '/api/client/v1/responses/resp_run-1/cancel', headers: { authorization: TOKEN_HEADERS.authorization } });

    expect(res.statusCode).toBe(200);
    expect(hoisted.cancelAgentRun).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', runId: 'run-1' });
    expect(parseJsonBody<{ id: string; status: string }>(res.body)).toMatchObject({ id: 'resp_run-1', status: 'in_progress' });
  });

  it('cancel of a queued run: cancelled; of a finished one: 200 with its final object (OpenAI behaviour)', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ mode: 'background', status: 'queued', result: null }));
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ mode: 'background', status: 'canceled', result: null }) });
    let res = await runsApp.inject({ method: 'POST', url: '/api/client/v1/agents/responses/resp_run-1/cancel', headers: { authorization: TOKEN_HEADERS.authorization } });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ status: string }>(res.body).status).toBe('cancelled');

    hoisted.getAgentRunStatus.mockResolvedValue(run({ result: { ...RESPONSE, id: 'resp_run-1' } }));
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'already_terminal', run: run({ result: { ...RESPONSE, id: 'resp_run-1' } }) });
    res = await runsApp.inject({ method: 'POST', url: '/api/client/v1/responses/resp_run-1/cancel', headers: { authorization: TOKEN_HEADERS.authorization } });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ status: string; output_text: string }>(res.body)).toMatchObject({ status: 'completed', output_text: 'hi there' });
  });
});

describe('GET/POST /client/v1/agents/runs/:runId — tenant+project scoping (§12.11)', () => {
  it('GET returns the serialized run status', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ mode: 'background', status: 'running', result: null }));

    const res = await runsApp.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run-1', headers: TOKEN_HEADERS });

    expect(res.statusCode).toBe(200);
    expect(hoisted.getAgentRunStatus).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-1');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ id: 'run_run-1', object: 'agent.run', status: 'running' });
  });

  it('GET returns 404 when the run does not belong to this tenant+project', async () => {
    const res = await runsApp.inject({ method: 'GET', url: '/api/client/v1/agents/runs/someone-elses-run', headers: TOKEN_HEADERS });
    expect(res.statusCode).toBe(404);
  });

  it('POST cancel goes through cancelAgentRun scoped by tenantId+projectId', async () => {
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'running', result: null, cancelRequestedAt: new Date() }) });

    const res = await runsApp.inject({ method: 'POST', url: '/api/client/v1/agents/runs/run-1/cancel', headers: { authorization: TOKEN_HEADERS.authorization } });

    expect(res.statusCode).toBe(200);
    expect(hoisted.cancelAgentRun).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', runId: 'run-1' });
  });

  it('POST cancel on an already-terminal run gets 409, distinct from 404 not-found', async () => {
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'already_terminal', run: run() });
    const res = await runsApp.inject({ method: 'POST', url: '/api/client/v1/agents/runs/run-1/cancel', headers: { authorization: TOKEN_HEADERS.authorization } });
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('agent_run_already_terminal');
  });

  it('POST cancel on a nonexistent run gets 404', async () => {
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'not_found' });
    const res = await runsApp.inject({ method: 'POST', url: '/api/client/v1/agents/runs/does-not-exist/cancel', headers: { authorization: TOKEN_HEADERS.authorization } });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /responses — structured output and inputs (§6)', () => {
  const TRIAGE = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
  const declare = (config: Record<string, unknown>) => {
    const declared = { ...activeAgent(), config: { modelKey: 'gpt-4o', ...config } };
    hoisted.getAgentByKey.mockResolvedValue(declared);
    hoisted.resolveAgentConfig.mockResolvedValue({ agent: declared, config: declared.config, resolvedVersion: 2 });
  };
  const error = (body: string) => parseJsonBody<{ error: Record<string, unknown> }>(body).error;

  it('text.format json_schema becomes the run\'s responseFormat; the answer carries output_parsed and the format', async () => {
    hoisted.startAgentRun.mockResolvedValue({
      kind: 'completed',
      run: run({ responseFormat: { type: 'json_schema', name: 'triage', schema: TRIAGE } }),
      response: { ...RESPONSE, output_parsed: { label: 'bug' } },
    });

    const res = await post({ model: 'support-agent', input: 'hello', text: { format: { type: 'json_schema', name: 'triage', schema: TRIAGE, strict: true } } });

    expect(res.statusCode).toBe(200);
    expect(startInput().responseFormat).toEqual({ type: 'json_schema', name: 'triage', schema: TRIAGE, strict: true });
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      output_parsed: { label: 'bug' },
      text: { format: { type: 'json_schema', name: 'triage' } },
    });
  });

  it('a contract the agent could not meet comes back as output_error, not as a failure', async () => {
    hoisted.startAgentRun.mockResolvedValue({
      kind: 'completed', run: run(), response: { ...RESPONSE, output_error: 'label is required' },
    });
    const res = await post({ model: 'support-agent', input: 'hello', text: { format: { type: 'json_object' } } });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ output_error: 'label is required' });
    expect(startInput().responseFormat).toEqual({ type: 'json_object' });
  });

  it('text.format "text" (or none) asks for no structured output', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });
    await post({ model: 'support-agent', input: 'hello', text: { format: { type: 'text' } } });
    expect(startInput().responseFormat).toBeNull();
  });

  it('refuses a schema that is not an object contract: 400 invalid_response_format in the OpenAI envelope, nothing starts', async () => {
    for (const schema of [{ type: 'weird' }, { type: 'string' }, { type: 'object' }]) {
      const res = await post({ model: 'support-agent', input: 'hello', text: { format: { type: 'json_schema', name: 'x', schema } } });
      expect(res.statusCode, JSON.stringify(schema)).toBe(400);
      expect(error(res.body)).toMatchObject({ code: 'invalid_response_format', param: 'text.format', type: 'invalid_request_error' });
    }
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('inputs are validated against the agent declaration and delivered validated, defaults applied', async () => {
    declare({ inputs: [{ name: 'customer_id', type: 'string', required: true }, { name: 'priority', type: 'string', default: 'low' }] });
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });

    const bad = await post({ model: 'support-agent', input: 'hello', inputs: {} });
    expect(bad.statusCode).toBe(400);
    expect(error(bad.body)).toMatchObject({
      code: 'invalid_inputs', param: 'inputs', errors: [{ field: 'customer_id', message: 'Required' }],
    });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();

    const ok = await post({ model: 'support-agent', input: 'hello', inputs: { customer_id: 'c-1' } });
    expect(ok.statusCode).toBe(200);
    expect(startInput().inputs).toEqual({ customer_id: 'c-1', priority: 'low' });
  });

  it('a request with only inputs (an empty message) is accepted', async () => {
    declare({ inputs: [{ name: 'topic', type: 'string' }] });
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run(), response: RESPONSE });
    const res = await post({ model: 'support-agent', input: '', inputs: { topic: 'billing' } });
    expect(res.statusCode).toBe(200);
    expect(startInput().inputs).toEqual({ topic: 'billing' });
  });

  it('GET /agents/:key publishes input_schema and output_schema (the agent as a typed function)', async () => {
    declare({
      inputs: [{ name: 'customer_id', type: 'string', required: true, description: 'Who to look up' }],
      structuredOutput: { enabled: true, schema: TRIAGE },
    });
    const res = await client.inject({ method: 'GET', url: '/api/client/v1/agents/support-agent', headers: TOKEN_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ agent: Record<string, unknown> }>(res.body).agent).toMatchObject({
      input_schema: {
        type: 'object',
        properties: { customer_id: { type: 'string', description: 'Who to look up' } },
        required: ['customer_id'],
        additionalProperties: false,
      },
      output_schema: TRIAGE,
    });

    declare({});
    const plain = await client.inject({ method: 'GET', url: '/api/client/v1/agents/support-agent', headers: TOKEN_HEADERS });
    expect(parseJsonBody<{ agent: Record<string, unknown> }>(plain.body).agent).toMatchObject({ input_schema: null, output_schema: null });
  });
});

describe('the runs API object carries the structured answer', () => {
  it('lifts output_parsed and output_error from the run result', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({
      status: 'succeeded',
      result: { ...RESPONSE, output_parsed: { label: 'bug' } },
    }));
    const ok = await runsApp.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run_run-1', headers: TOKEN_HEADERS });
    expect(parseJsonBody<Record<string, unknown>>(ok.body)).toMatchObject({ output_parsed: { label: 'bug' }, output_error: null });

    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'succeeded', result: { ...RESPONSE, output_error: 'label is required' } }));
    const failed = await runsApp.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run_run-1', headers: TOKEN_HEADERS });
    expect(parseJsonBody<Record<string, unknown>>(failed.body)).toMatchObject({ output_parsed: null, output_error: 'label is required' });
  });
});
