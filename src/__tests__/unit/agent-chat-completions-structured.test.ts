/**
 * `response_format` and the `inputs` extension on the agent chat-completions
 * bridge (`model` = an agent): validated before anything runs (OpenAI-shaped
 * 400), handed to the run, and the answer of a structured turn comes back as a
 * JSON string in `message.content`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  resolveAgentModel: vi.fn(),
  runAgentCompletion: vi.fn(),
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

import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createMockDb } from '../helpers/db.mock';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';
import { completionFrom } from '@/server/api/plugins/agent-openai-bridge';

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
let AGENT: Record<string, unknown> = { _id: 'a1', key: 'support-agent', name: 'Support', projectId: 'proj-1', tenantId: 'tenant-1', config: { modelKey: 'gpt-4o' } };

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
  AGENT = { _id: 'a1', key: 'support-agent', name: 'Support', projectId: 'proj-1', tenantId: 'tenant-1', config: { modelKey: 'gpt-4o' } };
  hoisted.resolveAgentModel.mockImplementation(async () => AGENT);
  hoisted.getModelByKey.mockResolvedValue(null);
  hoisted.runAgentCompletion.mockResolvedValue({ content: 'hello', conversationId: 'conv-1' });
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientInferenceApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
});

const lastRun = () => hoisted.runAgentCompletion.mock.calls.at(-1)![0] as Record<string, unknown>;
const TRIAGE = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
const error = (body: string) => parseJsonBody<{ error: Record<string, unknown> }>(body).error;

describe('chat completions response_format on an agent', () => {
  it('hands json_schema (the chat spelling) to the run', async () => {
    const res = await app.inject(chat({ response_format: { type: 'json_schema', json_schema: { name: 'triage', schema: TRIAGE, strict: true } } }));
    expect(res.statusCode).toBe(200);
    expect(lastRun().responseFormat).toEqual({ type: 'json_schema', name: 'triage', schema: TRIAGE, strict: true });
  });

  it('hands json_object over, and sends nothing for type "text" or no format', async () => {
    await app.inject(chat({ response_format: { type: 'json_object' } }));
    expect(lastRun().responseFormat).toEqual({ type: 'json_object' });
    await app.inject(chat({ response_format: { type: 'text' } }));
    expect(lastRun()).not.toHaveProperty('responseFormat');
    await app.inject(chat({}));
    expect(lastRun()).not.toHaveProperty('responseFormat');
  });

  it.each([
    [{ type: 'json_schema', json_schema: { name: 'x', schema: { type: 'weird' } } }],
    [{ type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } }],
    [{ type: 'json_schema' }],
    [{ type: 'xml' }],
    ['json'],
  ])('refuses %j with an OpenAI-shaped 400 before anything runs', async (format) => {
    hoisted.runAgentCompletion.mockClear();
    const res = await app.inject(chat({ response_format: format }));
    expect(res.statusCode).toBe(400);
    expect(error(res.body)).toMatchObject({ code: 'invalid_response_format', param: 'response_format', type: 'invalid_request_error' });
    expect(hoisted.runAgentCompletion).not.toHaveBeenCalled();
  });

  it('a structured turn answers with the JSON of the parsed output as message.content', () => {
    const response = {
      id: 'resp_x', object: 'response', model: 'support-agent', status: 'completed', created_at: 1, version: null,
      output: [{ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"label": "bug"}' }] }],
      output_parsed: { label: 'bug', extra: [1] },
    };
    const completion = completionFrom(response as never, 'conv-1');
    expect('content' in completion && JSON.parse(completion.content)).toEqual({ label: 'bug', extra: [1] });
    // Free text stays as it was.
    const plain = completionFrom({ ...response, output_parsed: undefined } as never, 'conv-1');
    expect('content' in plain && plain.content).toBe('{"label": "bug"}');
  });
});

describe('chat completions inputs extension on an agent', () => {
  const declare = () => {
    AGENT = { ...AGENT, config: { modelKey: 'gpt-4o', inputs: [{ name: 'customer_id', type: 'string', required: true }, { name: 'priority', type: 'string', default: 'low' }] } };
  };

  it('validates against the agent declaration and hands the validated inputs (defaults applied) to the run', async () => {
    declare();
    const res = await app.inject(chat({ inputs: { customer_id: 'c-1' } }));
    expect(res.statusCode).toBe(200);
    expect(lastRun().inputs).toEqual({ customer_id: 'c-1', priority: 'low' });
  });

  it('refuses a missing required input, a wrong type and an unknown name with errors[]', async () => {
    declare();
    hoisted.runAgentCompletion.mockClear();
    const missing = await app.inject(chat({ inputs: {} }));
    expect(missing.statusCode).toBe(400);
    expect(error(missing.body)).toMatchObject({ code: 'invalid_inputs', param: 'inputs', errors: [{ field: 'customer_id', message: 'Required' }] });
    const wrong = await app.inject(chat({ inputs: { customer_id: 4, nope: true } }));
    expect((error(wrong.body).errors as Array<{ field: string }>).map((e) => e.field).sort()).toEqual(['customer_id', 'nope']);
    expect(hoisted.runAgentCompletion).not.toHaveBeenCalled();
  });

  it('an agent without declared inputs takes none', async () => {
    const res = await app.inject(chat({ inputs: { a: 1 } }));
    expect(res.statusCode).toBe(400);
    expect(error(res.body).code).toBe('invalid_inputs');
  });
});
