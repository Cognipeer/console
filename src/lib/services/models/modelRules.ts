/**
 * Per-model request rules: the console's view of the agent-sdk rule table.
 *
 * What a model reasons with, which efforts it takes, whether sampling parameters
 * and `max_tokens` pass, the GPT "tools + reasoning" limit, how reasoning is
 * turned off - all of it lives in the SDK's `model-rules.json` and nowhere else.
 * The SDK applies the rules (and maps/learns at request time); this module reads
 * the same table for the places that decide BEFORE a request exists: the pickers,
 * the Model Hub form, the "detected unsupported parameters" list.
 *
 * It mirrors `resolveModelRule` of the SDK instead of importing it because the
 * SDK entry pulls Node built-ins and this module is bundled into client
 * components. `model-rules-parity.test.ts` runs both over a model matrix, so the
 * two cannot drift. Learned (per-process) adjustments are SDK-internal and are
 * reported through `onModelRuleLearned` (see nativeClients.ts), not read here.
 */

import rulesJson from '@cognipeer/agent-sdk/model-rules.json';
import type { ReasoningEffort } from './reasoning';

type RuleFamily = 'openai' | 'anthropic' | 'gemini' | 'other';
type OffMechanism = 'none' | 'disabled' | 'between_tools';

export interface ModelRuleView {
  id: string;
  family: RuleFamily;
  match: string;
  reasoning: {
    style: 'effort' | 'adaptive' | 'budget' | 'toggle' | 'none';
    efforts: ReasoningEffort[];
    responsesEfforts?: ReasoningEffort[];
    off: OffMechanism | null;
  };
  sampling: {
    temperature: 'any' | 'default-only' | 'unsupported' | 'thinking-requires-1';
    topP: boolean;
    topK: boolean;
    penalties: boolean;
    logprobs: boolean;
  };
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  chatTools: { reasoning: 'any' | 'force-none' };
  dropParams?: string[];
  source: string;
  note: string;
}

export interface ResolvedRuleView extends ModelRuleView {
  matchedRuleId: string;
  /** Only the family's permissive default matched: the model is not in the table. */
  isDefault: boolean;
}

const TABLE = rulesJson as unknown as {
  effortLadder: ReasoningEffort[];
  budgets: Record<Exclude<ReasoningEffort, 'none'>, number>;
  geminiBudgets: Record<Exclude<ReasoningEffort, 'none'>, number>;
  rules: ModelRuleView[];
};

/** none < minimal < low < medium < high < xhigh < max. */
export const EFFORT_LADDER: readonly ReasoningEffort[] = TABLE.effortLadder;
/** Thinking-token budget per effort for budget-style engines. */
export const EFFORT_BUDGETS: Readonly<Record<Exclude<ReasoningEffort, 'none'>, number>> = TABLE.budgets;
export const GEMINI_EFFORT_BUDGETS: Readonly<Record<Exclude<ReasoningEffort, 'none'>, number>> = TABLE.geminiBudgets;

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

const OPENAI_WIRE = new Set(['openai', 'azure', 'openai-compatible', 'together']);
const GATEWAY_PREFIX = /^(?:(?:global|us|eu|apac|jp|au|ca|us-gov)\.)?(?:(?:openai|anthropic|google|meta|amazon|deepseek|qwen|mistral|cohere|ai21)\.)?/;

/** Normalised ids a rule is matched against (same as the SDK's `modelIdCandidates`). */
export function modelIdCandidates(model: string | undefined): string[] {
  if (!model) return [];
  const lower = String(model).trim().toLowerCase();
  const last = lower.split('/').pop() ?? lower;
  const out: string[] = [];
  for (const id of [lower, last]) {
    for (const candidate of [id, id.replace(GATEWAY_PREFIX, '')]) {
      if (candidate && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

function familiesFor(provider: string): RuleFamily[] {
  if (OPENAI_WIRE.has(provider)) return ['openai'];
  if (provider === 'anthropic') return ['anthropic'];
  if (provider === 'bedrock') return ['anthropic', 'openai', 'other'];
  if (provider === 'vertex') return ['gemini', 'anthropic'];
  return ['openai', 'anthropic', 'gemini', 'other'];
}

const compiled = new Map<string, RegExp>();
function matchRule(family: RuleFamily, ids: string[], allowDefault: boolean): ModelRuleView | undefined {
  for (const rule of TABLE.rules) {
    if (rule.family !== family) continue;
    if (rule.match === '.*') {
      if (allowDefault) return rule;
      continue;
    }
    let re = compiled.get(rule.id);
    if (!re) {
      re = new RegExp(rule.match, 'i');
      compiled.set(rule.id, re);
    }
    if (ids.some((id) => re!.test(id))) return rule;
  }
  return undefined;
}

/** The rule of a model behind a console driver, or undefined for a driver without reasoning/parameter rules. */
export function resolveRuleForDriver(driver: string | undefined, modelId: string | undefined): ResolvedRuleView | undefined {
  const provider = sdkProviderForDriver(driver);
  if (!provider) return undefined;
  const families = familiesFor(provider);
  const ids = modelIdCandidates(modelId);
  let rule: ModelRuleView | undefined;
  for (const family of families) {
    rule = matchRule(family, ids, false);
    if (rule) break;
  }
  let isDefault = false;
  if (!rule) {
    isDefault = true;
    rule = matchRule(families[0], ids, true) ?? TABLE.rules[TABLE.rules.length - 1];
  }
  return { ...rule, matchedRuleId: rule.id, isDefault };
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
