/**
 * Fix 3 / #5, #6 — THE GATEWAY'S OUTPUT GUARDRAIL vs. THE SEMANTIC CACHE AND
 * THE ERROR BODY.
 *
 *   #5  What is cached is `finalResponse` — the redacted, annotated answer —
 *       and the cache variant key carries the bound output guardrails (and
 *       their `updatedAt`), so a hit is only ever served under the output
 *       policy that produced it.
 *   #6  `GuardrailBlockError.findings` never carries `value` / `span`: the
 *       matched secret does not travel to the HTTP client in the 400 body.
 *
 * Mirrors the mock surface of `inference-service.test.ts`, with the record
 * cache added (it is read for the variant key).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GuardrailBlockError,
  clientSafeFindings,
  handleChatCompletion,
} from '@/lib/services/models/inferenceService';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import { completion, json, openAiRuntime, stubUpstream } from '../helpers/nativeGateway';

const hoisted = vi.hoisted(() => ({
  getCachedGuardrail: vi.fn(),
}));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: vi.fn(),
}));

vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(true),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/models/usageLogger', () => ({
  logModelUsage: vi.fn().mockResolvedValue(undefined),
  calculateCost: vi.fn(() => ({ currency: 'USD', inputCost: 0, outputCost: 0, cachedCost: 0, cacheWriteCost: 0, totalCost: 0 })),
}));

vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn(),
  createStreamGate: vi.fn(),
}));

vi.mock('@/lib/services/guardrail/hooks/recordCache', () => ({
  getCachedGuardrail: hoisted.getCachedGuardrail,
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { buildCacheVariantKey, storeInCache } from '@/lib/services/models/semanticCacheService';
import { evaluateGuardrail } from '@/lib/services/guardrail';

const SECRET = 'sk-live-0123456789abcdef';
const RAW_ANSWER = `Your key is ${SECRET}.`;
const SAFE_ANSWER = 'Your key is [REDACTED].';

const model = (overrides: Record<string, unknown> = {}) => ({
  _id: 'model-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'GPT-4o',
  key: 'gpt-4o',
  providerKey: 'openai-main',
  providerDriver: 'openai',
  category: 'llm' as const,
  modelId: 'gpt-4o',
  settings: {},
  pricing: { inputPer1k: 0.01, outputPer1k: 0.03 },
  semanticCache: { indexKey: 'cache-idx', threshold: 0.9 },
  ...overrides,
});

const PARAMS = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  modelKey: 'gpt-4o',
  projectId: 'proj-1',
};

type Scripted = Record<string, Record<string, unknown>>;
const scriptGuardrails = (byKey: Scripted) => {
  (evaluateGuardrail as ReturnType<typeof vi.fn>).mockImplementation(
    async ({ guardrailKey }: { guardrailKey: string }) => ({
      passed: true,
      blocked: false,
      action: 'allow',
      findings: [],
      guardrailKey,
      guardrailName: guardrailKey,
      ...(byKey[guardrailKey] ?? {}),
    }),
  );
};

let runtime: ModelProviderRuntime;
beforeAll(async () => {
  runtime = await openAiRuntime();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime });
  stubUpstream(() => json(completion({ content: RAW_ANSWER })));
  (buildCacheVariantKey as ReturnType<typeof vi.fn>).mockReturnValue('variant-key');
  hoisted.getCachedGuardrail.mockResolvedValue(null);
  scriptGuardrails({});
});

afterEach(() => vi.unstubAllGlobals());

describe('#5 the semantic cache and the output guardrail', () => {
  it('stores the REDACTED answer, not the raw provider message', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({ outputGuardrailKey: 'gr-secrets' }));
    scriptGuardrails({
      'gr-secrets': {
        action: 'redact',
        redactedText: SAFE_ANSWER,
        findings: [{ type: 'custom', category: 'secret_detected', severity: 'high', message: 'secret', action: 'redact', block: false }],
      },
    });

    const result = await handleChatCompletion({ ...PARAMS, body: { messages: [{ role: 'user', content: 'what is my key?' }] } });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The caller's copy is redacted…
    const returned = result.response as { choices: Array<{ message: { content: string } }> };
    expect(returned.choices[0].message.content).toBe(SAFE_ANSWER);

    // …and so is the cached one. The raw answer would have been served to the
    // next semantically-similar caller with `cacheHit: true` and no guardrail row.
    expect(storeInCache).toHaveBeenCalledTimes(1);
    const stored = (storeInCache as ReturnType<typeof vi.fn>).mock.calls[0][0] as { response: { choices: Array<{ message: { content: string } }> } };
    expect(stored.response.choices[0].message.content).toBe(SAFE_ANSWER);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });

  it('keys the cache on the bound output guardrails and their policy version', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
      model({ guardrails: [{ key: 'gr-secrets', hooks: ['output.pre'] }, { key: 'gr-in', hooks: ['input.pre'] }] }),
    );
    hoisted.getCachedGuardrail.mockImplementation(async (_db: string, key: string) =>
      key === 'gr-secrets' ? { key, updatedAt: new Date('2026-08-30T10:00:00.000Z') } : null,
    );

    await handleChatCompletion({ ...PARAMS, body: { messages: [{ role: 'user', content: 'hi' }] } });

    expect(buildCacheVariantKey).toHaveBeenCalledTimes(1);
    const variant = (buildCacheVariantKey as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    // Only the OUTPUT keys: the input policy already shaped the cached prompt.
    expect(variant.__outputGuardrails).toEqual(['gr-secrets@2026-08-30T10:00:00.000Z']);
  });

  it('an unguarded model keys on an EMPTY output policy, so it cannot share entries with a guarded one', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model());
    await handleChatCompletion({ ...PARAMS, body: { messages: [{ role: 'user', content: 'hi' }] } });
    const variant = (buildCacheVariantKey as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(variant.__outputGuardrails).toEqual([]);
  });

  it('keys the cache on the reasoning the call RESOLVES to, not only on what the request carried', async () => {
    // The Model Hub default (or an agent's pick) changes what the model produces
    // from the same prompt; two callers with different resolved reasoning must not
    // share a cached answer.
    const keyOf = async (settings: Record<string, unknown>, body: Record<string, unknown> = {}) => {
      (buildCacheVariantKey as ReturnType<typeof vi.fn>).mockClear();
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({ settings }));
      await handleChatCompletion({ ...PARAMS, body: { messages: [{ role: 'user', content: 'hi' }], ...body } });
      return (buildCacheVariantKey as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    };

    expect((await keyOf({ reasoning: { effort: 'high' } })).__reasoning).toEqual({ effort: 'high' });
    expect((await keyOf({ reasoning: { effort: 'low' } })).__reasoning).toEqual({ effort: 'low' });
    // Model default wins over the request, so the request value is not what is keyed.
    expect((await keyOf({ reasoning: { effort: 'high' } }, { reasoning_effort: 'low' })).__reasoning).toEqual({ effort: 'high' });
    // Nothing resolved: the key carries no reasoning at all (unchanged for the common case).
    expect(await keyOf({})).not.toHaveProperty('__reasoning');
  });

  it('falls back to the bare key when the record cache cannot answer', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({ outputGuardrailKey: 'gr-secrets' }));
    hoisted.getCachedGuardrail.mockRejectedValue(new Error('tenant database unavailable'));
    await handleChatCompletion({ ...PARAMS, body: { messages: [{ role: 'user', content: 'hi' }] } });
    const variant = (buildCacheVariantKey as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(variant.__outputGuardrails).toEqual(['gr-secrets']);
  });
});

describe('#6 the block error never carries the matched value', () => {
  const blockingFinding = {
    type: 'custom',
    category: 'secret_detected',
    severity: 'high',
    message: 'A credential was detected.',
    code: 'secret_detected',
    action: 'block',
    block: true,
    value: SECRET,
    span: { start: 12, end: 12 + SECRET.length },
    path: '/text',
  };

  it('strips value and span from an output block, keeping the policy identifiers', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({ outputGuardrailKey: 'gr-secrets', semanticCache: undefined }));
    scriptGuardrails({
      'gr-secrets': { passed: false, blocked: true, action: 'block', findings: [blockingFinding] },
    });

    let caught: unknown;
    try {
      await handleChatCompletion({ ...PARAMS, body: { messages: [{ role: 'user', content: 'what is my key?' }] } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GuardrailBlockError);
    const error = caught as GuardrailBlockError;
    expect(error.guardrailKey).toBe('gr-secrets');
    expect(error.findings).toEqual([
      {
        type: 'custom',
        category: 'secret_detected',
        severity: 'high',
        message: 'A credential was detected.',
        code: 'secret_detected',
        action: 'block',
        block: true,
        path: '/text',
      },
    ]);
    expect(JSON.stringify(error.findings)).not.toContain(SECRET);
    expect(JSON.stringify(error.findings)).not.toContain('span');
  });

  it('strips them on the input block too — one constructor covers every route', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({ inputGuardrailKey: 'gr-secrets', semanticCache: undefined }));
    scriptGuardrails({
      'gr-secrets': { passed: false, blocked: true, action: 'block', findings: [blockingFinding] },
    });

    await expect(
      handleChatCompletion({ ...PARAMS, body: { messages: [{ role: 'user', content: `use ${SECRET}` }] } }),
    ).rejects.toSatisfy((error: unknown) =>
      error instanceof GuardrailBlockError && !JSON.stringify(error.findings).includes(SECRET),
    );
  });

  it('clientSafeFindings leaves non-object entries and unrelated fields alone', () => {
    expect(clientSafeFindings([{ message: 'm', value: 'v', span: { start: 0, end: 1 }, extra: 1 }, 'text', null])).toEqual([
      { message: 'm', extra: 1 },
      'text',
      null,
    ]);
  });
});
