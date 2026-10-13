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

  const callInput = (request: ChatCompletionRequest, stream: boolean): ModelCallInput => {
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
        requestTags: {
          ...(input.agentKey ? { agentKey: input.agentKey } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}),
        },
        logPrompt: false,
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
      let outcome: ModelCallOutcome;
      try {
        outcome = await executeModelCall(callInput(request, false));
      } catch (error) {
        throw await asAgentBlock(error);
      }
      noteRoute(outcome);
      const response = outcome.result?.response;
      if (!response) throw new Error('The gateway returned no answer');
      return outcome.includeReasoning === false ? withoutReasoningText(response) : response;
    },

    async *completeStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
      let outcome: ModelCallOutcome;
      try {
        outcome = await executeModelCall(callInput(request, true));
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

      for (;;) {
        const next = await events.next();
        if (next.done) break;
        const event = next.value;

        if (event.type === 'delta') {
          const toolCalls = event.toolCalls?.map((call) => {
            const known = (call.index !== undefined ? idByIndex.get(call.index) : undefined) ?? (call.id ? undefined : lastCall);
            const callId = call.id ?? known?.id;
            const callName = call.name ?? known?.name;
            if (callId) {
              lastCall = { id: callId, name: callName };
              if (call.index !== undefined) idByIndex.set(call.index, lastCall);
            }
            return { ...call, ...(callId ? { id: callId } : {}), ...(callName ? { name: callName } : {}) };
          });
          const blocks = event.reasoningPayload?.blocks;
          const summary = showReasoning ? event.reasoning : undefined;
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

      if (limit) throw limit;
    },
  };

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
