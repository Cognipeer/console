/**
 * Output limits and reasoning, the decisions that sit between a call's settings and the native client:
 *
 *  - a budget-style thinking limit holds budget + the answer headroom, not only "above the budget";
 *  - `effort: none` on an adaptive Claude is not translated and gets no headroom;
 *  - an OpenAI-schema reasoning model's configured limit is raised for its effort (reasoning tokens count against it);
 *  - a caller's own limit is never raised for thinking: a budget is fitted under it, or the call runs without thinking;
 *  - a token budget with no effort is sent as the effort it stands for on the OpenAI-schema drivers;
 *  - what the pickers offer / what a visible call asks for (Bedrock non-Claude, Vertex thoughts, adaptive Claude);
 *  - the extra body of Bedrock (Converse top level) and of Vertex (an allow-list).
 *
 * Everything here is pure (no network); the wire side of the same rules is in limits-reasoning-wire.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_MIN_OUTPUT_TOKENS,
  computeOutputTokenLimit,
  fitThinkingToLimit,
  type OutputLimitInput,
} from '@/lib/services/models/outputLimits';
import {
  SDK_THINKING_MIN_MAX_TOKENS,
  SDK_THINKING_OUTPUT_RESERVE,
  THINKING_ANSWER_HEADROOM,
  bedrockCarriesThinking,
  effortForBudget,
  fitThinkingBudget,
  reasoningControlForDriver,
  translateAnthropicThinking,
  withReasoningVisibility,
} from '@/lib/services/models/reasoning';
import { EFFORT_BUDGETS } from '@/lib/services/models/modelRules';
import { buildNativeOptions, resolveNativeCall } from '@/lib/providers/contracts/nativeClients';

type CallInput = Parameters<typeof resolveNativeCall>[0];

describe('budget thinking: the limit holds the budget plus the answer headroom', () => {
  const high = EFFORT_BUDGETS.high;

  it('a limit only just above the budget is raised, a roomy one is kept', () => {
    // effort high = budget 16384: a limit of 20000 leaves the answer 3616 tokens, under the 4096 headroom.
    expect(translateAnthropicThinking({ effort: 'high' }, 20000)).toEqual({
      thinking: { type: 'enabled', budget_tokens: high },
      maxTokens: high + THINKING_ANSWER_HEADROOM,
      dropSampling: true,
    });
    expect(translateAnthropicThinking({ effort: 'high' }, high + THINKING_ANSWER_HEADROOM)?.maxTokens).toBe(20480);
    expect(translateAnthropicThinking({ effort: 'high' }, 30000)?.maxTokens).toBe(30000);
    // The edge: exactly budget + headroom stays, one under it is raised to it.
    expect(translateAnthropicThinking({ budgetTokens: 3000 }, 7096)?.maxTokens).toBe(7096);
    expect(translateAnthropicThinking({ budgetTokens: 3000 }, 7095)?.maxTokens).toBe(7096);
  });

  it('the limit a model configured is raised to it, on the Messages API and on Bedrock', () => {
    for (const configured of [2000, 16385, 20000]) {
      expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', configured, reasoning: { effort: 'high' } })).toBe(20480);
    }
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', configured: 20480, reasoning: { effort: 'high' } })).toBe(20480);
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0', configured: 20000, reasoning: { effort: 'high' } })).toBe(20480);
  });
});

describe('effort none on an adaptive Claude', () => {
  const ADAPTIVE = ['claude-sonnet-5-5', 'claude-opus-5-1', 'claude-opus-5-5', 'claude-fable-1', 'claude-haiku-5-5', 'claude-opus-4-7', 'claude-sonnet-4-6'];

  it.each(ADAPTIVE)('%s: nothing is translated and the limit gets no headroom', (modelId) => {
    // The SDK sends the rule's off switch (or the lowest effort) itself; there is no effort to size a limit for.
    expect(translateAnthropicThinking({ effort: 'none' }, 500, modelId)).toBeUndefined();
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId, configured: 1000, reasoning: { effort: 'none' } })).toBe(1000);
    // None beats a budget, as it does in the SDK.
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId, configured: 1000, reasoning: { effort: 'none', budgetTokens: 5000 } })).toBe(1000);
  });

  it('on Bedrock Claude too; a budget-style Claude takes the disabled block with the limit as it is', () => {
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: 'us.anthropic.claude-sonnet-5-5-v1:0', configured: 1000, reasoning: { effort: 'none' } })).toBe(1000);
    expect(translateAnthropicThinking({ effort: 'none' }, 500, 'claude-sonnet-4-5'))
      .toEqual({ thinking: { type: 'disabled' }, maxTokens: 500, dropSampling: false });
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', configured: 1000, reasoning: { effort: 'none' } })).toBe(1000);
  });
});

describe('OpenAI-schema reasoning models: the configured limit is raised for the effort', () => {
  const configured = (driver: string, modelId: string, reasoning: unknown, extra: Partial<OutputLimitInput> = {}) =>
    computeOutputTokenLimit({ driver, modelId, configured: 400, reasoning, ...extra });

  it.each([
    // [driver, model, effort asked, limit after]. The rule maps the effort to the nearest one the model takes (as the SDK does on the wire).
    ['openai', 'gpt-5.2', 'medium', ADAPTIVE_MIN_OUTPUT_TOKENS.medium],
    ['openai', 'gpt-5.2', 'high', ADAPTIVE_MIN_OUTPUT_TOKENS.high],
    ['openai', 'gpt-5.2', 'xhigh', ADAPTIVE_MIN_OUTPUT_TOKENS.xhigh],
    ['openai', 'gpt-5.2', 'max', ADAPTIVE_MIN_OUTPUT_TOKENS.xhigh], // max -> xhigh
    ['openai', 'gpt-5.2', 'minimal', ADAPTIVE_MIN_OUTPUT_TOKENS.low], // minimal -> low
    ['openai', 'gpt-5', 'minimal', ADAPTIVE_MIN_OUTPUT_TOKENS.minimal],
    ['openai', 'gpt-5', 'max', ADAPTIVE_MIN_OUTPUT_TOKENS.high], // max -> high
    ['openai', 'o3', 'medium', ADAPTIVE_MIN_OUTPUT_TOKENS.medium],
    ['openai', 'gpt-oss-120b', 'low', ADAPTIVE_MIN_OUTPUT_TOKENS.low],
    ['azure', 'gpt-5', 'medium', ADAPTIVE_MIN_OUTPUT_TOKENS.medium],
    ['openai-compatible', 'gpt-5.6-luna', 'high', ADAPTIVE_MIN_OUTPUT_TOKENS.high],
    ['together', 'openai/gpt-oss-120b', 'high', ADAPTIVE_MIN_OUTPUT_TOKENS.high],
  ])('%s / %s at %s', (driver, modelId, effort, expected) => {
    expect(configured(driver, modelId, { effort })).toBe(expected);
  });

  it('effort none thinks nothing: the limit stays', () => {
    expect(configured('openai', 'gpt-5.2', { effort: 'none' })).toBe(400);
    expect(configured('openai', 'gpt-5', { effort: 'none' })).toBe(400);
    expect(configured('openai', 'gpt-5.2', { effort: 'none', budgetTokens: 20000 })).toBe(400);
  });

  it('a token budget counts as the effort the client sends for it', () => {
    expect(configured('openai', 'gpt-5.2', { budgetTokens: 1500 })).toBe(ADAPTIVE_MIN_OUTPUT_TOKENS.low);
    expect(configured('openai', 'gpt-5.2', { budgetTokens: 5000 })).toBe(ADAPTIVE_MIN_OUTPUT_TOKENS.medium);
    expect(configured('openai', 'gpt-5.2', { budgetTokens: 20000 })).toBe(ADAPTIVE_MIN_OUTPUT_TOKENS.high);
    // An effort beats the budget next to it.
    expect(configured('openai', 'gpt-5.2', { effort: 'low', budgetTokens: 20000 })).toBe(ADAPTIVE_MIN_OUTPUT_TOKENS.low);
  });

  it("a caller's own limit is a hard cap, and no limit stays no limit", () => {
    expect(computeOutputTokenLimit({ driver: 'openai', modelId: 'gpt-5.2', override: 400, configured: 300, reasoning: { effort: 'high' } })).toBe(400);
    expect(computeOutputTokenLimit({ driver: 'openai', modelId: 'gpt-5.2', reasoning: { effort: 'high' } })).toBeUndefined();
    expect(computeOutputTokenLimit({ driver: 'openai', modelId: 'gpt-5.2', stream: true, reasoning: { effort: 'high' } })).toBeUndefined();
  });

  it('a limit already above the table value stays; the model maximum caps the raise but never lowers a value', () => {
    expect(configured('openai', 'gpt-5.2', { effort: 'high' }, { configured: 50000 })).toBe(50000);
    expect(configured('openai', 'gpt-5.2', { effort: 'high' }, { modelMax: 20000 })).toBe(20000);
    expect(configured('openai', 'gpt-5.2', { effort: 'high' }, { modelMax: 300 })).toBe(400);
  });

  it('a model that does not reason, or that the rule table does not know, is left as the operator set it', () => {
    expect(configured('openai', 'gpt-4o', { effort: 'high' })).toBe(400);
    expect(configured('openai', 'gpt-5-chat-latest', { effort: 'high' })).toBe(400);
    // Only the family's permissive default matched (a vanity deployment, a self-hosted model).
    expect(configured('openai', 'my-vanity-deployment', { effort: 'high' })).toBe(400);
    // A toggle (Qwen3, DeepSeek) has no effort to size for.
    expect(configured('openai-compatible', 'qwen3-32b', { effort: 'high' })).toBe(400);
    expect(configured('openai', 'gpt-5.2', { includeThoughts: true })).toBe(400);
    expect(configured('openai', 'gpt-5.2', undefined)).toBe(400);
  });
});

describe("a caller's own limit is never raised for a thinking budget", () => {
  it('computeOutputTokenLimit: the model limit is raised, the caller one is not', () => {
    const reasoning = { effort: 'high' as const };
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', configured: 2000, reasoning })).toBe(20480);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', override: 2000, reasoning })).toBe(2000);
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', override: 2000, configured: 50000, reasoning })).toBe(2000);
    expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0', override: 2000, reasoning })).toBe(2000);
    // Adaptive thinking under a caller cap is unchanged: it fits itself into it.
    expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', override: 2000, reasoning })).toBe(2000);
  });

  it('fitThinkingBudget: what fits under a limit the SDK will not raise, or nothing', () => {
    // The SDK's guard rails (it raises max_tokens itself below them): pinned against the SDK in limits-reasoning-wire.test.ts.
    expect(SDK_THINKING_OUTPUT_RESERVE).toBe(1024);
    expect(SDK_THINKING_MIN_MAX_TOKENS).toBe(4096);

    const fits: Array<[number, number, number | undefined]> = [
      [16384, 20480, 16384], // room enough: as asked
      [16384, 8000, 6976], // shrunk to limit - 1024
      [16384, 5000, 3976],
      [16384, 4096, 3072], // the smallest limit the SDK takes without raising it
      [16384, 4095, undefined], // under its floor: no thinking
      [2048, 3000, undefined],
      [2048, 4000, undefined],
      [1024, 5120, 1024],
      [1024, 2048, undefined],
      [200, 8192, 1024], // Anthropic's own minimum
      [8192, 9216, 8192],
      [8192, 9215, 8191],
    ];
    for (const [budget, limit, expected] of fits) {
      expect([budget, limit, fitThinkingBudget(budget, limit)]).toEqual([budget, limit, expected]);
    }
  });

  describe('fitThinkingToLimit', () => {
    const claude = { driver: 'anthropic', modelId: 'claude-sonnet-4-5' };

    it('shrinks the budget the effort stands for and keeps every other field', () => {
      expect(fitThinkingToLimit({ effort: 'high', includeThoughts: true }, { ...claude, limit: 8000 }))
        .toEqual({ effort: 'high', includeThoughts: true, budgetTokens: 6976 });
      expect(fitThinkingToLimit({ budgetTokens: 5000 }, { ...claude, limit: 6000 })).toEqual({ budgetTokens: 4976 });
      expect(fitThinkingToLimit({ effort: 'high' }, { driver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0', limit: 5000 }))
        .toEqual({ effort: 'high', budgetTokens: 3976 });
    });

    it('drops thinking when the limit leaves no room for the smallest budget', () => {
      expect(fitThinkingToLimit({ effort: 'high' }, { ...claude, limit: 3000 })).toBeUndefined();
      expect(fitThinkingToLimit({ budgetTokens: 5000 }, { ...claude, limit: 3000 })).toBeUndefined();
      expect(fitThinkingToLimit({ effort: 'low' }, { ...claude, limit: 3500 })).toBeUndefined();
    });

    it('hands back the very same reasoning when it already fits', () => {
      const reasoning = { effort: 'low' as const };
      expect(fitThinkingToLimit(reasoning, { ...claude, limit: 30000 })).toBe(reasoning);
    });

    it('leaves alone what it is not about: no limit, effort none, an operator thinking block, adaptive, other drivers', () => {
      expect(fitThinkingToLimit({ effort: 'high' }, { ...claude, limit: undefined })).toEqual({ effort: 'high' });
      expect(fitThinkingToLimit({ effort: 'none' }, { ...claude, limit: 3000 })).toEqual({ effort: 'none' });
      expect(fitThinkingToLimit({ effort: 'high' }, { ...claude, limit: 3000, explicitThinking: true })).toEqual({ effort: 'high' });
      expect(fitThinkingToLimit({ effort: 'high' }, { driver: 'anthropic', modelId: 'claude-sonnet-5-5', limit: 3000 })).toEqual({ effort: 'high' });
      expect(fitThinkingToLimit({ effort: 'high' }, { driver: 'openai', modelId: 'gpt-5', limit: 3000 })).toEqual({ effort: 'high' });
      // Vertex: a caller's cap is never raised, so the budget is shrunk to leave the answer headroom (3000 - 2048).
      expect(fitThinkingToLimit({ budgetTokens: 5000 }, { driver: 'vertex', modelId: 'gemini-2.5-pro', limit: 3000 })).toEqual({ budgetTokens: 952 });
      expect(fitThinkingToLimit({ budgetTokens: 5000 }, { driver: 'vertex', modelId: 'gemini-2.5-pro', limit: 30000 })).toEqual({ budgetTokens: 5000 });
      // Bedrock thinking is a Claude feature: the other families' reasoning is not this function's.
      expect(fitThinkingToLimit({ effort: 'high' }, { driver: 'bedrock', modelId: 'amazon.nova-pro-v1:0', limit: 3000 })).toEqual({ effort: 'high' });
      expect(fitThinkingToLimit(undefined, { ...claude, limit: 3000 })).toBeUndefined();
    });
  });

  describe('resolveNativeCall: the limit and the reasoning of one call, decided together', () => {
    const call = (driver: string, modelId: string, reasoning: unknown, extra: Partial<CallInput> = {}) =>
      resolveNativeCall({ driver, modelId, overrides: {}, reasoning: reasoning as CallInput['reasoning'], ...extra });

    it('a caller cap: the limit is the cap, the budget is fitted under it, or thinking is dropped', () => {
      expect(call('anthropic', 'claude-sonnet-4-5', { effort: 'high' }, { requestMaxTokens: 8000 }))
        .toEqual({ maxTokens: 8000, reasoning: { effort: 'high', budgetTokens: 6976 } });
      expect(call('anthropic', 'claude-sonnet-4-5', { effort: 'high' }, { requestMaxTokens: 3000 }))
        .toEqual({ maxTokens: 3000, reasoning: undefined });
      expect(call('bedrock', 'eu.anthropic.claude-sonnet-4-5-v1:0', { effort: 'high' }, { requestMaxTokens: 5000 }))
        .toEqual({ maxTokens: 5000, reasoning: { effort: 'high', budgetTokens: 3976 } });
    });

    it('adaptive thinking under a caller cap is unchanged', () => {
      expect(call('anthropic', 'claude-sonnet-5-5', { effort: 'high' }, { requestMaxTokens: 3000 }))
        .toEqual({ maxTokens: 3000, reasoning: { effort: 'high' } });
    });

    it("the model's own limit is raised for the budget and the budget is kept; an operator thinking block is left alone", () => {
      expect(call('anthropic', 'claude-sonnet-4-5', { effort: 'high' }, { overrides: { maxTokens: 2000 } }))
        .toEqual({ maxTokens: 20480, reasoning: { effort: 'high' } });
      expect(call('anthropic', 'claude-sonnet-4-5', { effort: 'high' }, {
        requestMaxTokens: 3000,
        overrides: { extraBody: { thinking: { type: 'enabled', budget_tokens: 1500 } } },
      })).toEqual({ maxTokens: 3000, reasoning: { effort: 'high' } });
    });

    it('a raise the model maximum stops short of fits the budget under what is left', () => {
      expect(call('anthropic', 'claude-sonnet-4-5', { effort: 'high' }, { overrides: { maxTokens: 2000 }, modelMax: 8192 }))
        .toEqual({ maxTokens: 8192, reasoning: { effort: 'high', budgetTokens: 7168 } });
    });
  });

  describe('buildNativeOptions: what the client is built with', () => {
    const options = (requestMaxTokens: number) => buildNativeOptions({
      driver: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      overrides: { maxTokens: requestMaxTokens },
      settings: { requestMaxTokens },
      reasoning: { effort: 'high' },
    });

    it("a marked caller limit: the limit is the caller's and the reasoning fits it", () => {
      expect(options(8000)).toMatchObject({ maxTokens: 8000, reasoning: { effort: 'high', budgetTokens: 6976 } });
      const dropped = options(3000);
      expect(dropped.maxTokens).toBe(3000);
      expect(dropped).not.toHaveProperty('reasoning');
    });

    it("an unmarked model limit is raised for the thinking, as before", () => {
      const raised = buildNativeOptions({
        driver: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        overrides: { maxTokens: 2000 },
        settings: {},
        reasoning: { effort: 'high' },
      });
      expect(raised).toMatchObject({ maxTokens: 20480, reasoning: { effort: 'high' } });
    });
  });
});

describe('a token budget with no effort, on the OpenAI-schema drivers', () => {
  it('effortForBudget uses the thresholds of the SDK for adaptive Claude', () => {
    expect([1, 1024, 2048].map(effortForBudget)).toEqual(['low', 'low', 'low']);
    expect([2049, 8192].map(effortForBudget)).toEqual(['medium', 'medium']);
    expect([8193, 16384, 100000].map(effortForBudget)).toEqual(['high', 'high', 'high']);
  });

  const call = (driver: string, reasoning: unknown) =>
    resolveNativeCall({ driver, modelId: 'gpt-5.2', overrides: {}, reasoning: reasoning as CallInput['reasoning'] }).reasoning;

  it.each(['openai', 'azure', 'openai-compatible', 'together'])('%s sends the effort the budget stands for', (driver) => {
    expect(call(driver, { budgetTokens: 1500 })).toMatchObject({ effort: 'low', budgetTokens: 1500 });
    expect(call(driver, { budgetTokens: 2048 })).toMatchObject({ effort: 'low' });
    expect(call(driver, { budgetTokens: 2049 })).toMatchObject({ effort: 'medium' });
    expect(call(driver, { budgetTokens: 8192 })).toMatchObject({ effort: 'medium' });
    expect(call(driver, { budgetTokens: 8193 })).toMatchObject({ effort: 'high' });
  });

  it('an effort wins over the budget next to it, none included; a call with no budget is as it was', () => {
    expect(call('openai', { effort: 'medium', budgetTokens: 20000 })).toEqual({ effort: 'medium', budgetTokens: 20000 });
    expect(call('openai', { effort: 'none', budgetTokens: 20000 })).toEqual({ effort: 'none', budgetTokens: 20000 });
    expect(call('openai', { includeThoughts: true })).toEqual({ includeThoughts: true });
    expect(call('openai', undefined)).toBeUndefined();
  });

  it('the drivers that think in tokens keep the budget as it is', () => {
    const anthropic = resolveNativeCall({ driver: 'anthropic', modelId: 'claude-sonnet-4-5', overrides: {}, reasoning: { budgetTokens: 5000 }, stream: true });
    expect(anthropic.reasoning).toEqual({ budgetTokens: 5000 });
    const vertex = resolveNativeCall({ driver: 'vertex', modelId: 'gemini-2.5-pro', overrides: {}, reasoning: { budgetTokens: 5000 } });
    expect(vertex.reasoning).toEqual({ budgetTokens: 5000 });
  });

  it('buildNativeOptions hands the SDK the effort and the sized limit', () => {
    const options = buildNativeOptions({
      driver: 'openai',
      modelId: 'gpt-5.2',
      overrides: { maxTokens: 400 },
      settings: {},
      reasoning: { budgetTokens: 5000 },
    });
    expect(options.reasoning).toEqual({ budgetTokens: 5000, effort: 'medium' });
    expect(options.maxTokens).toBe(ADAPTIVE_MIN_OUTPUT_TOKENS.medium);
  });
});

describe('Bedrock: a model that is not Claude has no reasoning control', () => {
  const NONE = { kind: 'none', efforts: [], budget: false, includeThoughts: false };

  it.each([
    'us.amazon.nova-pro-v1:0',
    'meta.llama3-3-70b-instruct-v1:0',
    'openai.gpt-oss-120b-1:0',
  ])('%s', (modelId) => {
    expect(bedrockCarriesThinking(modelId)).toBe(false);
    expect(reasoningControlForDriver('bedrock', modelId)).toEqual(NONE);
  });

  it('Claude keeps it, in the kind its rule has', () => {
    expect(reasoningControlForDriver('bedrock', 'eu.anthropic.claude-sonnet-4-5-v1:0')).toMatchObject({ kind: 'budget', budget: true });
    expect(reasoningControlForDriver('bedrock', 'eu.anthropic.claude-sonnet-5-5-v1:0')).toMatchObject({ kind: 'budget', budget: false });
    expect(bedrockCarriesThinking('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
  });

  it('an ARN (an application inference profile hides its model) and a missing or blank id keep the control: the id cannot tell', () => {
    for (const modelId of [
      'arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123',
      'ARN:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123',
      undefined,
      '',
      '   ',
    ]) {
      expect(reasoningControlForDriver('bedrock', modelId)).toMatchObject({ kind: 'budget', budget: true });
    }
  });

  it('only Bedrock is asked about the model id', () => {
    expect(reasoningControlForDriver('anthropic', 'amazon.nova-pro-v1:0').kind).toBe('budget');
    expect(reasoningControlForDriver('openai', 'gpt-5').kind).toBe('effort');
  });
});

describe('thought text: what a visible call asks the provider for', () => {
  type Reasoning = { effort?: string; budgetTokens?: number; includeThoughts?: boolean };
  const visible = (reasoning: Reasoning | undefined, show: boolean, driver?: string, upstream?: string, modelId?: string) =>
    withReasoningVisibility<Reasoning>(reasoning, show, driver, upstream, modelId);

  describe('Vertex Gemini', () => {
    it('asks for thought summaries when it thinks on a budget', () => {
      expect(visible({ budgetTokens: 4000 }, true, 'vertex')).toEqual({ budgetTokens: 4000, includeThoughts: true });
      expect(visible({ effort: 'high' }, true, 'vertex')).toEqual({ effort: 'high', includeThoughts: true });
      expect(visible({ effort: 'minimal' }, true, 'vertex')).toEqual({ effort: 'minimal', includeThoughts: true });
    });

    it('asks for nothing when it does not think, and keeps the decision of the model record', () => {
      expect(visible({ effort: 'none' }, true, 'vertex')).toEqual({ effort: 'none' });
      expect(visible({ effort: 'none', budgetTokens: 4000 }, true, 'vertex')).toEqual({ effort: 'none', budgetTokens: 4000 });
      expect(visible({ includeThoughts: true }, true, 'vertex')).toEqual({ includeThoughts: true });
      expect(visible({ effort: 'high', includeThoughts: false }, true, 'vertex')).toEqual({ effort: 'high', includeThoughts: false });
    });

    it('hidden: the provider is told not to produce them', () => {
      expect(visible({ effort: 'high' }, false, 'vertex')).toEqual({ effort: 'high', includeThoughts: false });
    });

    it('the model form offers the switch for it; the Claude drivers have none', () => {
      expect(reasoningControlForDriver('vertex', 'gemini-2.5-pro')).toMatchObject({ kind: 'budget', budget: true, includeThoughts: true });
      expect(reasoningControlForDriver('anthropic', 'claude-sonnet-4-5').includeThoughts).toBe(false);
      expect(reasoningControlForDriver('bedrock', 'eu.anthropic.claude-sonnet-4-5-v1:0').includeThoughts).toBe(false);
      expect(reasoningControlForDriver('openai', 'gpt-5').includeThoughts).toBe(false);
    });

    it('the other drivers are as they were', () => {
      expect(visible({ effort: 'high' }, true, 'openai', 'chat')).toEqual({ effort: 'high' });
      expect(visible({ effort: 'high' }, true, 'openai', 'responses')).toEqual({ effort: 'high', includeThoughts: true });
    });
  });

  describe('an adaptive Claude with no reasoning configured', () => {
    it('asks for the thinking text anyway when someone will see it: it thinks by default', () => {
      for (const modelId of ['claude-sonnet-5-5', 'claude-opus-4-7', 'claude-sonnet-4-6']) {
        expect(visible(undefined, true, 'anthropic', undefined, modelId)).toEqual({ includeThoughts: true });
      }
      expect(visible(undefined, true, 'bedrock', undefined, 'us.anthropic.claude-sonnet-5-5-v1:0')).toEqual({ includeThoughts: true });
    });

    it('asks for no effort and no headroom: the model keeps its own default effort', () => {
      expect(translateAnthropicThinking({ includeThoughts: true }, 1000, 'claude-sonnet-5-5')).toBeUndefined();
      expect(computeOutputTokenLimit({ driver: 'anthropic', modelId: 'claude-sonnet-5-5', configured: 1000, reasoning: { includeThoughts: true } })).toBe(1000);
      expect(computeOutputTokenLimit({ driver: 'bedrock', modelId: 'us.anthropic.claude-sonnet-5-5-v1:0', configured: 1000, reasoning: { includeThoughts: true } })).toBe(1000);
    });

    it('nothing is added when the thinking is not shown, the model only thinks on a request, or the id is not known', () => {
      expect(visible(undefined, false, 'anthropic', undefined, 'claude-sonnet-5-5')).toBeUndefined();
      expect(visible(undefined, true, 'anthropic', undefined, 'claude-sonnet-4-5')).toBeUndefined();
      expect(visible(undefined, true, 'anthropic')).toBeUndefined();
      expect(visible(undefined, true, 'bedrock', undefined, 'us.amazon.nova-pro-v1:0')).toBeUndefined();
      expect(visible(undefined, true, 'bedrock', undefined, 'us.anthropic.claude-sonnet-4-5-v1:0')).toBeUndefined();
      expect(visible(undefined, true, 'openai', 'responses', 'gpt-5')).toBeUndefined();
      expect(visible(undefined, true, 'vertex', undefined, 'claude-sonnet-5-5@20260101')).toBeUndefined();
    });

    it('a call that has reasoning is as before', () => {
      expect(visible({ effort: 'high' }, true, 'anthropic', undefined, 'claude-sonnet-5-5')).toEqual({ effort: 'high', includeThoughts: true });
      expect(visible({ effort: 'high' }, false, 'anthropic', undefined, 'claude-sonnet-5-5')).toEqual({ effort: 'high', includeThoughts: false });
    });
  });
});

describe('the extra body of a model', () => {
  const claude = 'eu.anthropic.claude-sonnet-4-5-v1:0';
  const extraOf = (driver: string, modelId: string, extraBody: Record<string, unknown>) =>
    buildNativeOptions({ driver, modelId, overrides: { extraBody }, settings: {} }).extra;

  describe('Bedrock', () => {
    it('is handed to the SDK as it is: Converse sorts it into its top level and additionalModelRequestFields itself', () => {
      const extraBody = {
        top_k: 5,
        anthropic_beta: ['x'],
        guardrailConfig: { guardrailIdentifier: 'g', guardrailVersion: '1' },
        performanceConfig: { latency: 'optimized' },
        serviceTier: { type: 'priority' },
        requestMetadata: { team: 'a' },
      };
      expect(extraOf('bedrock', claude, extraBody)).toEqual(extraBody);
      // No wrapping of a nested block either.
      expect(extraOf('bedrock', claude, { additionalModelRequestFields: { top_k: 5 } })).toEqual({ additionalModelRequestFields: { top_k: 5 } });
    });

    it('does not let it replace the fields the request builds: messages, system, inferenceConfig, toolConfig', () => {
      expect(extraOf('bedrock', claude, { messages: [], system: [], inferenceConfig: { maxTokens: 1 }, toolConfig: {}, top_k: 5 })).toEqual({ top_k: 5 });
      expect(extraOf('bedrock', 'amazon.nova-pro-v1:0', { messages: [] })).toBeUndefined();
    });
  });

  describe('Vertex', () => {
    const SAFETY = [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }];

    it('forwards the request-level keys Gemini defines on its own: safetySettings and labels', () => {
      expect(extraOf('vertex', 'gemini-2.5-pro', { safetySettings: SAFETY, labels: { team: 'a' } })).toEqual({ safetySettings: SAFETY, labels: { team: 'a' } });
      expect(extraOf('vertex', 'gemini-2.5-pro', { labels: { team: 'a' } })).toEqual({ labels: { team: 'a' } });
    });

    it('drops everything else: it would replace what the client builds, or is an error there', () => {
      const extra = extraOf('vertex', 'gemini-2.5-pro', {
        safetySettings: SAFETY,
        generationConfig: { topK: 1 },
        tools: [],
        toolConfig: {},
        systemInstruction: 'x',
        top_k: 5,
      });
      expect(extra).toEqual({ safetySettings: SAFETY });
      expect(extraOf('vertex', 'gemini-2.5-pro', { top_k: 5, generationConfig: {} })).toBeUndefined();
    });
  });

  it('the other drivers get their extra body whole', () => {
    expect(extraOf('openai', 'gpt-4o', { seed: 1, top_k: 5 })).toEqual({ seed: 1, top_k: 5 });
  });
});
