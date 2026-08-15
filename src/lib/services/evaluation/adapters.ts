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
 * `agent` targets call `executeAgentChat`; semantic scorers embed via
 * `handleEmbeddingRequest`. `external` targets are recognised but not yet
 * wired — they throw a descriptive error, which the runner records as a
 * per-item failure rather than aborting the whole run.
 *
 * Trajectory support: when an item declares `tools`, model targets pass them
 * through (OpenAI function format, tool_choice 'auto') as a single-step
 * decision test — emitted calls are captured (via the SDK's normalised
 * toolCalls, or `extractToolCalls` on the gateway path), never executed.
 * Model targets also surface provider token usage and price it with the
 * target model's hub pricing (`calculateCost`) into `TargetOutput.usage`.
 */

import { handleChatCompletion, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import {
  invokeChatViaSdk,
  prepareSdkInvocation,
  SdkProviderMappingError,
  type PreparedSdkInvocation,
} from './sdkInvoker';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { getDatabase } from '@/lib/database';
import type { IEvaluationTarget, IModelPricing } from '@/lib/database';
import type {
  DatasetItem,
  EmbedInvoker,
  EvalUsage,
  JudgeInvoker,
  NormalizedToolCall,
  TargetInvoker,
  TargetOutput,
} from './types';

export interface EvaluationModelContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** Actor running the suite — required for agent targets. */
  userId?: string;
}

interface ChatLikeResponse {
  choices?: Array<{
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

/**
 * Pull tool calls out of a provider response, normalised to {name, args}.
 * Handles the OpenAI chat-completion shape
 * (`choices[0].message.tool_calls[].function` with a JSON-string `arguments`)
 * and is tolerant of Responses-shaped output (`output[]` items of type
 * `function_call` / `tool_call`, cf. extractAgentText). Invalid JSON arguments
 * become `{ __raw: <string> }` rather than throwing.
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

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { __raw: raw };
  } catch {
    return { __raw: raw };
  }
}

/** Map the inference layer's TokenUsage onto the engine's EvalUsage. */
function toEvalUsage(
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined,
  pricing: IModelPricing | null,
): EvalUsage | undefined {
  if (!usage) return undefined;
  const evalUsage: EvalUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
  };
  if (pricing) {
    evalUsage.costUsd = calculateCost(pricing, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
    }).totalCost;
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

async function invokeModel(
  ctx: EvaluationModelContext,
  modelKey: string,
  messages: Array<Record<string, unknown>>,
  extraBody?: Record<string, unknown>,
): Promise<{
  text: string;
  latencyMs?: number;
  raw: unknown;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
}> {
  const result = (await handleChatCompletion({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    modelKey,
    projectId: ctx.projectId,
    body: { messages, ...extraBody },
  })) as {
    response?: unknown;
    latencyMs?: number;
    usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  };
  return {
    text: extractAssistantText(result.response),
    latencyMs: result.latencyMs,
    raw: result.response,
    usage: result.usage,
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
function buildPricingResolver(ctx: EvaluationModelContext, modelKey: string): () => Promise<IModelPricing | null> {
  let cached: Promise<IModelPricing | null> | undefined;
  return () => {
    cached ??= (async () => {
      try {
        const db = await getDatabase();
        await db.switchToTenant(ctx.tenantDbName);
        const models = await db.listModels(ctx.projectId ? { projectId: ctx.projectId } : undefined);
        return models.find((m) => m.key === modelKey)?.pricing ?? null;
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

export function buildTargetInvoker(target: IEvaluationTarget, ctx: EvaluationModelContext): TargetInvoker {
  const resolvePricing = target.kind === 'model' && target.modelKey
    ? buildPricingResolver(ctx, target.modelKey)
    : () => Promise.resolve(null);
  const resolveInvocationPath = target.kind === 'model' && target.modelKey
    ? buildInvocationPathResolver(ctx, target.modelKey)
    : undefined;

  return async (item: DatasetItem): Promise<TargetOutput> => {
    if (target.kind === 'model') {
      if (!target.modelKey || !resolveInvocationPath) {
        throw new Error(`Evaluation target "${target.key}" has no modelKey configured`);
      }
      const messages = toProviderMessages(item.input);
      const path = await resolveInvocationPath();
      if (path.mode === 'sdk') {
        const result = await invokeChatViaSdk(
          { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId },
          path.prepared.model,
          messages,
          { tools: item.tools, config: path.prepared.config },
        );
        return {
          text: result.text,
          latencyMs: result.latencyMs,
          raw: result.raw,
          toolCalls: result.toolCalls,
          usage: toEvalUsage(result.usage, await resolvePricing()),
        };
      }
      // Gateway fallback — single-step trajectory test: expose the item's
      // tools so the model can *decide* to call them, but never execute
      // anything — the emitted calls are captured for the tool-call scorer.
      const extraBody: Record<string, unknown> = {};
      if (item.tools && item.tools.length > 0) {
        extraBody.tools = item.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        extraBody.tool_choice = 'auto';
      }
      const { text, latencyMs, raw, usage } = await invokeModel(ctx, target.modelKey, messages, extraBody);
      return {
        text,
        latencyMs,
        raw,
        toolCalls: extractToolCalls(raw),
        usage: toEvalUsage(usage, await resolvePricing()),
      };
    }
    if (target.kind === 'agent') {
      if (!target.agentKey) throw new Error(`Evaluation target "${target.key}" has no agentKey configured`);
      // Lazy import: the agent runtime pulls in a heavy module graph (rag /
      // document conversion) that we only want loaded when an agent target
      // actually runs — not at evaluation-engine import time.
      const { createConversation, executeAgentChat } = await import('@/lib/services/agents/agentService');
      const userId = ctx.userId ?? 'evaluation';
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
      );
      const started = Date.now();
      const response = await executeAgentChat({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        agentKey: target.agentKey,
        conversationId: String(conversation._id),
        userMessage: toUserMessage(item),
        userId,
        usePublished: true,
      });
      return {
        text: extractAgentText(response),
        latencyMs: Date.now() - started,
        raw: response,
        toolCalls: extractToolCalls(response),
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
  return async (messages) => {
    if (!judgeModelKey || !resolveInvocationPath) {
      throw new Error('judgeModelKey is required when a suite uses llm-judge scorers');
    }
    const wire = messages.map((m) => ({ role: m.role, content: m.content }));
    const path = await resolveInvocationPath();
    if (path.mode === 'sdk') {
      const { text } = await invokeChatViaSdk(
        { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId },
        path.prepared.model,
        wire,
        { config: path.prepared.config },
      );
      return text;
    }
    const { text } = await invokeModel(ctx, judgeModelKey, wire);
    return text;
  };
}
