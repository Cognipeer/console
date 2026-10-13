import {
  readModelReasoning,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@/lib/services/models/reasoning';

/** What the "Reasoning" form section edits. */
export interface ReasoningFormValue {
  /** '' = "Not set": the gateway sends nothing and the provider's own default applies. */
  effort: '' | ReasoningEffort;
  /** Token budget for engines that think in tokens. '' = derive from the level. */
  budgetTokens: number | '';
  includeThoughts: boolean;
  /** false hides the reasoning text from callers (tokens are still counted). */
  returnReasoning: boolean;
}

export const EMPTY_REASONING_FORM: ReasoningFormValue = {
  effort: '',
  budgetTokens: '',
  includeThoughts: true,
  returnReasoning: true,
};

export function reasoningFormFromSettings(settings: unknown): ReasoningFormValue {
  const reasoning = readModelReasoning(settings);
  const returnReasoning =
    !(settings && typeof settings === 'object' && (settings as Record<string, unknown>).returnReasoning === false);
  return {
    effort: reasoning?.effort && REASONING_EFFORTS.includes(reasoning.effort) ? reasoning.effort : '',
    budgetTokens: reasoning?.budgetTokens ?? '',
    includeThoughts: reasoning?.includeThoughts ?? true,
    returnReasoning,
  };
}

/**
 * The settings keys this section owns. `unset` is what a cleared key becomes:
 * `undefined` for a create (key omitted), `null` for an edit (the server treats
 * `null` as "remove").
 */
export function reasoningSettingsPatch<U extends null | undefined>(
  value: ReasoningFormValue,
  unset: U,
  existing?: unknown,
): { reasoning: Record<string, unknown> | U; returnReasoning: false | U } {
  const prior = readModelReasoning(existing);
  const reasoning: Record<string, unknown> = {};
  if (value.effort) reasoning.effort = value.effort;
  if (value.budgetTokens !== '' && Number(value.budgetTokens) > 0 && value.effort !== 'none') {
    reasoning.budgetTokens = Number(value.budgetTokens);
  }
  if (value.includeThoughts === false && value.effort !== 'none') reasoning.includeThoughts = false;
  // Legacy OpenAI summary mode is not editable here but must survive a save.
  if (prior?.summary) reasoning.summary = prior.summary;

  return {
    reasoning: Object.keys(reasoning).length > 0 ? reasoning : unset,
    returnReasoning: value.returnReasoning === false ? false : unset,
  };
}
