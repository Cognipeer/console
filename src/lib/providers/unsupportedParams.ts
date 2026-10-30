/**
 * Which OpenAI-schema parameters a given model refuses.
 *
 * This is the automatic half of the parameter-stripping story, and the direct
 * equivalent of LiteLLM's `drop_params` + `get_supported_openai_params()`: a
 * registry keyed on **provider driver and model id**, so a request never carries
 * a parameter the upstream is going to reject. The per-model facts (OpenAI
 * reasoning families, GPT tools + reasoning, `max_completion_tokens`) come from
 * the agent-sdk rule table (`modelRules.ts`) - the only place they are written
 * down; this file adds the wire-level rules and the operator's manual layer. The manual
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

import { resolveRuleForDriver, unsupportedParamsOfRule } from '@/lib/services/models/modelRules';
// The one list of OpenAI-schema drivers (`together` included) lives in services/models/reasoning.ts; the native clients
// (contracts/nativeClients.ts) re-export it. Taken from this pure module, not from nativeClients: that one pulls the
// server-side clients into the model forms' bundle.
import { OPENAI_SCHEMA_DRIVERS } from '@/lib/services/models/reasoning';
import { resolveUpstreamApi } from '@/lib/services/models/upstreamApi';

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
  /**
   * Wire values the request must CARRY when it also has tools, rather than
   * merely omit. Dropping is not always enough: a hosted upstream can supply its
   * own default for a parameter and reject the combination anyway. AWS Bedrock's
   * `/openai/v1` does exactly this for the gpt-5 family — a tool call with no
   * `reasoning_effort` at all still 400s, and only an explicit
   * `reasoning_effort: "none"` (the value the upstream's own error message names)
   * gets through. Applied AFTER `paramsWithTools` strips whatever the caller
   * asked for, so the forced value always wins.
   */
  forcedParamsWithTools?: Readonly<Record<string, unknown>>;
  /** Shown in the UI next to the detected parameters. */
  reason: string;
}

export const UNSUPPORTED_PARAM_RULES: readonly UnsupportedParamRule[] = [
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

/**
 * OpenAI-schema drivers whose parameter limits come from the SDK rule table. Bedrock / Vertex / Anthropic
 * clients apply their own rules inside the SDK, so nothing is detected for them here.
 */
const RULE_DRIVEN_DRIVERS: ReadonlySet<string> = OPENAI_SCHEMA_DRIVERS;

/**
 * Whether the driver speaks the OpenAI chat-completions schema: the only ones with a `max_tokens` /
 * `max_completion_tokens` choice to make (Anthropic, Bedrock and Vertex carry the cap in their own field).
 */
export function isOpenAiSchemaDriver(driver: string | undefined | null): boolean {
  return !!driver && RULE_DRIVEN_DRIVERS.has(driver);
}

function detectFromSdkRule(driver: string, modelId: string, hasTools: boolean): DetectedUnsupportedParams | undefined {
  if (!RULE_DRIVEN_DRIVERS.has(driver)) return undefined;
  const rule = resolveRuleForDriver(driver, modelId);
  if (!rule) return undefined;
  const params = unsupportedParamsOfRule(rule);
  // GPT-5+: Chat Completions 400s on function tools next to any reasoning effort but 'none' (and the model's own
  // default is not always 'none'), so the effort is dropped and 'none' is sent explicitly.
  const forceNone = hasTools && rule.chatTools.reasoning === 'force-none';
  if (forceNone) params.push('reasoning', 'reasoning_effort');
  if (params.length === 0 && !forceNone) return undefined;
  return {
    params,
    reason: rule.note,
    ruleId: rule.matchedRuleId,
    ...(forceNone ? { forced: { reasoning_effort: 'none' } } : {}),
  };
}

export interface DetectedUnsupportedParams {
  /** Wire names to strip. Empty when no rule matched. */
  params: string[];
  /** Human-readable justification, for the UI and for logs. */
  reason?: string;
  /** Id of the rule that matched. */
  ruleId?: string;
  /** Values the request must carry — see `forcedParamsWithTools`. */
  forced?: Readonly<Record<string, unknown>>;
}

const EMPTY: DetectedUnsupportedParams = { params: [] };

/**
 * Parameters the given model is known to reject. Returns an empty list — never
 * throws — for any driver or model the registry says nothing about.
 *
 * `hasTools` folds in a rule's `paramsWithTools` — pass `true` only when this
 * particular call carries function tools, since those params are otherwise fine.
 */
/**
 * The ids a rule is matched against: the model id as configured, plus each
 * suffix after a leading dotted segment.
 *
 * Every rule here is anchored at the start of the model id, which is right for a
 * first-party endpoint (`gpt-5.6-terra`) and wrong for every gateway that
 * namespaces the same model. AWS Bedrock serves it as
 * `global.openai.gpt-5.6-terra` and Anthropic's models as
 * `eu.anthropic.claude-...`, so anchored matching silently detected nothing and
 * the request went out with the parameters the upstream rejects.
 */
export function candidateModelIds(modelId: string): string[] {
  const candidates = [modelId];
  let rest = modelId;
  // Only leading `vendor.`/`region.` style segments are peeled: a dot inside the
  // model name itself (`gpt-5.6-terra`) must never split it, so a segment only
  // counts when it has no dash or colon in it.
  for (;;) {
    const dot = rest.indexOf('.');
    if (dot === -1) break;
    const head = rest.slice(0, dot);
    if (head === '' || /[-:]/.test(head)) break;
    rest = rest.slice(dot + 1);
    candidates.push(rest);
  }
  return candidates;
}

export function detectUnsupportedParams(
  driver: string | undefined,
  modelId: string | undefined,
  hasTools = false,
): DetectedUnsupportedParams {
  if (!driver || !modelId) return EMPTY;

  const fromRule = detectFromSdkRule(driver, modelId, hasTools);
  if (fromRule) return fromRule;

  const candidates = candidateModelIds(modelId);
  const rule = UNSUPPORTED_PARAM_RULES.find(
    (candidate) =>
      candidate.drivers.includes(driver)
      && candidates.some((id) => candidate.match.test(id)),
  );

  if (!rule) return EMPTY;

  const params = hasTools && rule.paramsWithTools
    ? [...rule.params, ...rule.paramsWithTools]
    : [...rule.params];

  return {
    params,
    reason: rule.reason,
    ruleId: rule.id,
    ...(hasTools && rule.forcedParamsWithTools ? { forced: rule.forcedParamsWithTools } : {}),
  };
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

/** OpenAI-schema drivers (`together` included, see `OPENAI_SCHEMA_DRIVERS`). */
const REASONING_EFFORT_DRIVERS: ReadonlySet<string> = OPENAI_SCHEMA_DRIVERS;

/**
 * Whether a reasoning effort that arrived on the REQUEST may be sent to this
 * model. OpenAI and Azure answer `reasoning_effort` on a model that does not
 * reason (gpt-4o, gpt-5-chat) with a 400; a caller's effort there is dropped, as
 * the LangChain-based gateway always did. Every other model gets it: the SDK
 * maps a level the model lacks to the nearest one it takes, and a model the
 * rule table does not know is learned from the provider's answer. An operator's
 * Model Hub pin never goes through this check: what the operator wrote is what
 * is sent. Providers with their own reasoning envelope (Anthropic, Bedrock,
 * Vertex) are not OpenAI-schema and always pass.
 */
export function requestReasoningEffortAccepted(
  driver: string | undefined,
  modelId: string | undefined,
  effort: string | undefined,
): boolean {
  if (!driver || !REASONING_EFFORT_DRIVERS.has(driver)) return true;
  if (!effort) return true;
  return resolveRuleForDriver(driver, modelId)?.reasoning.style !== 'none';
}

/**
 * Whether a reasoning picker should tell the operator that, with tools, this model runs WITHOUT reasoning: on GPT-5.1+
 * and gpt-6 (rule `chatTools.reasoning: 'force-none'`) Chat Completions answers any effort but `none` next to function
 * tools with a 400, so the gateway sends `none` whatever is set. Only while the model's Upstream API is Chat
 * Completions: the Responses API takes both together and keeps reasoning (`buildTransformRequest` skips the rule
 * there). Follows what the gateway detects, so a model with automatic detection switched off is not announced either.
 */
export function reasoningForcedNoneOnChat(
  driver: string | undefined | null,
  modelId: string | undefined,
  settings: unknown,
): boolean {
  if (!driver || resolveUpstreamApi(settings) !== 'chat') return false;
  const autoDetect = settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>).autoDropUnsupportedParams
    : undefined;
  return Boolean(
    resolveUnsupportedParamNames({ driver, modelId, autoDetect, hasTools: true }).detected.forced?.reasoning_effort,
  );
}
