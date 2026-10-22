/**
 * The chat model of an agent: ONE agent-sdk `BaseChatModel` whose every call is a
 * call into the gateway core (`executeModelCall`), in process, in agent-sdk
 * native terms.
 *
 * Why: everything an operator configured on a model in Model Hub - guardrails
 * (input, output, stream), semantic cache, replica pool, Dynamic LLM routing,
 * unsupported-parameter rules and request defaults, the reasoning default and its
 * hide switch, usage and cost logging - must apply whoever calls the model. An
 * agent used to build its own provider client and skip all of it. Main model,
 * additional models, sub-agents, titles, the model check and Dynamic LLM models
 * all come through here.
 *
 * What the agent adds on top of a plain call:
 *  - **Attribution.** The usage row carries the agent's route (`agent.chat`,
 *    `agent.subagent`, `agent.title`, ...), its key and session, and the user. The
 *    core writes ONE row per model call; the agent side writes none.
 *  - **Spend.** `onUsageSettled` is the one place a request's realized cost
 *    arrives (a Dynamic LLM child's own price included): the tenant's spend limit
 *    is debited there and the run's token tally (quota) grows there.
 *  - **Abort.** The agent loop's signal ends the upstream request; the core logs the
 *    call `cancelled`.
 *  - **Reasoning.** The agent's own pick is the in-process override (above the
 *    Model Hub default); an API request's value is the lowest rung. Reasoning
 *    blocks and their signatures stay inside the loop (the next request replays
 *    them); the Model Hub "return reasoning" switch removes only the TEXT.
 *  - **One input verdict per turn.** The model object lives for one run; its turn key
 *    makes the core evaluate the latest user message once, not at every step of the
 *    tool loop.
 *  - **Guardrail blocks** surface as `AgentGuardrailBlockedError`, which every agent
 *    endpoint already answers as a 400 `guardrail_block`.
 */

import crypto from 'crypto';
import type {
  BaseChatModel,
  BaseProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '@cognipeer/agent-sdk';
import type { IModel } from '@/lib/database';
import type { NativeReasoning } from '@/lib/providers/domains/model';
import { normalizeNativeReasoning } from '@/lib/providers/contracts/nativeClients';
import { executeModelCall } from '@/lib/services/models/gatewayCore';
import { GuardrailBlockError } from '@/lib/services/models/gatewayGuardrails';
import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { getDynamicRoutingConfig } from '@/lib/services/models/dynamicRouting';
import { nativeRequestToWire } from '@/lib/services/models/openaiAdapter';
import type { GatewayChatRequest, ModelCallInput, ModelCallOutcome } from '@/lib/services/models/gatewayTypes';
import type { UsageCostResult } from '@/lib/services/models/usageLogger';
import { isSyntheticActor } from './syntheticActor';
import { addRunUsage } from './runUsage';
import { outputLimitNotice } from './outputLimitNotice';

export { normalizeNativeReasoning };

/** The normalized reasoning value (`unset = send nothing`). */
export type NativeAgentReasoning = NativeReasoning;

type AnyRecord = Record<string, unknown>;

export function isDynamicModel(model: IModel | undefined): boolean {
  return Boolean(model && getDynamicRoutingConfig(model));
}

/** Marks a chat model that goes through the gateway (tests and callers can tell). */
export const GATEWAY_MODEL_MARK = '__gatewayModel';

export interface GatewayChatModelInput {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  model: IModel;
  /** Per-call settings in gateway names (`temperature`, `top_p`, `max_tokens`). */
  overrides?: Record<string, unknown>;
  /** What the AGENT selected for this model. Wins over everything else; unset falls through. */
  reasoning?: NativeAgentReasoning;
  /**
   * What the API request asked for. Lowest rung: agent selection > Model Hub
   * default > this > nothing sent (agentReasoning.ts has the full rule).
   */
  requestReasoning?: NativeAgentReasoning;
  /** false: the agent hides its reasoning, so the provider is not asked for thought text. */
  showReasoning?: boolean;
  /**
   * Called with each piece of thought text as the provider streams it, for a caller
   * that renders reasoning live. Only fires while reasoning is visible; never fails a request.
   */
  onReasoning?: (text: string) => void;
  /** The usage row's `route`: tells an agent call apart from a gateway call. */
  route?: string;
  agentKey?: string;
  /** The Session / API conversation this call belongs to. */
  sessionId?: string;
  userId?: string;
  /** What the call is for when it is not the agent answering (`title`, `model-check`). */
  purpose?: string;
  /**
   * Called once per model request with what it cost: the one place every request
   * of an agent passes through, so this is where the tenant's spend limit is
   * debited (agentSpendLimits.ts). Never allowed to fail a request.
   */
  onCost?: (cost: { currency: string; totalCost: number }) => void;
  /** A Dynamic LLM call reports the concrete model it was routed to. */
  onRouted?: (modelKey: string) => void;
  /** The run's `limits.maxTotalOutputTokens`: a raised-limit retry never plans past what is left of it. */
  maxTotalOutputTokens?: number;
}

/**
 * The limit to retry with after a model hit `limit` without answering: double,
 * capped by what the model record declares as its maximum output and by what is
 * left of the run's output-token budget. `undefined` when no larger limit is available.
 */
export function raisedOutputLimit(
  limit: number | undefined,
  model: IModel,
  budgetLeft?: number,
): number | undefined {
  if (!limit || limit <= 0) return undefined;
  const settings = (model.settings ?? {}) as AnyRecord;
  const declared = [settings.maxOutputTokens, settings.maxOutput]
    .find((value): value is number => typeof value === 'number' && value > 0);
  let next = limit * 2;
  if (declared) next = Math.min(next, declared);
  if (budgetLeft !== undefined) next = Math.min(next, budgetLeft);
  return next > limit ? Math.floor(next) : undefined;
}

/** The SDK provider family whose capabilities (structured output, strict tools) fit the model's driver. */
function providerFamily(model: IModel): 'openai' | 'azure' | 'anthropic' | 'bedrock' | 'vertex' | 'openai-compatible' {
  switch (model.providerDriver) {
    case 'openai':
    case 'azure':
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      return model.providerDriver;
    default:
      return 'openai-compatible';
  }
}

/** The OpenAI-shaped reasoning an API request carried (the lowest rung of the precedence). */
function reasoningWire(reasoning: NativeReasoning | ChatCompletionRequest['reasoning']): AnyRecord {
  if (!reasoning) return {};
  const out: AnyRecord = {};
  if (reasoning.effort) out.effort = reasoning.effort;
  if (reasoning.budgetTokens) out.budget_tokens = reasoning.budgetTokens;
  if (typeof reasoning.includeThoughts === 'boolean') out.include_thoughts = reasoning.includeThoughts;
  return Object.keys(out).length > 0 ? { reasoning: out } : {};
}

function withoutReasoningText<T extends { reasoning?: { summary?: string; blocks?: unknown } }>(value: T): T {
  const reasoning = value.reasoning;
  if (!reasoning || reasoning.summary === undefined) return value;
  const { summary: _summary, ...rest } = reasoning;
  void _summary;
  const next = { ...value } as T;
  if (Object.keys(rest).length > 0) next.reasoning = rest;
  else delete next.reasoning;
  return next;
}

/** The core's guardrail block, as the agent endpoints already know a block. */
async function asAgentBlock(error: unknown, hook?: 'output.stream.delta'): Promise<unknown> {
  if (!(error instanceof GuardrailBlockError)) return error;
  const { AgentGuardrailBlockedError } = await import('./agentService');
  return new AgentGuardrailBlockedError(error.message, {
    guardrailKey: error.guardrailKey,
    reason: error.message,
    ...(hook ? { hook } : {}),
  });
}

/** A provider (agent-sdk shape) whose HTTP call is the gateway core. */
function createGatewayProvider(input: GatewayChatModelInput): BaseProvider {
  const { model } = input;
  // One model object serves one run: its turn key lets the core judge the user's
  // message once however many steps the tool loop takes.
  const turnKey = crypto.randomUUID();
  const overrides = input.overrides ?? {};
  // A synthetic actor (the system, an agent, a public A2A caller) is no user row: nothing to attribute to.
  const actorId = input.userId && !isSyntheticActor(input.userId) ? input.userId : undefined;
  const agentPick = normalizeNativeReasoning(input.reasoning);
  const requestPick = normalizeNativeReasoning(input.requestReasoning);

  const settle = (cost: UsageCostResult, usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) => {
    // A call that produced no usage settles nothing; a cost with no usage attached
    // (a Dynamic LLM's decider) is settled as it is.
    if (usage) {
      spentOutputTokens += usage.outputTokens ?? 0;
      if (!usage.inputTokens && !usage.outputTokens) return;
      addRunUsage(usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
    }
    if (!input.onCost || !(cost.totalCost > 0 || usage)) return;
    try {
      input.onCost(cost);
    } catch {
      /* spend settlement never fails a model call */
    }
  };

  // Output tokens this run's calls have spent (for the budget check of a retry).
  let spentOutputTokens = 0;

  const callInput = (request: ChatCompletionRequest, stream: boolean, limitOverride?: number): ModelCallInput => {
    const native: GatewayChatRequest = {
      messages: request.messages,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
      ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { topP: request.topP } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.stop ? { stop: request.stop } : {}),
      ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
      ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.parallelToolCalls !== undefined ? { parallelToolCalls: request.parallelToolCalls } : {}),
    };
    // The agent's configured sampling first, the call's own on top. The reasoning an
    // API request carried sits on the wire (lowest rung); the agent's pick does not:
    // it rides beside it as the in-process override, which a caller can never claim.
    const wire: AnyRecord = {
      ...overrides,
      ...nativeRequestToWire(native, { streamUsage: true }),
      ...reasoningWire(requestPick ?? request.reasoning),
    };
    if (limitOverride !== undefined) {
      // The raised limit replaces whichever spelling the request carried.
      wire.max_tokens = limitOverride;
      if ('max_completion_tokens' in wire) wire.max_completion_tokens = limitOverride;
    }
    return {
      tenantDbName: input.tenantDbName,
      tenantId: input.tenantId,
      projectId: input.projectId,
      modelKey: model.key,
      request: native,
      wire,
      stream,
      context: {
        route: input.route ?? 'agent.chat',
        signal: request.signal,
        ...(actorId ? { attribution: { userId: actorId } } : {}),
        // Who is asking comes from the run's own routing scope; the agent adds its key.
        ...(input.agentKey ? { callerContext: { agentKey: input.agentKey } } : {}),
        ...(agentPick ? { reasoningOverride: agentPick } : {}),
        ...(input.showReasoning === false ? { showReasoning: false } : {}),
        requestTags: {
          ...(input.agentKey ? { agentKey: input.agentKey } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}),
        },
        logFailures: true,
        guardrailTurnKey: turnKey,
        onUsageSettled: settle,
      },
    };
  };

  const noteRoute = (outcome: ModelCallOutcome) => {
    const routed = outcome.routing?.chosenModelKey;
    if (routed) input.onRouted?.(routed);
  };

  const provider = {
    providerName: providerFamily(model),
    defaultModel: model.key,

    async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      try {
        return await completeOnce(request);
      } catch (error) {
        if (!(error instanceof OutputTokenLimitError)) throw error;
        const raised = nextLimit(error);
        if (raised !== undefined) {
          try {
            return await completeOnce(request, raised);
          } catch (retryError) {
            if (!(retryError instanceof OutputTokenLimitError)) throw retryError;
            return limitResponse(retryError.limit ?? raised);
          }
        }
        return limitResponse(error.limit);
      }
    },

    async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
      try {
        yield* streamOnce(request);
        return;
      } catch (error) {
        if (!(error instanceof OutputTokenLimitError)) throw error;
        const raised = nextLimit(error);
        let finalLimit = error.limit;
        if (raised !== undefined) {
          try {
            yield* streamOnce(request, raised);
            return;
          } catch (retryError) {
            if (!(retryError instanceof OutputTokenLimitError)) throw retryError;
            finalLimit = retryError.limit ?? raised;
          }
        }
        yield limitChunk(finalLimit);
      }
    },
  };

  const nextLimit = (error: OutputTokenLimitError): number | undefined => {
    const budgetLeft = input.maxTotalOutputTokens !== undefined
      ? Math.max(0, input.maxTotalOutputTokens - spentOutputTokens)
      : undefined;
    return raisedOutputLimit(error.limit, model, budgetLeft);
  };

  const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 };

  /** The graceful end of a turn whose model cannot fit an answer in its output limit. */
  const limitResponse = (limit?: number): ChatCompletionResponse => ({
    id: `limit_${crypto.randomUUID()}`,
    model: model.modelId,
    content: outputLimitNotice(limit),
    toolCalls: [],
    usage: emptyUsage,
    finishReason: 'stop',
    raw: null,
  });

  const limitChunk = (limit?: number): ChatCompletionChunk => ({
    id: `limit_${crypto.randomUUID()}`,
    model: model.modelId,
    delta: { content: outputLimitNotice(limit) },
    finishReason: 'stop',
  });

  const completeOnce = async (request: ChatCompletionRequest, limitOverride?: number): Promise<ChatCompletionResponse> => {
    {
      let outcome: ModelCallOutcome;
      try {
        outcome = await executeModelCall(callInput(request, false, limitOverride));
      } catch (error) {
        throw await asAgentBlock(error);
      }
      noteRoute(outcome);
      const response = outcome.result?.response;
      if (!response) throw new Error('The gateway returned no answer');
      const named = response.toolCalls?.some((call) => !call.id)
        ? { ...response, toolCalls: response.toolCalls.map((call, index) => (call.id ? call : { ...call, id: `call_${index}_${crypto.randomUUID()}` })) }
        : response;
      return outcome.includeReasoning === false ? withoutReasoningText(named) : named;
    }
  };

  async function* streamOnce(request: ChatCompletionRequest, limitOverride?: number): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    {
      let outcome: ModelCallOutcome;
      try {
        outcome = await executeModelCall(callInput(request, true, limitOverride));
      } catch (error) {
        throw await asAgentBlock(error);
      }
      noteRoute(outcome);
      const events = outcome.stream;
      if (!events) throw new Error('The gateway returned no stream');

      const showReasoning = outcome.includeReasoning !== false;
      const id = outcome.wireCompletion?.id ?? outcome.requestId;
      const modelName = model.modelId;
      // A tool-call fragment names its call by index; the SDK joins fragments by id.
      const idByIndex = new Map<number, { id: string; name?: string }>();
      let lastCall: { id: string; name?: string } | undefined;
      let limit: Error | undefined;

      let finished = false;
      try {
      for (;;) {
        const next = await events.next();
        if (next.done) break;
        const event = next.value;

        if (event.type === 'delta') {
          const toolCalls = event.toolCalls?.map((call) => {
            const known = (call.index !== undefined ? idByIndex.get(call.index) : undefined) ?? (call.id ? undefined : lastCall);
            // Some OpenAI-compatible upstreams send no tool-call id; the SDK joins
            // fragments by id, so mint one per index and reuse it for every fragment.
            const index = call.index ?? 0;
            let callId = call.id || known?.id;
            if (!callId) {
              callId = `call_${index}_${crypto.randomUUID()}`;
            }
            const callName = call.name ?? known?.name;
            lastCall = { id: callId, name: callName };
            idByIndex.set(index, lastCall);
            return { ...call, id: callId, ...(callName ? { name: callName } : {}) };
          });
          const blocks = event.reasoningPayload?.blocks;
          const summary = showReasoning ? event.reasoning : undefined;
          if (summary && input.onReasoning) {
            try { input.onReasoning(summary); } catch { /* a display callback must not fail the run */ }
          }
          yield {
            id,
            model: modelName,
            delta: {
              ...(event.content ? { content: event.content } : {}),
              ...(toolCalls?.length ? { toolCalls } : {}),
              ...(summary || blocks?.length
                ? { reasoning: { ...(blocks?.length ? { blocks } : {}), ...(summary ? { summary } : {}) } }
                : {}),
            },
            ...(event.providerFields ? { providerFields: event.providerFields } : {}),
          };
          continue;
        }

        if (event.type === 'done') {
          // The whole set of provider reasoning blocks, once: the SDK keeps the last
          // blocks it saw, and the signed set is what the next request replays.
          const blocks = event.response.reasoning?.blocks;
          yield {
            id,
            model: modelName,
            delta: blocks?.length ? { reasoning: { blocks } } : {},
            ...(event.response.providerFields ? { providerFields: event.response.providerFields } : {}),
            ...(event.nativeUsage ? { usage: event.nativeUsage } : {}),
            finishReason: event.response.finishReason,
            ...(event.response.rawFinishReason ? { rawFinishReason: event.response.rawFinishReason } : {}),
          };
          continue;
        }

        if (event.type === 'blocked') {
          // The core aborts the upstream only after this consumer lets it go on.
          const blocked = new GuardrailBlockError(event.message, event.guardrailKey ?? '', 'block');
          await events.next().catch(() => undefined);
          throw await asAgentBlock(blocked, 'output.stream.delta');
        }

        if (event.type === 'failed') {
          const failure = Object.assign(new Error(event.error.message), {
            status: event.status,
            type: event.error.type,
            code: event.error.code ?? undefined,
            param: event.error.param ?? undefined,
          });
          throw failure;
        }

        if (event.type === 'output_limit') {
          limit = Object.assign(new OutputTokenLimitError(), { message: event.error.message });
          continue;
        }

        if (event.type === 'cancelled') return;
        // 'start', 'finish' and 'usage' say nothing the chunks above do not.
      }

      finished = true;
      if (limit) throw limit;
      } finally {
        // Stopped reading early (a consumer error or break): close the core so it
        // aborts the upstream and books the partial usage.
        if (!finished) await events.return?.(undefined).catch(() => undefined);
      }
    }
  }

  return provider as unknown as BaseProvider;
}

/** The agent-sdk chat model of an agent run: every call is a gateway call. */
export async function buildGatewayChatModel(input: GatewayChatModelInput): Promise<BaseChatModel> {
  const { fromNativeProvider } = await import('@cognipeer/agent-sdk');
  const chatModel = fromNativeProvider(createGatewayProvider(input), { model: input.model.key });
  return markGateway(chatModel);
}

function markGateway(model: BaseChatModel): BaseChatModel {
  const marked = model as BaseChatModel & Record<string, unknown>;
  marked[GATEWAY_MODEL_MARK] = true;
  const bindTools = model.bindTools?.bind(model);
  if (bindTools) marked.bindTools = (tools, options) => markGateway(bindTools(tools, options));
  return marked;
}
