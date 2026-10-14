/**
 * Per-model request rules: the console's thin adapter over the agent-sdk rule table.
 *
 * What a model reasons with, which efforts it takes, whether sampling parameters
 * and `max_tokens` pass, the GPT "tools + reasoning" limit, how reasoning is
 * turned off - all of it lives in the SDK's rule table and nowhere else. The SDK
 * applies the rules (and maps/learns at request time); this module only maps a
 * console driver to an SDK provider and derives what the places that decide BEFORE
 * a request exists need: the pickers, the Model Hub form, the "detected
 * unsupported parameters" list. It imports the client-safe `model-rules` subpath
 * (no Node built-ins), so it is safe in client components.
 */

import {
  MODEL_RULES,
  effortBudget,
  modelIdCandidates,
  resolveModelRule,
  type ModelRule,
  type ReasoningEffort,
  type ResolvedModelRule,
} from '@cognipeer/agent-sdk/model-rules';

export type ModelRuleView = ModelRule;
export type ResolvedRuleView = ResolvedModelRule;
export { modelIdCandidates };

/** none < minimal < low < medium < high < xhigh < max. */
export const EFFORT_LADDER: readonly ReasoningEffort[] = MODEL_RULES.effortLadder;
/** Thinking-token budget per effort for budget-style engines. */
export const EFFORT_BUDGETS: Readonly<Record<Exclude<ReasoningEffort, 'none'>, number>> = MODEL_RULES.budgets;
export const GEMINI_EFFORT_BUDGETS: Readonly<Record<Exclude<ReasoningEffort, 'none'>, number>> = MODEL_RULES.geminiBudgets;
export { effortBudget };

/** Console driver -> the SDK provider name its client is built with. Unlisted drivers have no reasoning control. */
const SDK_PROVIDER_BY_DRIVER: Readonly<Record<string, string>> = {
  openai: 'openai',
  azure: 'azure',
  'openai-compatible': 'openai-compatible',
  together: 'together',
  anthropic: 'anthropic',
  bedrock: 'bedrock',
  vertex: 'vertex',
};

export function sdkProviderForDriver(driver: string | undefined): string | undefined {
  return driver ? SDK_PROVIDER_BY_DRIVER[driver] : undefined;
}

/** The rule of a model behind a console driver, or undefined for a driver without reasoning/parameter rules. */
export function resolveRuleForDriver(driver: string | undefined, modelId: string | undefined, scope?: string): ResolvedRuleView | undefined {
  const provider = sdkProviderForDriver(driver);
  if (!provider) return undefined;
  return resolveModelRule({ provider, model: modelId, scope });
}

/**
 * The efforts a picker offers for a rule: exactly what the rule takes, plus Off
 * when the rule has a way to turn reasoning off. A permissive default rule lists
 * the whole ladder (the SDK maps at request time).
 */
export function effortsOfRule(rule: ModelRuleView): ReasoningEffort[] {
  if (rule.reasoning.style === 'none') return [];
  if (rule.reasoning.style === 'toggle') return ['none', 'medium'];
  const set = new Set<ReasoningEffort>(rule.reasoning.efforts);
  if (rule.reasoning.off) set.add('none');
  return EFFORT_LADDER.filter((effort) => set.has(effort));
}

/** The wire names a model refuses outright, derived from its rule (sampling group, token param, learned drops). */
export function unsupportedParamsOfRule(rule: ModelRuleView): string[] {
  const out: string[] = [];
  if (rule.sampling.temperature !== 'any' && rule.sampling.temperature !== 'thinking-requires-1') out.push('temperature');
  if (!rule.sampling.topP) out.push('top_p');
  if (!rule.sampling.penalties) out.push('presence_penalty', 'frequency_penalty');
  if (!rule.sampling.logprobs) out.push('logprobs', 'top_logprobs', 'logit_bias');
  if (rule.maxTokensParam === 'max_completion_tokens') out.push('max_tokens');
  for (const name of rule.dropParams ?? []) out.push(name);
  return [...new Set(out)];
}
