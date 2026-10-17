/**
 * `POST /client/v1/chat/completions` with an agent as the model, as a complete dialect (§5.4) at the route layer:
 * the session (conversation_id, X-Cognipeer-Session-Id, or the transcript the client resends), the last user
 * message's text and files, response_format, stream quality (role chunk, usage chunk, error chunk, disconnect),
 * `service_tier: "flex"`, Idempotency-Key, metadata and the 202 past the wait window. Like the Responses route
 * tests, what touches the database or the queue in agentRunService is replaced; the route, the bridge and the
 * transcript matching are real.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getAgentByKey: vi.fn(),
  getConversationById: vi.fn(),
  createConversation: vi.fn(),
  startAgentRun: vi.fn(),
  waitForAgentRun: vi.fn(),
  lookupIdempotentAgentRun: vi.fn(),
  resolveAgentRunLimits: vi.fn(),
  resolveAgentConfig: vi.fn(),
  getModelByKey: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  decideSessionAccess: vi.fn(),
  refuseCancelPending: vi.fn(),
  storeResponseInputFiles: vi.fn(),
  assertQueuedTurnSpendAllowed: vi.fn(),
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
  deleteConversation: vi.fn(),
  executeAgentChat: vi.fn(),
  executePlaygroundChat: vi.fn(),
}));
vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/agentRunService')>()),
  startAgentRun: hoisted.startAgentRun,
  waitForAgentRun: hoisted.waitForAgentRun,
  lookupIdempotentAgentRun: hoisted.lookupIdempotentAgentRun,
  resolveAgentRunLimits: hoisted.resolveAgentRunLimits,
}));
vi.mock('@/lib/services/agents/agentSpendLimits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/agentSpendLimits')>()),
  assertQueuedTurnSpendAllowed: hoisted.assertQueuedTurnSpendAllowed,
}));
vi.mock('@/lib/services/agents/responseInputFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/responseInputFiles')>()),
  storeResponseInputFiles: hoisted.storeResponseInputFiles,
}));
vi.mock('@/lib/services/models/modelService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/modelService')>()),
  getModelByKey: hoisted.getModelByKey,
}));
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>()),
  decideSessionAccess: hoisted.decideSessionAccess,
}));
vi.mock('@/server/api/plugins/agent-approval-authz', () => ({
  refuseCancelPending: hoisted.refuseCancelPending,
  approvalAuthorizerFor: () => async () => ({ allowed: true }),
  CANCEL_PENDING_FORBIDDEN_MESSAGE: 'sending a message would cancel the open request',
}));

import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createMockDb } from '../helpers/db.mock';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';
import { transcriptDigestAfterTurn } from '@/lib/services/agents/chatTranscript';

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
const ATTACHMENTS = { attachments: { enabled: true, bucketKey: 'files' } };
const agent = (config: Record<string, unknown> = {}) => ({
  _id: 'agent-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'support', name: 'Support', status: 'active', config: { modelKey: 'gpt-x', ...config },
});
const run = (overrides: Record<string, unknown> = {}) => ({
  _id: 'r7', mode: 'inline', status: 'running', runClass: 'default', agentKey: 'support', conversationId: 'conv-1',
  metadata: null, responseFormat: null, createdAt: new Date('2026-10-17T10:00:00Z'), ...overrides,
});
const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  id: 'x', object: 'response', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  ...extra,
});
const completed = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'completed', run: run({ status: 'succeeded' }), response: reply(text, extra) });
const user = (content: unknown) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: '/api/client/v1/chat/completions', headers: { ...HEADERS, ...headers }, payload: { model: 'agent:support', ...payload },
});
const error = (res: { body: string }) => parseJsonBody<{ error: Record<string, unknown> }>(res.body).error;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runInput = (call = 0) => hoisted.startAgentRun.mock.calls[call][0] as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chunksOf = (body: string) => body.split('\n\n').filter((block) => block.startsWith('data: {')).map((block) => JSON.parse(block.slice(6)) as Record<string, any>);

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
/** What the database remembers: the transcript digest per session, and the sessions that exist. */
let hashes: Map<string, string>;
let conversations: Map<string, Record<string, unknown>>;

beforeEach(async () => {
  vi.clearAllMocks();
  hashes = new Map();
  conversations = new Map();
  let created = 0;
  hoisted.getDatabase.mockResolvedValue(createMockDb({
    runWithTenant: <T>(_name: string, fn: () => T) => fn(),
    updateAgentConversationRuntime: vi.fn(async (id: string, patch: { transcriptHash?: string }) => { if (patch.transcriptHash) hashes.set(id, patch.transcriptHash); return true; }),
    findAgentConversationByTranscriptHash: vi.fn(async (filter: { transcriptHash: string; createdBy: string }) => {
      const found = [...hashes].find(([, hash]) => hash === filter.transcriptHash);
      return found && filter.createdBy === 'user-1' ? { _id: found[0] } : null;
    }),
  } as never));
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.getAgentByKey.mockResolvedValue(agent());
  hoisted.createConversation.mockImplementation(async () => {
    created += 1;
    const conversation = { _id: `conv-${created}`, agentKey: 'support', projectId: 'proj-1', createdBy: 'user-1', messages: [] };
    conversations.set(conversation._id, conversation);
    return conversation;
  });
  hoisted.getConversationById.mockImplementation(async (_db: string, id: string) => conversations.get(id) ?? null);
  hoisted.resolveAgentConfig.mockResolvedValue({ config: agent().config });
  hoisted.resolveAgentRunLimits.mockResolvedValue(LIMITS);
  hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'none' });
  hoisted.getModelByKey.mockResolvedValue(null);
  hoisted.decideSessionAccess.mockResolvedValue({ ok: true, userId: 'user-1', owner: true });
  hoisted.refuseCancelPending.mockResolvedValue(null);
  hoisted.storeResponseInputFiles.mockResolvedValue({ attachments: ['file-1'], named: [] });
  hoisted.assertQueuedTurnSpendAllowed.mockResolvedValue(undefined);
  hoisted.startAgentRun.mockResolvedValue(completed('ok'));
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientInferenceApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
});

describe('the session of an agent chat completion', () => {
  it('a client that resends its transcript continues its session across three turns, whatever system prompt it sends', async () => {
    const u1 = user('first question');
    hoisted.startAgentRun.mockResolvedValueOnce(completed('first answer'));
    const t1 = await post({ messages: [{ role: 'system', content: 'You are helpful' }, u1] });
    expect(t1.statusCode).toBe(200);
    expect(t1.headers['x-cognipeer-session-id']).toBe('conv-1');
    expect(parseJsonBody<{ conversation_id: string }>(t1.body).conversation_id).toBe('conv-1');
    // the digest the session remembers is the transcript without the system message, plus the answer
    expect(hashes.get('conv-1')).toBe(transcriptDigestAfterTurn([u1], 'first answer'));

    hoisted.startAgentRun.mockResolvedValueOnce(completed('second answer'));
    const t2 = await post({ messages: [{ role: 'system', content: 'A different prompt' }, u1, assistant('first answer'), user('second question')] });
    expect(t2.headers['x-cognipeer-session-id']).toBe('conv-1');
    expect(hoisted.createConversation).toHaveBeenCalledTimes(1);
    expect(runInput(1)).toMatchObject({ conversationId: 'conv-1', userMessage: 'second question' });

    hoisted.startAgentRun.mockResolvedValueOnce(completed('third answer'));
    const t3 = await post({ messages: [u1, assistant('first answer'), user('second question'), assistant('second answer'), user([{ type: 'text', text: 'third question' }])] });
    expect(t3.headers['x-cognipeer-session-id']).toBe('conv-1');
    expect(parseJsonBody<{ conversation_id: string }>(t3.body).conversation_id).toBe('conv-1');
    expect(hoisted.createConversation).toHaveBeenCalledTimes(1);
    expect(runInput(2)).toMatchObject({ conversationId: 'conv-1', userMessage: 'third question' });
    expect(hashes.get('conv-1')).toBe(transcriptDigestAfterTurn([u1, assistant('first answer'), user('second question'), assistant('second answer'), user('third question')], 'third answer'));
  });

  it('a transcript that matches nothing starts a new session, and the first turn of a client never looks one up', async () => {
    await post({ messages: [user('hello')] });
    // same first turn, different history: nothing remembered ends in it
    await post({ messages: [user('hello'), assistant('something else'), user('and then?')] });
    expect(hoisted.createConversation).toHaveBeenCalledTimes(2);
    expect(runInput(1).conversationId).toBe('conv-2');
  });

  it('continues the session a caller names: conversation_id, or the X-Cognipeer-Session-Id header', async () => {
    await post({ messages: [user('hello')] });
    const byBody = await post({ messages: [user('more')], conversation_id: 'conv-1' });
    const byHeader = await post({ messages: [user('more')] }, { 'x-cognipeer-session-id': 'conv-1' });
    expect(byBody.headers['x-cognipeer-session-id']).toBe('conv-1');
    expect(byHeader.headers['x-cognipeer-session-id']).toBe('conv-1');
    expect(hoisted.createConversation).toHaveBeenCalledTimes(1);
    expect(runInput(1).conversationId).toBe('conv-1');
    expect(runInput(2).conversationId).toBe('conv-1');
  });

  it('refuses two different named sessions, and a session that is not this agent\'s', async () => {
    await post({ messages: [user('hello')] });
    const conflict = await post({ messages: [user('more')], conversation_id: 'conv-1' }, { 'x-cognipeer-session-id': 'conv-9' });
    expect(conflict.statusCode).toBe(400);
    expect(error(conflict)).toMatchObject({ code: 'session_conflict' });
    const missing = await post({ messages: [user('more')], conversation_id: 'conv-9' });
    expect(missing.statusCode).toBe(404);
    expect(error(missing)).toMatchObject({ code: 'session_not_found', param: 'conversation_id' });
    conversations.set('conv-x', { _id: 'conv-x', agentKey: 'someone-else', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    expect((await post({ messages: [user('more')], conversation_id: 'conv-x' })).statusCode).toBe(404);
    expect(hoisted.startAgentRun).toHaveBeenCalledTimes(1);
  });

  it('a session found by its transcript is checked like a named one (the caller\'s right to continue it)', async () => {
    await post({ messages: [user('hello')] });
    hoisted.decideSessionAccess.mockResolvedValue({ ok: false, status: 403, reason: 'forbidden', need: 'manage' });
    hoisted.startAgentRun.mockClear();
    const res = await post({ messages: [user('hello'), assistant('ok'), user('more')] });
    expect(res.statusCode).toBe(403);
    expect(error(res)).toMatchObject({ code: 'session_forbidden' });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('answering a tool call needs the session named: there is no transcript to match', async () => {
    const res = await post({ messages: [user('go'), { role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', tool_call_id: 'act_1', content: 'x' }] });
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({ code: 'missing_conversation_id' });
  });
});

describe('the message of an agent chat completion', () => {
  it('every text part of the last user message is the message, joined with a blank line; system messages are ignored', async () => {
    await post({ messages: [{ role: 'system', content: 'ignored' }, user('earlier'), assistant('ok'), user([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])] });
    expect(runInput()).toMatchObject({ userMessage: 'one\n\ntwo' });
  });

  it('an image-only message is a message: no text, the image is a file of the session, an earlier message is not used', async () => {
    hoisted.getAgentByKey.mockResolvedValue(agent(ATTACHMENTS));
    const res = await post({
      messages: [user('describe things'), assistant('sure'), user([{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }])],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(runInput()).toMatchObject({ userMessage: '', attachments: ['file-1'] });
    const stored = hoisted.storeResponseInputFiles.mock.calls[0][0] as { files: Array<{ kind: string; data?: string }> };
    expect(stored.files).toEqual([{ kind: 'image', data: 'data:image/png;base64,iVBORw0KGgo=' }]);
  });

  it('a file part (file_data) is a file of the session too', async () => {
    hoisted.getAgentByKey.mockResolvedValue(agent(ATTACHMENTS));
    await post({ messages: [user([{ type: 'text', text: 'summarize' }, { type: 'file', file: { filename: 'a.txt', file_data: 'data:text/plain;base64,aGk=' } }])] });
    expect(runInput()).toMatchObject({ userMessage: 'summarize', attachments: ['file-1'] });
    expect((hoisted.storeResponseInputFiles.mock.calls[0][0] as { files: unknown[] }).files).toEqual([{ kind: 'file', data: 'data:text/plain;base64,aGk=', filename: 'a.txt' }]);
  });

  it('files on an agent that takes no attachments are 403 in the OpenAI envelope, before a session exists', async () => {
    const res = await post({ messages: [user([{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }])] });
    expect(res.statusCode).toBe(403);
    expect(error(res)).toMatchObject({ type: 'invalid_request_error', code: 'attachments_disabled', param: null });
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });

  it('a part type the API does not take is 400 unsupported_content_part; no user message at all is 400', async () => {
    const audio = await post({ messages: [user([{ type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } }])] });
    expect(audio.statusCode).toBe(400);
    expect(error(audio)).toMatchObject({ code: 'unsupported_content_part' });
    const none = await post({ messages: [assistant('only an answer')] });
    expect(none.statusCode).toBe(400);
    expect(error(none)).toMatchObject({ code: 'missing_messages', param: 'messages' });
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });

  it('lists the parameters an agent ignores in X-Cognipeer-Ignored-Params', async () => {
    const res = await post({ messages: [user('hi')], temperature: 0.2, max_tokens: 50, tools: [], seed: 1 });
    expect(res.headers['x-cognipeer-ignored-params']).toBe('temperature,max_tokens,tools,seed');
    expect((await post({ messages: [user('hi')] })).headers['x-cognipeer-ignored-params']).toBeUndefined();
  });

  it('metadata becomes the run\'s metadata; a malformed one is 400 before a run exists', async () => {
    await post({ messages: [user('hi')], metadata: { ticket: 'OPS-12' } });
    expect(runInput().metadata).toEqual({ ticket: 'OPS-12' });
    const bad = await post({ messages: [user('hi')], metadata: { nested: { a: 1 } } });
    expect(bad.statusCode).toBe(400);
    expect(error(bad)).toMatchObject({ code: 'invalid_metadata', param: 'metadata' });
    expect(hoisted.startAgentRun).toHaveBeenCalledTimes(1);
  });
});

describe('response_format on an agent chat completion', () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

  it('is handed to the run, and the answer is the JSON string of the parsed output', async () => {
    hoisted.startAgentRun.mockResolvedValue(completed('{"city":"Ankara"}', { output_parsed: { city: 'Ankara' } }));
    const res = await post({ messages: [user('capital of Turkey?')], response_format: { type: 'json_schema', json_schema: { name: 'capital', schema, strict: true } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(runInput().responseFormat).toEqual({ type: 'json_schema', name: 'capital', schema, strict: true });
    const body = parseJsonBody<{ choices: Array<{ message: { content: string } }> }>(res.body);
    expect(JSON.parse(body.choices[0].message.content)).toEqual({ city: 'Ankara' });
  });

  it('json_object is handed over; a schema the converter cannot use is 400 invalid_response_format', async () => {
    await post({ messages: [user('hi')], response_format: { type: 'json_object' } });
    expect(runInput().responseFormat).toEqual({ type: 'json_object' });
    const bad = await post({ messages: [user('hi')], response_format: { type: 'json_schema', json_schema: { name: 'x' } } });
    expect(bad.statusCode).toBe(400);
    expect(error(bad)).toMatchObject({ code: 'invalid_response_format', param: 'response_format' });
  });
});

describe('streaming an agent chat completion', () => {
  const streamed = (usage = true) => hoisted.startAgentRun.mockImplementation(async (input: { execution: { stream: { onTextChunk: (t: string) => void } } }) => {
    input.execution.stream.onTextChunk('Hel');
    input.execution.stream.onTextChunk('lo');
    return completed('Hello', usage ? {} : { usage: undefined });
  });

  it('opens with the assistant role, names the session on the first and the last chunk, and ends with [DONE]', async () => {
    streamed();
    const res = await post({ messages: [user('hi')], stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-cognipeer-session-id']).toBe('conv-1');
    const chunks = chunksOf(res.body);
    expect(chunks[0]).toMatchObject({ object: 'chat.completion.chunk', conversation_id: 'conv-1', choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    expect(chunks.slice(1, -1).map((c) => c.choices[0].delta.content).join('')).toBe('Hello');
    expect(chunks.at(-1)).toMatchObject({ conversation_id: 'conv-1', choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // no usage chunk unless it was asked for
    expect(chunks.some((c) => c.usage)).toBe(false);
  });

  it('stream_options.include_usage adds one more chunk after the last: no choices, the run\'s usage', async () => {
    streamed();
    const res = await post({ messages: [user('hi')], stream: true, stream_options: { include_usage: true } });
    const chunks = chunksOf(res.body);
    expect(chunks.at(-1)).toMatchObject({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    expect(chunks.at(-2)!.choices[0].finish_reason).toBe('stop');
    expect(chunks.filter((c) => c.usage)).toHaveLength(1);
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('a failed run is an error chunk, then [DONE]; so is a refused start', async () => {
    hoisted.startAgentRun.mockRejectedValue(new Error('provider exploded'));
    const failed = await post({ messages: [user('hi')], stream: true });
    expect(chunksOf(failed.body).at(-1)).toMatchObject({ error: { message: expect.any(String) } });
    expect(failed.body.trimEnd().endsWith('data: [DONE]')).toBe(true);

    hoisted.startAgentRun.mockResolvedValue({ kind: 'conflict' });
    const busy = await post({ messages: [user('hi')], stream: true });
    expect(chunksOf(busy.body).at(-1)).toMatchObject({ error: { type: 'agent_run_conflict', code: 'agent_run_conflict' } });
    expect(busy.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('a client that goes away cancels the run (the signal aborts), a plain call\'s run carries on', async () => {
    let signal: AbortSignal | undefined;
    hoisted.startAgentRun.mockImplementation(async (input: { execution: { signal: AbortSignal; stream: { onTextChunk: (t: string) => void } } }) => {
      signal = input.execution.signal;
      input.execution.stream.onTextChunk('partial');
      await new Promise<void>((resolve) => input.execution.signal.addEventListener('abort', () => resolve()));
      return completed('partial');
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/client/v1/chat/completions', headers: HEADERS }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => undefined);
      req.end(JSON.stringify({ model: 'agent:support', messages: [user('hi')], stream: true }));
      setTimeout(() => reject(new Error('no first chunk')), 5_000).unref();
    });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(runInput().execution).toMatchObject({ kind: 'inline', cancelOnDisconnect: true });

    hoisted.startAgentRun.mockReset().mockResolvedValue(completed('ok'));
    await post({ messages: [user('hi')] });
    expect(runInput().execution).toMatchObject({ kind: 'inline', cancelOnDisconnect: false });
  });

  it('sends a : ping comment every 15 s while quiet (the shared connection)', async () => {
    vi.useFakeTimers();
    try {
      const { openSseConnection } = await import('@/server/api/plugins/sse-connection');
      const written: string[] = [];
      const raw = Object.assign(new (await import('node:events')).EventEmitter(), {
        writableEnded: false, statusCode: 0, setHeader() {}, flushHeaders() {}, end() { this.writableEnded = true; },
        write(chunk: string) { written.push(chunk); return true; },
      });
      const connection = openSseConnection({ raw, getHeaders: () => ({}) } as never);
      vi.advanceTimersByTime(15_000);
      expect(written).toContain(': ping\n\n');
      connection.end();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('service_tier flex on an agent chat completion', () => {
  it('queues the run in the deferred class and waits for it up to the window', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'queued', runClass: 'deferred', mode: 'background' }) });
    hoisted.waitForAgentRun.mockResolvedValue(run({ status: 'succeeded', runClass: 'deferred', result: reply('done later') }));
    const res = await post({ messages: [user('hi')], service_tier: 'flex' });
    expect(res.statusCode, res.body).toBe(200);
    expect(runInput()).toMatchObject({ runClass: 'deferred', execution: { kind: 'queued' } });
    expect(hoisted.waitForAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r7' }), LIMITS.syncWaitMs);
    expect(parseJsonBody<{ choices: Array<{ message: { content: string } }> }>(res.body).choices[0].message.content).toBe('done later');
    expect(hoisted.assertQueuedTurnSpendAllowed).toHaveBeenCalled();
  });

  it('answers 202 naming the queued run when the window ends first; a stream cannot be flex', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'queued', runClass: 'deferred' }) });
    hoisted.waitForAgentRun.mockResolvedValue(run({ status: 'queued', runClass: 'deferred' }));
    const res = await post({ messages: [user('hi')], service_tier: 'flex' });
    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe('/api/client/v1/agents/runs/run_r7');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ choices: [], cognipeer: { status: 'queued', run_id: 'run_r7', session_id: 'conv-1' } });

    const stream = await post({ messages: [user('hi')], service_tier: 'flex', stream: true });
    expect(stream.statusCode).toBe(400);
    expect(error(stream)).toMatchObject({ code: 'unsupported_parameter', param: 'service_tier' });
  });

  it('any other tier runs in the default class', async () => {
    await post({ messages: [user('hi')], service_tier: 'auto' });
    expect(runInput()).toMatchObject({ execution: { kind: 'inline' } });
    expect(runInput().runClass).toBe('default');
  });
});

describe('the wait window of an agent chat completion', () => {
  it('past it the answer is 202 with an empty chat.completion naming the run, and Location on the runs API', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'detached', run: run() });
    const res = await post({ messages: [user('hi')] });
    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe('/api/client/v1/agents/runs/run_r7');
    expect(res.headers['x-cognipeer-session-id']).toBe('conv-1');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      id: expect.stringMatching(/^chatcmpl-/), object: 'chat.completion', created: expect.any(Number), model: 'agent:support', choices: [],
      cognipeer: { status: 'in_progress', run_id: 'run_r7', session_id: 'conv-1' },
    });
  });
});

describe('Idempotency-Key on an agent chat completion', () => {
  it('a retry gets the stored answer: no second session, no second run, and the transcript digest is left alone', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'replay', run: run({ status: 'succeeded', conversationId: 'conv-5', result: reply('stored answer') }) });
    const res = await post({ messages: [user('hi')] }, { 'idempotency-key': 'k-1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cognipeer-session-id']).toBe('conv-5');
    const body = parseJsonBody<{ conversation_id: string; choices: Array<{ message: { content: string } }> }>(res.body);
    expect(body.choices[0].message.content).toBe('stored answer');
    expect(body.conversation_id).toBe('conv-5');
    expect(hoisted.createConversation).not.toHaveBeenCalled();
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
    expect(hashes.size).toBe(0);
  });

  it('a retry of a run that is still going waits up to the window, then answers 202', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'replay', run: run({ status: 'running' }) });
    hoisted.waitForAgentRun.mockResolvedValue(run({ status: 'running' }));
    const res = await post({ messages: [user('hi')] }, { 'idempotency-key': 'k-1' });
    expect(res.statusCode).toBe(202);
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('a retry that streams gets the stored answer as chunks', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'replay', run: run({ status: 'succeeded', conversationId: 'conv-5', result: reply('stored answer') }) });
    const res = await post({ messages: [user('hi')], stream: true }, { 'idempotency-key': 'k-1' });
    const chunks = chunksOf(res.body);
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join('')).toBe('stored answer');
    expect(chunks.at(-1)).toMatchObject({ conversation_id: 'conv-5', choices: [{ finish_reason: 'stop' }] });
  });

  it('the same key with another request is 409 idempotency_key_conflict; a too long key is 400', async () => {
    hoisted.lookupIdempotentAgentRun.mockResolvedValue({ kind: 'conflict' });
    const conflict = await post({ messages: [user('hi')] }, { 'idempotency-key': 'k-1' });
    expect(conflict.statusCode).toBe(409);
    expect(error(conflict)).toMatchObject({ code: 'idempotency_key_conflict' });
    const long = await post({ messages: [user('hi')] }, { 'idempotency-key': 'k'.repeat(500) });
    expect(long.statusCode).toBe(400);
    expect(error(long)).toMatchObject({ code: 'idempotency_key_too_long' });
  });

  it('a first call hands the key to the run; only a named session is part of what makes a retry the same', async () => {
    await post({ messages: [user('hi')] }, { 'idempotency-key': 'k-1' });
    expect(runInput()).toMatchObject({ idempotencyKey: 'k-1', idempotencyConversationScope: null });
    await post({ messages: [user('hi')], conversation_id: 'conv-1' }, { 'idempotency-key': 'k-2' });
    expect(runInput(1)).toMatchObject({ idempotencyKey: 'k-2', idempotencyConversationScope: 'conv-1' });
    expect(hoisted.lookupIdempotentAgentRun).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: 'k-2', idempotencyConversationScope: 'conv-1', userMessage: 'hi' }));
  });
});
