/**
 * Live invokers that bridge the pure evaluation engine to the platform model
 * runtime. `model` targets (and the llm-judge) run SDK-FIRST: the provider is
 * resolved to an @cognipeer/agent-sdk native provider (`sdkInvoker.ts`) so
 * evaluations hit the provider wire on ALL providers without the gateway
 * funnel's param narrowing. The gateway path (`handleChatCompletion`) remains
 * as fallback and is selected when (a) the model's driver has no SDK mapping
 * (typed `SdkProviderMappingError`) or (b) `EVALUATION_INVOKER=gateway` is
 * set. Runtime provider errors (auth, 4xx/5xx) do NOT fall back — they
 * surface as the per-item error exactly as before. The SDK path writes no
 * usage logs (intentional — see sdkInvoker.ts); the gateway fallback keeps
 * its existing logging behavior.
 *
 * `agent` targets call `executeAgentChat`; `rag` targets call `queryRag` and
 * return the ranked passages alongside their concatenation, which is what the
 * retrieval scorers grade. Semantic and retrieval scorers embed via
 * `handleEmbeddingRequest`. `external` targets are recognised but not yet
 * wired — they throw a descriptive error, which the runner records as a
 * per-item failure rather than aborting the whole run.
 *
 * Trajectory support: when an item declares `tools`, model targets pass them
 * through (OpenAI function format, tool_choice 'auto') as a single-step
 * decision test — emitted calls are captured (via the SDK's normalised
 * toolCalls, or `extractToolCalls` on the gateway path), never executed.
 * An AGENT target's calls are different: the agent really runs its tools, and
 * its response carries only messages, so they are read from the `steps` the turn
 * persisted on the item's conversation (the agent's own calls; a delegated
 * child's internal steps are not in them).
 *
 * Reliability: model / rag targets and the judge retry transient transport
 * errors (retry.ts) and run under a timeout; an agent target is NEVER retried
 * (its tools may have side effects) but has a timeout. A target's
 * `defaultParams` (temperature, top_p, max_tokens, seed, stop, penalties) are
 * applied on both the SDK and the gateway path.
 * Model targets also surface provider token usage and price it with the
 * target model's hub pricing (`calculateCost`) into `TargetOutput.usage`.
 *
 * Output limits: a call that was cut off at its output limit is never scored as
 * a normal answer. With nothing to show (no visible text, no tool call - a
 * reasoning model that spent the whole budget thinking) it is the item's error,
 * naming the limit; with text it is returned flagged `truncated`. The gateway
 * fallback gets the same verdicts from the gateway itself (it throws the first
 * case) and from the finish reason of the response (the second).
 */

import { handleChatCompletion, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import {
  invokeChatViaSdk,
  parseToolArguments,
  prepareSdkInvocation,
  SdkProviderMappingError,
  type PreparedSdkInvocation,
  type SdkChatResult,
  type SdkSamplingParams,
} from './sdkInvoker';
import { callWithPolicy, envMs, DEFAULT_RETRY_BACKOFF_MS } from './retry';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';
import { getDatabase } from '@/lib/database';
import type { IEvaluationTarget, IModelPricing } from '@/lib/database';
import type { IAgentConversationMessage, IAgentConversationStep } from '@/lib/database/provider/types.domain';
import { selectorForStoredDefault, type AgentRunSelector } from '@/lib/services/agents/agentRevision';
import { kbCallerForActor, runtimeContextForActor } from './kbCaller';
import { sideCallReasoning } from '@/lib/services/agents/agentReasoning';
import type {
  DatasetItem,
  EmbedInvoker,
  EvalUsage,
  JudgeCompletion,
  JudgeInvoker,
  NormalizedToolCall,
  RetrievedChunk,
  TargetInvoker,
  TargetOutput,
} from './types';

export interface EvaluationModelContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** Actor running the suite — required for agent targets; a retrieval target reads a knowledge base as this person. */
  userId?: string;
  /** The API token a client API call started the work with: knowledge bases are then read as the token. */
  tokenId?: string;
}

interface ChatLikeResponse {
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>;
    };
  }>;
}

/** Pull the assistant text out of an OpenAI-shaped chat completion response. */
export function extractAssistantText(response: unknown): string {
  const content = (response as ChatLikeResponse | null | undefined)?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

/** The first choice's finish reason of an OpenAI-shaped chat completion response, normalized. */
function extractFinishReason(response: unknown): string | undefined {
  return normalizeFinishReason((response as ChatLikeResponse | null | undefined)?.choices?.[0]?.finish_reason);
}

/**
 * The SDK path's counterpart of the gateway's output-limit verdict (`completeOnce`): a `length` finish with
 * nothing to show - no visible text (an unterminated `<think>` block is not an answer) and no tool call - is
 * the item's error, carrying the limit the call was sent with and what it burned. A `length` finish WITH text
 * or a tool call is returned to the caller, which flags it `truncated`.
 */
function assertAnswered(result: SdkChatResult): void {
  if (result.finishReason !== 'length') return;
  if (result.toolCalls.length > 0) return;
  if (stripInlineReasoning(result.text).trim() !== '') return;
  throw new OutputTokenLimitError(result.outputTokenLimit, {
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.rawFinishReason ? { rawFinishReason: result.rawFinishReason } : {}),
  });
}

/**
 * Output limit of an LLM-judge call when neither the judge model's record ("Default max tokens") nor anything
 * else sets one: a verdict is a short JSON object, and every chat model - including a small self-hosted one -
 * takes this much. A limit the judge model's record sets wins (and, like any limit a model record sets, may get
 * thinking headroom).
 */
const JUDGE_DEFAULT_MAX_TOKENS = 4096;

/**
 * Pull tool calls out of a provider response, normalised to {name, args}.
 * Handles the OpenAI chat-completion shape
 * (`choices[0].message.tool_calls[].function` with a JSON-string `arguments`)
 * and is tolerant of Responses-shaped output (`output[]` items of type
 * `function_call` / `tool_call`, cf. extractAgentText). Invalid JSON arguments
 * become `{ __raw: <string> }` rather than throwing (the one convention shared
 * with sdkInvoker's `parseToolArguments`). NOT for agent targets: an agent
 * response never carries tool calls (see the agent branch).
 */
export function extractToolCalls(response: unknown): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];

  const chatToolCalls = (response as ChatLikeResponse | null | undefined)?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(chatToolCalls)) {
    for (const call of chatToolCalls) {
      const name = call?.function?.name;
      if (typeof name !== 'string' || !name) continue;
      calls.push({ name, args: parseToolArguments(call.function?.arguments) });
    }
    if (calls.length > 0) return calls;
  }

  // Responses-shaped output: top-level `output` array carrying function-call
  // items alongside message items (the same shape extractAgentText reads).
  const output = (response as { output?: Array<{ type?: unknown; name?: unknown; arguments?: unknown }> })?.output;
  if (Array.isArray(output)) {
    for (const entry of output) {
      if (entry?.type !== 'function_call' && entry?.type !== 'tool_call') continue;
      const name = entry.name;
      if (typeof name !== 'string' || !name) continue;
      calls.push({ name, args: parseToolArguments(entry.arguments) });
    }
  }
  return calls;
}

/** Canonical gateway usage (input includes cache read/write; those are subsets). */
interface EvalCanonicalUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
}

/** A model's pricing with the driver + id its cache-write rate follows. */
interface EvalPricedModel { pricing: IModelPricing; providerDriver?: string; modelId?: string }

/** Map the inference layer's TokenUsage onto the engine's EvalUsage. */
function toEvalUsage(
  usage: EvalCanonicalUsage | undefined,
  priced: EvalPricedModel | null,
): EvalUsage | undefined {
  if (!usage) return undefined;
  const evalUsage: EvalUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    // Optional keys only when present: Mongo stores `undefined` as null.
    ...(usage.cachedWriteTokens ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
    ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
  if (priced) {
    evalUsage.costUsd = calculateCost(priced.pricing, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cachedWriteTokens: usage.cachedWriteTokens,
      reasoningTokens: usage.reasoningTokens,
    }, { providerDriver: priced.providerDriver, modelId: priced.modelId }).totalCost;
  }
  return evalUsage;
}

/**
 * Serialize dataset messages to the OpenAI chat wire format with full tool
 * fidelity: assistant `toolCalls` become `tool_calls` entries and tool turns
 * become `role:'tool'` messages. Call ids are kept when recorded; missing ids
 * are synthesized deterministically (`call_<n>`) and tool turns without a
 * `toolCallId` are linked to the oldest still-open call of the preceding
 * assistant turn, so replays of recorded history stay provider-valid.
 */
/** Stand-in content for a recorded call whose tool response never made it
 *  into the source — the wire REQUIRES a tool message per tool_call_id. */
const MISSING_TOOL_RESULT = '[no recorded tool result]';

export function toProviderMessages(input: DatasetItem['input']): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [];
  let synth = 0;
  /** Ids of tool calls awaiting a response, oldest first. */
  const openCallIds: string[] = [];

  // Wire validity: every assistant tool_call must be answered by a tool
  // message BEFORE the next non-tool turn — providers 400 otherwise. Sources
  // (traces especially) can record calls whose results were never captured,
  // so close any still-open calls with an explicit stand-in tool message.
  const closeOpenCalls = () => {
    while (openCallIds.length > 0) {
      const id = openCallIds.shift() as string;
      wire.push({ role: 'tool', tool_call_id: id, content: MISSING_TOOL_RESULT });
    }
  };

  for (const message of input) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      closeOpenCalls();
      const toolCalls = message.toolCalls.map((call) => {
        const id = call.id && call.id.length > 0 ? call.id : `call_${++synth}`;
        openCallIds.push(id);
        return {
          id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        };
      });
      wire.push({ role: 'assistant', content: message.content ?? '', tool_calls: toolCalls });
      continue;
    }
    if (message.role === 'tool') {
      let id = message.toolCallId && message.toolCallId.length > 0 ? message.toolCallId : undefined;
      if (id !== undefined) {
        const idx = openCallIds.indexOf(id);
        if (idx >= 0) {
          openCallIds.splice(idx, 1);
        } else {
          // Orphan tool response: its declaring call was never captured (e.g.
          // a trace recorded the result but not the call). A call DID happen —
          // synthesize the declaring assistant turn, or providers reject the
          // message with "tool_call_id not found". Close other open calls
          // first so their own follow-up contract stays intact.
          closeOpenCalls();
          wire.push({
            role: 'assistant',
            content: '',
            tool_calls: [{
              id,
              type: 'function',
              function: { name: message.name ?? 'tool', arguments: '{}' },
            }],
          });
        }
      } else {
        id = openCallIds.shift();
        if (id === undefined) {
          id = `call_${++synth}`;
          wire.push({
            role: 'assistant',
            content: '',
            tool_calls: [{
              id,
              type: 'function',
              function: { name: message.name ?? 'tool', arguments: '{}' },
            }],
          });
        }
      }
      wire.push({
        role: 'tool',
        tool_call_id: id,
        content: message.content ?? '',
        ...(message.name ? { name: message.name } : {}),
      });
      continue;
    }
    closeOpenCalls();
    wire.push({ role: message.role, content: message.content });
  }
  closeOpenCalls();
  return wire;
}

/** Agent chat usage (OpenAI Responses shape) → EvalUsage. Not priced: an agent may route across several models. */
function agentUsageToEval(response: unknown): EvalUsage | undefined {
  const usage = (response as {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      input_tokens_details?: { cached_tokens?: unknown };
      output_tokens_details?: { reasoning_tokens?: unknown };
    };
  } | null | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const cached = num(usage.input_tokens_details?.cached_tokens);
  const reasoning = num(usage.output_tokens_details?.reasoning_tokens);
  // Optional keys only when present: Mongo stores `undefined` as null.
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  };
}

type PersistedAssistantTurn = Pick<IAgentConversationMessage, 'steps' | 'usage'>;

/** The last assistant message of a conversation (what the turn that just ran wrote), or null when unreadable. */
async function lastAssistantTurn(tenantDbName: string, conversationId: string): Promise<PersistedAssistantTurn | null> {
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const conversation = await db.findAgentConversationById(conversationId);
    const messages = conversation?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i];
    }
  } catch {
    // Bookkeeping only: the answer text is already in hand.
  }
  return null;
}

/** The agent's calls, from the steps its turn persisted. Same `__raw` convention for unparseable arguments. */
function toolCallsFromSteps(steps: IAgentConversationStep[]): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  for (const step of steps) {
    if (typeof step?.name !== 'string' || !step.name) continue;
    calls.push({ name: step.name, args: parseToolArguments(step.args) });
  }
  return calls;
}

/** The persisted (already priced) usage of a turn → EvalUsage, optional keys only when present. */
function messageUsageToEval(usage: NonNullable<IAgentConversationMessage['usage']>): EvalUsage | undefined {
  const evalUsage: EvalUsage = {
    ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cachedInputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.cachedWriteTokens ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
    ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(typeof usage.costUsd === 'number' ? { costUsd: usage.costUsd } : {}),
  };
  return Object.keys(evalUsage).length > 0 ? evalUsage : undefined;
}

/** Sampling parameters a model target pins, normalised (R9). */
export interface TargetSamplingParams extends SdkSamplingParams {
  maxTokens?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a target's `defaultParams` into the parameters both invocation paths
 * understand. Accepts the OpenAI snake_case spelling and camelCase; unknown keys
 * are ignored (they are not part of the request contract and must never reach
 * a provider body unchecked). An explicit `target.maxTokens` beats a
 * `max_tokens` default.
 */
export function resolveTargetParams(target: Pick<IEvaluationTarget, 'defaultParams' | 'maxTokens'>): TargetSamplingParams {
  const raw = target.defaultParams && typeof target.defaultParams === 'object' && !Array.isArray(target.defaultParams)
    ? target.defaultParams as Record<string, unknown>
    : {};
  const pick = (...keys: string[]) => {
    for (const key of keys) if (raw[key] !== undefined && raw[key] !== null) return raw[key];
    return undefined;
  };
  const params: TargetSamplingParams = {};
  const temperature = finiteNumber(pick('temperature'));
  if (temperature !== undefined) params.temperature = temperature;
  const topP = finiteNumber(pick('top_p', 'topP'));
  if (topP !== undefined) params.topP = topP;
  const seed = finiteNumber(pick('seed'));
  if (seed !== undefined && Number.isInteger(seed)) params.seed = seed;
  const presence = finiteNumber(pick('presence_penalty', 'presencePenalty'));
  if (presence !== undefined) params.presencePenalty = presence;
  const frequency = finiteNumber(pick('frequency_penalty', 'frequencyPenalty'));
  if (frequency !== undefined) params.frequencyPenalty = frequency;
  const stop = pick('stop');
  if (typeof stop === 'string' && stop !== '') params.stop = [stop];
  else if (Array.isArray(stop)) {
    const list = stop.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
    if (list.length > 0) params.stop = list;
  }
  const maxTokens = finiteNumber(target.maxTokens) ?? finiteNumber(pick('max_tokens', 'maxTokens'));
  if (maxTokens !== undefined && maxTokens > 0) params.maxTokens = Math.floor(maxTokens);
  return params;
}

async function invokeModel(
  ctx: EvaluationModelContext,
  modelKey: string,
  messages: Array<Record<string, unknown>>,
  extraBody?: Record<string, unknown>,
): Promise<{
  text: string;
  latencyMs?: number;
  raw: unknown;
  usage?: EvalCanonicalUsage;
  /** The first choice's finish reason (`length` = cut off at the output limit). */
  finishReason?: string;
}> {
  const result = (await handleChatCompletion({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    modelKey,
    projectId: ctx.projectId,
    // Its own route: an evaluation call is not production traffic (the gateway keeps such routes out of
    // the semantic cache - a cached answer would grade the cache, not the model).
    route: 'evaluation',
    body: { messages, ...extraBody },
  })) as {
    response?: unknown;
    latencyMs?: number;
    usage?: EvalCanonicalUsage;
  };
  const finishReason = extractFinishReason(result.response);
  return {
    text: extractAssistantText(result.response),
    latencyMs: result.latencyMs,
    raw: result.response,
    usage: result.usage,
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Pull the assistant text out of an agent chat (Responses-shaped) result. */
export function extractAgentText(response: unknown): string {
  const output = (response as { output?: Array<{ content?: Array<{ text?: unknown; type?: string }> }> })?.output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const message of output) {
    for (const part of message?.content ?? []) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('').trim();
}

/** The last user turn (falling back to a join of all turns) drives an agent. */
function toUserMessage(item: DatasetItem): string {
  const lastUser = [...item.input].reverse().find((m) => m.role === 'user');
  if (lastUser) return lastUser.content;
  return item.input.map((m) => m.content).join('\n');
}

/**
 * Lazily resolve (and cache) the target model's hub pricing so per-item cost
 * can be computed without a DB round-trip per invocation. Resolution failures
 * degrade to "no pricing" — the run must never fail over cost bookkeeping.
 */
function buildPricingResolver(ctx: EvaluationModelContext, modelKey: string): () => Promise<EvalPricedModel | null> {
  let cached: Promise<EvalPricedModel | null> | undefined;
  return () => {
    cached ??= (async () => {
      try {
        const db = await getDatabase();
        await db.switchToTenant(ctx.tenantDbName);
        const models = await db.listModels(ctx.projectId ? { projectId: ctx.projectId } : undefined);
        const found = models.find((m) => m.key === modelKey);
        return found?.pricing ? { pricing: found.pricing, providerDriver: found.providerDriver, modelId: found.modelId } : null;
      } catch {
        return null;
      }
    })();
    return cached;
  };
}

/** Which invocation path a model target / judge runs on. */
type ModelInvocationPath =
  | { mode: 'sdk'; prepared: PreparedSdkInvocation }
  | { mode: 'gateway' };

/**
 * Decide once per invoker (lazily, cached) whether a model runs through the
 * agent-sdk native provider or the legacy gateway funnel. The SDK path is the
 * default; `EVALUATION_INVOKER=gateway` or a typed SdkProviderMappingError
 * (driver with no SDK mapping) selects the gateway. Any OTHER resolution
 * error (model not found, provider record missing, decrypt failure) is
 * re-thrown as the item error — the cache is cleared first so a transient
 * failure on one item does not poison the rest of the run.
 */
function buildInvocationPathResolver(
  ctx: EvaluationModelContext,
  modelKey: string,
): () => Promise<ModelInvocationPath> {
  let cached: Promise<ModelInvocationPath> | undefined;
  const resolve = async (): Promise<ModelInvocationPath> => {
    if (process.env.EVALUATION_INVOKER === 'gateway') return { mode: 'gateway' };
    try {
      const prepared = await prepareSdkInvocation(
        { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId },
        modelKey,
      );
      return { mode: 'sdk', prepared };
    } catch (error) {
      if (error instanceof SdkProviderMappingError) return { mode: 'gateway' };
      throw error;
    }
  };
  return () => {
    if (!cached) {
      cached = resolve().catch((error) => {
        cached = undefined;
        throw error;
      });
    }
    return cached;
  };
}

/**
 * Resolve a target's system-prompt override, once per run.
 *
 * `promptKey` is resolved lazily and cached so a suite always tests the
 * CURRENT template of that prompt (promote a new version → next run tests it)
 * without re-reading it for every dataset item.
 */
function buildSystemPromptResolver(
  target: IEvaluationTarget,
  ctx: EvaluationModelContext,
): (() => Promise<string | null>) | undefined {
  if (target.promptKey) {
    let cached: Promise<string | null> | undefined;
    return () => {
      if (!cached) {
        cached = (async () => {
          const { resolvePromptForEnvironment } = await import('@/lib/services/prompts/promptService');
          const resolved = await resolvePromptForEnvironment(
            ctx.tenantDbName, ctx.projectId, target.promptKey!, undefined, target.promptVersion,
          );
          if (!resolved) throw new Error(`Evaluation target "${target.key}" references prompt "${target.promptKey}", which was not found`);
          return resolved.resolvedVersion?.template ?? resolved.prompt.template;
        })().catch((error) => { cached = undefined; throw error; });
      }
      return cached;
    };
  }
  if (target.systemPrompt?.trim()) {
    const literal = target.systemPrompt;
    return () => Promise.resolve(literal);
  }
  return undefined;
}

/**
 * Apply a system-prompt override to an item's messages.
 *
 * The item's own system turn is REPLACED, not stacked on: dataset items
 * captured from live traffic embed the system prompt they were recorded with,
 * so keeping it would mean testing the override on top of the prompt it is
 * meant to replace — the old prompt would never actually leave the request.
 */
function withSystemPrompt(input: DatasetItem['input'], systemPrompt: string): DatasetItem['input'] {
  return [{ role: 'system' as const, content: systemPrompt }, ...input.filter((m) => m.role !== 'system')];
}

/** Retry (x2) + timeout for model / rag targets and the judge; both limits are env-tunable. */
function modelCallPolicy(label: string, timeoutEnv = 'EVALUATION_TARGET_TIMEOUT_MS', fallbackMs = 180_000) {
  return { timeoutMs: envMs(timeoutEnv, fallbackMs), retries: 2, backoffMs: DEFAULT_RETRY_BACKOFF_MS, label };
}

/**
 * The item's earlier user / assistant TEXT turns, i.e. everything before its last user turn.
 * Seeded into an agent's conversation so a multi-turn item is not graded without its context.
 * System turns are dropped (the agent runs its own prompt); recorded tool exchanges and tool-call-only
 * assistant turns are not seeded (a tool result is a fact about an environment the agent no longer has).
 */
function priorTextTurns(item: DatasetItem): Array<{ role: 'user' | 'assistant'; content: string }> {
  let lastUser = -1;
  for (let i = item.input.length - 1; i >= 0; i--) {
    if (item.input[i].role === 'user') { lastUser = i; break; }
  }
  if (lastUser <= 0) return [];
  const prior: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of item.input.slice(0, lastUser)) {
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.trim() === '') continue;
    prior.push({ role: m.role, content: m.content });
  }
  return prior;
}

export interface TargetInvokerOptions {
  /**
   * Agent targets: the config this run pinned as it started. Without it the
   * invoker follows the target's own default, as each call finds it.
   */
  agentRun?: AgentRunSelector;
}

export function buildTargetInvoker(
  target: IEvaluationTarget,
  ctx: EvaluationModelContext,
  options: TargetInvokerOptions = {},
): TargetInvoker {
  const resolvePricing = target.kind === 'model' && target.modelKey
    ? buildPricingResolver(ctx, target.modelKey)
    : () => Promise.resolve<EvalPricedModel | null>(null);
  const resolveInvocationPath = target.kind === 'model' && target.modelKey
    ? buildInvocationPathResolver(ctx, target.modelKey)
    : undefined;
  const resolveSystemPrompt = buildSystemPromptResolver(target, ctx);

  return async (item: DatasetItem): Promise<TargetOutput> => {
    if (target.kind === 'model') {
      if (!target.modelKey || !resolveInvocationPath) {
        throw new Error(`Evaluation target "${target.key}" has no modelKey configured`);
      }
      const override = resolveSystemPrompt ? await resolveSystemPrompt() : null;
      const messages = toProviderMessages(override ? withSystemPrompt(item.input, override) : item.input);
      // The target's contract wins — that is how you test a contract CHANGE.
      // With none set, the item replays under the contract it was RECORDED
      // with (captured from the trace by Traffic Snapshots): a suite that
      // silently drops production's JSON schema grades a different system.
      const responseFormat = target.responseFormat ?? item.responseFormat;
      const path = await resolveInvocationPath();
      const params = resolveTargetParams(target);
      const policy = modelCallPolicy('Target model call');
      if (path.mode === 'sdk') {
        const { maxTokens, ...sampling } = params;
        const result = await callWithPolicy((signal) => invokeChatViaSdk(
          { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId },
          path.prepared.model,
          messages,
          {
            tools: item.tools,
            config: path.prepared.config,
            responseFormat,
            maxTokens,
            params: sampling,
            signal,
          },
        ), policy);
        assertAnswered(result);
        const output: TargetOutput = {
          text: result.text,
          latencyMs: result.latencyMs,
          raw: result.raw,
          toolCalls: result.toolCalls,
          usage: toEvalUsage(result.usage, await resolvePricing()),
          ...(result.finishReason === 'length' ? { truncated: true } : {}),
        };
        return output;
      }
      // Gateway fallback — single-step trajectory test: expose the item's
      // tools so the model can *decide* to call them, but never execute
      // anything — the emitted calls are captured for the tool-call scorer.
      // Reproduce the production request contract, not just its messages: if
      // the live call enforces a JSON schema and caps output length, a test
      // that omits both is measuring a different system.
      const extraBody: Record<string, unknown> = {};
      if (responseFormat) extraBody.response_format = responseFormat;
      if (params.maxTokens !== undefined) extraBody.max_tokens = params.maxTokens;
      if (params.temperature !== undefined) extraBody.temperature = params.temperature;
      if (params.topP !== undefined) extraBody.top_p = params.topP;
      if (params.seed !== undefined) extraBody.seed = params.seed;
      if (params.stop) extraBody.stop = params.stop;
      if (params.presencePenalty !== undefined) extraBody.presence_penalty = params.presencePenalty;
      if (params.frequencyPenalty !== undefined) extraBody.frequency_penalty = params.frequencyPenalty;
      if (item.tools && item.tools.length > 0) {
        extraBody.tools = item.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        extraBody.tool_choice = 'auto';
      }
      const modelKey = target.modelKey;
      const { text, latencyMs, raw, usage, finishReason } = await callWithPolicy(
        () => invokeModel(ctx, modelKey, messages, extraBody),
        policy,
      );
      const output: TargetOutput = {
        text,
        latencyMs,
        raw,
        toolCalls: extractToolCalls(raw),
        usage: toEvalUsage(usage, await resolvePricing()),
        ...(isTruncatedFinishReason(finishReason) ? { truncated: true } : {}),
      };
      return output;
    }
    if (target.kind === 'agent') {
      if (!target.agentKey) throw new Error(`Evaluation target "${target.key}" has no agentKey configured`);
      // An agent runs with its OWN prompt, resolved inside executeAgentChat —
      // there is no per-call override seam. Failing loudly
      // beats silently evaluating a different prompt than the user selected.
      if (resolveSystemPrompt) {
        throw new Error(
          `Evaluation target "${target.key}" sets a system-prompt override, which agent targets do not support — an agent runs its own prompt (of the version or draft the run tests). Use a model target to test a prompt, or change the agent's prompt.`,
        );
      }
      // Lazy import: the agent runtime pulls in a heavy module graph (rag /
      // document conversion) that we only want loaded when an agent target
      // actually runs — not at evaluation-engine import time.
      const { createConversation, executeAgentChat } = await import('@/lib/services/agents/agentService');
      const userId = ctx.userId ?? 'evaluation';
      const evaluationRuntime = runtimeContextForActor(ctx.userId, ctx.tokenId, 'evaluation');
      // Each item runs in its own fresh conversation so cases never bleed into
      // each other. `executeAgentChat` requires an existing conversation, so we
      // create one first (the id is DB-generated, not synthesised).
      const conversation = await createConversation(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        userId,
        target.agentKey,
        `Eval ${target.key} · ${item.id}`,
        { source: 'evaluation' },
      );
      // Prior turns of a multi-turn item go into the conversation BEFORE the last user message, in the shape
      // `executeAgentChat` loads as history (`{ role, content, timestamp }` rows of `conversation.messages`).
      // Under `perTurn` the runner hands each turn an input that already holds the agent's OWN earlier
      // answers, so seeding them gives the agent the same view as a live session.
      const prior = priorTextTurns(item);
      const conversationId = String(conversation._id);
      const agentKey = target.agentKey;
      try {
        if (prior.length > 0) {
          const db = await getDatabase();
          await db.switchToTenant(ctx.tenantDbName);
          const now = new Date();
          const seeded = await db.updateAgentConversation(conversationId, {
            messages: prior.map((m) => ({ role: m.role, content: m.content, timestamp: now })),
          });
          if (!seeded) throw new Error(`Could not seed the earlier turns of item "${item.id}" into the agent conversation`);
        }
        const started = Date.now();
        // NO retry: a tool may have side effects. A timeout still frees the runner slot.
        const response = await callWithPolicy((signal) => executeAgentChat({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          agentKey,
          conversationId,
          userMessage: toUserMessage(item),
          userId,
          // No one is present during a suite run: a gated tool follows the agent's
          // `humanInTheLoop.unattended` setting (deny by default).
          unattended: true,
          signal,
          // A run pins its config up front (`options.agentRun`) so every item
          // tests the same one. Without that, follow the target's own default:
          // a pinned version, the draft, or whatever is published.
          ...(options.agentRun ?? selectorForStoredDefault(target.agentVersion)),
          // Its knowledge tools read as the person who started the suite (or the token it was started with).
          ...(evaluationRuntime ? { runtimeContext: evaluationRuntime } : {}),
        }), { timeoutMs: envMs('EVALUATION_AGENT_TIMEOUT_MS', 600_000), retries: 0, label: 'Agent target call' });
        const latencyMs = Date.now() - started;
        // The Responses-shaped result holds messages only (no function_call items), so the agent's own tool
        // calls and its priced usage are read back from the turn the runtime just persisted (`steps` = this
        // turn's tool history; a delegated child's internal calls are not in it), BEFORE the conversation is
        // deleted below. `executeAgentChat` has no tool-event hook to listen on instead.
        const turn = await lastAssistantTurn(ctx.tenantDbName, conversationId);
        const usage = turn?.usage ? messageUsageToEval(turn.usage) : agentUsageToEval(response);
        return {
          text: extractAgentText(response),
          latencyMs,
          raw: response,
          toolCalls: turn?.steps ? toolCallsFromSteps(turn.steps) : extractToolCalls(response),
          ...(usage ? { usage } : {}),
        };
      } finally {
        // The conversation only existed for this item: remove it once the output is captured. Best effort -
        // a failed delete must never fail (or change) the item.
        try {
          const { deleteConversation } = await import('@/lib/services/agents/agentService');
          await deleteConversation(ctx.tenantDbName, conversationId);
        } catch {
          // leave it; it is tagged `metadata.source: 'evaluation'`
        }
      }
    }
    if (target.kind === 'rag') {
      if (!target.ragModuleKey) {
        throw new Error(
          `Evaluation target "${target.key}" has no ragModuleKey configured — a retrieval target must name the Knowledge Engine module it queries`,
        );
      }
      // Lazy import for the same reason as the agent branch: the RAG graph
      // (document conversion, vector providers, rerankers) is heavy and should
      // not load just because the evaluation engine was imported.
      const { queryRag } = await import('@/lib/services/rag/ragService');
      // A knowledge base with access control answers with what the person running the suite may read.
      const ragModuleKey = target.ragModuleKey;
      const result = await callWithPolicy(() => queryRag(ctx.tenantDbName, ctx.tenantId, ctx.projectId || undefined, {
        ragModuleKey,
        query: toUserMessage(item),
        topK: target.retrievalTopK,
        minScore: target.retrievalMinScore,
        includeContent: true,
      }, { caller: kbCallerForActor(ctx.userId, ctx.tokenId) }), modelCallPolicy('Retrieval call'));
      const retrieved: RetrievedChunk[] = result.matches.map((match, index) => ({
        id: match.id,
        score: match.score,
        content: match.content ?? '',
        documentId: match.documentId,
        fileName: match.fileName,
        chunkIndex: match.chunkIndex,
        rank: index + 1,
      }));
      return {
        // The concatenation is exactly what a generator would be handed as
        // context, so it is what the non-retrieval scorers grade; the ranked
        // matches ride along for the retrieval scorers, which need per-chunk
        // text and rank that a concatenation has already thrown away.
        text: retrieved.map((chunk) => chunk.content).filter((content) => content.trim()).join('\n\n'),
        latencyMs: result.latencyMs,
        raw: result,
        retrieved,
      };
    }
    throw new Error('external evaluation targets are not yet supported (model targets only in this release)');
  };
}

export function buildEmbedInvoker(embeddingModelKey: string | undefined, ctx: EvaluationModelContext): EmbedInvoker {
  return async (texts) => {
    if (!embeddingModelKey) {
      throw new Error('embeddingModelKey is required when a suite uses semantic scorers');
    }
    const result = (await handleEmbeddingRequest({
      tenantDbName: ctx.tenantDbName,
      modelKey: embeddingModelKey,
      projectId: ctx.projectId,
      body: { input: texts },
    })) as { response?: { data?: Array<{ embedding?: number[] }> } };
    const data = result.response?.data;
    if (!data || data.length < texts.length) {
      throw new Error('embedding provider returned fewer vectors than requested');
    }
    return data.map((d) => {
      if (!d.embedding) throw new Error('missing embedding in provider response');
      return d.embedding;
    });
  };
}

export function buildJudgeInvoker(judgeModelKey: string | undefined, ctx: EvaluationModelContext): JudgeInvoker {
  const resolveInvocationPath = judgeModelKey
    ? buildInvocationPathResolver(ctx, judgeModelKey)
    : undefined;
  const resolvePricing = judgeModelKey
    ? buildPricingResolver(ctx, judgeModelKey)
    : () => Promise.resolve<EvalPricedModel | null>(null);
  return async (messages): Promise<JudgeCompletion> => {
    if (!judgeModelKey || !resolveInvocationPath) {
      throw new Error('judgeModelKey is required when a suite uses llm-judge scorers');
    }
    const wire = messages.map((m) => ({ role: m.role, content: m.content }));
    const path = await resolveInvocationPath();
    // Transient transport errors retry x2 (1s, 3s; Retry-After honoured) and each attempt has a timeout.
    // Parse failures are the scorer's to retry - this layer only knows the transport.
    // No `temperature: 0`: whether a judge model accepts one (reasoning models reject it) is not known
    // reliably here, and a rejected parameter would fail every judge call. Revisit if the model record
    // ever exposes "accepts temperature".
    const policy = modelCallPolicy('Judge call', 'EVALUATION_JUDGE_TIMEOUT_MS', 120_000);
    if (path.mode === 'sdk') {
      const result = await callWithPolicy((signal) => invokeChatViaSdk(
        { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId },
        path.prepared.model,
        wire,
        {
          config: path.prepared.config,
          // The verdict shares its limit with the thinking: the lowest thinking the model allows, and the 4096 only as
          // the MODEL-level default (it then gets thinking headroom for any effort that remains).
          defaultMaxTokens: JUDGE_DEFAULT_MAX_TOKENS,
          reasoning: sideCallReasoning(path.prepared.model),
          signal,
        },
      ), policy);
      assertAnswered(result);
      const usage = toEvalUsage(result.usage, await resolvePricing());
      return { text: result.text, ...(usage ? { usage } : {}) };
    }
    // The gateway resolves the judge's output limit itself (the model's own setting, else the driver default):
    // a limit in the body would be a CALLER's cap and beat the "Default max tokens" the operator configured.
    const { text, usage } = await callWithPolicy(() => invokeModel(ctx, judgeModelKey, wire), policy);
    const evalUsage = toEvalUsage(usage, await resolvePricing());
    return { text, ...(evalUsage ? { usage: evalUsage } : {}) };
  };
}
