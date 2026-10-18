/**
 * `reasoning_effort` / `reasoning: { effort }` on the agent chat-completions
 * bridge (`model` = an agent): validated before anything runs (OpenAI-shaped
 * 400), then handed to the run as the lowest rung of the precedence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  resolveAgentModel: vi.fn(),
  runAgentCompletion: vi.fn(),
  prepareSession: vi.fn(),
  getModelByKey: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: hoisted.getDatabase,
  runWithTenantScope: async (_db: string, fn: (db: unknown) => unknown) => fn(await hoisted.getDatabase()),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => hoisted.log,
  logger: hoisted.log,
  SENSITIVE_KEY_PATTERN: /^(password|secret|token)$/i,
}));
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
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/server/api/plugins/agent-openai-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/api/plugins/agent-openai-bridge')>()),
  resolveAgentModel: hoisted.resolveAgentModel,
  runAgentCompletion: hoisted.runAgentCompletion,
}));

vi.mock('@/server/api/plugins/agent-invocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/api/plugins/agent-invocation')>()),
  // The session of a new turn is created here; the run itself is what these tests look at.
  prepareInvocationSession: hoisted.prepareSession,
}));

import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createMockDb } from '../helpers/db.mock';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';

const headers = { authorization: 'Bearer tok_abc', 'content-type': 'application/json' };
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
const AGENT = { _id: 'a1', key: 'support-agent', name: 'Support', projectId: 'proj-1', tenantId: 'tenant-1', config: { modelKey: 'gpt-4o' } };

const chat = (payload: Record<string, unknown>) => ({
  method: 'POST' as const,
  url: '/api/client/v1/chat/completions',
  headers,
  payload: { model: 'support-agent', messages: [{ role: 'user', content: 'hi' }], ...payload },
});

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.getDatabase.mockResolvedValue(createMockDb());
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.resolveAgentModel.mockResolvedValue(AGENT);
  hoisted.getModelByKey.mockResolvedValue(null);
  hoisted.prepareSession.mockResolvedValue({ conversationId: 'conv-1', conversation: { _id: 'conv-1' }, attachments: [], namedAttachments: [] });
  hoisted.runAgentCompletion.mockResolvedValue({ content: 'hello', conversationId: 'conv-1' });
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientInferenceApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
});

const lastRun = () => hoisted.runAgentCompletion.mock.calls.at(-1)![0] as Record<string, unknown>;

describe('agent chat completions', () => {
  it('hands reasoning_effort to the run as the request value', async () => {
    const res = await app.inject(chat({ reasoning_effort: 'low' }));
    expect(res.statusCode).toBe(200);
    expect(lastRun().requestReasoning).toEqual({ effort: 'low' });
  });

  it('understands reasoning: { effort }, the object winning', async () => {
    await app.inject(chat({ reasoning_effort: 'low', reasoning: { effort: 'high' } }));
    expect(lastRun().requestReasoning).toEqual({ effort: 'high' });
  });

  it('sends nothing when the request has neither', async () => {
    await app.inject(chat({}));
    expect(lastRun()).not.toHaveProperty('requestReasoning');
  });

  it.each([
    [{ reasoning_effort: 'extreme' }],
    [{ reasoning: { effort: 'turbo' } }],
    [{ reasoning: 'high' }],
  ])('refuses %j with an OpenAI-shaped 400 before anything runs', async (extra) => {
    const res = await app.inject(chat(extra));
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { type: string; code: string } }>(res.body).error).toMatchObject({
      type: 'invalid_request_error', code: 'invalid_reasoning',
    });
    expect(hoisted.runAgentCompletion).not.toHaveBeenCalled();
  });
});

describe('agent chat completions: the thinking text', () => {
  it('returns message.reasoning_content when the run produced it', async () => {
    hoisted.runAgentCompletion.mockResolvedValue({ content: 'hello', conversationId: 'conv-1', reasoning: 'I considered it.' });
    const res = await app.inject(chat({}));
    expect(parseJsonBody<{ choices: Array<{ message: Record<string, unknown> }> }>(res.body).choices[0].message)
      .toMatchObject({ content: 'hello', reasoning_content: 'I considered it.' });
  });

  it('include_reasoning: false narrows it out', async () => {
    hoisted.runAgentCompletion.mockResolvedValue({ content: 'hello', conversationId: 'conv-1', reasoning: 'I considered it.' });
    const res = await app.inject(chat({ include_reasoning: false }));
    expect(parseJsonBody<{ choices: Array<{ message: Record<string, unknown> }> }>(res.body).choices[0].message)
      .not.toHaveProperty('reasoning_content');
  });

  it('streams delta.reasoning_content live, and asks the run for it only when allowed', async () => {
    hoisted.runAgentCompletion.mockImplementation(async (input: { onTextChunk?: (t: string) => void; onReasoningChunk?: (t: string) => void }) => {
      input.onReasoningChunk?.('hm ');
      input.onReasoningChunk?.('ok');
      input.onTextChunk?.('hello');
      return { content: 'hello', conversationId: 'conv-1', reasoning: 'hm ok' };
    });
    const res = await app.inject(chat({ stream: true }));
    const deltas = res.body.split('\n\n')
      .filter((block) => block.startsWith('data: {'))
      .map((block) => JSON.parse(block.slice(6)).choices?.[0]?.delta ?? {});
    expect(deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('')).toBe('hm ok');
    expect(deltas.filter((d) => d.content).map((d) => d.content).join('')).toBe('hello');
    // Streamed already: the final result does not send it a second time.
    expect(deltas.filter((d) => d.reasoning_content)).toHaveLength(2);

    hoisted.runAgentCompletion.mockClear();
    await app.inject(chat({ stream: true, include_reasoning: false }));
    expect(lastRun()).not.toHaveProperty('onReasoningChunk');
  });

  it('sends thinking that did not stream before the answer tail', async () => {
    hoisted.runAgentCompletion.mockResolvedValue({ content: 'hello', conversationId: 'conv-1', reasoning: 'late thought' });
    const res = await app.inject(chat({ stream: true }));
    const deltas = res.body.split('\n\n')
      .filter((block) => block.startsWith('data: {'))
      .map((block) => JSON.parse(block.slice(6)).choices?.[0]?.delta ?? {});
    // The stream opens with the role, then the thinking comes out ahead of the answer.
    expect(deltas[0]).toEqual({ role: 'assistant', content: '' });
    expect(deltas[1]).toEqual({ reasoning_content: 'late thought' });
  });
});
