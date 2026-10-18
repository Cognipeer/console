/**
 * `POST /client/v1/responses` as a complete dialect (§5.3) at the route layer:
 * a model target is one gateway call (`handleChatCompletion`, stood in for)
 * answered as a Response object or as `response.*` events; an agent target
 * streams its run as `response.*` events, cancels it when the client goes away
 * unless `background: true`, and refuses a content part it does not take.
 * Like agent-run-routes.test.ts, what touches the database or the queue in
 * agentRunService is replaced; its pure helpers are real.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getAgentByKey: vi.fn(),
  getConversationById: vi.fn(),
  createConversation: vi.fn(),
  startAgentRun: vi.fn(),
  waitForAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  getModelByKey: vi.fn(),
  resolveAgentConfig: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  lookupIdempotentAgentRun: vi.fn(),
  resolveAgentRunLimits: vi.fn(),
  handleChatCompletion: vi.fn(),
  logModelUsage: vi.fn(),
  deleteConversation: vi.fn(),
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
  deleteConversation: hoisted.deleteConversation,
  executeAgentChat: vi.fn(),
  executePlaygroundChat: vi.fn(),
}));
vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/agentRunService')>()),
  startAgentRun: hoisted.startAgentRun,
  waitForAgentRun: hoisted.waitForAgentRun,
  getAgentRunStatus: hoisted.getAgentRunStatus,
  lookupIdempotentAgentRun: hoisted.lookupIdempotentAgentRun,
  resolveAgentRunLimits: hoisted.resolveAgentRunLimits,
}));
vi.mock('@/lib/services/models/modelService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/modelService')>()),
  getModelByKey: hoisted.getModelByKey,
}));
vi.mock('@/lib/services/models/inferenceService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/inferenceService')>()),
  handleChatCompletion: hoisted.handleChatCompletion,
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: hoisted.logModelUsage,
}));

import type { FastifyReply } from 'fastify';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createMockDb } from '../helpers/db.mock';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
import { clientAgentRunsApiPlugin } from '@/server/api/plugins/client-agent-runs';
import { createResponsesStreamWriter } from '@/server/api/plugins/agent-responses-stream';

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
const LIMITS = { syncWaitMs: 60_000, maxDurationMs: 1_800_000, maxActivePerTenant: 10, maxActivePerProject: 0 };
const MODEL = { key: 'gpt-x', projectId: 'proj-1', category: 'llm', pricing: {} };
const agent = (config: Record<string, unknown> = {}) => ({
  _id: 'agent-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'support', name: 'Support', status: 'active', config: { modelKey: 'gpt-x', ...config },
});
const run = (overrides: Record<string, unknown> = {}) => ({
  _id: 'r7', mode: 'inline', status: 'running', runClass: 'default', agentKey: 'support', conversationId: 'conv-1',
  metadata: null, responseFormat: null, createdAt: new Date('2026-10-17T10:00:00Z'), ...overrides,
});

type Frame = { event: string; data: Record<string, unknown> };
type StreamExecution = { onStarted: (run: unknown) => void; stream: { onTextChunk: (text: string) => void; onReasoningChunk?: (text: string) => void } };
const framesOf = (body: string): Frame[] => body.split('\n\n').filter((chunk) => chunk.startsWith('event: ')).map((chunk) => {
  const [eventLine, dataLine] = chunk.split('\n');
  return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> };
});
const sseSource = (payloads: unknown[]) => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.getDatabase.mockResolvedValue(createMockDb());
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.getAgentByKey.mockResolvedValue(agent());
  hoisted.createConversation.mockResolvedValue({ _id: 'conv-1' });
  hoisted.resolveAgentConfig.mockResolvedValue({ config: agent().config });
  hoisted.resolveAgentRunLimits.mockResolvedValue(LIMITS);
  hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'none' });
  hoisted.getAgentRunStatus.mockResolvedValue(null);
  hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => (key === 'gpt-x' ? MODEL : null));
  hoisted.logModelUsage.mockResolvedValue(undefined);
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientAgentsApiPlugin);
    await instance.register(clientAgentRunsApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
});

const post = (payload: Record<string, unknown>, url = '/api/client/v1/responses') => app.inject({ method: 'POST', url, headers: HEADERS, payload });
const error = (res: { body: string }) => parseJsonBody<{ error: Record<string, unknown> }>(res.body).error;

describe('POST /responses — a model target', () => {
  it('sync: one gateway call with the translated request, answered as a Response object that is not stored', async () => {
    hoisted.handleChatCompletion.mockResolvedValue({
      requestId: 'req-1',
      response: {
        id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'Bonjour' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });
    const res = await post({ model: 'gpt-x', instructions: 'Answer in French.', input: 'Hello', max_output_tokens: 50, metadata: { ticket: 'T-1' }, store: true });
    expect(res.statusCode, res.body).toBe(200);
    const body = parseJsonBody<Record<string, unknown>>(res.body);
    expect(body).toMatchObject({
      object: 'response', status: 'completed', model: 'gpt-x', output_text: 'Bonjour', metadata: { ticket: 'T-1' },
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 }, store: false,
    });
    expect(body.id).toMatch(/^resp_[0-9a-f]{32}$/);
    expect(hoisted.handleChatCompletion).toHaveBeenCalledTimes(1);
    expect(hoisted.handleChatCompletion.mock.calls[0][0]).toMatchObject({
      modelKey: 'gpt-x',
      route: 'responses',
      stream: false,
      body: { model: 'gpt-x', max_tokens: 50, messages: [{ role: 'system', content: 'Answer in French.' }, { role: 'user', content: 'Hello' }] },
    });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();

    // Not stored: the id it just answered with does not read back.
    const read = await app.inject({ method: 'GET', url: `/api/client/v1/responses/${String(body.id)}`, headers: HEADERS });
    expect(read.statusCode).toBe(404);
    expect(error(read).code).toBe('response_not_found');
  });

  it('stream: chat chunks become response.* events with sequence numbers, the full object on response.completed', async () => {
    hoisted.handleChatCompletion.mockResolvedValue({
      requestId: 'req-2',
      stream: sseSource([
        { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'Bon' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'jour' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ]),
    });
    const res = await post({ model: 'gpt-x', input: 'Hello', stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(hoisted.handleChatCompletion.mock.calls[0][0]).toMatchObject({ stream: true, body: { stream: true, stream_options: { include_usage: true } } });
    const frames = framesOf(res.body);
    expect(frames.map((f) => f.event)).toEqual([
      'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done',
      'response.output_item.done', 'response.completed',
    ]);
    expect(frames.map((f) => f.data.sequence_number)).toEqual(frames.map((_, i) => i));
    expect(frames[9].data.response).toMatchObject({ status: 'completed', output_text: 'Bonjour', usage: { total_tokens: 7 } });
  });

  it('refuses what a model does not take (400 OpenAI envelope) before any gateway call', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ previous_response_id: 'resp_1' }, 'unsupported_parameter', 'previous_response_id'],
      [{ conversation: 'conv-1' }, 'unsupported_parameter', 'conversation'],
      [{ background: true }, 'unsupported_parameter', 'background'],
      [{ tools: [{ type: 'file_search' }] }, 'unsupported_parameter', 'tools'],
      [{ input: [{ role: 'user', content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,QUJD' }] }] }, 'unsupported_content_part', 'input'],
      [{ metadata: { 'bad key': 'x' } }, 'invalid_metadata', 'metadata'],
    ];
    for (const [extra, code, param] of cases) {
      const res = await post({ model: 'gpt-x', input: 'Hello', ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(error(res)).toMatchObject({ type: 'invalid_request_error', code, param });
    }
    expect(hoisted.handleChatCompletion).not.toHaveBeenCalled();
  });

  it('an upstream failure keeps its status, in the OpenAI envelope, and is logged on the model under the responses route', async () => {
    hoisted.handleChatCompletion.mockRejectedValue(Object.assign(new Error('Rate limit reached for gpt-x'), { status: 429 }));
    const res = await post({ model: 'gpt-x', input: 'Hello' });
    expect(res.statusCode).toBe(429);
    expect(error(res)).toMatchObject({ message: expect.stringContaining('Rate limit'), param: null });
    expect(hoisted.logModelUsage).toHaveBeenCalledWith('tenant_acme', MODEL, expect.objectContaining({ route: 'responses', status: 'error' }));
  });
});

describe('POST /responses — an agent target, streamed', () => {
  const streamed = (onRun?: (input: { execution: StreamExecution }) => void) => {
    hoisted.startAgentRun.mockImplementation(async (input: { execution: StreamExecution }) => {
      input.execution.onStarted(run());
      input.execution.stream.onReasoningChunk?.('Thinking');
      input.execution.stream.onTextChunk('Hel');
      input.execution.stream.onTextChunk('lo');
      onRun?.(input);
      return {
        kind: 'completed',
        run: run({ status: 'succeeded', metadata: { ticket: 'T-9' } }),
        response: {
          id: 'x', object: 'response', status: 'completed', model: 'support', _conversation_messages: [],
          output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [{ type: 'file_citation', file_id: 'f1' }] }] }],
          output_files: [{ id: 'f1', name: 'report.md' }],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      };
    });
  };

  it('emits the §5.3 sequence (reasoning item, message item) and closes with the full object', async () => {
    streamed();
    const res = await post({ model: 'agent:support', input: 'hello', stream: true, metadata: { ticket: 'T-9' }, temperature: 0.3 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // The header the route set before the stream opened is on the stream.
    expect(res.headers['x-cognipeer-ignored-params']).toBe('temperature');
    const frames = framesOf(res.body);
    expect(frames.map((f) => f.event)).toEqual([
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.completed',
    ]);
    expect(frames.map((f) => f.data.sequence_number)).toEqual(frames.map((_, i) => i));
    expect(frames[0].data.response).toMatchObject({ id: 'resp_r7', status: 'in_progress', model: 'agent:support', cognipeer: { run_id: 'run_r7', session_id: 'conv-1' } });
    expect(frames[15].data.response).toMatchObject({
      id: 'resp_r7',
      status: 'completed',
      output_text: 'Hello',
      output_files: [{ id: 'f1', name: 'report.md' }],
      metadata: { ticket: 'T-9' },
      background: false,
      output: [{ content: [{ annotations: [{ type: 'file_citation', file_id: 'f1' }] }] }],
    });
    expect(res.body).not.toContain('_conversation_messages');
    const input = hoisted.startAgentRun.mock.calls[0][0] as { execution: Record<string, unknown>; channel: string };
    expect(input.channel).toBe('responses');
    expect(input.execution).toMatchObject({ kind: 'inline', cancelOnDisconnect: true });
    expect(input.execution.signal).toBeInstanceOf(AbortSignal);
  });

  it('background: true streams inline too, but a disconnect leaves the run going (detached)', async () => {
    streamed();
    const res = await post({ model: 'agent:support', input: 'hello', stream: true, background: true });
    expect(res.statusCode).toBe(200);
    expect(hoisted.startAgentRun.mock.calls[0][0].execution).toMatchObject({ kind: 'inline', cancelOnDisconnect: false });
    expect(framesOf(res.body).at(-1)!.data.response).toMatchObject({ background: true });
  });

  it('background: true is kept on the run, so GET /responses/{id} reads it back (a plain stream reads false)', async () => {
    streamed();
    await post({ model: 'agent:support', input: 'hello', stream: true, background: true });
    await post({ model: 'agent:support', input: 'hello', stream: true });
    const [asked, plain] = hoisted.startAgentRun.mock.calls.map(([input]) => input as { background?: boolean });
    expect(asked.background).toBe(true);
    expect(plain.background).toBeUndefined();

    for (const [row, expected] of [[run({ status: 'succeeded', background: true }), true], [run({ status: 'succeeded' }), false]] as const) {
      hoisted.getAgentRunStatus.mockResolvedValue(row);
      for (const url of ['/api/client/v1/responses/resp_r7', '/api/client/v1/agents/responses/resp_r7']) {
        const res = await app.inject({ method: 'GET', url, headers: HEADERS });
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ id: 'resp_r7', background: expected });
      }
    }
  });

  it('include_reasoning: false streams no reasoning item', async () => {
    streamed();
    const res = await post({ model: 'agent:support', input: 'hello', stream: true, include_reasoning: false });
    expect(hoisted.startAgentRun.mock.calls[0][0].execution.stream.onReasoningChunk).toBeUndefined();
    expect(framesOf(res.body).some((f) => f.event.startsWith('response.reasoning_summary'))).toBe(false);
  });

  it('a failed turn is an error event, then response.failed with the run object', async () => {
    hoisted.startAgentRun.mockImplementation(async (input: { execution: StreamExecution }) => {
      input.execution.onStarted(run());
      input.execution.stream.onTextChunk('Par');
      throw new Error('provider exploded');
    });
    const res = await post({ model: 'agent:support', input: 'hello', stream: true });
    const frames = framesOf(res.body);
    expect(frames.map((f) => f.event).slice(-2)).toEqual(['error', 'response.failed']);
    expect(frames.at(-1)!.data.response).toMatchObject({ id: 'resp_r7', status: 'failed', error: { message: expect.any(String) } });
  });

  it('a refused start (409 busy session) is an error event', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'conflict' });
    const frames = framesOf((await post({ model: 'agent:support', input: 'hello', stream: true })).body);
    expect(frames.map((f) => f.event)).toEqual(['error']);
    expect(frames[0].data).toMatchObject({ sequence_number: 0, code: expect.any(String) });
  });

  it('stream with service_tier "flex" is refused: a deferred run has no turn to stream yet', async () => {
    const res = await post({ model: 'agent:support', input: 'hello', stream: true, service_tier: 'flex' });
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({ code: 'unsupported_parameter', param: 'service_tier' });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });
});

describe('POST /responses — bodies, admission and refusals', () => {
  it('a body that is not JSON, empty, or not an object is a 400 invalid_json in the OpenAI envelope (bodies arrive as strings)', async () => {
    const raw = await createFastifyApiTestApp(async (instance) => {
      instance.removeContentTypeParser('application/json');
      instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));
      await instance.register(clientAgentsApiPlugin);
    });
    try {
      for (const url of ['/api/client/v1/responses', '/api/client/v1/agents/responses']) {
        for (const payload of ['{', '', '[]']) {
          const res = await raw.inject({ method: 'POST', url, headers: HEADERS, payload });
          expect(res.statusCode, `${url} ${JSON.stringify(payload)}`).toBe(400);
          expect(error(res), url).toMatchObject({ type: 'invalid_request_error', code: 'invalid_json' });
        }
      }
      expect(hoisted.startAgentRun).not.toHaveBeenCalled();
      expect(hoisted.handleChatCompletion).not.toHaveBeenCalled();
    } finally {
      await raw.close();
    }
  });

  it('stream over the active-run cap: a plain 429 with Retry-After before the stream opens, no session created', async () => {
    hoisted.getDatabase.mockResolvedValue(createMockDb({ countActiveAgentRuns: vi.fn().mockResolvedValue(LIMITS.maxActivePerTenant) } as never));
    const res = await post({ model: 'agent:support', input: 'hello', stream: true });
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['retry-after']).toBe('30');
    expect(error(res)).toMatchObject({ type: 'rate_limit_error', code: 'agent_run_concurrency_limit' });
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('a refused start removes the session the request created: sync (429 + Retry-After) and stream (409 error event)', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'concurrency_limit', limit: 10, scope: 'tenant', runClass: 'default' });
    const res = await post({ model: 'agent:support', input: 'hello' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
    expect(hoisted.deleteConversation).toHaveBeenCalledWith('tenant_acme', 'conv-1');

    hoisted.deleteConversation.mockClear();
    hoisted.startAgentRun.mockResolvedValue({ kind: 'conflict' });
    await post({ model: 'agent:support', input: 'hello', stream: true });
    expect(hoisted.deleteConversation).toHaveBeenCalledWith('tenant_acme', 'conv-1');
  });

  it('a refused start on a continued session leaves the session alone', async () => {
    hoisted.getConversationById.mockResolvedValue({ _id: 'conv-9', agentKey: 'support', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    hoisted.startAgentRun.mockResolvedValue({ kind: 'conflict' });
    const res = await post({ model: 'agent:support', input: 'hello', conversation: 'conv-9' });
    expect(res.statusCode).toBe(409);
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.deleteConversation).not.toHaveBeenCalled();
  });
});

describe('GET /responses/{id} — the object read back', () => {
  const read = async (row: Record<string, unknown>) => {
    hoisted.getAgentRunStatus.mockResolvedValue(row);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/responses/resp_r7', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    return parseJsonBody<Record<string, any>>(res.body);
  };

  it('background is what the Responses request asked for: a flex call is queued but not background', async () => {
    expect(await read(run({ channel: 'responses', mode: 'background', runClass: 'deferred', status: 'queued' }))).toMatchObject({ service_tier: 'flex', background: false });
    expect(await read(run({ channel: 'responses', mode: 'background', runClass: 'deferred', status: 'queued', background: true }))).toMatchObject({ background: true });
    // A run another surface queued is background.
    expect(await read(run({ channel: 'runs', mode: 'background', status: 'queued' }))).toMatchObject({ background: true });
  });

  it('usage carries its detail objects, zero when the run did not report them', async () => {
    const usage = (await read(run({ status: 'succeeded', result: { status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }))).usage;
    expect(usage).toEqual({ input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
    const reported = (await read(run({
      status: 'succeeded',
      result: { status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } } },
    }))).usage;
    expect(reported).toMatchObject({ input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } });
  });
});

describe('POST /responses — agent input parts', () => {
  it('an unsupported part type is a 400 unsupported_content_part, before a session is created', async () => {
    const res = await post({
      model: 'agent:support',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'listen' }, { type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } }] }],
    });
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({ type: 'invalid_request_error', code: 'unsupported_content_part', param: 'input' });
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('every input_text part of the last user message is the message, joined with a blank line', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: run({ status: 'succeeded' }), response: { id: 'x', object: 'response', status: 'completed', output: [] } });
    await post({ model: 'agent:support', input: [{ role: 'user', content: [{ type: 'input_text', text: 'one' }, { type: 'input_text', text: 'two' }] }] });
    expect(hoisted.startAgentRun.mock.calls[0][0]).toMatchObject({ userMessage: 'one\n\ntwo' });
  });
});

describe('the Responses stream writer', () => {
  const fakeReply = () => {
    const raw = Object.assign(new EventEmitter(), {
      statusCode: 0,
      writableEnded: false,
      headers: {} as Record<string, unknown>,
      written: [] as string[],
      setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = value; },
      flushHeaders() {},
      write(chunk: string) { this.written.push(chunk); return true; },
      end() { this.writableEnded = true; },
    });
    return { raw, reply: { raw, getHeaders: () => ({ 'x-cognipeer-ignored-params': 'tools' }) } as unknown as FastifyReply };
  };

  it('aborts its signal when the client goes away (the run is then cancelled or detached) and writes nothing more', () => {
    const { raw, reply } = fakeReply();
    const writer = createResponsesStreamWriter(reply);
    expect(raw.headers).toMatchObject({ 'content-type': 'text/event-stream', 'x-cognipeer-ignored-params': 'tools' });
    writer.started({ id: 'resp_1' });
    expect(writer.signal.aborted).toBe(false);
    raw.emit('close');
    expect(writer.signal.aborted).toBe(true);
    const before = raw.written.length;
    writer.text('late');
    expect(raw.written.length).toBe(before);
    writer.end();
  });

  it('sends a : ping comment every 15 s while the turn is quiet', () => {
    vi.useFakeTimers();
    try {
      const { raw, reply } = fakeReply();
      const writer = createResponsesStreamWriter(reply);
      vi.advanceTimersByTime(15_000);
      expect(raw.written).toContain(': ping\n\n');
      writer.end();
      const count = raw.written.length;
      vi.advanceTimersByTime(30_000);
      expect(raw.written.length).toBe(count);
    } finally {
      vi.useRealTimers();
    }
  });
});
