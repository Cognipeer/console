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
  /** Wire names the model rejects outright, regardless of the rest of the request. */
  params: readonly string[];
  /**
   * Wire names the model only rejects when the request also carries function
   * tools (`tools`/`tool_choice`) — e.g. OpenAI's newer reasoning models 400 on
   * `reasoning`/`reasoning_effort` together with tools on `/v1/chat/completions`
   * ("use /v1/responses, or set reasoning_effort to 'none'"). Kept separate from
   * `params` because the parameter works fine — and callers rely on it — for a
   * tool-free request.
   */
  paramsWithTools?: readonly string[];
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
    // Confirmed on gpt-5.6-terra: /v1/chat/completions 400s with "Function tools
    // with reasoning_effort are not supported ... To use function tools, use
    // /v1/responses or set reasoning_effort to 'none'." The console does not proxy
    // /v1/responses, so the only safe move on this endpoint is to drop it.
    paramsWithTools: ['reasoning', 'reasoning_effort'],
    reason: 'GPT-5 family: only the default temperature and top_p are accepted, max_tokens was replaced by max_completion_tokens, and reasoning_effort cannot be combined with function tools on /v1/chat/completions (upstream requires /v1/responses, or reasoning_effort:"none")',
  },
  {
    id: 'anthropic-messages',
    drivers: ['anthropic'],
    // Every Claude model on the Messages API, not a family quirk.
    match: /^claude/i,
    // The Messages API has no penalty knobs and no OpenAI-style logprobs
    // surface. Passing them reaches the SDK as unknown constructor fields and
    // either 400s or is silently ignored depending on the version — neither is
    // a behaviour an operator should have to discover in production.
    params: [
      'presence_penalty',
      'frequency_penalty',
      'logprobs',
      'top_logprobs',
      'logit_bias',
      // NOTE: `max_completion_tokens` is deliberately NOT listed. Messages has
      // no such field, but the contract already folds it into `max_tokens`
      // (`maxCompletionTokens ?? maxTokens`), so blocking it here would throw
      // the caller's requested cap away and silently fall back to the default.
    ],
    reason: 'Anthropic Messages API: no presence/frequency penalties, no logprobs or logit_bias, and the output cap is max_tokens (there is no max_completion_tokens)',
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
 *
 * `hasTools` folds in a rule's `paramsWithTools` — pass `true` only when this
 * particular call carries function tools, since those params are otherwise fine.
 */
export function detectUnsupportedParams(
  driver: string | undefined,
  modelId: string | undefined,
  hasTools = false,
): DetectedUnsupportedParams {
  if (!driver || !modelId) return EMPTY;

  const rule = UNSUPPORTED_PARAM_RULES.find(
    (candidate) => candidate.drivers.includes(driver) && candidate.match.test(modelId),
  );

  if (!rule) return EMPTY;

  const params = hasTools && rule.paramsWithTools
    ? [...rule.params, ...rule.paramsWithTools]
    : [...rule.params];

  return { params, reason: rule.reason, ruleId: rule.id };
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
  hasTools?: boolean;
}): { params: string[]; detected: DetectedUnsupportedParams } {
  const detected = input.autoDetect === false
    ? EMPTY
    : detectUnsupportedParams(input.driver, input.modelId, input.hasTools);

  const manual = Array.isArray(input.manual)
    ? input.manual.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return {
    detected,
    params: [...new Set([...detected.params, ...manual].map((name) => name.trim()).filter(Boolean))],
  };
}
