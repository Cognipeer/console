/**
 * Request-side rules of the gateway that are independent of any chat library:
 * which body fields are known, what may pass through to an upstream, how a
 * request's parameters and the model record combine, and how a request is
 * described for the logs.
 */

import { AGENT_REASONING_OVERRIDE, hasExplicitThinking, normalizeReasoning, resolveGatewayReasoning } from '@/lib/services/models/reasoning';
import { computeOutputTokenLimit, modelMaxOutputTokens } from '@/lib/services/models/outputLimits';
import { createLogger } from '@/lib/core/logger';
import type { IModel } from '@/lib/database';
import { requestReasoningEffortAccepted, resolveUnsupportedParamNames } from '@/lib/providers/unsupportedParams';
import { resolveUpstreamApi, supportsUpstreamApiChoice } from '@/lib/services/models/upstreamApi';

const logger = createLogger('inference');

/**
 * The parts of a model request that decide the SHAPE of the answer, recorded
 * in one canonical form for every call site and every surface (gateway logs,
 * tracing, evaluation runs).
 *
 * Messages alone cannot explain a malformed or prose-instead-of-JSON reply:
 * whether the provider was asked for a JSON schema, which tools were on the
 * table, and where the output ceiling sat are what actually determine it.
 * Logging those was the missing half — without them a structured-output
 * failure is indistinguishable from a model that simply chose to write prose.
 *
 * Tool SCHEMAS get their own byte budget (like `responseFormat.schema` below)
 * rather than being logged unconditionally: the full definitions routinely
 * dwarf the rest of the payload and would be truncated away by
 * `sanitizeForLogging`'s whole-payload cap, taking the response with them.
 * `names`/`count` are always logged regardless, so a caller that only needs
 * "which tools were offered" never depends on the budget.
 */
export interface LoggedRequestContract {
  responseFormat?: {
    type: string;
    schemaName?: string;
    strict?: boolean;
    /** The JSON Schema as sent, when it fits RESPONSE_SCHEMA_LOG_MAX_BYTES. */
    schema?: Record<string, unknown>;
    /** Set when the schema was dropped by that budget. */
    schemaTruncated?: true;
  };
  tools?: {
    count: number;
    names: string[];
    /** The full tool/function definitions as sent, when they fit TOOLS_SCHEMA_LOG_MAX_BYTES. */
    schemas?: unknown[];
    /** Set when the schemas were dropped by that budget — names/count still logged. */
    schemasTruncated?: true;
  };
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

/**
 * Per-field budget for the logged response schema. Deliberately far below
 * `sanitizeForLogging`'s whole-payload cap: that cap replaces the ENTIRE
 * providerRequest with a preview once exceeded, so an unbounded schema would
 * take the messages down with it. Beyond this budget the contract's identity
 * (type / name / strict) survives and only the schema body is dropped.
 */
const RESPONSE_SCHEMA_LOG_MAX_BYTES = 8 * 1024;

/** Same rationale as RESPONSE_SCHEMA_LOG_MAX_BYTES, sized for a typical tool
 *  menu (several tool definitions) rather than a single schema. */
const TOOLS_SCHEMA_LOG_MAX_BYTES = 16 * 1024;

export function describeRequestContract(body: Record<string, unknown> | undefined): LoggedRequestContract {
  const out: LoggedRequestContract = {};
  if (!body) return out;

  const rf = body.response_format ?? body.responseFormat;
  if (rf && typeof rf === 'object') {
    const r = rf as Record<string, unknown>;
    const schema = (r.json_schema ?? r.jsonSchema) as Record<string, unknown> | undefined;
    // The schema itself is what a REPLAY needs (evaluation suite, prompt
    // optimizer, traffic snapshot): a summary says a contract existed, only
    // the schema lets the same contract be sent again.
    const body_ = schema?.schema;
    let schemaBody: Record<string, unknown> | undefined;
    let schemaTruncated = false;
    if (body_ && typeof body_ === 'object' && !Array.isArray(body_)) {
      try {
        if (Buffer.byteLength(JSON.stringify(body_), 'utf8') <= RESPONSE_SCHEMA_LOG_MAX_BYTES) {
          schemaBody = body_ as Record<string, unknown>;
        } else {
          schemaTruncated = true;
        }
      } catch {
        schemaTruncated = true;
      }
    }
    out.responseFormat = {
      type: typeof r.type === 'string' ? r.type : 'unknown',
      ...(schema && typeof schema.name === 'string' ? { schemaName: schema.name } : {}),
      ...(schema && typeof schema.strict === 'boolean' ? { strict: schema.strict } : {}),
      ...(schemaBody ? { schema: schemaBody } : {}),
      ...(schemaTruncated ? { schemaTruncated: true as const } : {}),
    };
  }

  const tools = body.tools;
  if (Array.isArray(tools)) {
    out.tools = {
      count: tools.length,
      names: tools
        .map((t) => {
          const entry = t as Record<string, unknown> | null;
          const fn = entry?.function as Record<string, unknown> | undefined;
          const name = fn?.name ?? entry?.name;
          return typeof name === 'string' ? name : null;
        })
        .filter((n): n is string => Boolean(n)),
    };
    // Full definitions are what a REPLAY needs (evaluation suite, prompt
    // optimizer, traffic snapshot) — same reasoning as the response schema
    // above, on its own budget so an oversized tool menu can't take the
    // messages down with it.
    try {
      if (Buffer.byteLength(JSON.stringify(tools), 'utf8') <= TOOLS_SCHEMA_LOG_MAX_BYTES) {
        out.tools.schemas = tools;
      } else {
        out.tools.schemasTruncated = true;
      }
    } catch {
      out.tools.schemasTruncated = true;
    }
  }
  if (body.tool_choice !== undefined) out.toolChoice = body.tool_choice;

  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.maxTokens;
  if (typeof maxTokens === 'number') out.maxTokens = maxTokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.topP = body.top_p;

  return out;
}

export function sanitizeForLogging(payload: unknown, maxLength = 20000) {
  if (payload === null || payload === undefined) {
    return payload;
  }

  try {
    const json = JSON.stringify(payload);
    if (json.length <= maxLength) {
      return payload;
    }
    return {
      truncated: true,
      preview: json.slice(0, maxLength),
    };
  } catch {
    return '[unserializable]';
  }
}

/**
 * Body fields the gateway understands natively. Everything else is a candidate
 * for passthrough (see `buildPassthroughBody`) rather than being dropped.
 */
export const KNOWN_REQUEST_FIELDS = new Set([
  // Unwrapped below rather than forwarded as-is; forwarding the literal key too
  // makes OpenAI and Azure answer 400 "Unrecognized request argument".
  'extra_body',
  'frequency_penalty',
  'max_completion_tokens',
  'max_output_tokens',
  'max_tokens',
  'messages',
  'modality',
  'model',
  'presence_penalty',
  'include_reasoning',
  'reasoning',
  'reasoning_effort',
  'request_id',
  'response_format',
  'seed',
  'stop',
  'stream',
  'temperature',
  'tool_choice',
  'tools',
  'top_p',
]);

/**
 * Fields a caller must never be able to inject into the upstream body — they
 * either address our own routing or would let a request rewrite the transport.
 */
export const PASSTHROUGH_DENYLIST = new Set([
  'api_key',
  'apikey',
  'authorization',
  'base_url',
  'messages',
  'model',
  'stream',
]);

export function buildOverrides(body: Record<string, unknown>) {
  const overrides: Record<string, unknown> = {};
  const fields = [
    'temperature',
    'top_p',
    'max_tokens',
    'presence_penalty',
    'frequency_penalty',
    'seed',
  ];

  fields.forEach((field) => {
    if (body[field] !== undefined) {
      overrides[field] = body[field];
    }
  });

  if (body.stop !== undefined) overrides.stop = body.stop;
  if (body.tools !== undefined) overrides.tools = body.tools;
  if (body.tool_choice !== undefined) overrides.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) {
    overrides.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.strict !== undefined) overrides.strict = body.strict;
  if (body.stream_options !== undefined) {
    overrides.stream_options = body.stream_options;
  }
  if (body.response_format !== undefined)
    overrides.response_format = body.response_format;
  if (body.modality !== undefined) overrides.modality = body.modality;
  if (body.max_output_tokens !== undefined)
    overrides.max_output_tokens = body.max_output_tokens;

  // Reasoning model support (o1, o3, o4-mini, etc.)
  // max_completion_tokens is required for reasoning models instead of max_tokens
  if (body.max_completion_tokens !== undefined)
    overrides.max_completion_tokens = body.max_completion_tokens;

  // reasoning parameter: { effort: "low" | "medium" | "high", summary?: "auto" | "concise" }
  if (body.reasoning !== undefined) overrides.reasoning = body.reasoning;

  // Legacy reasoning_effort parameter (deprecated but still supported)
  // Read as a reasoning effort when no `reasoning` object is sent.
  if (body.reasoning_effort !== undefined)
    overrides.reasoning_effort = body.reasoning_effort;

  return overrides;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...(value as Record<string, unknown>) };
}

function buildChatModelSettings(
  modelSettings: unknown,
  overrides: Record<string, unknown>,
  agentReasoning?: unknown,
  target?: { driver?: string; modelId?: string },
) {
  const settings = asRecord(modelSettings);

  if (overrides.temperature !== undefined) {
    settings.temperature = overrides.temperature;
  }

  // top_p / presence_penalty / frequency_penalty were collected from the request
  // and then read by nobody, so the API accepted them and silently sampled at
  // the provider's defaults.
  if (overrides.top_p !== undefined) {
    settings.topP = overrides.top_p;
  }

  if (overrides.presence_penalty !== undefined) {
    settings.presencePenalty = overrides.presence_penalty;
  }

  if (overrides.frequency_penalty !== undefined) {
    settings.frequencyPenalty = overrides.frequency_penalty;
  }

  if (overrides.max_tokens !== undefined) {
    settings.maxTokens = overrides.max_tokens;
  }

  if (overrides.max_completion_tokens !== undefined) {
    settings.maxCompletionTokens = overrides.max_completion_tokens;
  }

  // The request's limit (any of the three names a caller may use) is THE limit of this call: it replaces
  // both of the model's, so the native client - which reads `maxCompletionTokens` before `maxTokens` -
  // sends the value `resolveOutputTokenLimit` reports, not a model-level `maxCompletionTokens` that the
  // request's `max_tokens` was meant to override.
  const requested = firstPositiveNumber(
    overrides.max_completion_tokens,
    overrides.max_tokens,
    overrides.max_output_tokens,
  );
  if (requested !== undefined) {
    settings.maxTokens = requested;
    settings.maxCompletionTokens = requested;
    // Marks the limit as the caller's: a hard cap the thinking headroom never raises (outputLimits.ts).
    settings.requestMaxTokens = requested;
  } else {
    // Call-scoped: never read from a stored model record.
    delete settings.requestMaxTokens;
  }

  // Model Hub default > request value > nothing. The request only fills the
  // gap when the operator left the model's reasoning unset; it never overrides
  // what the UI pinned (see `resolveGatewayReasoning`).
  // (An agent's own pick, carried through a Dynamic LLM, is the one thing above the Model Hub default.)
  const picked = normalizeReasoning(agentReasoning);
  const resolved = picked
    ? { reasoning: picked, source: 'agent' as const }
    : resolveGatewayReasoning(settings, {
        reasoning: overrides.reasoning,
        reasoning_effort: overrides.reasoning_effort,
      });
  // A caller's own effort only reaches a model that takes one; the agent's pick
  // and the operator's pin are deliberate and always go through.
  const droppedRequestEffort =
    resolved.source === 'request'
    && target !== undefined
    && !requestReasoningEffortAccepted(target.driver, target.modelId, resolved.reasoning?.effort);
  if (resolved.reasoning && !droppedRequestEffort) {
    settings.reasoning = resolved.reasoning;
  } else {
    delete settings.reasoning;
  }

  return settings;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
}

/** What a call's output limit depends on besides the request and the model's settings. */
export type OutputLimitContext = {
  /** The provider driver; defaults to the model's own. */
  driver?: string;
  /** The model record: its declared maximum output beats the built-in table by model id. */
  model?: IModel;
  /** A streaming call; a non-streaming default is capped (outputLimits.ts). */
  stream?: boolean;
  /**
   * What the native client derives thinking from for this call: the normalized reasoning of the call's
   * settings (`{ effort?, budgetTokens?, includeThoughts? }`, any shape `normalizeReasoning` reads).
   * Pass undefined for a call that runs without thinking (a tool loop whose signed thinking blocks were
   * lost, see `hasUnreplayableToolTurn`).
   */
  reasoning?: unknown;
};

/**
 * The output limit of a call: the first positive of the caller / retry override (`max_completion_tokens`,
 * `max_tokens`, `max_output_tokens`), the model's `maxCompletionTokens`, then its `maxTokens`.
 *
 * Without a context that is all it is. With a context it is EXACTLY the `max_tokens` the native client sends
 * (the same `computeOutputTokenLimit` decides both): the driver default (anthropic: the model maximum, else
 * 8192; a non-streaming default capped), then the thinking headroom, then capped by the model maximum when
 * the value is a default or a raise. undefined = no limit is sent (the provider's maximum applies).
 */
export function resolveOutputTokenLimit(
  overrides: Record<string, unknown>,
  modelSettings: Record<string, unknown>,
  context?: OutputLimitContext,
): number | undefined {
  const override = firstPositiveNumber(
    overrides.max_completion_tokens,
    overrides.max_tokens,
    overrides.max_output_tokens,
    modelSettings.requestMaxTokens,
  );
  const configured = firstPositiveNumber(modelSettings.maxCompletionTokens, modelSettings.maxTokens);
  if (!context) return override ?? configured;

  return computeOutputTokenLimit({
    driver: context.driver ?? context.model?.providerDriver,
    modelId: context.model?.modelId,
    modelMax: context.model
      ? modelMaxOutputTokens(context.model)
      : firstPositiveNumber(modelSettings.maxOutputTokens, modelSettings.max_output_tokens),
    override,
    configured,
    stream: context.stream,
    reasoning: context.reasoning,
    explicitThinking: hasExplicitThinking(modelSettings.extraBody),
  });
}

/**
 * Extra request-body fields destined for the upstream verbatim: the model's own
 * `settings.requestDefaults` merged under anything the caller sent that our
 * schema does not know (`chat_template_kwargs`, `top_k`, `repetition_penalty`,
 * `min_p`, …). Caller passthrough is opt-in per model, because forwarding
 * arbitrary fields to a provider is a decision the operator should make.
 *
 * Precedence is model defaults < caller body, and plain objects merge one level
 * deep so a caller's `chat_template_kwargs: { enable_thinking: true }` does not
 * erase a sibling key the operator set on the model.
 */
export function buildPassthroughBody(
  modelSettings: unknown,
  body: Record<string, unknown>,
  blockedNames: Set<string>,
  driver?: string,
): Record<string, unknown> | undefined {
  const settings = asRecord(modelSettings);
  const bedrock = driver === 'bedrock';
  // Bedrock: the caller's fields are collected apart and land only in `additionalModelRequestFields` (below).
  const callerFields: Record<string, unknown> = {};
  const defaults = asRecord(settings.requestDefaults);
  const explicit = asRecord(settings.extraBody);
  const merged: Record<string, unknown> = { ...defaults, ...explicit };

  // Operator-authored defaults are not exempt from the reserved-key rule: these
  // address our own routing, and the UI validator that rejects them only guards
  // one of the two surfaces that can write them.
  for (const key of Object.keys(merged)) {
    if (PASSTHROUGH_DENYLIST.has(key.toLowerCase())) delete merged[key];
  }

  if (settings.allowUnknownPassthrough === true) {
    // A parameter the operator declared unsupported must not come back through
    // the passthrough channel; and a parameter the gateway already resolves has
    // its own precedence rules, so it must not be duplicated here either —
    // extra-body fields are spread *after* them in the provider SDK and would
    // win.
    const accept = (key: string) =>
      !KNOWN_REQUEST_FIELDS.has(key)
      && !PASSTHROUGH_DENYLIST.has(key.toLowerCase())
      && !blockedNames.has(key.toLowerCase());

    const mergeField = (key: string, value: unknown) => {
      if (bedrock) {
        // Converse's own top-level fields (`guardrailConfig`, `serviceTier` ...) belong to the operator's model
        // record: a caller's extra field is model-specific data and goes under `additionalModelRequestFields`.
        if (key.startsWith('__') || BEDROCK_REQUEST_OWNED_FIELDS.has(key)) return;
        if (key === 'additionalModelRequestFields') {
          if (isPlainObject(value)) {
            for (const [k, v] of Object.entries(value)) {
              if (!k.startsWith('__')) callerFields[k] = v;
            }
          }
          return;
        }
        const existing = callerFields[key];
        callerFields[key] = isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
        return;
      }
      const existing = merged[key];
      merged[key] = isPlainObject(existing) && isPlainObject(value)
        ? { ...existing, ...value }
        : value;
    };

    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || !accept(key)) continue;
      mergeField(key, value);
    }

    // `extra_body` is how OpenAI SDK users carry non-schema fields; unwrap it so
    // those land as real top-level body fields rather than a nested object the
    // upstream would reject. `extra_body` itself is a known field, so the loop
    // above already skipped the literal key.
    for (const [key, value] of Object.entries(asRecord(body.extra_body))) {
      if (!accept(key)) continue;
      mergeField(key, value);
    }
  }

  if (bedrock && Object.keys(callerFields).length > 0) {
    const operatorFields = asRecord(merged.additionalModelRequestFields);
    merged.additionalModelRequestFields = { ...operatorFields, ...callerFields };
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Converse request fields the gateway builds itself; a caller's passthrough never carries them on Bedrock. */
const BEDROCK_REQUEST_OWNED_FIELDS: ReadonlySet<string> = new Set(['messages', 'system', 'inferenceConfig', 'toolConfig']);


export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The one place a chat runnable's parameters are decided. Every caller that
 * builds a chat model — the gateway, agents, guardrail judges — goes through
 * here so a model's `unsupportedParams` and `requestDefaults` apply everywhere,
 * not only on the routes that happen to remember to read them.
 *
 * `unsupportedParams` is stripped at the contract layer (`resolveOverrides`),
 * which is the last point before the provider SDK; passing it through the
 * settings object keeps that single strip point authoritative.
 */
export function resolveModelInvocationConfig(
  model: Pick<IModel, 'settings'> & Partial<Pick<IModel, 'modelId' | 'providerDriver' | 'metadata'>>,
  body: Record<string, unknown>,
): {
  modelSettings: Record<string, unknown>;
  overrides: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
  unsupportedParams: string[];
} {
  const settings = asRecord(model.settings);
  // Responses takes reasoning next to function tools, so the Chat Completions tools rules do not apply there.
  const onResponses = supportsUpstreamApiChoice(model.providerDriver) && resolveUpstreamApi(model.settings) === 'responses';
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0 && !onResponses;

  // Resolved here as well as in the contract layer, because the passthrough body
  // is assembled here and must not smuggle back a parameter the provider is
  // known to reject.
  const { params: unsupportedParams, detected } = resolveUnsupportedParamNames({
    driver: model.providerDriver,
    modelId: model.modelId,
    manual: settings.unsupportedParams,
    autoDetect: settings.autoDropUnsupportedParams,
    hasTools,
  });
  const blockedLower = new Set(unsupportedParams.map((name) => name.toLowerCase()));

  const overrides = buildOverrides(body);
  const modelSettings = buildChatModelSettings(
    model.settings,
    overrides,
    (body as { [AGENT_REASONING_OVERRIDE]?: unknown })[AGENT_REASONING_OVERRIDE],
    { driver: model.providerDriver, modelId: model.modelId },
  );
  const extraBody = buildPassthroughBody(model.settings, body, blockedLower, model.providerDriver);

  if (extraBody) {
    modelSettings.extraBody = extraBody;
  }

  // The model's declared maximum output rides along so the native client, which never sees the record,
  // caps defaults and raises at the same number `resolveOutputTokenLimit` does.
  const maxOutput = modelMaxOutputTokens(model as IModel);
  if (maxOutput !== undefined) modelSettings.maxOutputTokens = maxOutput;

  // `reasoning`/`reasoning_effort` is a call-level field the constructor
  // wiring (openAiChatOverrides) always forwards, so — unlike the other
  // unsupported params, which get filtered in the contract layer — it has to
  // be dropped here, before it ever lands in modelSettings.
  if (blockedLower.has('reasoning') || blockedLower.has('reasoning_effort')) {
    delete modelSettings.reasoning;
  }

  // A rule can also REQUIRE a value, not just forbid one — see
  // `forcedParamsWithTools`. It goes on the passthrough body under its WIRE
  // name rather than through a typed setting: a provider that decides from the
  // model id whether a typed reasoning applies is prefix-anchored, so a
  // gateway-namespaced id (`global.openai.gpt-5.6-terra`) would silently lose
  // the parameter on the way out.
  // Merged last, after `buildPassthroughBody` has filtered the caller's fields,
  // so the forced value always wins.
  if (detected.forced) {
    modelSettings.extraBody = { ...asRecord(modelSettings.extraBody), ...detected.forced };
  }

  // Stripping silently changes sampling behaviour, so leave a trace of which
  // rule did it and what the caller had asked for.
  if (detected.params.length > 0) {
    const overridden = detected.params.filter((name) => body[name] !== undefined);
    if (overridden.length > 0) {
      logger.debug('Dropping parameters this model does not accept', {
        driver: model.providerDriver,
        dropped: overridden,
        modelId: model.modelId,
        rule: detected.ruleId,
      });
    }
  }

  return {
    modelSettings,
    overrides,
    extraBody,
    unsupportedParams,
  };
}
