/**
 * Decision service — `POST /api/client/v1/decisions`.
 *
 * Resolves a `decision`-category Model Hub entry, runs the project's input
 * guardrails over EVERYTHING the caller sent in free text (the input and every
 * question's `instructions`) BEFORE the backend sees any of it, then asks the
 * provider's decision runtime. P1 only has the structured-output emulator
 * (`backend.kind: 'structured'`); native vendor adapters plug in behind the same
 * `createDecisionRuntime` seam in a later phase.
 *
 * Pricing is the underlying chat model's: input and output tokens on the model's
 * own `pricing`, recorded through the same usage logger as every other call.
 */
import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { fireAndForget } from '@/lib/core/asyncTask';
import type { IModel } from '@/lib/database';
import type {
  DecisionInputPart,
  DecisionQuestion,
  DecisionResult,
} from '@/lib/providers';
import {
  DecisionRequestError,
  decisionInputHasImage,
  type ParsedDecisionRequest,
} from '@/lib/providers/contracts/decisionHelpers';
import { InvalidRequestError } from '@/lib/providers/contracts/upstreamError';
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';
import { getModelByKey } from './modelService';
import { buildModelRuntime } from './runtimeService';
import { enforceModelGuardrailChain } from './inferenceService';
import { calculateCost, logModelUsage, type UsageCostResult } from './usageLogger';

const logger = createLogger('decision');

export interface DecisionOutcome {
  result: DecisionResult;
  model: IModel;
  cost: UsageCostResult;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  requestId: string;
}

function decisionSettings(model: IModel): Record<string, unknown> {
  const raw = model.settings?.decision;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Whether the model has declared it can read images. Explicit and per model: the
 * structured emulator rides on whatever chat model the operator picked, and only
 * the operator knows whether it is vision-capable. `isMultimodal` is accepted as
 * the same declaration so a model marked multimodal elsewhere does not need to
 * be declared twice; an explicit `supports.image: false` always wins.
 */
export function modelSupportsDecisionImage(model: IModel): boolean {
  const supports = decisionSettings(model).supports;
  const explicit = supports && typeof supports === 'object'
    ? (supports as Record<string, unknown>).image
    : undefined;
  if (typeof explicit === 'boolean') return explicit;
  return model.isMultimodal === true;
}

function ensureDecisionModel(model: IModel) {
  if (model.category !== 'decision') {
    throw new InvalidRequestError('Model is not configured for decisions');
  }
  const mode = decisionSettings(model).mode ?? 'structured';
  if (mode !== 'structured') {
    throw new InvalidRequestError(
      `Decision mode "${String(mode)}" is not available yet; only "structured" is supported`,
    );
  }
}

/**
 * Runs `transform` over every piece of caller-supplied free text, in a fixed
 * order (input parts, then each question's instructions), and returns a copy of
 * the request with the transformed text. Redactions land in the copy, so the
 * backend only ever sees the post-guardrail text.
 */
async function mapRequestText(
  request: ParsedDecisionRequest,
  transform: (text: string) => Promise<string>,
): Promise<ParsedDecisionRequest> {
  const input: DecisionInputPart[] = [];
  for (const part of request.input) {
    input.push(part.type === 'text' ? { type: 'text', text: await transform(part.text) } : part);
  }
  const questions: Record<string, DecisionQuestion> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    questions[id] = question.instructions
      ? { ...question, instructions: await transform(question.instructions) }
      : question;
  }
  return { ...request, input, questions };
}

function loggableRequest(request: ParsedDecisionRequest) {
  return {
    model: request.model,
    // Image bytes do not belong in a trace row; their presence and size do.
    input: request.input.map((part) =>
      part.type === 'text' ? part : { type: 'image', chars: part.data_url.length },
    ),
    questions: request.questions,
    include_rationale: request.includeRationale,
  };
}

export async function handleDecisionRequest(params: {
  tenantDbName: string;
  projectId: string;
  request: ParsedDecisionRequest;
  requestId?: string;
  signal?: AbortSignal;
}): Promise<DecisionOutcome> {
  const { tenantDbName, projectId } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();
  const modelKey = params.request.model;

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new InvalidRequestError(`Model with key ${modelKey} not found`);
  }
  ensureDecisionModel(model);

  if (decisionInputHasImage(params.request.input) && !modelSupportsDecisionImage(model)) {
    throw new DecisionRequestError(
      `Model "${modelKey}" does not declare image support (decision.supports.image)`,
      { param: 'input' },
    );
  }

  // Input guardrails (PII redaction, secrets, prompt shield, …) over every piece
  // of caller text, BEFORE the backend call. A block throws GuardrailBlockError
  // and nothing below runs. Mirrors chat's `input.pre` hook binding.
  let request = params.request;
  const guardrailKeys = resolveBindings(model, 'input.pre');
  if (guardrailKeys.length > 0) {
    request = await mapRequestText(request, async (text) => {
      const outcome = await enforceModelGuardrailChain({
        tenantDbName,
        tenantId: model.tenantId,
        projectId,
        guardrailKeys,
        text,
        phase: 'input',
        requestId,
        source: 'decisions',
      });
      return outcome.redactedText ?? text;
    });
  }

  const { runtime } = await buildModelRuntime(tenantDbName, model.tenantId, model.providerKey, projectId);
  if (!runtime.createDecisionRuntime) {
    throw new InvalidRequestError(
      `Structured decision not yet supported for provider ${model.providerDriver}`,
    );
  }
  const decisionRuntime = await runtime.createDecisionRuntime({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
  });

  const result = await withResilience(
    (signal) => decisionRuntime.decide(request, { signal: params.signal ?? signal }),
    { key: `decision:${model.providerKey}:${model.modelId}` },
  );

  const latencyMs = Date.now() - start;
  const usage = {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
  const cost = calculateCost(model.pricing, usage);

  fireAndForget('log-decision-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'decisions',
      status: 'success',
      providerRequest: loggableRequest(request),
      providerResponse: { answers: result.answers, backend: result.backend },
      latencyMs,
      usage: {
        ...usage,
        totalTokens: usage.inputTokens + usage.outputTokens,
      },
    }),
  );

  logger.debug('Decision served', { requestId, modelKey, backend: result.backend });
  return { result, model, cost, usage, latencyMs, requestId };
}
