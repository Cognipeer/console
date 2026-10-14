/**
 * A model that refuses a request setting must not break the caller: the agent-sdk
 * adjusts what it can (and remembers it), and what it cannot becomes a typed
 * ModelRequestError that the gateway answers as a clean 400 and an agent run ends with
 * as a readable message.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRequestError, clearLearnedModelRules, listLearnedModelRules } from '@cognipeer/agent-sdk';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { MODEL_PARAMETER_UNSUPPORTED_CODE, normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import { completion, json, openAiRuntime, stubUpstream } from '../helpers/nativeGateway';

vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('k'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...original, logModelUsage: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockResolvedValue(new Map()),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({ action: 'allow', findings: [] }),
  createStreamGate: vi.fn().mockReturnValue(undefined),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';

const refused = (overrides: Record<string, unknown> = {}) => new ModelRequestError({
  status: 400,
  code: 'unsupported_value',
  param: 'reasoning_effort',
  value: 'max',
  supportedValues: ['low', 'medium', 'high'],
  provider: 'azure',
  model: 'my-deployment',
  message: "Unsupported value: 'max' is not supported with this model.",
  ...overrides,
});

describe('ModelRequestError becomes a clean client error', () => {
  it('OpenAI-style 400 invalid_request_error / model_parameter_unsupported with the parameter and the supported values', () => {
    const { status, error } = normalizeInferenceError(refused());
    expect(status).toBe(400);
    expect(error).toMatchObject({ type: 'invalid_request_error', code: MODEL_PARAMETER_UNSUPPORTED_CODE, param: 'reasoning_effort' });
    expect(error.message).toContain('"my-deployment"');
    expect(error.message).toContain('Supported values: low, medium, high.');
  });

  it('an unsupported parameter without a list, and a generic refusal', () => {
    expect(normalizeInferenceError(refused({ code: 'unsupported_parameter', param: 'seed', supportedValues: undefined })).error)
      .toMatchObject({ code: MODEL_PARAMETER_UNSUPPORTED_CODE, param: 'seed' });
    const generic = normalizeInferenceError(refused({ code: 'model_request_invalid', param: undefined, supportedValues: undefined }));
    expect(generic.status).toBe(400);
    expect(generic.error).toMatchObject({ type: 'invalid_request_error', code: 'model_request_invalid', param: null });
  });

  it('an ordinary provider error is untouched', () => {
    expect(normalizeInferenceError(Object.assign(new Error('boom'), { status: 429 })).status).toBe(429);
  });

  it('an agent run ends with a readable message naming the model, not a 500', () => {
    const wrapped = Object.assign(new Error(normalizeInferenceError(refused()).error.message), {
      status: 400, type: 'invalid_request_error', code: MODEL_PARAMETER_UNSUPPORTED_CODE, param: 'reasoning_effort',
      agentModelKey: 'main-model',
    });
    const classified = classifyAgentRunError(wrapped);
    expect(classified.status).toBe(400);
    expect(classified.error).toMatchObject({ type: 'invalid_request_error', code: MODEL_PARAMETER_UNSUPPORTED_CODE, param: 'reasoning_effort' });
    expect(classified.error.message).toContain('my-deployment');
    expect(classified.error.message).toContain('model "main-model"');
    // the raw error from the SDK is mapped too
    expect(classifyAgentRunError(refused()).status).toBe(400);
  });
});

describe('through the gateway, with a model no rule names', () => {
  const BASE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', modelKey: 'm', projectId: 'proj-1' };
  const record = {
    _id: 'id', tenantId: 'tenant-1', projectId: 'proj-1', name: 'M', key: 'm', providerKey: 'p',
    providerDriver: 'openai', category: 'llm' as const, modelId: 'my-deployment', settings: {},
    pricing: { inputPer1k: 0, outputPer1k: 0 },
  };
  let runtime: ModelProviderRuntime;
  beforeAll(async () => { runtime = await openAiRuntime(); });
  beforeEach(() => {
    vi.clearAllMocks();
    clearLearnedModelRules();
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime });
  });
  afterEach(() => vi.unstubAllGlobals());

  const body = { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 };
  const reject = (param: string) => json({
    error: { message: `Unsupported parameter: '${param}' is not supported with this model.`, type: 'invalid_request_error', param, code: 'unsupported_parameter' },
  }, 400);

  it('a parameter the model refuses is dropped, the call succeeds, and the next call is right first time', async () => {
    const upstream = stubUpstream((_call, index) => index === 0 ? reject('temperature') : json(completion({ content: 'ok' })));
    await handleChatCompletion({ ...BASE, body });
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[0].body.temperature).toBe(0.2);
    expect(upstream.calls[1].body.temperature).toBeUndefined();
    expect(listLearnedModelRules().some((entry) => entry.model === 'my-deployment')).toBe(true);

    await handleChatCompletion({ ...BASE, body });
    expect(upstream.calls).toHaveLength(3);
    expect(upstream.calls[2].body.temperature).toBeUndefined();
  });

  it('a refusal the SDK cannot fix is a clean 400, not an opaque failure', async () => {
    stubUpstream(() => reject('temperature'));
    const failure = await handleChatCompletion({ ...BASE, body }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeDefined();
    const { status, error } = normalizeInferenceError(failure);
    expect(status).toBe(400);
    expect(error).toMatchObject({ type: 'invalid_request_error', code: MODEL_PARAMETER_UNSUPPORTED_CODE, param: 'temperature' });
  });
});
