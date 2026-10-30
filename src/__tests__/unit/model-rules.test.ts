/**
 * The console reads per-model request rules from the agent-sdk table (one source).
 * `modelRules.ts` is a thin driver->provider adapter over the SDK's client-safe
 * `model-rules` subpath; this pins the adapter over a model matrix, then what the
 * pickers, the detected unsupported parameters and the token-field rename derive
 * from a rule.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_RULES, resolveModelRule } from '@cognipeer/agent-sdk/model-rules';
import { reasoningPickerOptions } from '@/components/agents/studio/AgentReasoningPicker';
import { playgroundReasoningControl } from '@/components/playground/playgroundReasoning';
import {
  EFFORT_BUDGETS,
  effortsOfRule,
  resolveRuleForDriver,
  sdkProviderForDriver,
  unsupportedParamsOfRule,
} from '@/lib/services/models/modelRules';
import {
  detectUnsupportedParams,
  requestReasoningEffortAccepted,
} from '@/lib/providers/unsupportedParams';
import { resolveOverrides } from '@/lib/providers/contracts/modelContracts';
import { reasoningControlForDriver, supportsAdaptiveThinking, translateAnthropicThinking } from '@/lib/services/models/reasoning';

const MATRIX: Array<[string, string]> = [
  ['openai', 'gpt-6-luna'], ['azure', 'gpt-6-luna'], ['azure', 'gpt-5.6-luna'], ['azure', 'gpt-5.6-terra'],
  ['openai', 'gpt-5'], ['openai', 'gpt-5-mini'], ['openai', 'gpt-5.1'], ['openai', 'gpt-5-chat-latest'], ['openai', 'gpt-4o'],
  ['openai', 'o3'], ['openai', 'o4-mini'], ['openai-compatible', 'openai/o3-mini'], ['openai-compatible', 'gpt-oss-120b'],
  ['openai-compatible', 'qwen3-32b'], ['together', 'qwen3-8b'], ['openai-compatible', 'deepseek-reasoner'], ['openai-compatible', 'llama-3.3-70b'],
  ['azure', 'my-prod-deployment'], ['openai', ''],
  ['bedrock', 'global.openai.gpt-5.6-terra'], ['bedrock', 'eu.anthropic.claude-sonnet-5-5-v1:0'], ['bedrock', 'us.amazon.nova-pro-v1:0'],
  ['anthropic', 'claude-haiku-5-5'], ['anthropic', 'claude-sonnet-5-5'], ['anthropic', 'claude-opus-5-5'],
  ['anthropic', 'claude-sonnet-4-5'], ['anthropic', 'claude-opus-4-7'], ['anthropic', 'claude-3-7-sonnet-20250219'], ['anthropic', 'some-future-model'],
  ['vertex', 'claude-sonnet-5-5@20260101'], ['vertex', 'gemini-2.5-pro'], ['vertex', 'gemini-3-flash'],
];

describe('modelRules adapter resolves through the SDK table', () => {
  it.each(MATRIX)('%s / %s', (driver, modelId) => {
    const sdk = resolveModelRule({ provider: sdkProviderForDriver(driver), model: modelId });
    const mine = resolveRuleForDriver(driver, modelId)!;
    expect(mine.matchedRuleId).toBe(sdk.matchedRuleId);
    expect(mine.isDefault).toBe(sdk.isDefault);
    expect(mine.reasoning).toEqual(sdk.reasoning);
    expect(mine.sampling).toEqual(sdk.sampling);
    expect(mine.maxTokensParam).toBe(sdk.maxTokensParam);
    expect(mine.chatTools).toEqual(sdk.chatTools);
  });

  it('reads the same table the SDK ships (budgets included)', () => {
    expect(EFFORT_BUDGETS).toEqual(MODEL_RULES.budgets);
  });

  it('drivers without reasoning rules resolve to nothing', () => {
    expect(resolveRuleForDriver('mystery', 'gpt-5')).toBeUndefined();
    expect(resolveRuleForDriver(undefined, 'gpt-5')).toBeUndefined();
  });
});

const efforts = (driver: string, modelId: string) => reasoningPickerOptions(
  { key: 'k', name: 'K', providerKey: 'p', modelId },
  { p: driver },
)?.efforts;
const LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('pickers offer exactly the matched rule', () => {
  it.each([
    ['openai', 'gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['azure', 'gpt-5.6-luna', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['openai', 'gpt-5', ['minimal', 'low', 'medium', 'high']],
    ['openai', 'o3', ['low', 'medium', 'high']],
    ['anthropic', 'claude-sonnet-5-5', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['anthropic', 'claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['anthropic', 'claude-haiku-5-5', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['azure', 'my-prod-deployment', LADDER],
    // An application inference profile hides its model: the id cannot tell, so the control stays.
    ['bedrock', 'arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123', LADDER],
  ])('%s / %s', (driver, modelId, expected) => {
    expect(efforts(driver, modelId)).toEqual(expected);
  });

  it('a Bedrock model that is not Claude has no picker: the client leaves reasoning off its wire', () => {
    expect(efforts('bedrock', 'us.amazon.nova-pro-v1:0')).toBeUndefined();
    expect(efforts('bedrock', 'meta.llama3-3-70b-instruct-v1:0')).toBeUndefined();
  });

  it('the playground control and the Model Hub form read the same list', () => {
    expect(playgroundReasoningControl({ driver: 'azure', modelId: 'gpt-6-luna' })?.efforts)
      .toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(reasoningControlForDriver('azure', 'gpt-6-luna').efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(reasoningControlForDriver('anthropic', 'claude-sonnet-5-5')).toMatchObject({ kind: 'budget', budget: false });
    expect(reasoningControlForDriver('anthropic', 'claude-sonnet-4-5')).toMatchObject({ kind: 'budget', budget: true });
  });

  it('a chat-tuned model has no reasoning control', () => {
    expect(reasoningControlForDriver('openai', 'gpt-4o').kind).toBe('none');
    expect(effortsOfRule(resolveRuleForDriver('openai', 'gpt-5-chat-latest')!)).toEqual([]);
  });
});

describe('detected unsupported parameters come from the rule', () => {
  it('gpt-6 / gpt-5.x: sampling group and max_tokens; reasoning forced to none next to tools', () => {
    const plain = detectUnsupportedParams('azure', 'gpt-6-luna');
    expect(plain.ruleId).toBe('openai-gpt-6-plus');
    expect(plain.params).toEqual(expect.arrayContaining(['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'logprobs', 'max_tokens']));
    expect(plain.forced).toBeUndefined();
    const withTools = detectUnsupportedParams('azure', 'gpt-6-luna', true);
    expect(withTools.params).toEqual(expect.arrayContaining(['reasoning', 'reasoning_effort']));
    expect(withTools.forced).toEqual({ reasoning_effort: 'none' });
  });

  it('o3: the sampling group, but no tools rule', () => {
    const detected = detectUnsupportedParams('openai', 'o3', true);
    expect(detected.params).toContain('temperature');
    expect(detected.params).not.toContain('reasoning_effort');
    expect(detected.forced).toBeUndefined();
  });

  it('an unknown deployment is left alone (the SDK learns from the provider)', () => {
    expect(detectUnsupportedParams('azure', 'my-prod-deployment', true).params).toEqual([]);
    expect(unsupportedParamsOfRule(resolveRuleForDriver('azure', 'my-prod-deployment')!)).toEqual([]);
  });

  it('Claude through the Messages API keeps the wire-level rule', () => {
    expect(detectUnsupportedParams('anthropic', 'claude-sonnet-5-5').params).toContain('presence_penalty');
  });
});

describe('request efforts', () => {
  it('are dropped only where the rule says the model does not reason', () => {
    expect(requestReasoningEffortAccepted('openai', 'gpt-4o', 'low')).toBe(false);
    expect(requestReasoningEffortAccepted('openai', 'gpt-5-chat-latest', 'low')).toBe(false);
    expect(requestReasoningEffortAccepted('openai', 'o3', 'xhigh')).toBe(true); // the SDK maps it to high
    expect(requestReasoningEffortAccepted('azure', 'my-prod-deployment', 'max')).toBe(true);
    expect(requestReasoningEffortAccepted('anthropic', 'claude-opus-5-5', 'max')).toBe(true);
  });
});

describe('token field rename', () => {
  const settings = { unsupportedParams: ['max_tokens'], maxTokens: 500 };

  it('rides in the extra body only for ids whose rule does not already use max_completion_tokens', () => {
    const known = resolveOverrides(settings, 'gpt-6-luna', 'azure');
    expect(known.maxTokensRenamed).toBe(true);
    expect(known.extraBody?.max_completion_tokens).toBeUndefined();
    const vanity = resolveOverrides(settings, 'my-prod-deployment', 'azure');
    expect(vanity.extraBody?.max_completion_tokens).toBe(500);
  });
});

describe('Claude thinking form follows the rule', () => {
  it('adaptive for 4.6+/5.x, budget tokens for older models', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-5-5')).toBe(true);
    expect(supportsAdaptiveThinking('eu.anthropic.claude-opus-5-5-v1:0')).toBe(true);
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
    expect(translateAnthropicThinking({ effort: 'max' }, 4000, 'claude-sonnet-5-5')).toMatchObject({
      thinking: { type: 'adaptive' }, outputConfig: { effort: 'max' },
    });
    expect(translateAnthropicThinking({ effort: 'high' }, 4000, 'claude-sonnet-4-5')?.thinking).toEqual({ type: 'enabled', budget_tokens: EFFORT_BUDGETS.high });
  });
});

describe('reasoning text needs the Responses API hint', () => {
  it('shows for OpenAI/Azure and OpenAI reasoning models on compatible endpoints, on Chat Completions only', async () => {
    const { reasoningTextNeedsResponses } = await import('@/lib/services/models/upstreamApi');
    const { en } = await import('@/lib/i18n/messages/en');
    const { tr } = await import('@/lib/i18n/messages/tr');
    expect(reasoningTextNeedsResponses('azure', 'gpt-6-luna', {})).toBe(true);
    expect(reasoningTextNeedsResponses('openai', 'gpt-5', { upstreamApi: 'chat' })).toBe(true);
    expect(reasoningTextNeedsResponses('openai', 'gpt-5', { upstreamApi: 'responses' })).toBe(false);
    expect(reasoningTextNeedsResponses('openai-compatible', 'o3-mini', {})).toBe(true);
    expect(reasoningTextNeedsResponses('openai-compatible', 'llama-3.3-70b', {})).toBe(false);
    expect(reasoningTextNeedsResponses('anthropic', 'claude-sonnet-5-5', {})).toBe(false);
    expect(en.modelReasoning.hint.responsesOnly).toBeTruthy();
    expect(tr.modelReasoning.hint.responsesOnly).toBeTruthy();
  });
});
