/**
 * The runs API (§5.1) and the session cancel (§5.2) at the route layer: what a
 * request turns into for the engine (`startAgentRun`, `waitForAgentRun`,
 * the cancel) and how each outcome is answered. The engine's own behaviour has
 * its tests (integration/agent-run-*.test.ts); here every DB/queue-touching
 * function of agentRunService is replaced and its pure serializer and error
 * bodies are kept real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  getAgentByKey: vi.fn(),
  getConversationById: vi.fn(),
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  resolveAgentConfig: vi.fn(),
  startAgentRun: vi.fn(),
  waitForAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  cancelAgentRun: vi.fn(),
  listAgentRuns: vi.fn(),
  lookupIdempotentAgentRun: vi.fn(),
  resolveAgentRunLimits: vi.fn(),
  validateCallbackRequest: vi.fn(),
  refuseSessionLinked: vi.fn(),
  sessionListScope: vi.fn(),
  authorizeEndingOpenRequests: vi.fn(),
  cancelConversationTurn: vi.fn(),
  resolveAgentPendingAction: vi.fn(),
  followSessionEvents: vi.fn(),
}));

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
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: hoisted.requireApiTokenFromHeader };
});

vi.mock('@/lib/services/agents/agentService', () => ({
  AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
  getAgentByKey: hoisted.getAgentByKey,
  getConversationById: hoisted.getConversationById,
  createConversation: hoisted.createConversation,
  deleteConversation: hoisted.deleteConversation,
  resolveAgentConfig: hoisted.resolveAgentConfig,
  executeAgentChat: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentRunService')>();
  return {
    ...actual,
    startAgentRun: hoisted.startAgentRun,
    waitForAgentRun: hoisted.waitForAgentRun,
    getAgentRunStatus: hoisted.getAgentRunStatus,
    cancelAgentRun: hoisted.cancelAgentRun,
    listAgentRuns: hoisted.listAgentRuns,
    lookupIdempotentAgentRun: hoisted.lookupIdempotentAgentRun,
    resolveAgentRunLimits: hoisted.resolveAgentRunLimits,
    validateCallbackRequest: hoisted.validateCallbackRequest,
  };
});

// Whose session a run is, and what a caller may list, are the session access module's questions (own tests).
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return {
    ...actual,
    refuseSessionLinked: hoisted.refuseSessionLinked,
    decideSessionAccess: vi.fn(async () => ({ ok: true })),
    sessionListScope: hoisted.sessionListScope,
    sessionStreamStillAllowed: vi.fn(async () => true),
  };
});
vi.mock('@/server/api/plugins/agent-approval-authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-approval-authz')>();
  return {
    ...actual,
    authorizeEndingOpenRequests: hoisted.authorizeEndingOpenRequests,
    refuseCancelPending: vi.fn(async () => null),
  };
});
vi.mock('@/lib/services/agents/agentActionResolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentActionResolution')>();
  return {
    ...actual,
    pendingActionsBlockingMessage: vi.fn(async () => null),
    resolveAgentPendingAction: hoisted.resolveAgentPendingAction,
  };
});
vi.mock('@/lib/services/agents/sessionEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/sessionEvents')>();
  return { ...actual, followSessionEvents: hoisted.followSessionEvents };
});
vi.mock('@/lib/services/agents/agentSpendLimits', () => ({ assertQueuedTurnSpendAllowed: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/agents/turnCancellation', () => ({ cancelConversationTurn: hoisted.cancelConversationTurn }));

import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createMockDb } from '../helpers/db.mock';
import { clientAgentRunsApiPlugin, parsePreferHeader, parseRunSchedule } from '@/server/api/plugins/client-agent-runs';

const HEADERS = { authorization: 'Bearer tok_abc', 'content-type': 'application/json' };
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
const LIMITS = { syncWaitMs: 60_000, maxDurationMs: 1_800_000, maxActivePerTenant: 250, maxActivePerProject: 0 };
const CREATED = new Date('2026-10-17T10:00:00Z');

const agent = () => ({
  _id: 'agent-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'support', name: 'Support', status: 'active', config: { modelKey: 'gpt-4o' },
});
const session = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support', createdBy: 'user-1', messages: [], ...overrides,
});
const run = (overrides: Record<string, unknown> = {}) => ({
  _id: 'r1',
  mode: 'background',
  status: 'queued',
  runClass: 'default',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentKey: 'support',
  conversationId: 'conv-1',
  userId: 'user-1',
  channel: 'runs',
  trigger: 'request',
  createdAt: CREATED,
  ...overrides,
});

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let db: ReturnType<typeof createMockDb>;

beforeEach(async () => {
  vi.clearAllMocks();
  db = createMockDb({ runWithTenant: (_name: string, fn: () => unknown) => fn() } as never);
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.getAgentByKey.mockResolvedValue(agent());
  hoisted.getConversationById.mockResolvedValue(session());
  hoisted.createConversation.mockResolvedValue(session({ _id: 'conv-new' }));
  hoisted.resolveAgentConfig.mockResolvedValue({ agent: agent(), config: agent().config, resolvedVersion: 3 });
  hoisted.resolveAgentRunLimits.mockResolvedValue(LIMITS);
  hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'none' });
  hoisted.validateCallbackRequest.mockImplementation(async (url: unknown, secret: unknown) => (url ? { ok: true, url, secret } : { ok: true }));
  hoisted.refuseSessionLinked.mockResolvedValue(null);
  hoisted.sessionListScope.mockResolvedValue({ userId: 'user-1' });
  hoisted.authorizeEndingOpenRequests.mockResolvedValue({ allowed: true });
  hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ conversationId: 'conv-new' }) });
  app = await createFastifyApiTestApp(clientAgentRunsApiPlugin);
});

afterEach(async () => {
  await app.close();
});

const create = (body: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: '/api/client/v1/agents/support/runs', headers: { ...HEADERS, ...headers }, payload: body,
});
const startInput = () => hoisted.startAgentRun.mock.calls[0][0];

describe('POST /client/v1/agents/:agentKey/runs', () => {
  it('is async-first: no wait = a queued run, 202 with the run, its Location and Retry-After', async () => {
    const res = await create({ input: 'hello' });
    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe('/api/client/v1/agents/runs/run_r1');
    expect(res.headers['retry-after']).toBe('2');
    const body = parseJsonBody<Record<string, unknown>>(res.body);
    expect(body).toMatchObject({ id: 'run_r1', object: 'agent.run', status: 'queued', class: 'default', channel: 'runs', session_id: 'conv-new' });
    expect(hoisted.waitForAgentRun).not.toHaveBeenCalled();
    expect(startInput()).toMatchObject({
      agentKey: 'support', conversationId: 'conv-new', userMessage: 'hello', runClass: 'default', channel: 'runs', trigger: 'request',
      usePublished: true, actorType: 'api_token', apiTokenId: 'tok-1', execution: { kind: 'queued' }, limits: LIMITS,
    });
    expect(hoisted.createConversation).toHaveBeenCalledTimes(1);
  });

  it('wait: the call holds until the run finished (200, the run with its answer)', async () => {
    hoisted.waitForAgentRun.mockResolvedValue(run({
      status: 'succeeded', result: { id: 'resp_r1', object: 'response', output_text: 'Hi there' }, completedAt: CREATED,
    }));
    const res = await create({ input: 'hello', wait: 30 });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toMatchObject({ status: 'succeeded', output_text: 'Hi there' });
    expect(hoisted.waitForAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', projectId: 'proj-1' }), 30_000, expect.any(AbortSignal));
  });

  it('wait that ends first is a 202 with the run still going; the wait never exceeds the window', async () => {
    hoisted.waitForAgentRun.mockResolvedValue(run({ status: 'running' }));
    const res = await create({ input: 'hello', wait: 10_000 });
    expect(res.statusCode).toBe(202);
    expect(hoisted.waitForAgentRun).toHaveBeenCalledWith(expect.anything(), LIMITS.syncWaitMs, expect.any(AbortSignal));
  });

  it('honours Prefer: wait=N (and says so), and Prefer: respond-async', async () => {
    hoisted.waitForAgentRun.mockResolvedValue(run({ status: 'running' }));
    let res = await create({ input: 'hello' }, { prefer: 'wait=3' });
    expect(res.statusCode).toBe(202);
    expect(res.headers['preference-applied']).toBe('wait=3');
    expect(hoisted.waitForAgentRun).toHaveBeenCalledWith(expect.anything(), 3_000, expect.any(AbortSignal));

    hoisted.waitForAgentRun.mockClear();
    res = await create({ input: 'hello' }, { prefer: 'respond-async, wait=5' });
    expect(res.statusCode).toBe(202);
    expect(res.headers['preference-applied']).toBe('respond-async');
    expect(hoisted.waitForAgentRun).not.toHaveBeenCalled();
  });

  it('delay_seconds schedules the run (202, status scheduled), and a wait does not hold a scheduled run', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'scheduled', notBefore: new Date(Date.now() + 3_600_000) }) });
    const before = Date.now();
    const res = await create({ input: 'hello', delay_seconds: 3600, wait: 10 });
    expect(res.statusCode).toBe(202);
    const body = parseJsonBody<{ status: string; scheduled_for: number }>(res.body);
    expect(body.status).toBe('scheduled');
    expect(body.scheduled_for).toBeGreaterThan(Math.floor(before / 1000));
    const notBefore = startInput().execution.notBefore as Date;
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(hoisted.waitForAgentRun).not.toHaveBeenCalled();
  });

  it('refuses a schedule more than 30 days ahead, or both run_at and delay_seconds', async () => {
    const far = new Date(Date.now() + 31 * 86_400_000).toISOString();
    let res = await create({ input: 'hello', run_at: far });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_schedule');
    res = await create({ input: 'hello', run_at: far, delay_seconds: 5 });
    expect(res.statusCode).toBe(400);
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('class deferred starts a deferred run (202)', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ runClass: 'deferred' }) });
    const res = await create({ input: 'hello', class: 'deferred' });
    expect(res.statusCode).toBe(202);
    expect(parseJsonBody(res.body)).toMatchObject({ class: 'deferred' });
    expect(startInput()).toMatchObject({ runClass: 'deferred', execution: { kind: 'queued' } });
    expect((await create({ input: 'hello', class: 'cheap' })).statusCode).toBe(400);
  });

  const TRIAGE_SCHEMA = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
  /** An agent declaring `variables`: the published config (what API calls run) and the draft carry them. */
  const declareVariables = (variables: unknown[]) => {
    const declared = { ...agent(), config: { modelKey: 'gpt-4o', variables } };
    hoisted.getAgentByKey.mockResolvedValue(declared);
    hoisted.resolveAgentConfig.mockResolvedValue({ agent: declared, config: declared.config, resolvedVersion: 3 });
  };
  const lastStart = () => hoisted.startAgentRun.mock.calls.at(-1)![0];

  it('passes metadata, response_format, variables, the callback and version "draft" through to the run', async () => {
    declareVariables([{ name: 'customer_id', type: 'string' }]);
    const res = await create({
      input: 'hello',
      version: 'draft',
      metadata: { ticket: 'OPS-12' },
      response_format: { type: 'json_schema', json_schema: { name: 'triage', schema: TRIAGE_SCHEMA, strict: true } },
      variables: { customer_id: 'c-9' },
      callback: { url: 'https://hooks.example.com/run', secret: 'x'.repeat(20) },
    });
    expect(res.statusCode).toBe(202);
    expect(startInput()).toMatchObject({
      usePublished: false,
      metadata: { ticket: 'OPS-12' },
      responseFormat: { type: 'json_schema', name: 'triage', schema: TRIAGE_SCHEMA, strict: true },
      variables: { customer_id: 'c-9' },
      callback: { url: 'https://hooks.example.com/run', secret: 'x'.repeat(20) },
    });
    expect(startInput().version).toBeUndefined();
  });

  it('refuses a response_format the converter cannot turn into an object contract', async () => {
    for (const schema of [{ type: 'object' }, { type: 'array', items: { type: 'string' } }, { type: 'weird' }, { properties: { a: { type: 'string' } } }]) {
      const res = await create({ input: 'hi', response_format: { type: 'json_schema', json_schema: { name: 'x', schema } } });
      expect(res.statusCode, JSON.stringify(schema)).toBe(400);
      expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_response_format');
    }
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('accepts json_object and the Responses spelling, and treats type "text" as no format', async () => {
    await create({ input: 'hi', response_format: { type: 'json_object' } });
    expect(lastStart().responseFormat).toEqual({ type: 'json_object' });
    await create({ input: 'hi', response_format: { type: 'json_schema', name: 'n', schema: TRIAGE_SCHEMA } });
    expect(lastStart().responseFormat).toMatchObject({ type: 'json_schema', name: 'n' });
    await create({ input: 'hi', response_format: { type: 'text' } });
    expect(lastStart().responseFormat).toBeNull();
  });

  it('validates variables against the agent declaration: required, type, enum, unknown names, defaults', async () => {
    declareVariables([
      { name: 'customer_id', type: 'string', required: true },
      { name: 'priority', type: 'string', enum: ['low', 'high'], default: 'low' },
      { name: 'attempts', type: 'integer' },
    ]);
    const failure = async (variables: unknown) => {
      const res = await create({ input: 'hi', variables });
      expect(res.statusCode).toBe(400);
      const error = parseJsonBody<{ error: { code: string; errors: Array<{ field: string; message: string }> } }>(res.body).error;
      expect(error.code).toBe('invalid_variables');
      return error.errors;
    };
    expect(await failure({})).toEqual([{ field: 'customer_id', message: 'Required' }]);
    expect(await failure({ customer_id: 7 })).toEqual([{ field: 'customer_id', message: 'Must be a string' }]);
    expect(await failure({ customer_id: 'c', priority: 'urgent' })).toEqual([{ field: 'priority', message: 'Must be one of: low, high' }]);
    expect(await failure({ customer_id: 'c', attempts: 1.5 })).toEqual([{ field: 'attempts', message: 'Must be an integer' }]);
    expect(await failure({ customer_id: 'c', other: 1 })).toEqual([{ field: 'other', message: 'Not a variable of this agent' }]);
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();

    const ok = await create({ input: 'hi', variables: { customer_id: 'c-1', attempts: 2 } });
    expect(ok.statusCode).toBe(202);
    // The default fills the field the caller left out.
    expect(lastStart().variables).toEqual({ customer_id: 'c-1', priority: 'low', attempts: 2 });
  });

  it('an agent that declares no variables refuses any, and an empty message is fine when variables carry the turn', async () => {
    const res = await create({ input: 'hi', variables: { a: 1 } });
    expect(res.statusCode).toBe(400);
    declareVariables([{ name: 'topic', type: 'string' }]);
    const ok = await create({ input: '', variables: { topic: 'billing' } });
    expect(ok.statusCode).toBe(202);
    expect(lastStart().variables).toEqual({ topic: 'billing' });
  });

  it('pins version N after checking it exists', async () => {
    await create({ input: 'hello', version: 3 });
    expect(startInput()).toMatchObject({ version: 3, usePublished: true });
    hoisted.resolveAgentConfig.mockRejectedValue(new Error('Version 9 not found'));
    const res = await create({ input: 'hello', version: 9 });
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('version_not_found');
  });

  it('answers bad fields with a typed 400 and starts nothing', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ input: 'hi', metadata: { 'bad key': 'x' } }, 'invalid_metadata'],
      [{ input: 'hi', response_format: { type: 'json_schema' } }, 'invalid_response_format'],
      [{ input: 'hi', response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } } }, 'invalid_response_format'],
      [{ input: 'hi', variables: ['x'] }, 'invalid_variables'],
      [{ input: 'hi', version: 0 }, 'invalid_version'],
      [{ input: 'hi', wait: -1 }, 'invalid_wait'],
      [{ input: 'hi', stream: true, class: 'deferred' }, 'invalid_request'],
      [{}, 'missing_input'],
    ];
    for (const [body, code] of cases) {
      const res = await create(body);
      expect(res.statusCode, code).toBe(400);
      expect(parseJsonBody<{ error: { type: string; code: string } }>(res.body).error).toMatchObject({ type: 'invalid_request_error', code });
    }
    hoisted.validateCallbackRequest.mockResolvedValue({ ok: false, message: 'callback_url must resolve to a public address' });
    const res = await create({ input: 'hi', callback: { url: 'http://10.0.0.1/' } });
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_callback');
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('an unknown or inactive agent is refused in the client envelope', async () => {
    hoisted.getAgentByKey.mockResolvedValue(null);
    let res = await create({ input: 'hi' });
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody(res.body)).toEqual({ error: { type: 'not_found_error', message: 'Agent "support" not found', code: 'agent_not_found' } });
    hoisted.getAgentByKey.mockResolvedValue({ ...agent(), status: 'inactive' });
    res = await create({ input: 'hi' });
    expect(res.statusCode).toBe(400);
  });

  it('continues a session of this agent; a session of another project is a 404', async () => {
    await create({ input: 'next', session_id: 'conv-1' });
    expect(startInput()).toMatchObject({ conversationId: 'conv-1', idempotencyConversationScope: 'conv-1' });
    expect(hoisted.createConversation).not.toHaveBeenCalled();

    hoisted.getConversationById.mockResolvedValue(session({ projectId: 'proj-2' }));
    const res = await create({ input: 'next', session_id: 'conv-1' });
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('session_not_found');
  });

  it('Idempotency-Key: a replay of a finished run is a 200 with it (no new session); a different request is a 409', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'replay', run: run({ status: 'succeeded', result: { output_text: 'done' } }) });
    let res = await create({ input: 'hello' }, { 'idempotency-key': 'k1' });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toMatchObject({ id: 'run_r1', status: 'succeeded', output_text: 'done' });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.lookupIdempotentAgentRun).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'k1', idempotencyConversationScope: null }));

    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'conflict' });
    res = await create({ input: 'hello' }, { 'idempotency-key': 'k1' });
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('idempotency_key_conflict');
  });

  it.each(['trigger:abc:2026-10-18T06:00:00.000Z', 'hook:wh_1:delivery'])('Idempotency-Key %s is reserved for trigger runs: 400, nothing started', async (key) => {
    const res = await create({ input: 'hello' }, { 'idempotency-key': key });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { type: string; code: string } }>(res.body).error).toMatchObject({ type: 'invalid_request_error', code: 'idempotency_key_reserved' });
    expect(hoisted.lookupIdempotentAgentRun).not.toHaveBeenCalled();
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });

  it('the class caps answer 429 with the class and scope', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'concurrency_limit', limit: 10_000, scope: 'tenant', runClass: 'deferred' });
    const res = await create({ input: 'hello', class: 'deferred' });
    expect(res.statusCode).toBe(429);
    expect(parseJsonBody(res.body)).toMatchObject({
      error: { type: 'rate_limit_error', code: 'agent_run_concurrency_limit', class: 'deferred', scope: 'tenant', limit: 10_000 },
    });
    hoisted.startAgentRun.mockResolvedValue({ kind: 'conflict' });
    expect((await create({ input: 'hello' })).statusCode).toBe(409);
  });

  it('stream: true runs the turn inline and answers with Responses events', async () => {
    hoisted.startAgentRun.mockImplementation(async (input: {
      execution: { onStarted: (r: unknown) => void; stream: { onTextChunk: (t: string) => void } };
    }) => {
      input.execution.onStarted(run({ _id: 'r9', mode: 'inline', status: 'running' }));
      input.execution.stream.onTextChunk('Hel');
      input.execution.stream.onTextChunk('lo');
      return {
        kind: 'completed',
        run: run({ _id: 'r9', mode: 'inline', status: 'succeeded' }),
        response: { id: 'x', object: 'response', status: 'completed', output: [], model: 'support', _conversation_messages: [] },
      };
    });
    const res = await create({ input: 'hello', stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = res.body.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.split('data: ')[1]) as Record<string, unknown>);
    expect(events.map((e) => e.type)).toEqual([
      'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done',
      'response.output_item.done', 'response.completed',
    ]);
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events[0]).toMatchObject({ response: { id: 'resp_r9', cognipeer: { run_id: 'run_r9' } } });
    expect(events[6]).toMatchObject({ text: 'Hello' });
    expect(events[9]).toMatchObject({ response: { id: 'resp_r9', status: 'completed' } });
    expect(JSON.stringify(events[9])).not.toContain('_conversation_messages');
    expect(startInput().execution).toMatchObject({ kind: 'inline', cancelOnDisconnect: false });
  });
});

describe('POST /client/v1/agents/:agentKey/runs: bodies, refusals and replays', () => {
  it('a body that is not JSON, empty, or not an object is a 400 invalid_json (the server keeps JSON bodies as strings)', async () => {
    const raw = await createFastifyApiTestApp(async (instance) => {
      instance.removeContentTypeParser('application/json');
      instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));
      await instance.register(clientAgentRunsApiPlugin);
    });
    try {
      for (const payload of ['{', '', '[1]', '"text"']) {
        const res = await raw.inject({ method: 'POST', url: '/api/client/v1/agents/support/runs', headers: HEADERS, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(parseJsonBody<{ error: { type: string; code: string } }>(res.body).error, payload).toMatchObject({ type: 'invalid_request_error', code: 'invalid_json' });
      }
      expect(hoisted.startAgentRun).not.toHaveBeenCalled();
      expect(hoisted.createConversation).not.toHaveBeenCalled();
    } finally {
      await raw.close();
    }
  });

  it('a refused start removes the session this request created, and its 429 carries Retry-After', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'concurrency_limit', limit: 250, scope: 'tenant', runClass: 'default' });
    const res = await create({ input: 'hello' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
    expect(hoisted.deleteConversation).toHaveBeenCalledWith('tenant_acme', 'conv-new');
  });

  it('a refused start on a continued session leaves that session alone', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'conflict' });
    const res = await create({ input: 'hello', session_id: 'conv-1' });
    expect(res.statusCode).toBe(409);
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.deleteConversation).not.toHaveBeenCalled();
  });

  it('stream: over the active-run cap is a plain 429 with Retry-After before the stream opens, and no session is created', async () => {
    hoisted.getDatabase.mockResolvedValue(createMockDb({
      runWithTenant: (_name: string, fn: () => unknown) => fn(),
      countActiveAgentRuns: vi.fn().mockResolvedValue(LIMITS.maxActivePerTenant),
    } as never));
    const res = await create({ input: 'hello', stream: true });
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['retry-after']).toBe('30');
    expect(parseJsonBody(res.body)).toMatchObject({ error: { type: 'rate_limit_error', code: 'agent_run_concurrency_limit', scope: 'tenant' } });
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('Idempotency-Key: a retried stream is answered as a stream (the run as it stands), not as JSON', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({
      kind: 'replay',
      run: run({ mode: 'inline', status: 'succeeded', result: { status: 'completed', output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] } }),
    });
    const res = await create({ input: 'hello', stream: true }, { 'idempotency-key': 'k1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = res.body.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.split('data: ')[1]) as { type: string; response?: Record<string, unknown> });
    expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { id: 'resp_r1', status: 'completed', output_text: 'done' } });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });
});

describe('GET /client/v1/agents/runs', () => {
  it('lists runs with every filter, newest first, as an OpenAI list with a cursor', async () => {
    hoisted.listAgentRuns.mockResolvedValue([run({ _id: 'a' }), run({ _id: 'b' }), run({ _id: 'c' })]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/agents/runs?agent=support&status=queued,running&class=deferred&session_id=conv-1&trigger_id=trg-1&channel=trigger'
        + '&metadata[ticket]=OPS-12&created_after=1760000000&created_before=2026-10-18T00:00:00Z&limit=2&after=run_z',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toMatchObject({ object: 'list', first_id: 'run_a', last_id: 'run_b', has_more: true });
    expect(parseJsonBody<{ data: unknown[] }>(res.body).data).toHaveLength(2);
    expect(hoisted.listAgentRuns).toHaveBeenCalledWith('tenant_acme', {
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      excludeModes: ['sync'],
      agentKey: 'support',
      conversationId: 'conv-1',
      status: ['queued', 'running'],
      runClass: 'deferred',
      triggerId: 'trg-1',
      channel: 'trigger',
      metadata: { ticket: 'OPS-12' },
      createdAfter: new Date(1_760_000_000_000),
      createdBefore: new Date('2026-10-18T00:00:00Z'),
      cursor: 'z',
      limit: 3,
    });
  });

  it('a caller who may not view other people\'s sessions lists only the runs they started', async () => {
    hoisted.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1' } });
    hoisted.listAgentRuns.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs', headers: HEADERS });
    expect(parseJsonBody(res.body)).toEqual({ object: 'list', data: [], first_id: null, last_id: null, has_more: false });
    expect(hoisted.listAgentRuns).toHaveBeenCalledWith('tenant_acme', expect.objectContaining({ userId: 'user-1', limit: 21 }));
  });

  it('refuses unknown filter values', async () => {
    for (const query of ['status=done', 'class=x', 'channel=fax', 'limit=101', 'created_after=yesterday',
      'metadata[a]=1&metadata[b]=2&metadata[c]=3&metadata[d]=4']) {
      const res = await app.inject({ method: 'GET', url: `/api/client/v1/agents/runs?${query}`, headers: HEADERS });
      expect(res.statusCode, query).toBe(400);
    }
    expect(hoisted.listAgentRuns).not.toHaveBeenCalled();
  });
});

describe('GET /client/v1/agents/runs/queue', () => {
  it('reports the tenant\'s and the project\'s counts per class with the limits', async () => {
    db.countAgentRunsByStatus.mockImplementation(async (_tenantId: string, opts: { runClass?: string; projectId?: string }) => (
      opts.runClass === 'default'
        ? (opts.projectId ? { running: 1, queued: 0, scheduled: 0 } : { running: 5, queued: 2, scheduled: 1 })
        : (opts.projectId ? { running: 1, queued: 3, scheduled: 0 } : { running: 2, queued: 7, scheduled: 4 })
    ));
    db.listQueuedDeferredAgentRuns.mockResolvedValue([run({ runClass: 'deferred', createdAt: CREATED })] as never);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs/queue', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({
      object: 'agent.run_queue',
      default: { running: 5, queued: 2, scheduled: 1, limit: 250 },
      deferred: { running: 2, queued: 7, scheduled: 4, running_limit: 2, queued_limit: 10_000, oldest_queued_at: Math.floor(CREATED.getTime() / 1000) },
      project: { id: 'proj-1', default: { running: 1, queued: 0, scheduled: 0 }, deferred: { running: 1, queued: 3, scheduled: 0 } },
    });
  });
});

describe('GET /client/v1/agents/runs/:runId', () => {
  it('?wait= long-polls an active run and returns it once finished', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'running' }));
    hoisted.waitForAgentRun.mockResolvedValue(run({ status: 'succeeded', result: { output_text: 'ok' } }));
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run_r1?wait=5', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toMatchObject({ status: 'succeeded', output_text: 'ok' });
    expect(hoisted.waitForAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', projectId: 'proj-1' }), 5_000, expect.any(AbortSignal));
  });

  it('without wait (or for a finished run) answers at once', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'failed', errorReason: 'agent_error', errorMessage: 'boom' }));
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run_r1?wait=5', headers: HEADERS });
    expect(parseJsonBody(res.body)).toMatchObject({ status: 'failed', error: { type: 'agent_error', message: 'boom' } });
    expect(hoisted.waitForAgentRun).not.toHaveBeenCalled();
  });

  it('a run of another project (or a sync reservation) is 404 on every run route', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(null);
    // The cancel asks the engine, which scopes by project the same way.
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'not_found' });
    for (const [method, url] of [
      ['GET', '/api/client/v1/agents/runs/run_r1'],
      ['POST', '/api/client/v1/agents/runs/run_r1/cancel'],
      ['GET', '/api/client/v1/agents/runs/run_r1/events'],
      ['GET', '/api/client/v1/agents/runs/run_r1/events/stream'],
      ['POST', '/api/client/v1/agents/runs/run_r1/actions/act-1'],
    ] as const) {
      const res = await app.inject({ method, url, headers: HEADERS, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(res.statusCode, url).toBe(404);
      expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('agent_run_not_found');
    }
    // Looked up in the caller's project only.
    for (const call of hoisted.getAgentRunStatus.mock.calls) expect(call.slice(0, 3)).toEqual(['tenant_acme', 'tenant-1', 'proj-1']);
    expect(hoisted.cancelAgentRun).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', runId: 'run_r1' });
    hoisted.getAgentRunStatus.mockResolvedValue(run({ mode: 'sync', status: 'running' }));
    expect((await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run_r1', headers: HEADERS })).statusCode).toBe(404);
  });
});

describe('POST /client/v1/agents/runs/:runId/cancel', () => {
  const cancel = () => app.inject({ method: 'POST', url: '/api/client/v1/agents/runs/run_r1/cancel', headers: HEADERS, payload: {} });

  it('a queued run is canceled at once', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run());
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'canceled', errorReason: 'canceled_by_caller' }) });
    const res = await cancel();
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toMatchObject({ status: 'canceled', error: { type: 'canceled_by_caller' } });
  });

  it('a running run comes back still running, with cancel_requested_at', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'running' }));
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'running', cancelRequestedAt: CREATED }) });
    const res = await cancel();
    expect(parseJsonBody(res.body)).toMatchObject({ status: 'running', cancel_requested_at: Math.floor(CREATED.getTime() / 1000) });
  });

  it('a paused run is settled canceled for a caller that may answer its open request', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'requires_action' }));
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'canceled' }) });
    const res = await cancel();
    expect(res.statusCode).toBe(200);
    expect(hoisted.authorizeEndingOpenRequests).toHaveBeenCalled();
    expect(parseJsonBody(res.body)).toMatchObject({ status: 'canceled' });
  });

  it('a finished run is a 409 agent_run_already_terminal', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'succeeded' }));
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'already_terminal', run: run({ status: 'succeeded' }) });
    const res = await cancel();
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody(res.body)).toMatchObject({ error: { type: 'agent_run_already_terminal', code: 'agent_run_already_terminal', status: 'succeeded' } });
  });
});

describe('the run\'s events', () => {
  it('GET …/events lists the session events this run wrote, after ?after_seq=', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'running' }));
    db.listAgentSessionEvents.mockResolvedValue([
      { seq: 5, type: 'agent.message', runId: 'r1', data: { content: 'hi' }, createdAt: CREATED },
    ] as never);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run_r1/events?after_seq=4', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({
      object: 'list',
      run_id: 'run_r1',
      session_id: 'conv-1',
      events: [{ seq: 5, type: 'agent.message', run_id: 'run_r1', data: { content: 'hi' }, created_at: CREATED.toISOString() }],
      has_more: false,
      last_seq: 5,
    });
    expect(db.listAgentSessionEvents).toHaveBeenCalledWith('conv-1', expect.objectContaining({ afterSeq: 4, runId: 'r1' }));
  });

  it('GET …/events/stream follows the same events as SSE', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'running' }));
    hoisted.followSessionEvents.mockImplementation(async (options: { write: (frame: unknown) => void }) => {
      options.write({ id: 6, event: 'agent.message', data: { seq: 6, type: 'agent.message', data: { content: 'hi' }, runId: 'r1', createdAt: CREATED.toISOString() } });
    });
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run_r1/events/stream', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id: 6\nevent: agent.message\n');
    expect(res.body).toContain('"run_id":"run_r1"');
    expect(hoisted.followSessionEvents).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', runId: 'r1' }));
  });

  it('reading the events is reading the session: a refusal there is answered before anything is read', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run());
    hoisted.refuseSessionLinked.mockResolvedValue({ ok: false, status: 403, reason: 'forbidden', need: 'view' });
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run_r1/events', headers: HEADERS });
    expect(res.statusCode).toBe(403);
    expect(db.listAgentSessionEvents).not.toHaveBeenCalled();
  });
});

describe('POST /client/v1/agents/runs/:runId/actions/:actionId', () => {
  const answer = () => app.inject({
    method: 'POST', url: '/api/client/v1/agents/runs/run_r1/actions/act-1', headers: HEADERS, payload: { decision: 'approve' },
  });

  it('resolves an action of the run\'s session through the session actions logic', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'requires_action' }));
    db.findAgentPendingActionById.mockResolvedValue({ _id: 'act-1', conversationId: 'conv-1', runId: 'r1', status: 'pending' } as never);
    hoisted.resolveAgentPendingAction.mockResolvedValue({ kind: 'queued', run: run({ _id: 'r2', status: 'queued' }) });
    const res = await answer();
    expect(res.statusCode).toBe(202);
    expect(parseJsonBody(res.body)).toMatchObject({ id: 'run_r2' });
    expect(hoisted.resolveAgentPendingAction).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1', actionId: 'act-1', projectId: 'proj-1', body: expect.objectContaining({ decision: 'approve' }),
    }));
  });

  it('an action of another session, or of another run, is 404', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue(run({ status: 'requires_action' }));
    db.findAgentPendingActionById.mockResolvedValue({ _id: 'act-1', conversationId: 'conv-2', status: 'pending' } as never);
    let res = await answer();
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('action_not_found');
    db.findAgentPendingActionById.mockResolvedValue({ _id: 'act-1', conversationId: 'conv-1', runId: 'r7', status: 'pending' } as never);
    res = await answer();
    expect(res.statusCode).toBe(404);
    expect(hoisted.resolveAgentPendingAction).not.toHaveBeenCalled();
  });
});

describe('POST /client/v1/agents/sessions/:id/cancel', () => {
  it('stops the session\'s turn and names the runs it ended', async () => {
    hoisted.cancelConversationTurn.mockResolvedValue({ cancelled: true, runIds: ['r1'], cancelledActions: false });
    const res = await app.inject({ method: 'POST', url: '/api/client/v1/agents/sessions/conv-1/cancel', headers: HEADERS, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({ object: 'agent.session.cancel', session_id: 'conv-1', cancelled: true, run_ids: ['run_r1'] });
    expect(hoisted.cancelConversationTurn).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', projectId: 'proj-1', conversationId: 'conv-1', cancelActions: true,
    }));
  });

  it('a session of another project is 404 and nothing stops', async () => {
    hoisted.getConversationById.mockResolvedValue(session({ projectId: 'proj-2' }));
    const res = await app.inject({ method: 'POST', url: '/api/client/v1/agents/sessions/conv-1/cancel', headers: HEADERS, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('session_not_found');
    expect(hoisted.cancelConversationTurn).not.toHaveBeenCalled();
  });
});

describe('request parsing helpers', () => {
  it('reads Prefer: wait=N and respond-async', () => {
    expect(parsePreferHeader('wait=10')).toEqual({ wait: 10, respondAsync: false });
    expect(parsePreferHeader('respond-async, wait=5')).toEqual({ wait: 5, respondAsync: true });
    expect(parsePreferHeader('return=minimal')).toEqual({ respondAsync: false });
    expect(parsePreferHeader(null)).toEqual({ respondAsync: false });
  });

  it('turns run_at / delay_seconds into a start time; a time already past is now', () => {
    const now = Date.UTC(2026, 9, 17);
    expect(parseRunSchedule({ delay_seconds: 60 }, now)).toEqual({ notBefore: new Date(now + 60_000) });
    expect(parseRunSchedule({ run_at: (now + 120_000) / 1000 }, now)).toEqual({ notBefore: new Date(now + 120_000) });
    expect(parseRunSchedule({ run_at: '2026-10-16T00:00:00Z' }, now)).toEqual({});
    expect(parseRunSchedule({ delay_seconds: 1.5 }, now)).toMatchObject({ param: 'delay_seconds' });
    expect(parseRunSchedule({ run_at: 'soon' }, now)).toMatchObject({ param: 'run_at' });
    expect(parseRunSchedule({ delay_seconds: 31 * 86_400 }, now)).toMatchObject({ param: 'delay_seconds' });
  });
});
