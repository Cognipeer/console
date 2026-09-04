import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { fireAndForget } from '@/lib/core/asyncTask';
import { AIMessageChunk, type AIMessage } from '@langchain/core/messages';

const logger = createLogger('inference');
import { IModel } from '@/lib/database';
import type {
  SttRuntime,
  SttTranscribeInput,
  SttTranslateInput,
  TtsRuntime,
  TtsSynthesizeInput,
  OcrRuntime,
  OcrExtractInput,
  OcrResult,
  ImageGenerateInput,
} from '@/lib/providers';
import { resolveUnsupportedParamNames } from '@/lib/providers/unsupportedParams';
import { createInlineReasoningSplitter } from '@/lib/shared/inlineReasoning';
import { repairJsonContent } from '@/lib/shared/jsonExtraction';
import { InvalidRequestError } from '@/lib/providers/contracts/upstreamError';
import { getModelByKey } from './modelService';
import {
  toLangChainMessages,
  toOpenAIChatResponse,
  newCompletionId,
  openAIStreamDeltaChunk,
  openAIStreamRoleChunk,
  openAIStreamStopChunk,
  toOpenAIStreamChunk,
  summarizeUsage,
  extractFinishReason,
} from './openaiAdapter';
import {
  normalizeInferenceError,
  OutputTokenLimitError,
} from './openaiErrors';

export { OutputTokenLimitError } from './openaiErrors';

import { logModelUsage, TokenUsage } from './usageLogger';
import {
  MAX_ROUTING_DEPTH,
  buildDeciderMessages,
  evaluateRules,
  extractRoutingSignals,
  getDynamicRoutingConfig,
  parseDeciderLabel,
  publicSignals,
} from './dynamicRouting';
import type { IDynamicRoutingConfig, IModelUsageRouting } from '@/lib/database';
import { buildModelRuntime } from './runtimeService';
import {
  buildCacheVariantKey,
  isSemanticCacheEnabled,
  lookupCache,
  storeInCache,
} from './semanticCacheService';
import { createStreamGate, evaluateGuardrail } from '@/lib/services/guardrail';
import type { HookActor, HookScope } from '@/lib/services/guardrail';
// Not on the barrel (deliberately — see `guardrail/index.ts`). Read here only to
// version the semantic-cache key by the bound output guardrails' `updatedAt`.
import { getCachedGuardrail } from '@/lib/services/guardrail/hooks/recordCache';
// The gate's wire types are not re-exported from the guardrail barrel yet. A
// type-only import is erased at build time, so naming the module directly adds
// no runtime import edge — only the value import above goes through the barrel.
import type {
  OpenAiStreamChunkLike,
  StreamGateEmission,
} from '@/lib/services/guardrail/hooks/streamGate';
// Also not on the barrel yet, and this one IS a value import. Deep-importing it
// is still the right call: `binding.ts` is pure (one type-only import, no DB, no
// engine) so the extra module edge costs nothing, and the alternative —
// re-deriving "which guardrails does this model bind to this hook?" locally —
// is exactly the drift the module exists to prevent.
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';
import { resolveUsageAttribution } from '@/lib/services/usage/usageEvents';

const encoder = new TextEncoder();

// ── Guardrail block error ────────────────────────────────────────────────

/**
 * A finding as it may leave the process in an error body.
 *
 * `value` is the MATCHED STRING — the credential the secrets family found, the
 * card number the PII family found — and `span` is where it sits. The
 * evaluation logger masks `value` before storage for exactly that reason; the
 * HTTP error path did not, so a blocked completion handed the client the secret
 * it was blocked for. Both routes (`/chat/completions`, `/messages`) serialise
 * `error.findings` as-is, so the stripping happens HERE, where the error is
 * built, and covers every route at once. Everything that identifies the policy
 * decision (type, category, severity, message, code, action, block) is kept.
 */
export function clientSafeFindings(findings: readonly unknown[]): unknown[] {
  return findings.map((finding) => {
    if (!finding || typeof finding !== 'object') return finding;
    const { value: _value, span: _span, ...safe } = finding as Record<string, unknown>;
    void _value;
    void _span;
    return safe;
  });
}

export class GuardrailBlockError extends Error {
  readonly guardrailKey: string;
  readonly action: string;
  /** Client-safe: `value` and `span` are stripped at construction. */
  readonly findings: unknown[];

  constructor(
    message: string,
    guardrailKey: string,
    action: string,
    findings: unknown[] = [],
  ) {
    super(message);
    this.name = 'GuardrailBlockError';
    this.guardrailKey = guardrailKey;
    this.action = action;
    this.findings = clientSafeFindings(findings);
  }
}

/**
 * The bound output guardrails as `key@updatedAt` — the same `policyVersion`
 * spelling `HookVerdict` uses — for the semantic-cache variant key.
 *
 * Reads the RECORD CACHE (TTL'd, tenant-scoped), not the database: a request
 * that pays for an embedding and a vector search can afford a memoised record
 * read, but not a DB round trip per bound key. A record that cannot be read —
 * cache miss into a failing database, a key that no longer exists — falls back
 * to the bare key, so the lookup degrades to "keyed by binding" rather than
 * failing the request. An empty list is returned as `[]` on purpose: "no output
 * guardrail" is itself a policy that must not share entries with a guarded one.
 */
async function outputGuardrailPolicyVersions(
  tenantDbName: string,
  projectId: string | undefined,
  guardrailKeys: readonly string[],
): Promise<string[]> {
  return Promise.all(
    guardrailKeys.map(async (key) => {
      try {
        const record = await getCachedGuardrail(tenantDbName, key, projectId ?? null);
        const updatedAt = record?.updatedAt;
        const stamp = updatedAt instanceof Date && !Number.isNaN(updatedAt.getTime())
          ? updatedAt.toISOString()
          : typeof updatedAt === 'string'
            ? updatedAt
            : undefined;
        return stamp ? `${key}@${stamp}` : key;
      } catch {
        return key;
      }
    }),
  );
}

// ── Model guardrail enforcement ───────────────────────────────────────────
// Every guardrail a model binds runs on every chat completion. WHICH ones a
// given hook gets is `resolveBindings`' answer, not this file's: a model may
// carry the ordered `guardrails` list, or only the two legacy slots
// (`inputGuardrailKey` / `outputGuardrailKey`), and the resolver projects the
// second shape onto the first. For a legacy row that projection yields exactly
// one key per hook, so everything below reduces to what it did before.
//
// `input.pre` checks the latest user message before the model is called,
// `output.pre` the assistant response (non-streaming; the streamed answer is
// gated by `createStreamGate` and audited post-hoc). Blocking guardrails throw
// GuardrailBlockError.

function guardrailContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && 'text' in part
            ? String((part as { text?: unknown }).text ?? '')
            : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role === 'user') return guardrailContentToText(msg.content);
  }
  return '';
}

function extractAssistantText(response: unknown): string {
  const choices = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  return guardrailContentToText(choices?.[0]?.message?.content);
}

interface GuardrailEnforcementOutcome {
  /** Text with redact-action findings masked; undefined when nothing was redacted. */
  redactedText?: string;
  /** Non-blocking findings (warn/flag/redact) to surface to the caller. */
  findings: Awaited<ReturnType<typeof evaluateGuardrail>>['findings'];
  guardrailKey: string;
}

async function enforceModelGuardrail(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  guardrailKey: string;
  text: string;
  phase: 'input' | 'output';
  requestId?: string;
  source?: string;
}): Promise<GuardrailEnforcementOutcome | null> {
  if (!params.text.trim()) return null;
  const result = await evaluateGuardrail({
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    projectId: params.projectId,
    guardrailKey: params.guardrailKey,
    text: params.text,
    phase: params.phase,
    requestId: params.requestId,
    source: params.source ?? 'chat.completions',
  });
  // `blocked`, NOT `passed`: `passed` is the counterfactual ("would a blocking
  // finding have fired"), which stays true-to-form in monitor mode, while
  // `blocked` is the guardrail's Mode-neutralised decision. Reading `passed`
  // here is what made a Monitor guardrail keep refusing chat.completions.
  if (result.blocked) {
    // Prefer the finding's own message: a fail-closed guardrail whose judge model
    // could not run already explains that, and reducing it to the bare category
    // `evaluation_error` threw that explanation away — leaving a provider
    // misconfiguration looking like a content violation.
    const reasons = result.findings
      .filter((f) => f.block)
      .map((f) => f.message || f.category || f.type)
      .filter(Boolean)
      .join('; ');
    throw new GuardrailBlockError(
      `${params.phase === 'input' ? 'Input' : 'Output'} blocked by guardrail "${result.guardrailName}"${reasons ? `: ${reasons}` : ''}`,
      result.guardrailKey,
      result.action,
      result.findings,
    );
  }
  return {
    redactedText: result.redactedText,
    findings: result.findings,
    guardrailKey: result.guardrailKey,
  };
}

/** One guardrail's non-blocking findings, in the shape the response carries. */
interface GuardrailAnnotationResult {
  guardrail_key: string;
  findings: unknown[];
}

/**
 * A hook's entry in the response's `guardrails` extension field.
 *
 * `guardrail_key` + `findings` are the shape documented since the single-slot
 * days (docs/guide/guardrails.md) and are LEFT ALONE for the one-guardrail case,
 * which is every legacy row. When several guardrails contributed, the entry
 * grows a `results` breakdown rather than picking a winner: `findings` becomes
 * the concatenation over all of them — still a superset of what a consumer read
 * before, so an existing reader keeps working — and `results` is what says which
 * guardrail each finding came from. `guardrail_key` stays the FIRST contributor
 * in binding order, matching the singular/plural convention the verdict shape
 * already uses (`guardrailKey` + `guardrailKeys` in plugins/guardrails.ts).
 */
interface GuardrailAnnotation extends GuardrailAnnotationResult {
  /** Per-guardrail attribution. Present only when more than one contributed. */
  results?: GuardrailAnnotationResult[];
}

interface GuardrailChainOutcome {
  /**
   * Text after every redact-action rewrite in the chain; undefined when nothing
   * rewrote it. Distinguishing "unchanged" from "rewritten to the same string"
   * is what keeps the caller from cloning the request body for no reason.
   */
  redactedText?: string;
  /** Guardrails that produced findings, in binding order. */
  results: GuardrailAnnotationResult[];
}

/**
 * Runs every guardrail bound to one hook, in binding order, and folds them.
 *
 * Two properties are load-bearing:
 *
 *  1. THE FIRST BLOCKER WINS. `enforceModelGuardrail` throws, and the loop is
 *     sequential, so the GuardrailBlockError the caller sees — and therefore the
 *     message the end user reads — always comes from the earliest blocking
 *     guardrail in binding order. An operator who put the guardrail with the
 *     friendlier refusal first meant it, and a Promise.all here would make that
 *     message depend on which provider answered quickest.
 *
 *  2. REDACTIONS CHAIN. Guardrail N+1 evaluates the text as guardrail N left it,
 *     not the original. Feeding each the original and keeping the last
 *     `redactedText` would silently discard every earlier redaction — the
 *     composed result would mask strictly less than the guardrails did
 *     individually, which is the opposite of what composing them is for.
 *
 * A key that resolves to no record still throws (`evaluateGuardrail` does), as
 * it always has: a model pointing at a deleted guardrail is a misconfiguration,
 * and quietly running the rest of the chain would let it look enforced.
 */
async function enforceModelGuardrailChain(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  guardrailKeys: string[];
  text: string;
  phase: 'input' | 'output';
  requestId?: string;
  source?: string;
}): Promise<GuardrailChainOutcome> {
  const results: GuardrailAnnotationResult[] = [];
  let text = params.text;
  let rewritten = false;

  for (const guardrailKey of params.guardrailKeys) {
    const outcome = await enforceModelGuardrail({
      tenantDbName: params.tenantDbName,
      tenantId: params.tenantId,
      projectId: params.projectId,
      guardrailKey,
      text,
      phase: params.phase,
      requestId: params.requestId,
      source: params.source,
    });
    // null = there was nothing to check (empty text). That can happen mid-chain
    // when an earlier redaction emptied the message, and skipping is right:
    // there is no subject left to adjudicate.
    if (!outcome) continue;
    if (outcome.redactedText !== undefined) {
      text = outcome.redactedText;
      rewritten = true;
    }
    if (outcome.findings.length > 0) {
      results.push({
        guardrail_key: outcome.guardrailKey,
        findings: outcome.findings,
      });
    }
  }

  return { redactedText: rewritten ? text : undefined, results };
}

/** Collapses a chain's per-guardrail findings into one annotation entry. */
function foldGuardrailAnnotation(
  results: GuardrailAnnotationResult[],
): GuardrailAnnotation | undefined {
  if (results.length === 0) return undefined;
  // Byte-identical to the pre-multi-binding shape, deliberately: no `results`
  // key appears on a response that only ever had one guardrail on the hook.
  if (results.length === 1) return results[0];
  return {
    ...results[0],
    findings: results.flatMap((result) => result.findings),
    results,
  };
}

/** Rewrites the latest user message's textual content (used by the redact action). */
function replaceLatestUserText(messages: unknown, newText: string): unknown {
  if (!Array.isArray(messages)) return messages;
  const cloned = [...messages];
  for (let i = cloned.length - 1; i >= 0; i--) {
    const msg = cloned[i] as { role?: string; content?: unknown };
    if (msg?.role === 'user') {
      cloned[i] = { ...msg, content: newText };
      break;
    }
  }
  return cloned;
}

/** Attaches non-blocking guardrail findings to an OpenAI-shaped response. */
function annotateResponseWithGuardrails(
  response: unknown,
  annotations: Record<string, GuardrailAnnotation>,
): unknown {
  if (!response || typeof response !== 'object' || Object.keys(annotations).length === 0) {
    return response;
  }
  return { ...(response as Record<string, unknown>), guardrails: annotations };
}

// ── Streaming guardrail enforcement helpers ───────────────────────────────

/**
 * The actor a gateway-side hook call is made on behalf of.
 *
 * `HookActor.id` is required to come from the AUTHENTICATED context and never
 * from a caller-supplied field, so it is read from the same request-scoped
 * attribution `logModelUsage` already writes onto every usage row. When there is
 * no ambient request (a queued job, a unit test) it degrades to an anonymous
 * system actor, which is safe on THIS door specifically: the only check that
 * reads the actor is `tool_access`'s `allowedRoles`, and POLICY_VALID_HOOKS keeps
 * that family off `output.stream.delta`.
 */
function gatewayActor(): HookActor {
  const attribution = resolveUsageAttribution();
  const kind: HookActor['kind'] =
    attribution.actorType === 'user'
      ? 'user'
      : attribution.actorType === 'api_token'
        ? 'api_token'
        : 'system';
  return {
    id: attribution.userId ?? attribution.apiTokenId ?? '',
    kind,
    roles: [],
  };
}

/**
 * True when a frame the gate released actually put characters on the wire.
 *
 * This is what decides whether a later block has to tell the client to discard
 * what it already rendered: a block that lands before the first character is a
 * clean refusal, one that lands after it leaves half an answer on screen.
 */
function streamFrameHasContent(frame: OpenAiStreamChunkLike): boolean {
  return (frame.choices ?? []).some((choice) => {
    const content = choice.delta?.content;
    return typeof content === 'string' && content.length > 0;
  });
}

/**
 * Hand a stream payload to the gate in the shape the gate declares.
 *
 * The only difference is `finish_reason`: `toOpenAIStreamChunk` infers it as
 * `{} | null`, because LangChain types `response_metadata` as an open record.
 * The wire value is a string or null, and the loop below already relies on
 * exactly that (`typeof choice.finish_reason === 'string'`) — so the mismatch is
 * narrowed here, where the assumption is stated, rather than cast away at the
 * call site where it would be invisible.
 */
function toGateChunk(
  payload: ReturnType<typeof toOpenAIStreamChunk>,
): OpenAiStreamChunkLike {
  return {
    ...payload,
    choices: payload.choices.map((choice) => ({
      ...choice,
      finish_reason:
        typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    })),
  };
}

interface ChatRunnable {
  invoke(input: unknown, options?: Record<string, unknown>): Promise<AIMessage>;
  stream?(
    input: unknown,
    options?: Record<string, unknown>,
  ): AsyncIterable<AIMessageChunk> | Promise<AsyncIterable<AIMessageChunk>>;
}

function ensureChatRunnable(value: unknown): ChatRunnable {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid chat runtime.');
  }

  const candidate = value as Partial<ChatRunnable>;
  if (typeof candidate.invoke !== 'function') {
    throw new Error('Model provider returned an invalid chat runtime.');
  }

  return candidate as ChatRunnable;
}

type EmbeddingVector = number[] | Float32Array | { values: number[] };

interface EmbeddingRunnable {
  embedDocuments(inputs: string[]): Promise<EmbeddingVector[]>;
}

function ensureEmbeddingRunnable(value: unknown): EmbeddingRunnable {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid embedding runtime.');
  }

  const candidate = value as Partial<EmbeddingRunnable>;
  if (typeof candidate.embedDocuments !== 'function') {
    throw new Error('Model provider returned an invalid embedding runtime.');
  }

  return candidate as EmbeddingRunnable;
}

function normalizeEmbeddingVector(vector: EmbeddingVector): number[] {
  if (Array.isArray(vector)) {
    return vector;
  }

  if (vector instanceof Float32Array) {
    return Array.from(vector);
  }

  if (
    vector &&
    typeof vector === 'object' &&
    Array.isArray((vector as { values?: unknown }).values)
  ) {
    return (vector as { values: number[] }).values;
  }

  return [];
}

type ToolCallPayload = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

function getToolCallCount(message: AIMessage): number {
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) {
    return 0;
  }

  return toolCalls.length;
}

interface ChatCompletionRequestBody extends Record<string, unknown> {
  messages?: unknown;
  stream?: unknown;
  request_id?: string;
}

interface EmbeddingRequestBody extends Record<string, unknown> {
  input?: string | string[];
  request_id?: string;
  input_tokens?: number;
  inputTokenCount?: number;
}

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

function sanitizeForLogging(payload: unknown, maxLength = 20000) {
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
const KNOWN_REQUEST_FIELDS = new Set([
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
const PASSTHROUGH_DENYLIST = new Set([
  'api_key',
  'apikey',
  'authorization',
  'base_url',
  'messages',
  'model',
  'stream',
]);

function buildOverrides(body: Record<string, unknown>) {
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
  // Will be mapped to reasoning.effort by LangChain
  if (body.reasoning_effort !== undefined)
    overrides.reasoning_effort = body.reasoning_effort;

  return overrides;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...(value as Record<string, unknown>) };
}

function buildChatModelSettings(
  modelSettings: unknown,
  overrides: Record<string, unknown>,
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

  if (overrides.reasoning !== undefined) {
    settings.reasoning = overrides.reasoning;
  } else if (overrides.reasoning_effort !== undefined) {
    settings.reasoning = {
      ...(typeof settings.reasoning === 'object' && settings.reasoning !== null
        ? settings.reasoning as Record<string, unknown>
        : {}),
      effort: overrides.reasoning_effort,
    };
  }

  return settings;
}

function normalizeStrictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStrictJsonSchema);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const schema = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
      key,
      normalizeStrictJsonSchema(nestedValue),
    ]),
  );

  if (schema.type === 'object' || schema.properties) {
    schema.additionalProperties = false;
  }

  return schema;
}

function normalizeTools(tools: unknown, strictOverride: unknown): unknown {
  if (!Array.isArray(tools)) {
    return tools;
  }

  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }

    const normalizedTool = { ...(tool as Record<string, unknown>) };
    if (!normalizedTool.function || typeof normalizedTool.function !== 'object') {
      return normalizedTool;
    }

    const fn = { ...(normalizedTool.function as Record<string, unknown>) };
    const strict = typeof strictOverride === 'boolean' ? strictOverride : fn.strict;
    if (strict === true) {
      fn.strict = true;
      if (fn.parameters !== undefined) {
        fn.parameters = normalizeStrictJsonSchema(fn.parameters);
      }
    }

    normalizedTool.function = fn;
    return normalizedTool;
  });
}

function buildChatCallOptions(overrides: Record<string, unknown>) {
  const options: Record<string, unknown> = {};

  if (overrides.stop !== undefined) options.stop = overrides.stop;
  if (overrides.tools !== undefined) {
    options.tools = normalizeTools(overrides.tools, overrides.strict);
  }
  if (overrides.tool_choice !== undefined) options.tool_choice = overrides.tool_choice;
  if (overrides.parallel_tool_calls !== undefined) {
    options.parallel_tool_calls = overrides.parallel_tool_calls;
  }
  if (overrides.strict !== undefined) options.strict = overrides.strict;
  if (overrides.stream_options !== undefined) {
    options.stream_options = overrides.stream_options;
  }
  if (overrides.response_format !== undefined) {
    options.response_format = overrides.response_format;
  }
  if (overrides.seed !== undefined) options.seed = overrides.seed;
  if (overrides.modality !== undefined) {
    options.modalities = Array.isArray(overrides.modality)
      ? overrides.modality
      : [overrides.modality];
  }
  if (overrides.max_output_tokens !== undefined) {
    options.max_output_tokens = overrides.max_output_tokens;
  }

  return options;
}

function resolveOutputTokenLimit(
  overrides: Record<string, unknown>,
  modelSettings: Record<string, unknown>,
): number | undefined {
  const candidates = [
    overrides.max_completion_tokens,
    overrides.max_tokens,
    modelSettings.maxCompletionTokens,
    modelSettings.maxTokens,
  ];

  return candidates.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
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
function buildPassthroughBody(
  modelSettings: unknown,
  body: Record<string, unknown>,
  blockedNames: Set<string>,
): Record<string, unknown> | undefined {
  const settings = asRecord(modelSettings);
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

  return Object.keys(merged).length > 0 ? merged : undefined;
}


function isPlainObject(value: unknown): value is Record<string, unknown> {
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
  model: Pick<IModel, 'settings'> & Partial<Pick<IModel, 'modelId' | 'providerDriver'>>,
  body: Record<string, unknown>,
): {
  modelSettings: Record<string, unknown>;
  callOptions: Record<string, unknown>;
  overrides: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
  unsupportedParams: string[];
} {
  const settings = asRecord(model.settings);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

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
  const modelSettings = buildChatModelSettings(model.settings, overrides);
  const extraBody = buildPassthroughBody(model.settings, body, blockedLower);

  if (extraBody) {
    modelSettings.extraBody = extraBody;
  }

  // `reasoning`/`reasoning_effort` is a call-level field the constructor
  // wiring (openAiChatOverrides) always forwards, so — unlike the other
  // unsupported params, which get filtered in the contract layer — it has to
  // be dropped here, before it ever lands in modelSettings.
  if (blockedLower.has('reasoning') || blockedLower.has('reasoning_effort')) {
    delete modelSettings.reasoning;
  }

  // A rule can also REQUIRE a value, not just forbid one — see
  // `forcedParamsWithTools`. It goes on the passthrough body under its WIRE
  // name rather than through a typed setting: LangChain only forwards
  // `reasoning` for a model its own `isReasoningModel()` recognises, and that
  // check is prefix-anchored, so a gateway-namespaced id
  // (`global.openai.gpt-5.6-terra`) silently loses the parameter on the way out.
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
    callOptions: buildChatCallOptions(overrides),
    overrides,
    extraBody,
    unsupportedParams,
  };
}

/**
 * Circuit-breaker key for a chat call.
 *
 * Scoped to the MODEL, not just the provider. One Model Hub entry can be broken
 * on its own — a model id the upstream rejects, a response shape that fails to
 * parse — and a provider-wide key let that one model trip the breaker for every
 * other model behind the same credentials, which then answered `503 Circuit
 * breaker is open` for requests that would have succeeded. A genuine provider
 * outage still trips, once per model in use, which is what the breaker is for.
 */
function chatResilienceKey(prefix: 'chat' | 'chat-stream', model: IModel): string {
  return `${prefix}:${model.providerKey}:${model.modelId}`;
}

function ensureModerationModel(model: IModel) {
  if (model.category !== 'moderation') {
    throw new InvalidRequestError('Model is not configured for moderation');
  }
}

function ensureImageModel(model: IModel) {
  if (model.category !== 'image') {
    throw new InvalidRequestError('Model is not configured for image generation');
  }
}

function ensureLlmModel(model: IModel) {
  if (model.category !== 'llm') {
    throw new InvalidRequestError('Model is not configured for chat completions');
  }
}

function ensureEmbeddingModel(model: IModel) {
  if (model.category !== 'embedding') {
    throw new InvalidRequestError('Model is not configured for embeddings');
  }
}

/**
 * Unified result shape for chat completions. A single object (not a union) so
 * callers can probe `stream` / `response` / `usage` without narrowing — exactly
 * how every existing call site already uses it. `routing` is present only on
 * Dynamic LLM responses.
 */
export interface ChatCompletionOutcome {
  response?: Record<string, unknown>;
  usage?: TokenUsage;
  latencyMs?: number;
  requestId: string;
  cacheHit?: boolean;
  stream?: ReadableStream<Uint8Array>;
  routing?: IModelUsageRouting;
  /**
   * Verdict headers for a STREAMED answer, filled in as the stream unfolds —
   * so it is only complete once the stream is.
   *
   * A guardrail block on a stream is discovered mid-response, long after the
   * response headers were flushed, which is why the same facts are also written
   * in-band (the `{ guardrail: { blocked, discardPrior } }` frame). A transport
   * that can send trailers should announce these here and send them as
   * trailers; one that cannot should ignore it and let the in-band frame do the
   * talking. Present only on the streaming path.
   */
  streamHeaders?: Record<string, string>;
}

// ── Dynamic LLM resolution ────────────────────────────────────────────────
// Resolves a Dynamic LLM router to a concrete child model and invokes it via
// `handleChatCompletion` (recursively, depth-guarded). The router records its
// own decision row (route 'chat.completions.router') with the full routing
// metadata; the child + any decider model log their real usage independently,
// so cost is never double-counted (router pricing is zero).
async function resolveDynamicCompletion(args: {
  tenantDbName: string;
  tenantId?: string;
  projectId: string;
  body: ChatCompletionRequestBody;
  stream?: boolean;
  router: IModel;
  config: IDynamicRoutingConfig;
  depth: number;
}): Promise<ChatCompletionOutcome> {
  const { tenantDbName, tenantId, projectId, body, stream, router, config, depth } = args;
  const start = Date.now();
  const routerRequestId =
    typeof body.request_id === 'string' && body.request_id.length > 0
      ? body.request_id
      : crypto.randomUUID();

  const signals = extractRoutingSignals(body);

  let chosenModelKey = config.defaultModelKey;
  let decision: IModelUsageRouting['decision'] = 'default';
  let matchedRuleLabel: string | undefined;
  let deciderLabel: string | undefined;
  let deciderModelKey: string | undefined;
  let deciderLatencyMs: number | undefined;
  let reason = 'No rule matched; used default model';

  if (config.strategy === 'rule-based') {
    const rule = evaluateRules(config.rules ?? [], signals);
    if (rule) {
      chosenModelKey = rule.targetModelKey;
      decision = 'rule';
      matchedRuleLabel = rule.label;
      reason = `Matched rule "${rule.label}"`;
    }
  } else if (config.strategy === 'model-based' && config.decider) {
    deciderModelKey = config.decider.modelKey;
    const deciderStart = Date.now();
    try {
      const deciderResult = (await handleChatCompletion({
        tenantDbName,
        tenantId,
        modelKey: config.decider.modelKey,
        projectId,
        body: {
          messages: buildDeciderMessages(config.decider, signals),
          temperature: 1,
          max_tokens: 256,
        },
        _routingDepth: depth + 1,
      })) as { response?: unknown };
      deciderLatencyMs = Date.now() - deciderStart;
      const text = extractAssistantText(deciderResult.response);
      const label = parseDeciderLabel(text, config.decider.labels);
      if (label) {
        chosenModelKey = label.targetModelKey;
        decision = 'model';
        deciderLabel = label.label;
        reason = `Decider "${config.decider.modelKey}" classified as "${label.label}"`;
      } else {
        reason = `Decider returned an unrecognized label "${text.slice(0, 40)}"; used default model`;
      }
    } catch (error) {
      deciderLatencyMs = Date.now() - deciderStart;
      reason = `Decider failed (${error instanceof Error ? error.message : 'error'}); used default model`;
    }
  }

  // Never route back to the router itself (would loop until the depth cap).
  if (chosenModelKey === router.key) {
    chosenModelKey = config.defaultModelKey === router.key ? '' : config.defaultModelKey;
  }

  const runChild = (childKey: string) =>
    handleChatCompletion({
      tenantDbName,
      tenantId,
      modelKey: childKey,
      projectId,
      body,
      stream,
      _routingDepth: depth + 1,
    });

  const buildRouting = (
    chosen: string,
    decisionValue: IModelUsageRouting['decision'],
    reasonValue: string,
  ): IModelUsageRouting => ({
    routerKey: router.key,
    routerModelDbId: router._id ? String(router._id) : undefined,
    strategy: config.strategy,
    decision: decisionValue,
    chosenModelKey: chosen,
    matchedRuleLabel,
    deciderLabel,
    deciderModelKey,
    deciderLatencyMs,
    reason: reasonValue,
    signals: publicSignals(signals),
  });

  const logDecision = (
    routing: IModelUsageRouting,
    status: 'success' | 'error',
    usage: TokenUsage,
    errorMessage?: string,
  ) => {
    fireAndForget('log-router-decision', () =>
      logModelUsage(tenantDbName, router, {
        requestId: routerRequestId,
        route: 'chat.completions.router',
        status,
        providerRequest: sanitizeForLogging({
          model: router.key,
          messages: body.messages,
          signals: routing.signals,
          ...describeRequestContract(body),
        }),
        providerResponse: sanitizeForLogging({
          chosenModelKey: routing.chosenModelKey,
          decision: routing.decision,
          reason: routing.reason,
        }),
        errorMessage,
        latencyMs: Date.now() - start,
        usage,
        routing,
      }),
    );
  };

  let finalModelKey = chosenModelKey;
  let finalDecision: IModelUsageRouting['decision'] = decision;
  let finalReason = reason;
  let childResult: ChatCompletionOutcome;

  try {
    if (!chosenModelKey) throw new Error('No target model resolved for dynamic router');
    childResult = await runChild(chosenModelKey);
  } catch (primaryError) {
    if (config.fallbackModelKey && config.fallbackModelKey !== chosenModelKey) {
      finalModelKey = config.fallbackModelKey;
      finalDecision = 'fallback';
      finalReason = `${reason}; primary "${chosenModelKey || '(none)'}" failed, fell back to "${config.fallbackModelKey}"`;
      try {
        childResult = await runChild(config.fallbackModelKey);
      } catch (fallbackError) {
        logDecision(
          buildRouting(finalModelKey, finalDecision, finalReason),
          'error',
          {},
          fallbackError instanceof Error ? fallbackError.message : 'error',
        );
        throw fallbackError;
      }
    } else {
      logDecision(
        buildRouting(chosenModelKey, decision, reason),
        'error',
        {},
        primaryError instanceof Error ? primaryError.message : 'error',
      );
      throw primaryError;
    }
  }

  const routing = buildRouting(finalModelKey, finalDecision, finalReason);

  // Streaming children return { stream, requestId }; non-streaming return
  // { response, usage, ... }. Mirror the child's token usage onto the router
  // row for traffic accounting (router pricing is zero, so cost never doubles).
  routing.childRequestId = childResult.requestId;

  if (stream) {
    logDecision(routing, 'success', {});
    return { ...childResult, routing };
  }

  logDecision(routing, 'success', childResult.usage ?? {});
  return { ...childResult, routing };
}

/** True when the caller (or the model's defaults) asked for a JSON document. */
function wantsJsonOutput(responseFormat: unknown): boolean {
  const type = (responseFormat as { type?: unknown } | undefined)?.type;
  return type === 'json_object' || type === 'json_schema';
}

export async function handleChatCompletion(params: {
  tenantDbName: string;
  tenantId?: string;
  modelKey: string;
  projectId: string;
  body: ChatCompletionRequestBody;
  stream?: boolean;
  /** Internal: recursion depth when a Dynamic LLM resolves to another model. */
  _routingDepth?: number;
}): Promise<ChatCompletionOutcome> {
  const { tenantDbName, tenantId, modelKey, projectId, stream } = params;
  let { body } = params;

  if (!Array.isArray(body?.messages)) {
    throw new Error('`messages` array is required');
  }

  const requestId =
    typeof body.request_id === 'string' && body.request_id.length > 0
      ? body.request_id
      : crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  // Dynamic LLM: this model owns no provider — it routes to a concrete child
  // model. Resolve and recurse before any provider/runtime work happens.
  const dynamicConfig = getDynamicRoutingConfig(model);
  if (dynamicConfig) {
    const depth = params._routingDepth ?? 0;
    if (depth >= MAX_ROUTING_DEPTH) {
      throw new Error(
        `Dynamic routing depth exceeded (${MAX_ROUTING_DEPTH}) resolving model "${modelKey}"`,
      );
    }
    return resolveDynamicCompletion({
      tenantDbName,
      tenantId,
      projectId,
      body,
      stream,
      router: model,
      config: dynamicConfig,
      depth,
    });
  }

  ensureLlmModel(model);

  // Input guardrails: check the latest user message before calling the model.
  // Non-blocking findings (warn/flag) are surfaced on the response; redact
  // findings rewrite the user message before it reaches the provider, and chain
  // through the rest of the bound guardrails.
  const guardrailAnnotations: Record<string, GuardrailAnnotation> = {};
  const inputGuardrailKeys = resolveBindings(model, 'input.pre');
  if (inputGuardrailKeys.length > 0) {
    const inputOutcome = await enforceModelGuardrailChain({
      tenantDbName,
      tenantId: model.tenantId,
      projectId,
      guardrailKeys: inputGuardrailKeys,
      text: extractLatestUserText(body.messages),
      phase: 'input',
      requestId,
    });
    if (inputOutcome.redactedText !== undefined) {
      body = { ...body, messages: replaceLatestUserText(body.messages, inputOutcome.redactedText) as typeof body.messages };
    }
    const annotation = foldGuardrailAnnotation(inputOutcome.results);
    if (annotation) guardrailAnnotations.input = annotation;
  }

  // Resolved before the cache lookup on purpose: the sampling parameters and
  // any passthrough body fields change what the model produces from the same
  // prompt, so they have to take part in the cache key.
  const invocation = resolveModelInvocationConfig(model, body);

  // THE OUTPUT POLICY IS PART OF THE CACHE KEY. What gets cached is the
  // response AFTER the `output.pre` chain (see `storeInCache` below), so an
  // entry is only valid for a caller under the SAME output policy: a model
  // whose binding changed, or a model with no output guardrail at all, must not
  // be served a hit that was redacted — or NOT redacted — under a different
  // one. Keyed on the guardrail's `policyVersion` (`key@updatedAt`) when the
  // record is cheaply available from the record cache, so an edit to a policy
  // also retires the entries produced under the old one.
  const outputGuardrailKeys = resolveBindings(model, 'output.pre');
  const cacheEnabled = !stream && tenantId && isSemanticCacheEnabled(model);
  const cacheVariantKey = buildCacheVariantKey({
    ...invocation.overrides,
    ...(invocation.extraBody ?? {}),
    ...(cacheEnabled
      ? { __outputGuardrails: await outputGuardrailPolicyVersions(tenantDbName, projectId, outputGuardrailKeys) }
      : {}),
  });

  // Semantic cache: check for cached response before calling the model
  if (cacheEnabled && model.semanticCache) {
    try {
      const cacheResult = await lookupCache({
        tenantDbName,
        tenantId,
        projectId,
        config: model.semanticCache,
        messages: body.messages as unknown[],
        variantKey: cacheVariantKey,
      });

      if (cacheResult.hit && cacheResult.response) {
        const latencyMs = Date.now() - start;

        fireAndForget('log-cache-hit', () =>
          logModelUsage(tenantDbName, model, {
            requestId,
            route: 'chat.completions',
            status: 'success',
            providerRequest: sanitizeForLogging({
              model: modelKey,
              messages: body.messages,
              stream: false,
              ...describeRequestContract(body),
            }),
            providerResponse: sanitizeForLogging(cacheResult.response),
            latencyMs,
            usage: {},
            cacheHit: true,
          }),
        );

        return {
          response: cacheResult.response,
          usage: {} as TokenUsage,
          latencyMs,
          requestId,
          cacheHit: true,
        };
      }
    } catch (cacheError) {
      logger.warn('Cache lookup error, proceeding with model', { error: cacheError });
    }
  }

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createChatModel) {
    throw new Error('Model provider does not support chat completions');
  }

  const messagesInput = body.messages as Parameters<typeof toLangChainMessages>[0];
  const messages = toLangChainMessages(messagesInput);
  const { modelSettings, callOptions, overrides } = invocation;
  const outputTokenLimit = resolveOutputTokenLimit(overrides, modelSettings);
  // A streamed request that carries tools used to be answered by a single
  // `invoke()` replayed as one SSE frame. The reason was real at the time —
  // the collapsed `tool_calls` on a streamed chunk arrive with empty arguments
  // — but `toOpenAIStreamChunk` now emits genuine `tool_call_chunks` deltas,
  // so all the workaround still did was turn streaming silently off for any
  // client that sends tools. That is every request from Open WebUI (native
  // function calling is its default, and it always ships its built-in time
  // tools) and from Onyx, i.e. exactly the clients that reported streaming not
  // working. Tools are the normal case, not the exception; the escape hatch
  // stays per-model for an upstream that really cannot stream them.
  const disableProviderStreaming = Boolean(
    stream
    && modelSettings.disableStreamingWithTools === true
    && Array.isArray(overrides.tools)
    && overrides.tools.length > 0,
  );
  const includeStreamUsage =
    asRecord(overrides.stream_options).include_usage === true;

  if (disableProviderStreaming) {
    delete callOptions.stream_options;
  }

  const chatModel = ensureChatRunnable(await runtime.createChatModel({
    modelId: model.modelId,
    category: model.category,
    modelSettings,
    options: {
      streaming: Boolean(stream),
      disableStreaming: disableProviderStreaming,
      // `withResilience` owns retry and circuit-breaking on this path, so the
      // provider SDK must not retry underneath it.
      maxRetries: 0,
    },
  }));

  if (stream) {
    if (!disableProviderStreaming && typeof chatModel.stream !== 'function') {
      throw new Error('Model provider does not support streaming responses');
    }

    // A disconnected client used to leave the provider generating (and billing)
    // until it finished on its own. Cancelling the readable — which Fastify does
    // when the response socket closes — now aborts the upstream call.
    const abortController = new AbortController();
    const streamCallOptions = { ...callOptions, signal: abortController.signal };

    let asyncIterator: AsyncIterable<AIMessageChunk>;
    if (disableProviderStreaming) {
      const eagerMessage = await withResilience(
        (signal) => chatModel.invoke(messages, { ...callOptions, signal }),
        { key: chatResilienceKey('chat', model) },
      );
      asyncIterator = (async function* () {
        yield new AIMessageChunk({
          content: eagerMessage.content,
          additional_kwargs: eagerMessage.additional_kwargs,
          response_metadata: eagerMessage.response_metadata,
          id: eagerMessage.id,
          name: eagerMessage.name,
          usage_metadata: eagerMessage.usage_metadata,
          tool_calls: eagerMessage.tool_calls,
          invalid_tool_calls: eagerMessage.invalid_tool_calls,
        });
      })();
    } else {
      asyncIterator = await withResilience(
        (signal) => {
          // The stream already aborts on client disconnect; chain the gateway's
          // timeout into the same controller so a provider that never opens the
          // stream is cut loose too, instead of holding the socket.
          signal.addEventListener(
            'abort',
            () => abortController.abort(signal.reason),
            { once: true },
          );
          return chatModel.stream!(messages, streamCallOptions) as Promise<AsyncIterable<AIMessageChunk>>;
        },
        { key: chatResilienceKey('chat-stream', model) },
      );
    }
    const startedAt = Date.now();
    const completionId = newCompletionId();
    const completionCreated = Math.floor(Date.now() / 1000);

    // Upstreams that leak a reasoning model's chain-of-thought into `content`
    // (Bedrock's `/openai/v1` gpt-oss shim among them) do it across delta
    // boundaries, so one splitter carries the state for this whole completion.
    const reasoningSplitter = createInlineReasoningSplitter();

    const chunkOptions = {
      model: model.modelId,
      stream: true as const,
      completionId,
      created: completionCreated,
      reasoningSplitter,
    };

    // ── Real-time streaming enforcement ──────────────────────────────────
    // Until now a streamed answer could only be audited AFTER the fact (see
    // `auditStreamedOutput` below, whose own comment says why): the text was
    // already in the caller's browser by the time the guardrail saw it. The
    // gate withholds it behind a release frontier instead, adjudicates a window
    // that overlaps what was already released — so a secret split across two
    // provider chunks is still caught — and only then lets the characters out.
    //
    // Only the DETERMINISTIC families run per window; the gate enforces that
    // itself. The LLM judge and the webhook family stay post-hoc, because a 4K
    // answer is ~17 windows and nobody wants 17 judge calls or 17 third-party
    // round trips on the token path.
    //
    // `audit: false` because `auditStreamedOutput` still owns the terminal
    // `output.pre` pass on every exit — success, block and client hang-up
    // alike. Letting the gate schedule its own would put two evaluation rows in
    // the audit trail for one answer.
    //
    // Nothing is gated when the model binds no guardrail to the stream hook:
    // constructing a gate for an empty key list buys a pass-through wrapper and
    // an extra allocation per chunk.
    //
    // The two hooks are resolved SEPARATELY because a multi-binding model can
    // scope a guardrail to the real-time gate and not to the terminal audit, or
    // the other way round. On a legacy row both resolve to `outputGuardrailKey`
    // — the resolver projects that slot onto `output.pre` AND
    // `output.stream.delta` — so this is a no-op for the production majority.
    const streamGuardrailKeys = resolveBindings(model, 'output.stream.delta');
    const auditGuardrailKeys = resolveBindings(model, 'output.pre');

    const streamHeaders: Record<string, string> = {};
    const gate = streamGuardrailKeys.length > 0
      ? createStreamGate({
        scope: {
          tenantId: model.tenantId,
          tenantDbName,
          projectId,
          actor: gatewayActor(),
          // Unlike `evaluateGuardrail`'s facade — which is reached from four
          // different surfaces and has to answer 'api' — this call site knows
          // exactly where it is.
          surface: 'gateway',
          source: 'chat.completions:stream',
          requestId,
          // The evaluation log has no traceId column; this ties one stream's
          // window verdicts together and fills the block message's
          // {{traceId}}. Reusing requestId keeps the two identifiers aligned,
          // exactly as the legacy facade does.
          traceId: requestId,
        } satisfies HookScope,
        guardrailKeys: streamGuardrailKeys,
        // The gate cannot forward the provider's own chunk once it has delayed
        // or rewritten that chunk's content, so it asks for the envelope those
        // characters should arrive in. Identical to `toOpenAIStreamChunk`'s.
        makeChunk: (text: string) => ({
          id: completionId,
          object: 'chat.completion.chunk',
          created: completionCreated,
          model: model.modelId,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        }),
        audit: false,
      })
      : null;

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let aggregatedChunk: AIMessageChunk | null = null;
        let lastUsage: TokenUsage | undefined;
        let finalUsagePayload: Record<string, unknown> | undefined;
        let terminalFinishReason: string | undefined;
        let hasFinalOutput = false;
        let outputLimitError: OutputTokenLimitError | null = null;
        const toolCalls: ToolCallPayload[] = [];

        // A cancelled stream almost never carries provider usage: the counts
        // ride on the terminal chunk, which is precisely the chunk the client
        // did not stay for. Reporting zero there writes off output the
        // provider generated and bills us for, so fall back to an estimate
        // over the text we did stream — the same chars/4 rule the quota
        // pre-flight uses. The log marks it `output_tokens_estimated` so a
        // measured count and a guessed one stay distinguishable downstream.
        // Input tokens are never guessed; they are reported or absent.
        const partialUsageOnCancel = (): TokenUsage => {
          const toolCallCount = toolCalls.length || undefined;
          if (lastUsage) {
            return { ...lastUsage, toolCalls: toolCallCount };
          }

          const streamed = guardrailContentToText(
            (aggregatedChunk as { content?: unknown } | null)?.content,
          );
          const outputTokens = streamed ? Math.ceil(streamed.length / 4) : 0;
          return {
            outputTokens,
            totalTokens: outputTokens,
            toolCalls: toolCallCount,
          };
        };

        // Output guardrails (streaming): the text has already reached the
        // client, so this is a post-hoc audit — violations land in the
        // evaluation log and alert metrics rather than blocking the stream.
        // It runs on a cancelled stream too: those tokens were delivered, and
        // auditing only completed answers would let a caller skip the audit by
        // hanging up.
        //
        // One evaluation row PER BOUND GUARDRAIL, which is what the log's
        // per-guardrail shape means; a legacy row still produces exactly one.
        // They are started together rather than in sequence because these are
        // independent audits: `evaluateGuardrail` throws for a key whose record
        // is gone, and a sequential loop would let that one misconfiguration
        // erase the audit trail of every guardrail behind it. `Promise.all`
        // still surfaces the rejection to `fireAndForget`'s handler.
        const auditStreamedOutput = (source: string) => {
          if (auditGuardrailKeys.length === 0) return;

          const streamedText = guardrailContentToText(
            (aggregatedChunk as { content?: unknown } | null)?.content,
          );
          if (!streamedText.trim()) return;

          fireAndForget('guardrail-stream-output-audit', async () => {
            await Promise.all(
              auditGuardrailKeys.map((guardrailKey) =>
                evaluateGuardrail({
                  tenantDbName,
                  tenantId: model.tenantId,
                  projectId,
                  guardrailKey,
                  text: streamedText,
                  phase: 'output',
                  requestId,
                  source,
                }),
              ),
            );
          });
        };

        // Set the moment a window blocks, and checked in the catch below BEFORE
        // `abortController.signal.aborted` — the block path aborts the upstream
        // on purpose, so without this a policy block would be filed as a client
        // hang-up.
        let blockedByGuardrail = false;
        /** True once gated characters actually reached the socket. */
        let releasedGatedText = false;

        const emitGatedFrames = (frames: readonly OpenAiStreamChunkLike[]) => {
          for (const frame of frames) {
            if (streamFrameHasContent(frame)) releasedGatedText = true;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
            );
          }
        };

        /**
         * The terminal sequence for a guardrail block. THE ORDER IS
         * LOAD-BEARING, and the last step is the one that makes it so.
         */
        const closeWithGuardrailBlock = (
          verdict: StreamGateEmission['verdict'],
        ) => {
          blockedByGuardrail = true;
          // A verdict is normally present, but `StreamGateEmission` types it as
          // optional (a latched gate replays a block whose verdict it never
          // had), and "blocked with no reason at all" is the one thing worse
          // than blocking.
          const blockMessage =
            verdict?.message?.body ?? 'Response blocked by an output guardrail.';
          // The verdict names the guardrail that actually blocked. Falling back
          // to the FIRST stream-bound key keeps the old single-guardrail answer
          // for a latched replay that carries no verdict, and stays deterministic
          // now that there can be several.
          const blockedKey = verdict?.guardrailKey ?? streamGuardrailKeys[0];

          // 1. The OpenAI-native signal every SDK already understands. A client
          //    that reads nothing else still learns the answer was filtered.
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(
              openAIStreamStopChunk(chunkOptions, 'content_filter'),
            )}\n\n`),
          );

          // 2. Characters already rendered cannot be recalled, so say so on
          //    both channels: a header for the transport (see
          //    `ChatCompletionOutcome.streamHeaders` — a stream's headers are
          //    long flushed by now, which is exactly why the same fact also
          //    goes in-band) and a frame for the client holding the prefix.
          if (releasedGatedText) {
            streamHeaders['x-guardrail-partial'] = 'true';
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                guardrail: { blocked: true, discardPrior: true },
              })}\n\n`),
            );
          }

          // 3. The same error-frame shape the output-limit path emits, so a
          //    caller has one place to look for "the gateway ended this".
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              error: {
                type: 'guardrail_block',
                code: verdict?.message?.reasonClass,
                message: blockMessage,
                guardrail_key: blockedKey,
              },
              request_id: requestId,
            })}\n\n`),
          );

          // 4. ALWAYS. Withholding `[DONE]` leaves a client that reads to the
          //    sentinel blocked on the socket instead of returning the error it
          //    was just handed.
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();

          // 5. ONLY NOW. Aborting first makes the provider iterator throw into
          //    the catch below, which tests `abortController.signal.aborted`,
          //    logs `status: 'cancelled'` and RETURNS — so none of the frames
          //    above would ever be written, a policy block would be reported as
          //    a user pressing stop, and the usage row would be wrong with it.
          abortController.abort();

          fireAndForget('log-stream-guardrail-block', () =>
            logModelUsage(tenantDbName, model, {
              requestId,
              route: 'chat.completions',
              // 'error' rather than a new status: the non-streaming path throws
              // GuardrailBlockError and lands here as an error too, and the two
              // halves of one feature must not report differently.
              status: 'error',
              providerRequest: sanitizeForLogging({
                model: modelKey,
                messages: body.messages,
                overrides,
                stream: true,
                ...describeRequestContract(body),
              }),
              providerResponse: sanitizeForLogging({
                guardrail_blocked: true,
                guardrail_key: blockedKey,
                codes: verdict?.codes,
                risk_score: verdict?.riskScore,
                partial_delivery: releasedGatedText,
                // The provider produced this whether or not we delivered it.
                partial: aggregatedChunk ?? { tool_calls: toolCalls },
                ...(lastUsage ? {} : { output_tokens_estimated: true }),
              }),
              errorMessage: blockMessage,
              latencyMs: Date.now() - startedAt,
              // The same estimator the cancel path uses, for the same reason:
              // a stream cut short never carries the provider's terminal usage
              // frame, and reporting zero writes off tokens we are billed for.
              usage: partialUsageOnCancel(),
              finishReason: 'content_filter',
            }),
          );

          // The gate was built with `audit: false`, so this is still the single
          // post-hoc `output.pre` row for the answer — and it audits the
          // aggregated provider text, which INCLUDES the withheld characters
          // that caused the block.
          auditStreamedOutput('chat.completions:stream');
        };

        try {
          // OpenAI opens every stream with the assistant role before any content.
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(openAIStreamRoleChunk(chunkOptions))}\n\n`),
          );

          for await (const chunk of asyncIterator) {
            aggregatedChunk = aggregatedChunk
              ? aggregatedChunk.concat(chunk)
              : chunk;

            const chunkToolCalls = (chunk as { tool_calls?: unknown }).tool_calls;
            if (Array.isArray(chunkToolCalls)) {
              chunkToolCalls.forEach((call) => {
                toolCalls.push(call as ToolCallPayload);
              });
            }

            const payload = toOpenAIStreamChunk(chunk, chunkOptions);
            const choice = payload.choices[0];
            if (typeof choice?.finish_reason === 'string') {
              terminalFinishReason = choice.finish_reason;
            }
            const delta = choice?.delta as Record<string, unknown> | undefined;
            if (
              guardrailContentToText(delta?.content).trim()
              || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)
            ) {
              hasFinalOutput = true;
            }
            if (terminalFinishReason === 'length' && !hasFinalOutput) {
              outputLimitError = new OutputTokenLimitError(outputTokenLimit);
            }

            // The reasoning splitter can consume a whole delta while it waits
            // for the rest of a tag. What is left is not a valid OpenAI frame
            // — it carries no delta, no finish_reason and no usage — so it is
            // dropped rather than pushed at the client.
            const carriesNothing =
              (!delta || Object.keys(delta).length === 0)
              && choice?.finish_reason == null
              && !payload.usage;
            if (carriesNothing) continue;

            if (payload.usage) {
              lastUsage = {
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: payload.usage.completion_tokens,
                cachedInputTokens: payload.usage.cached_tokens,
                totalTokens: payload.usage.total_tokens,
                // Subset of outputTokens — never folded into totalTokens/cost.
                reasoningTokens:
                  payload.usage.completion_tokens_details?.reasoning_tokens,
              };
              // `usage` is only allowed on the wire when the caller asked for
              // it with `stream_options.include_usage`, and then only on a
              // dedicated final frame. We were attaching it to whichever
              // content chunk happened to carry it, which is a shape strict
              // OpenAI clients do not expect on a delta.
              finalUsagePayload = payload.usage;
              payload.usage = undefined;
            }

            if (!outputLimitError) {
              if (gate) {
                // The gate hands back the frames that are safe NOW: whatever it
                // has cleared, plus this chunk's non-content residual (tool-call
                // deltas, finish_reason) in order. It never throws.
                const gated = await gate.push(toGateChunk(payload));
                emitGatedFrames(gated.emit);
                if (gated.blocked) {
                  closeWithGuardrailBlock(gated.verdict);
                  break;
                }
              } else {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
                );
              }
            }
          }

          // `break`ing out of the loop above already wrote the terminal frames,
          // closed the controller and aborted the upstream. Nothing here may
          // touch the controller again.
          if (blockedByGuardrail) return;

          // A stream that ended mid-tag — or mid-thought, when the model was
          // cut off inside its reasoning — leaves text in the splitter.
          // Release it instead of truncating the answer.
          const reasoningTail = reasoningSplitter.flush();
          if (!outputLimitError && (reasoningTail.content || reasoningTail.reasoning)) {
            const tailDelta: Record<string, unknown> = {};
            if (reasoningTail.content) tailDelta.content = reasoningTail.content;
            if (reasoningTail.reasoning) tailDelta.reasoning_content = reasoningTail.reasoning;
            const tailPayload = openAIStreamDeltaChunk(chunkOptions, tailDelta);
            if (gate) {
              const gatedTail = await gate.push(toGateChunk(tailPayload));
              emitGatedFrames(gatedTail.emit);
              if (gatedTail.blocked) {
                closeWithGuardrailBlock(gatedTail.verdict);
                return;
              }
            } else {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(tailPayload)}\n\n`),
              );
            }
          }

          if (gate) {
            // An upstream that never sends a finish_reason leaves the gate
            // holding its hold-back tail, with no terminal chunk to trigger the
            // final window — this is what releases it. It is also the LAST
            // chance for a window to block, so it can come back blocked exactly
            // like a push.
            const tail = await gate.end();
            emitGatedFrames(tail.emit);
            if (tail.blocked) {
              closeWithGuardrailBlock(tail.verdict);
              return;
            }
          }

          if (outputLimitError) {
            const normalizedError = normalizeInferenceError(outputLimitError);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                error: normalizedError.error,
                request_id: requestId,
              })}\n\n`),
            );
          }

          if (!outputLimitError && includeStreamUsage && finalUsagePayload) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: completionCreated,
                model: model.modelId,
                choices: [],
                usage: finalUsagePayload,
              })}\n\n`),
            );
          }

          // Some upstreams never send a terminal finish_reason. Clients that wait
          // for one would hang until the socket closed. A completion that ended in
          // tool calls must say so, or an agent client reads it as a finished
          // answer and never dispatches them.
          if (!outputLimitError && terminalFinishReason === undefined) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(openAIStreamStopChunk(
                chunkOptions,
                toolCalls.length ? 'tool_calls' : 'stop',
              ))}\n\n`),
            );
          }

          // `[DONE]` terminates every stream, including one that ended in an
          // error frame. Withholding it leaves a client that reads until the
          // sentinel — the OpenAI SDK, and everything built on it — blocked on
          // the socket instead of returning the error it was just handed.
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();

          const latencyMs = Date.now() - startedAt;
          const usage: TokenUsage = lastUsage
            ? {
              ...lastUsage,
              toolCalls: toolCalls.length || undefined,
            }
            : { toolCalls: toolCalls.length || undefined };

          const providerResponse = aggregatedChunk
            ? aggregatedChunk
            : { tool_calls: toolCalls };

          fireAndForget('log-stream-usage', () =>
            logModelUsage(tenantDbName, model, {
              requestId,
              route: 'chat.completions',
              status: outputLimitError ? 'error' : 'success',
              providerRequest: sanitizeForLogging({
                model: modelKey,
                messages: body.messages,
                overrides,
                stream: true,
                ...describeRequestContract(body),
              }),
              providerResponse: sanitizeForLogging(providerResponse),
              errorMessage: outputLimitError?.message,
              latencyMs,
              usage,
              finishReason: terminalFinishReason,
            }),
          );

          auditStreamedOutput('chat.completions:stream');
        } catch (error: unknown) {
          const latencyMs = Date.now() - startedAt;

          // CHECKED FIRST, and before the aborted branch below: a guardrail
          // block aborts the upstream itself, so the provider iterator can
          // still throw its way out of `for await`'s `return()` afterwards.
          // Everything that had to be written was written by
          // `closeWithGuardrailBlock`, and the controller is closed.
          if (blockedByGuardrail) return;

          // Only `cancel()` aborts this signal, and only a closed response
          // socket reaches `cancel()`. So an aborted signal means the client
          // walked away — the upstream call we abort in response then throws
          // out of the loop above. That is not a provider failure, and
          // recording it as one blamed us for every user who pressed stop:
          // the error rate rose, alerting fired, and the tokens the provider
          // had already generated (and bills us for) were written as zero.
          if (abortController.signal.aborted) {
            fireAndForget('log-stream-cancelled', () =>
              logModelUsage(tenantDbName, model, {
                requestId,
                route: 'chat.completions',
                status: 'cancelled',
                providerRequest: sanitizeForLogging({
                  model: modelKey,
                  messages: body.messages,
                  overrides,
                  stream: true,
                }),
                providerResponse: sanitizeForLogging({
                  cancelled: 'client_disconnected',
                  partial: aggregatedChunk ?? { tool_calls: toolCalls },
                  ...(lastUsage ? {} : { output_tokens_estimated: true }),
                }),
                latencyMs,
                usage: partialUsageOnCancel(),
              }),
            );
            auditStreamedOutput('chat.completions:stream:cancelled');
            // Nothing is left to write to: the controller is already cancelled,
            // and enqueueing on it throws.
            return;
          }

          const normalizedError = normalizeInferenceError(error);
          const errorMessage = normalizedError.error.message;
          fireAndForget('log-stream-error', () =>
            logModelUsage(tenantDbName, model, {
              requestId,
              route: 'chat.completions',
              status: 'error',
              providerRequest: sanitizeForLogging({
                model: modelKey,
                messages: body.messages,
                overrides,
                stream: true,
                ...describeRequestContract(body),
              }),
              providerResponse: sanitizeForLogging({ error: errorMessage }),
              errorMessage,
              latencyMs,
              usage: {},
              finishReason: terminalFinishReason,
            }),
          );

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              error: normalizedError.error,
              request_id: requestId,
            })}\n\n`),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
      cancel(reason) {
        abortController.abort(reason);
      },
    });

    return { stream: readable, requestId, streamHeaders };
  }

  const aiMessage = await withResilience(
    (signal) => chatModel.invoke(messages, { ...callOptions, signal }),
    { key: chatResilienceKey('chat', model) },
  );

  const latencyMs = Date.now() - start;
  const response = toOpenAIChatResponse(aiMessage, {
    model: model.modelId,
    stream: false,
  });

  // JSON mode is a contract: the caller asked for a parseable document and is
  // going to `JSON.parse` whatever comes back. Some providers break it anyway —
  // Bedrock's `/openai/v1` gpt-oss path splices a stray brace or a truncated
  // prose answer in front of the payload under `response_format`. Recover the
  // model's own JSON bytes rather than handing the caller something it asked
  // not to receive. A response that already parses is never touched, and a
  // response with nothing recoverable in it is passed through unchanged.
  if (wantsJsonOutput(overrides.response_format ?? body.response_format)) {
    const choice = response.choices[0];
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.length > 0) {
      const { content: repairedContent, repaired } = repairJsonContent(content);
      if (repaired) {
        choice.message.content = repairedContent;
        logger.warn('Repaired malformed JSON-mode response from provider', {
          requestId,
          modelKey,
          providerDriver: model.providerDriver,
          discardedPrefix: content.slice(0, content.indexOf(repairedContent)).slice(0, 120),
        });
      }
    }
  }

  if (
    aiMessage.response_metadata?.finish_reason === 'length'
    && !guardrailContentToText(aiMessage.content).trim()
    && getToolCallCount(aiMessage) === 0
  ) {
    throw new OutputTokenLimitError(outputTokenLimit);
  }

  const usage = summarizeUsage(aiMessage) as TokenUsage;
  const toolCallCount = getToolCallCount(aiMessage);
  if (toolCallCount) {
    usage.toolCalls = toolCallCount;
  }

  fireAndForget('log-chat-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'chat.completions',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        messages: body.messages,
        overrides,
        stream: false,
        ...describeRequestContract(body),
      }),
      providerResponse: sanitizeForLogging(response),
      latencyMs,
      usage,
      cacheHit: false,
      finishReason: extractFinishReason(aiMessage),
    }),
  );

  // Output guardrails: check the assistant response before returning it
  // (streamed responses are gated in real time and audited post-hoc after the
  // stream completes). `outputGuardrailKeys` was resolved above, before the
  // cache lookup, because it is part of the cache key.
  let finalResponse: unknown = response;
  if (outputGuardrailKeys.length > 0) {
    const outputOutcome = await enforceModelGuardrailChain({
      tenantDbName,
      tenantId: model.tenantId,
      projectId,
      guardrailKeys: outputGuardrailKeys,
      text: extractAssistantText(response),
      phase: 'output',
      requestId,
    });
    if (outputOutcome.redactedText !== undefined) {
      const withChoices = finalResponse as { choices?: Array<{ message?: { content?: unknown } }> };
      if (withChoices?.choices?.[0]?.message) {
        finalResponse = {
          ...withChoices,
          choices: withChoices.choices.map((choice, index) =>
            index === 0 && choice.message
              ? { ...choice, message: { ...choice.message, content: outputOutcome.redactedText } }
              : choice,
          ),
        };
      }
    }
    const annotation = foldGuardrailAnnotation(outputOutcome.results);
    if (annotation) guardrailAnnotations.output = annotation;
  }

  finalResponse = annotateResponseWithGuardrails(finalResponse, guardrailAnnotations);

  // Semantic cache: store the response for future lookups — the FINAL one,
  // redacted and annotated, never the raw provider message. A cache hit returns
  // before any output guardrail runs, so a raw entry would hand the next
  // semantically-similar caller the exact text the guardrail removed — with
  // `cacheHit: true` and no evaluation row. The variant key carries the output
  // policy (above), so the entry is only ever served under the policy that
  // produced it.
  if (cacheEnabled && tenantId && model.semanticCache) {
    storeInCache({
      tenantDbName,
      tenantId,
      projectId,
      config: model.semanticCache,
      messages: body.messages as unknown[],
      response: finalResponse as Record<string, unknown>,
      variantKey: cacheVariantKey,
    }).catch((err) =>
      logger.warn('Failed to store response in cache', { error: err }),
    );
  }

  return {
    response: finalResponse as Record<string, unknown>,
    usage,
    latencyMs,
    requestId,
    cacheHit: false,
  };
}

export async function handleEmbeddingRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  body: EmbeddingRequestBody;
}) {
  const { tenantDbName, modelKey, projectId, body } = params;

  if (!body?.input) {
    throw new Error('`input` is required');
  }

  const requestId = body?.request_id || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  ensureEmbeddingModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createEmbeddingModel) {
    throw new Error('Model provider does not support embeddings');
  }

  const embedder = ensureEmbeddingRunnable(await runtime.createEmbeddingModel({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
  }));
  const rawInput = body.input;
  const inputsArray = Array.isArray(rawInput) ? rawInput : [rawInput];
  const inputs = inputsArray.map((value) => {
    if (typeof value !== 'string') {
      throw new Error('`input` must be a string or an array of strings');
    }
    return value;
  });

  const embeddings = await withResilience(
    () => embedder.embedDocuments(inputs),
    { key: `embedding:${model.providerKey}` },
  );
  const latencyMs = Date.now() - start;

  const tokenEstimate =
    typeof body.input_tokens === 'number'
      ? body.input_tokens
      : typeof body.inputTokenCount === 'number'
        ? body.inputTokenCount
        : 0;

  const usage: TokenUsage = {
    inputTokens: tokenEstimate,
    outputTokens: 0,
    totalTokens: tokenEstimate,
  };

  fireAndForget('log-embedding-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'embeddings',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        input: inputs.slice(0, 5),
      }),
      providerResponse: sanitizeForLogging({
        embeddingsLength: embeddings.length,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      object: 'list',
      data: embeddings.map((vector, index) => ({
        object: 'embedding',
        index,
        embedding: normalizeEmbeddingVector(vector),
      })),
      model: model.modelId,
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        total_tokens: usage.totalTokens ?? 0,
      },
    },
    latencyMs,
    requestId,
  };
}

// ── STT / TTS / OCR ─────────────────────────────────────────────────────────

function ensureSttModel(model: IModel) {
  if (model.category !== 'stt') {
    throw new InvalidRequestError('Model is not configured for speech-to-text');
  }
}

function ensureTtsModel(model: IModel) {
  if (model.category !== 'tts') {
    throw new InvalidRequestError('Model is not configured for text-to-speech');
  }
}

function ensureOcrModel(model: IModel) {
  if (model.category !== 'ocr') {
    throw new Error('Model is not configured for OCR');
  }
}

function getOcrMode(model: IModel): 'native' | 'vlm' {
  const settings = (model.settings ?? {}) as Record<string, unknown>;
  const ocrSettings = settings.ocr as Record<string, unknown> | undefined;
  const mode = ocrSettings?.mode;
  if (mode === 'native' || mode === 'vlm') return mode;
  // Default: if provider supports native OCR, prefer native; else vlm.
  return 'native';
}

function ensureSttRuntime(value: unknown): SttRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid STT runtime.');
  }
  const candidate = value as Partial<SttRuntime>;
  if (typeof candidate.transcribe !== 'function') {
    throw new Error('Model provider returned an invalid STT runtime.');
  }
  return candidate as SttRuntime;
}

function ensureTtsRuntime(value: unknown): TtsRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid TTS runtime.');
  }
  const candidate = value as Partial<TtsRuntime>;
  if (typeof candidate.synthesize !== 'function') {
    throw new Error('Model provider returned an invalid TTS runtime.');
  }
  return candidate as TtsRuntime;
}

function ensureOcrRuntime(value: unknown): OcrRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid OCR runtime.');
  }
  const candidate = value as Partial<OcrRuntime>;
  if (typeof candidate.extract !== 'function') {
    throw new Error('Model provider returned an invalid OCR runtime.');
  }
  return candidate as OcrRuntime;
}

export async function handleTranscriptionRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: SttTranscribeInput;
  /** When true, calls the provider's translate() instead of transcribe(). */
  translate?: boolean;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input, translate } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureSttModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createSttRuntime) {
    throw new Error('Model provider does not support speech-to-text');
  }

  const sttRuntime = ensureSttRuntime(
    await runtime.createSttRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: model.settings,
    }),
  );

  const operation = translate ? sttRuntime.translate : sttRuntime.transcribe;
  if (typeof operation !== 'function') {
    throw new Error(
      translate
        ? 'Model provider does not support audio translation'
        : 'Model provider does not support audio transcription',
    );
  }

  const result = await withResilience(
    () => operation.call(sttRuntime, input as SttTranscribeInput & SttTranslateInput),
    { key: `${translate ? 'stt-translate' : 'stt'}:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;

  const usage: TokenUsage = {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    totalTokens:
      result.usage?.totalTokens ??
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    inputSeconds: result.usage?.inputSeconds,
  };

  fireAndForget('log-stt-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: translate ? 'audio.translations' : 'audio.transcriptions',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        language: input.language,
        responseFormat: input.responseFormat,
        audioBytes: input.audio.data.byteLength,
      }),
      providerResponse: sanitizeForLogging({
        text: result.text.slice(0, 500),
        language: result.language,
        duration: result.duration,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
      words: result.words,
      usage: result.usage,
    },
    rawUsage: result.usage,
    latencyMs,
    requestId,
    model,
  };
}

export async function handleSpeechRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: TtsSynthesizeInput;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureTtsModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createTtsRuntime) {
    throw new Error('Model provider does not support text-to-speech');
  }

  const ttsRuntime = ensureTtsRuntime(
    await runtime.createTtsRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: model.settings,
    }),
  );

  const result = await withResilience(
    () => ttsRuntime.synthesize(input),
    { key: `tts:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;

  fireAndForget('log-tts-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'audio.speech',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        voice: input.voice,
        format: input.format,
        speed: input.speed,
        characterCount: input.text.length,
      }),
      providerResponse: sanitizeForLogging({
        contentType: result.contentType,
        format: result.format,
        audioBytes: result.audio.byteLength,
      }),
      latencyMs,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputCharacters: result.usage?.inputCharacters ?? input.text.length,
        outputSeconds: result.usage?.outputSeconds,
      },
    }),
  );

  return {
    audio: result.audio,
    contentType: result.contentType,
    format: result.format,
    usage: result.usage,
    latencyMs,
    requestId,
    model,
  };
}

/**
 * `POST /v1/images/generations`.
 *
 * Same shape as the other non-chat handlers: resolve the model, build the
 * provider runtime, run it under the shared resilience wrapper, and log usage.
 * Image models bill per IMAGE rather than per token, so `usage.images` is what
 * the usage row carries; token counts are recorded only when the upstream
 * reports them (gpt-image does, dall-e does not).
 */
export async function handleImageRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: ImageGenerateInput;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureImageModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createImageRuntime) {
    throw new Error('Model provider does not support image generation');
  }

  const imageRuntime = await runtime.createImageRuntime({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
  });

  const result = await withResilience(
    () => imageRuntime.generate(input),
    { key: `image:${model.providerKey}:${model.modelId}` },
  );

  const latencyMs = Date.now() - start;

  fireAndForget('log-image-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'images.generations',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        n: input.n,
        size: input.size,
        quality: input.quality,
        promptCharacters: input.prompt.length,
      }),
      // The base64 payload is megabytes; only its shape is worth a trace row.
      providerResponse: sanitizeForLogging({
        images: result.images.length,
        withUrl: result.images.filter((image) => Boolean(image.url)).length,
        revisedPrompt: result.images[0]?.revisedPrompt,
      }),
      latencyMs,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
        images: result.usage?.images ?? result.images.length,
      },
    }),
  );

  return {
    response: {
      created: Math.floor(Date.now() / 1000),
      data: result.images.map((image) => ({
        ...(image.b64Json !== undefined ? { b64_json: image.b64Json } : {}),
        ...(image.url !== undefined ? { url: image.url } : {}),
        ...(image.revisedPrompt !== undefined ? { revised_prompt: image.revisedPrompt } : {}),
      })),
      usage: result.usage,
    },
    latencyMs,
    requestId,
    model,
  };
}

/**
 * Native moderation: one call to a purpose-built classifier.
 *
 * The guardrail engine's LLM-judge path stays where it is — this is the other
 * half of the story (see `providers/domains/moderation.ts`), used both by
 * `/v1/moderations` when the caller names a moderation MODEL and by a guardrail
 * whose moderation policy selects the model detector.
 */
export async function handleModerationRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  texts: string[];
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, texts } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureModerationModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createModerationRuntime) {
    throw new Error('Model provider does not support moderation');
  }

  const moderationRuntime = await runtime.createModerationRuntime({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
  });

  const result = await withResilience(
    () => moderationRuntime.classify(texts),
    { key: `moderation:${model.providerKey}:${model.modelId}` },
  );

  const latencyMs = Date.now() - start;

  fireAndForget('log-moderation-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'moderations',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        inputs: texts.length,
        characters: texts.reduce((total, text) => total + text.length, 0),
      }),
      // The texts themselves are the thing being moderated; only the verdict
      // shape belongs in a trace row.
      providerResponse: sanitizeForLogging({
        results: result.results.length,
        flagged: result.results.filter((entry) => entry.flagged).length,
      }),
      latencyMs,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: 0,
        totalTokens: result.usage?.totalTokens ?? result.usage?.inputTokens ?? 0,
      },
    }),
  );

  return { result, latencyMs, requestId, model };
}

export async function handleOcrRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: OcrExtractInput;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureOcrModel(model);

  const mode = getOcrMode(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createOcrRuntime) {
    throw new Error('Model provider does not support OCR');
  }

  // The OCR factory itself decides native vs VLM based on the contract. We pass
  // the requested mode through modelSettings.ocr.mode so VLM-only providers can
  // refuse a native request explicitly if they wanted to.
  const ocrSettings = {
    ...((model.settings ?? {}) as Record<string, unknown>),
    ocr: {
      ...(((model.settings ?? {}) as Record<string, unknown>).ocr as
        | Record<string, unknown>
        | undefined),
      mode,
    },
  };

  const ocrRuntime = ensureOcrRuntime(
    await runtime.createOcrRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: ocrSettings,
    }),
  );

  const result: OcrResult = await withResilience(
    () => ocrRuntime.extract(input),
    { key: `ocr:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;

  const usage: TokenUsage = {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    totalTokens:
      result.usage?.totalTokens ??
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    pages: result.usage?.pages,
  };

  fireAndForget('log-ocr-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'ocr',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        mode,
        documentKind: input.document.kind,
        documentBytes:
          input.document.kind === 'bytes' ? input.document.data.byteLength : undefined,
        documentUrl: input.document.kind === 'url' ? input.document.url : undefined,
        pages: input.pages,
        features: input.features,
      }),
      providerResponse: sanitizeForLogging({
        text: result.text.slice(0, 500),
        pageCount: result.pages?.length,
        tableCount: result.tables?.length,
        invokedVia: result.invokedVia,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      text: result.text,
      pages: result.pages,
      tables: result.tables,
      keyValuePairs: result.keyValuePairs,
      language: result.language,
      invokedVia: result.invokedVia ?? mode,
      usage: result.usage,
    },
    latencyMs,
    requestId,
    model,
  };
}
