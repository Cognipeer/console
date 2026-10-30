import { describe, it, expect } from 'vitest';
import type { IModel } from '@/lib/database';
import {
  ADAPTIVE_MIN_OUTPUT_TOKENS,
  ANTHROPIC_FALLBACK_OUTPUT_TOKENS,
  NON_STREAM_DEFAULT_CAP,
  builtInMaxOutputTokens,
  computeOutputTokenLimit,
  modelMaxOutputTokens,
} from '@/lib/services/models/outputLimits';
import { THINKING_ANSWER_HEADROOM, GEMINI_ANSWER_HEADROOM } from '@/lib/services/models/reasoning';
import { EFFORT_BUDGETS } from '@/lib/services/models/modelRules';
import { resolveModelInvocationConfig, resolveOutputTokenLimit } from '@/lib/services/models/gatewayRequest';
import { ANTHROPIC_DEFAULT_MAX_TOKENS, buildNativeOptions, normalizeNativeReasoning } from '@/lib/providers/contracts/nativeClients';
import { resolveOverrides } from '@/lib/providers/contracts/modelContracts';

const model = (over: Partial<IModel> = {}): IModel => ({
  tenantId: 't',
  name: 'm',
  key: 'm',
  providerKey: 'p',
  providerDriver: 'anthropic',
  category: 'llm',
  modelId: 'claude-sonnet-5-5',
  settings: {},
  pricing: {} as IModel['pricing'],
  ...over,
} as IModel);

describe('built-in model maximum table', () => {
  it.each([
    ['claude-sonnet-5-5', 128000],
    ['claude-sonnet-5-5-2', 128000], // Foundry deployment name
    ['claude-sonnet-5-20260101', 128000],
    ['prod-claude-opus-5-1', 128000],
    ['claude-haiku-5-5', 128000],
    ['claude-fable-5-1', 128000],
    ['claude-mythos-5', 128000],
    ['claude-opus-4-6', 128000],
    ['claude-opus-4-7', 128000],
    ['claude-opus-4-8', 128000],
    ['claude-sonnet-4-6', 128000],
    ['us.anthropic.claude-sonnet-5-5-v1:0', 128000], // Bedrock inference profile
    ['global.anthropic.claude-opus-4-7-20260101-v1:0', 128000],
    ['claude-haiku-4-5', 64000],
    ['claude-sonnet-4-5-20250929', 64000],
    ['claude-opus-4-5', 64000],
    ['eu.anthropic.claude-opus-4-5-20251101-v1:0', 64000],
    ['claude-sonnet-4-5@20250929', 64000], // Vertex
    ['claude-3-7-sonnet-20250219', undefined],
    ['claude-opus-4-1-20250805', undefined],
    ['claude-sonnet-4-20250514', undefined],
    ['claude-sonnet-4-50', undefined],
    ['gpt-5', undefined],
    ['gemini-2.5-pro', undefined],
  ])('%s -> %s', (id, expected) => {
    expect(builtInMaxOutputTokens(id)).toBe(expected);
  });

  it('unknown for an empty id', () => {
    expect(builtInMaxOutputTokens(undefined)).toBeUndefined();
    expect(builtInMaxOutputTokens('')).toBeUndefined();
  });
});

describe('modelMaxOutputTokens', () => {
  it('a declared capability beats the built-in table', () => {
    const m = model({ metadata: { capabilities: { maxOutputTokens: 32000 } } });
    expect(modelMaxOutputTokens(m)).toBe(32000);
  });

  it('falls back to the table by model id, then to unknown', () => {
    expect(modelMaxOutputTokens(model())).toBe(128000);
    expect(modelMaxOutputTokens(model({ modelId: 'my-private-llm' }))).toBeUndefined();
    expect(modelMaxOutputTokens(undefined)).toBeUndefined();
    expect(modelMaxOutputTokens(null)).toBeUndefined();
  });

  it('never reads settings.maxTokens (the default limit is not what the model can write)', () => {
    expect(modelMaxOutputTokens(model({ modelId: 'my-private-llm', settings: { maxTokens: 2048 } }))).toBeUndefined();
    expect(modelMaxOutputTokens(model({ settings: { maxTokens: 2048 } }))).toBe(128000);
  });
});

describe('adaptive headroom table', () => {
  it('is the agent-sdk table', () => {
    expect(ADAPTIVE_MIN_OUTPUT_TOKENS).toEqual({
      minimal: 4096, low: 8192, medium: 16384, high: 32768, xhigh: 64000, max: 64000,
    });
    expect(NON_STREAM_DEFAULT_CAP).toBe(21333);
  });
});

describe('computeOutputTokenLimit: the driver default', () => {
  it('anthropic streaming: the model maximum', () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', stream: true })).toBe(128000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', stream: true })).toBe(64000);
  });

  it('anthropic non-streaming: a default is capped at 21333', () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', stream: false })).toBe(21333);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5' })).toBe(21333);
  });

  it('anthropic with an unknown model: the 8192 floor, stream or not', () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-3-7-sonnet-20250219', stream: true })).toBe(8192);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-3-7-sonnet-20250219' })).toBe(8192);
    expect(ANTHROPIC_DEFAULT_MAX_TOKENS).toBe(ANTHROPIC_FALLBACK_OUTPUT_TOKENS);
    expect(ANTHROPIC_DEFAULT_MAX_TOKENS).toBe(8192);
  });

  it('anthropic with a declared maximum below the cap: the maximum', () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'x', modelMax: 10000 })).toBe(10000);
  });

  it('an explicit value is never lowered, capped or defaulted over', () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', configured: 4000, stream: true })).toBe(4000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', configured: 4000 })).toBe(4000);
    // Above the non-stream default cap and above the model maximum: the caller's own number stands.
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', configured: 50000 })).toBe(50000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'x', modelMax: 8000, configured: 50000 })).toBe(50000);
  });

  it.each(['bedrock', 'openai', 'azure', 'openai-compatible', 'together', 'vertex'])('%s: nothing is sent by default', (driver) => {
    expect(computeOutputTokenLimit({ driver, modelId: 'claude-sonnet-5-5', stream: true })).toBeUndefined();
    expect(computeOutputTokenLimit({ driver, modelId: 'claude-sonnet-5-5', stream: false })).toBeUndefined();
    expect(computeOutputTokenLimit({ driver, modelId: 'claude-sonnet-5-5', configured: 700 })).toBe(700);
  });

  it('non-positive configured values count as unset', () => {
    expect(computeOutputTokenLimit({ driver: 'openai', configured: 0 })).toBeUndefined();
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', configured: -5, stream: true })).toBe(128000);
  });
});

describe('computeOutputTokenLimit: thinking headroom', () => {
  const sonnet5 = 'claude-sonnet-5-5';

  it("adaptive: raises the model's own limit to the table value of the effort, never less than what was set", () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, configured: 9000, reasoning: { effort: 'high' } })).toBe(32768);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, configured: 4000, reasoning: { effort: 'medium' } })).toBe(16384);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, configured: 1000, reasoning: { effort: 'max' } })).toBe(64000);
    // Already roomier than the table: unchanged.
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, configured: 9000, reasoning: { effort: 'low' } })).toBe(9000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, configured: 90000, reasoning: { effort: 'high' } })).toBe(90000);
  });

  it("adaptive: a caller's own limit is a hard cap and stays, whatever the effort", () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, override: 2000, reasoning: { effort: 'high' } })).toBe(2000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, override: 2000, configured: 50000, reasoning: { effort: 'max' } })).toBe(2000);
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: 'anthropic.claude-sonnet-5-5-v1:0', override: 3000, reasoning: { effort: 'high' } })).toBe(3000);
    // A thinking budget does not raise it either: the budget is fitted under the cap instead (fitThinkingToLimit).
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', override: 2000, reasoning: { budgetTokens: 5000 } })).toBe(2000);
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0', override: 2000, reasoning: { effort: 'high' } })).toBe(2000);
  });

  it('adaptive on a default: the model maximum already clears every effort', () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, stream: true, reasoning: { effort: 'max' } })).toBe(128000);
    // A non-streaming default is capped, then raised to what the effort needs.
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, stream: false, reasoning: { effort: 'high' } })).toBe(32768);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, stream: false, reasoning: { effort: 'low' } })).toBe(21333);
  });

  it('a raise stops at the model maximum; an explicit value above it stays', () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, modelMax: 20000, configured: 1000, reasoning: { effort: 'max' } })).toBe(20000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, modelMax: 50000, configured: 90000, reasoning: { effort: 'max' } })).toBe(90000);
  });

  it('no thinking, no bump: effort none, an explicit thinking block, a model without thinking input', () => {
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, configured: 1000, reasoning: { effort: 'none' } })).toBe(1000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, configured: 1000, reasoning: { effort: 'max' }, explicitThinking: true })).toBe(1000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: sonnet5, configured: 1000 })).toBe(1000);
    expect(computeOutputTokenLimit({ driver: 'openai', modelId: 'gpt-4o', configured: 1000, reasoning: { effort: 'max' } })).toBe(1000);
  });

  it('budget style: above the budget by the answer headroom, and the reported value is the raised one', () => {
    const budget = EFFORT_BUDGETS.medium;
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', configured: 3000, stream: true, reasoning: { effort: 'medium' } }))
      .toBe(budget + THINKING_ANSWER_HEADROOM);
    // A limit already above the budget is kept.
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', configured: 30000, reasoning: { effort: 'medium' } })).toBe(30000);
    // An explicit budget from the caller.
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', configured: 2000, reasoning: { budgetTokens: 5000 } })).toBe(5000 + THINKING_ANSWER_HEADROOM);
  });

  it('bedrock Claude: adaptive with no limit set stays unset, with one it is raised; budget style gets its floor', () => {
    const profile = 'us.anthropic.claude-sonnet-5-5-v1:0';
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: profile, reasoning: { effort: 'high' } })).toBeUndefined();
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: profile, configured: 2000, reasoning: { effort: 'high' } })).toBe(32768);
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0', configured: 700, reasoning: { effort: 'low' } }))
      .toBe(EFFORT_BUDGETS.low + THINKING_ANSWER_HEADROOM);
  });

  it('bedrock non-Claude families keep their own envelope', () => {
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: 'amazon.nova-pro-v1:0', configured: 700, reasoning: { effort: 'high' } })).toBe(700);
  });

  it('vertex Gemini: a limit set below budget + 2048 is raised to it; no limit stays unset', () => {
    expect(computeOutputTokenLimit({ driver: 'vertex', modelId: 'gemini-2.5-pro', configured: 1000, reasoning: { budgetTokens: 4000 } }))
      .toBe(4000 + GEMINI_ANSWER_HEADROOM);
    expect(GEMINI_ANSWER_HEADROOM).toBe(2048);
    expect(computeOutputTokenLimit({ driver: 'vertex', modelId: 'gemini-2.5-pro', reasoning: { budgetTokens: 4000 } })).toBeUndefined();
    expect(computeOutputTokenLimit({ driver: 'vertex', modelId: 'gemini-2.5-pro', configured: 9000, reasoning: { budgetTokens: 4000 } })).toBe(9000);
    expect(computeOutputTokenLimit({ driver: 'vertex', modelId: 'gemini-2.5-pro', configured: 100, reasoning: { effort: 'none' } })).toBe(100);
  });
});

describe('resolveOutputTokenLimit', () => {
  it('without a context: caller > settings, completion name first, non-positive values skipped', () => {
    expect(resolveOutputTokenLimit({ max_completion_tokens: 1, max_tokens: 2, max_output_tokens: 3 }, { maxCompletionTokens: 4, maxTokens: 5 })).toBe(1);
    expect(resolveOutputTokenLimit({ max_tokens: 2, max_output_tokens: 3 }, { maxCompletionTokens: 4, maxTokens: 5 })).toBe(2);
    expect(resolveOutputTokenLimit({ max_output_tokens: 3 }, { maxCompletionTokens: 4, maxTokens: 5 })).toBe(3);
    expect(resolveOutputTokenLimit({}, { maxCompletionTokens: 4, maxTokens: 5 })).toBe(4);
    expect(resolveOutputTokenLimit({}, { maxTokens: 5 })).toBe(5);
    expect(resolveOutputTokenLimit({ max_tokens: 0 }, { maxTokens: 5 })).toBe(5);
    expect(resolveOutputTokenLimit({}, {})).toBeUndefined();
  });

  it('without a context an anthropic call has no default (today\'s behaviour)', () => {
    expect(resolveOutputTokenLimit({}, {})).toBeUndefined();
  });

  it('with a context it is the driver default for the model and the call kind', () => {
    const m = model();
    expect(resolveOutputTokenLimit({}, {}, { model: m, stream: true })).toBe(128000);
    expect(resolveOutputTokenLimit({}, {}, { model: m, stream: false })).toBe(21333);
    expect(resolveOutputTokenLimit({}, {}, { model: m })).toBe(21333);
    const declared = model({ metadata: { capabilities: { maxOutputTokens: 40000 } } });
    expect(resolveOutputTokenLimit({}, {}, { model: declared, stream: true })).toBe(40000);
    expect(resolveOutputTokenLimit({}, {}, { model: declared, stream: false })).toBe(21333);
  });

  it('with a context an explicit value (caller or settings) stays', () => {
    const m = model();
    expect(resolveOutputTokenLimit({ max_tokens: 321 }, {}, { model: m, stream: true })).toBe(321);
    expect(resolveOutputTokenLimit({ max_output_tokens: 654 }, {}, { model: m })).toBe(654);
    expect(resolveOutputTokenLimit({}, { maxTokens: 9000 }, { model: m, stream: true })).toBe(9000);
  });

  it('other drivers send nothing by default', () => {
    expect(resolveOutputTokenLimit({}, {}, { model: model({ providerDriver: 'openai', modelId: 'gpt-5' }), stream: true })).toBeUndefined();
    expect(resolveOutputTokenLimit({}, {}, { driver: 'bedrock', model: model({ providerDriver: 'bedrock' }), stream: true })).toBeUndefined();
  });

  it('applies the thinking bump on the context\'s reasoning and honours an explicit thinking block', () => {
    const m = model();
    expect(resolveOutputTokenLimit({}, { maxTokens: 1000 }, { model: m, stream: true, reasoning: { effort: 'high' } })).toBe(32768);
    expect(resolveOutputTokenLimit({}, { maxTokens: 1000, extraBody: { thinking: { type: 'enabled', budget_tokens: 2048 } } }, { model: m, stream: true, reasoning: { effort: 'high' } })).toBe(1000);
  });

  it("never raises the caller's own limit for adaptive thinking", () => {
    const m = model();
    expect(resolveOutputTokenLimit({ max_tokens: 1000 }, {}, { model: m, stream: true, reasoning: { effort: 'high' } })).toBe(1000);
    // The invocation settings carry the request's value as a marked caller limit.
    expect(resolveOutputTokenLimit({}, { maxTokens: 1000, requestMaxTokens: 1000 }, { model: m, stream: true, reasoning: { effort: 'high' } })).toBe(1000);
  });
});

describe('the gateway limit and the native client send the same number', () => {
  type Case = {
    name: string;
    model: IModel;
    body: Record<string, unknown>;
    stream: boolean;
    expected: number | undefined;
  };

  const cases: Case[] = [
    {
      name: 'a request max_tokens beats a model-level maxCompletionTokens',
      model: model({ modelId: 'claude-sonnet-4-5', settings: { maxCompletionTokens: 5000, maxTokens: 3000 } }),
      body: { max_tokens: 100 },
      stream: true,
      expected: 100,
    },
    {
      name: 'max_output_tokens on /chat/completions is honoured',
      model: model({ modelId: 'claude-sonnet-4-5', settings: { maxTokens: 3000 } }),
      body: { max_output_tokens: 777 },
      stream: false,
      expected: 777,
    },
    {
      name: 'the model\'s own default limit when the request sends none',
      model: model({ modelId: 'claude-sonnet-4-5', settings: { maxTokens: 3000 } }),
      body: {},
      stream: true,
      expected: 3000,
    },
    {
      name: 'anthropic default, streaming',
      model: model(),
      body: {},
      stream: true,
      expected: 128000,
    },
    {
      name: 'anthropic default, non-streaming',
      model: model(),
      body: {},
      stream: false,
      expected: 21333,
    },
    {
      name: 'a declared maximum caps the default',
      model: model({ metadata: { capabilities: { maxOutputTokens: 40000 } } }),
      body: {},
      stream: true,
      expected: 40000,
    },
    {
      name: 'adaptive thinking raises a small non-streaming default',
      model: model({ settings: { reasoning: { effort: 'high' } } }),
      body: {},
      stream: false,
      expected: 32768,
    },
    {
      name: "adaptive thinking raises the model's small Default max tokens",
      model: model({ settings: { reasoning: { effort: 'high' }, maxTokens: 2000 } }),
      body: {},
      stream: true,
      expected: 32768,
    },
    {
      name: "adaptive thinking keeps a caller's small max_tokens (a hard cap)",
      model: model({ settings: { reasoning: { effort: 'high' } } }),
      body: { max_tokens: 2000 },
      stream: true,
      expected: 2000,
    },
    {
      name: 'budget thinking: the reported value is the raised one',
      model: model({ modelId: 'claude-sonnet-4-5', settings: { reasoning: { effort: 'medium' }, maxTokens: 3000 } }),
      body: {},
      stream: true,
      expected: EFFORT_BUDGETS.medium + THINKING_ANSWER_HEADROOM,
    },
    {
      name: "budget thinking keeps a caller's small max_tokens (the budget is fitted under it, the cap is not raised)",
      model: model({ modelId: 'claude-sonnet-4-5', settings: { reasoning: { effort: 'high' } } }),
      body: { max_tokens: 3000 },
      stream: true,
      expected: 3000,
    },
    {
      name: "bedrock Claude budget thinking keeps a caller's max_tokens too",
      model: model({ providerDriver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0', settings: { reasoning: { effort: 'high' } } }),
      body: { max_tokens: 5000 },
      stream: true,
      expected: 5000,
    },
    {
      name: 'budget thinking: a model limit only just above the budget is raised to budget + the answer headroom',
      model: model({ modelId: 'claude-sonnet-4-5', settings: { reasoning: { effort: 'high' }, maxTokens: 20000 } }),
      body: {},
      stream: true,
      expected: EFFORT_BUDGETS.high + THINKING_ANSWER_HEADROOM,
    },
    {
      name: "an openai reasoning model's small Default max tokens is raised to the table value of its effort",
      model: model({ providerDriver: 'openai', modelId: 'gpt-5.2', settings: { reasoning: { effort: 'high' }, maxTokens: 400 } }),
      body: {},
      stream: false,
      expected: ADAPTIVE_MIN_OUTPUT_TOKENS.high,
    },
    {
      name: "an openai reasoning model keeps a caller's max_completion_tokens (a hard cap)",
      model: model({ providerDriver: 'openai', modelId: 'gpt-5.2', settings: { reasoning: { effort: 'high' }, maxTokens: 400 } }),
      body: { max_completion_tokens: 300 },
      stream: false,
      expected: 300,
    },
    {
      name: 'an openai reasoning model with effort none keeps its limit',
      model: model({ providerDriver: 'openai', modelId: 'gpt-5.2', settings: { reasoning: { effort: 'none' }, maxTokens: 400 } }),
      body: {},
      stream: false,
      expected: 400,
    },
    {
      name: 'azure gpt-5: the effort its rule maps to (max -> high) sizes the limit',
      model: model({ providerDriver: 'azure', modelId: 'gpt-5', settings: { reasoning: { effort: 'max' }, maxTokens: 1000 } }),
      body: {},
      stream: true,
      expected: ADAPTIVE_MIN_OUTPUT_TOKENS.high,
    },
    {
      name: 'a non-reasoning openai model keeps its limit whatever the configured effort',
      model: model({ providerDriver: 'openai', modelId: 'gpt-4o', settings: { reasoning: { effort: 'high' }, maxTokens: 400 } }),
      body: {},
      stream: false,
      expected: 400,
    },
    {
      name: 'bedrock Claude with no limit set stays unset',
      model: model({ providerDriver: 'bedrock', modelId: 'us.anthropic.claude-sonnet-5-5-v1:0', settings: { reasoning: { effort: 'high' } } }),
      body: {},
      stream: true,
      expected: undefined,
    },
    {
      name: 'openai sends what was asked',
      model: model({ providerDriver: 'openai', modelId: 'gpt-4o', settings: {} }),
      body: { max_completion_tokens: 512 },
      stream: false,
      expected: 512,
    },
  ];

  it.each(cases)('$name', (c) => {
    const { modelSettings, overrides } = resolveModelInvocationConfig(c.model, { messages: [], ...c.body });
    const reasoning = modelSettings.reasoning;

    const gateway = resolveOutputTokenLimit(overrides, modelSettings, { model: c.model, stream: c.stream, reasoning });

    const native = buildNativeOptions({
      driver: c.model.providerDriver,
      modelId: c.model.modelId,
      overrides: resolveOverrides(modelSettings, c.model.modelId, c.model.providerDriver),
      settings: modelSettings,
      reasoning: normalizeNativeReasoning(reasoning),
      stream: c.stream,
      modelMax: typeof modelSettings.maxOutputTokens === 'number' ? modelSettings.maxOutputTokens : undefined,
    }).maxTokens;

    expect(gateway).toBe(c.expected);
    expect(native).toBe(gateway);
  });
});

describe('resolveModelInvocationConfig', () => {
  it('no longer returns the unused callOptions', () => {
    const config = resolveModelInvocationConfig(model(), { messages: [] });
    expect(config).not.toHaveProperty('callOptions');
  });

  it('hands the native client the model\'s declared maximum output', () => {
    const declared = resolveModelInvocationConfig(model({ metadata: { capabilities: { maxOutputTokens: 40000 } } }), { messages: [] });
    expect(declared.modelSettings.maxOutputTokens).toBe(40000);
    const unknown = resolveModelInvocationConfig(model({ modelId: 'my-private-llm' }), { messages: [] });
    expect(unknown.modelSettings).not.toHaveProperty('maxOutputTokens');
  });
});

describe('buildNativeOptions: the limit it sends', () => {
  const base = { settings: {} as Record<string, unknown> };

  it('anthropic: the model maximum when streaming, the capped default otherwise, an explicit value as set', () => {
    const args = { ...base, driver: 'anthropic', modelId: 'claude-sonnet-5-5', overrides: {} };
    expect(buildNativeOptions({ ...args, stream: true }).maxTokens).toBe(128000);
    expect(buildNativeOptions({ ...args, stream: false }).maxTokens).toBe(21333);
    expect(buildNativeOptions({ ...args, overrides: { maxTokens: 321 }, stream: true }).maxTokens).toBe(321);
    expect(buildNativeOptions({ ...args, overrides: { maxCompletionTokens: 111, maxTokens: 321 } }).maxTokens).toBe(111);
  });

  it('bedrock and openai: unset stays unset', () => {
    expect(buildNativeOptions({ ...base, driver: 'bedrock', modelId: 'us.anthropic.claude-sonnet-5-5-v1:0', overrides: {} })).not.toHaveProperty('maxTokens');
    expect(buildNativeOptions({ ...base, driver: 'openai', modelId: 'gpt-4o', overrides: {} })).not.toHaveProperty('maxTokens');
  });

  it('an operator\'s explicit thinking block is the whole instruction: no headroom is added', () => {
    const options = buildNativeOptions({
      ...base,
      driver: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      overrides: { maxTokens: 1000, extraBody: { thinking: { type: 'enabled', budget_tokens: 2048 } } },
      reasoning: { effort: 'high' },
    });
    expect(options.maxTokens).toBe(1000);
    expect(options.reasoning).toBeUndefined();
  });

  it('vertex: raised above the thinking budget', () => {
    const options = buildNativeOptions({
      ...base,
      driver: 'vertex',
      modelId: 'gemini-2.5-pro',
      overrides: { maxTokens: 1000 },
      reasoning: { budgetTokens: 4000 },
    });
    expect(options.maxTokens).toBe(4000 + GEMINI_ANSWER_HEADROOM);
  });
});
