/**
 * Unit tests - `handleOcrRequest` in 'vlm' mode: the whole read is neither retried nor held to the single-request
 * timeout, and the model's declared maximum output rides along in the OCR runtime's model settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getServingModel: vi.fn(),
  buildModelRuntime: vi.fn(),
  withResilience: vi.fn(async (fn: () => Promise<unknown>, _opts?: unknown) => fn()),
  createOcrRuntime: vi.fn(),
}));

vi.mock('@/lib/core/resilience', () => ({
  withResilience: h.withResilience,
  abortErrorFrom: () => new Error('aborted'),
  getCircuitState: () => undefined,
}));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: h.getServingModel }));
vi.mock('@/lib/services/models/decisionService', () => ({ handleDecisionRequest: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: h.buildModelRuntime }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', () => ({
  logModelUsage: vi.fn().mockResolvedValue(undefined),
  calculateCost: vi.fn().mockReturnValue({ totalCost: 0, currency: 'USD' }),
}));
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
  createStreamGate: vi.fn(),
}));

import { handleOcrRequest } from '@/lib/services/models/inferenceService';
import { modelMaxOutputTokens } from '@/lib/services/models/outputLimits';

const ocrModel = (mode: string) => ({
  _id: 'm1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'OCR',
  key: 'ocr-model',
  providerKey: 'anthropic-main',
  providerDriver: 'anthropic',
  category: 'ocr' as const,
  modelId: 'claude-sonnet-5-5',
  settings: { ocr: { mode } },
  pricing: undefined,
});

const run = () =>
  handleOcrRequest({
    tenantDbName: 'tenant_acme',
    modelKey: 'ocr-model',
    projectId: 'proj-1',
    input: { document: { kind: 'url', url: 'https://example.com/a.pdf' } },
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.withResilience.mockImplementation(async (fn: () => Promise<unknown>, _opts?: unknown) => fn());
  h.createOcrRuntime.mockResolvedValue({
    extract: vi.fn().mockResolvedValue({ text: 'page', usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  h.buildModelRuntime.mockResolvedValue({ runtime: { createOcrRuntime: h.createOcrRuntime } });
});

describe('handleOcrRequest in vlm mode', () => {
  it('calls withResilience with retry disabled and no timeout', async () => {
    h.getServingModel.mockResolvedValue(ocrModel('vlm'));
    await run();

    expect(h.withResilience).toHaveBeenCalledTimes(1);
    expect(h.withResilience.mock.calls[0][1]).toMatchObject({ retry: { enabled: false }, timeoutMs: 0 });
  });

  it("injects the model's declared maximum as maxOutputTokens", async () => {
    const model = ocrModel('vlm');
    h.getServingModel.mockResolvedValue(model);
    await run();

    const expected = modelMaxOutputTokens(model as never);
    expect(expected).toBeGreaterThan(0);
    expect(h.createOcrRuntime.mock.calls[0][0].modelSettings).toMatchObject({
      maxOutputTokens: expected,
      ocr: { mode: 'vlm' },
    });
  });

  it('keeps the default resilience for a native read', async () => {
    h.getServingModel.mockResolvedValue(ocrModel('native'));
    await run();

    expect(h.withResilience.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
    expect(h.withResilience.mock.calls[0][1]).not.toHaveProperty('retry');
  });
});
