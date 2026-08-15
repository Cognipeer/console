/**
 * Which OpenAI-schema parameters a given model refuses.
 *
 * This is the automatic half of the parameter-stripping story, and the direct
 * equivalent of LiteLLM's `drop_params` + `get_supported_openai_params()`: a
 * maintained registry keyed on **provider driver and model id**, so a request
 * never carries a parameter the upstream is going to reject. The manual
 * per-model `settings.unsupportedParams` list is the equivalent of LiteLLM's
 * `additional_drop_params` and is unioned on top of whatever is detected here.
 *
 * Two deliberate choices:
 *  - Detection is per driver, not global. `gpt-5` behind `openai` and `gpt-5`
 *    behind a self-hosted `openai-compatible` shim are different upstreams, and
 *    a rule that fits one may not fit the other.
 *  - A model can opt out with `settings.autoDropUnsupportedParams: false`, which
 *    plays the role of LiteLLM's `allowed_openai_params` — for the case where a
 *    provider has since started accepting a parameter this table still lists.
 *
 * Keeping the table honest matters: a wrong entry silently changes sampling
 * behaviour, a missing entry produces a 400. Add a rule only for a restriction
 * the provider actually documents.
 */

/** Drivers that speak the OpenAI chat-completions schema. */
const OPENAI_SCHEMA_DRIVERS = ['openai', 'openai-compatible', 'azure'] as const;

export interface UnsupportedParamRule {
  /** Stable id, used in logs so a surprising drop can be traced to its rule. */
  id: string;
  /** Provider drivers this rule applies to. */
  drivers: readonly string[];
  /** Matched against the upstream model id (not the Model Hub key). */
  match: RegExp;
  /** Wire names the model rejects. */
  params: readonly string[];
  /** Shown in the UI next to the detected parameters. */
  reason: string;
}

export const UNSUPPORTED_PARAM_RULES: readonly UnsupportedParamRule[] = [
  {
    id: 'openai-o-series',
    drivers: OPENAI_SCHEMA_DRIVERS,
    match: /^o\d/,
    // The o-series rejects the whole sampling group outright and replaced
    // `max_tokens` with `max_completion_tokens`.
    params: [
      'temperature',
      'top_p',
      'presence_penalty',
      'frequency_penalty',
      'logprobs',
      'top_logprobs',
      'logit_bias',
      'max_tokens',
    ],
    reason: 'OpenAI reasoning family (o-series): sampling parameters are fixed and max_tokens was replaced by max_completion_tokens',
  },
  {
    id: 'openai-gpt-5',
    drivers: OPENAI_SCHEMA_DRIVERS,
    // `gpt-5-chat` is the non-reasoning variant and keeps the normal knobs.
    match: /^gpt-5(?!-chat)/,
    params: ['temperature', 'top_p', 'max_tokens'],
    reason: 'GPT-5 family: only the default temperature and top_p are accepted, and max_tokens was replaced by max_completion_tokens',
  },
];

export interface DetectedUnsupportedParams {
  /** Wire names to strip. Empty when no rule matched. */
  params: string[];
  /** Human-readable justification, for the UI and for logs. */
  reason?: string;
  /** Id of the rule that matched. */
  ruleId?: string;
}

const EMPTY: DetectedUnsupportedParams = { params: [] };

/**
 * Parameters the given model is known to reject. Returns an empty list — never
 * throws — for any driver or model the registry says nothing about.
 */
export function detectUnsupportedParams(
  driver: string | undefined,
  modelId: string | undefined,
): DetectedUnsupportedParams {
  if (!driver || !modelId) return EMPTY;

  const rule = UNSUPPORTED_PARAM_RULES.find(
    (candidate) => candidate.drivers.includes(driver) && candidate.match.test(modelId),
  );

  if (!rule) return EMPTY;

  return { params: [...rule.params], reason: rule.reason, ruleId: rule.id };
}

/**
 * Everything to strip for a model: what the registry detects for its driver plus
 * whatever the operator listed by hand, de-duplicated. Detection can be switched
 * off per model, in which case only the manual list applies.
 */
export function resolveUnsupportedParamNames(input: {
  driver?: string;
  modelId?: string;
  manual?: unknown;
  autoDetect?: unknown;
}): { params: string[]; detected: DetectedUnsupportedParams } {
  const detected = input.autoDetect === false
    ? EMPTY
    : detectUnsupportedParams(input.driver, input.modelId);

  const manual = Array.isArray(input.manual)
    ? input.manual.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return {
    detected,
    params: [...new Set([...detected.params, ...manual].map((name) => name.trim()).filter(Boolean))],
  };
}
