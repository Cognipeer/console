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
import { resolveDecisionMode } from '@/lib/providers/contracts/nativeDecisionRuntime';
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
}

/** Parallel guardrail evaluations per request. */
export const GUARDRAIL_CONCURRENCY = 4;

export interface TextSegment {
  text: string;
  apply: (next: string) => void;
}

/**
 * Every piece of caller-supplied free text the model will read, in a FIXED
 * order: input text parts, then per question (declaration order) its
 * instructions, each choice description, and each score level label. Returns a
 * copy of the request plus setters into that copy, so redactions land in the
 * copy and the caller's object is never mutated.
 *
 * Choice keys and question ids are identifiers (schema property names and the
 * answer's keys), not prose, and are not scanned.
 */
export function collectSegments(request: ParsedDecisionRequest): {
  copy: ParsedDecisionRequest;
  segments: TextSegment[];
} {
  const segments: TextSegment[] = [];
  const input: DecisionInputPart[] = request.input.map((part) => ({ ...part }));
  for (const part of input) {
    if (part.type === 'text') {
      segments.push({ text: part.text, apply: (next) => { part.text = next; } });
    }
  }
  const questions: Record<string, DecisionQuestion> = {};
  for (const [id, original] of Object.entries(request.questions)) {
    const question = (
      original.type === 'choice'
        ? { ...original, choices: { ...original.choices } }
        : original.type === 'score'
          ? { ...original, levels: [...original.levels] }
          : { ...original }
    ) as DecisionQuestion;
    questions[id] = question;
    if (question.instructions) {
      segments.push({ text: question.instructions, apply: (next) => { question.instructions = next; } });
    }
    if (question.type === 'choice') {
      for (const key of Object.keys(question.choices)) {
        segments.push({ text: question.choices[key], apply: (next) => { question.choices[key] = next; } });
      }
    } else if (question.type === 'score') {
      question.levels.forEach((level, index) => {
        segments.push({ text: level, apply: (next) => { question.levels[index] = next; } });
      });
    }
  }
  return { copy: { ...request, input, questions }, segments };
}

/**
 * Runs `transform` over the non-blank segments with bounded concurrency and
 * applies the results in place.
 *
 * Why per segment and not one joined call: a guardrail may rewrite the text
 * (redact / mask / tokenize) and no delimiter is guaranteed to survive a
 * rewrite, so a joined call cannot be split back safely; it would also let one
 * segment's content change how another is judged. Per segment keeps each
 * redaction exactly attributable. Round-trips are cut by skipping blank
 * segments and running up to GUARDRAIL_CONCURRENCY at once.
 *
 * Once any segment fails (a block) no new segment starts, and the failure of the
 * EARLIEST segment in the fixed order is thrown, so the message the caller reads
 * does not depend on which evaluation finished first.
 */
export async function mapSegmentsBounded(
  segments: TextSegment[],
  transform: (text: string) => Promise<string>,
  concurrency = GUARDRAIL_CONCURRENCY,
): Promise<void> {
  const work = segments.filter((segment) => segment.text.trim().length > 0);
  const errors = new Map<number, unknown>();
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= work.length) return;
      try {
        work[index].apply(await transform(work[index].text));
      } catch (error) {
        failed = true;
        errors.set(index, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));

  if (errors.size > 0) {
    throw errors.get(Math.min(...errors.keys()));
  }
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
    const { copy, segments } = collectSegments(request);
    await mapSegmentsBounded(segments, async (text) => {
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
    request = copy;
  }

  const { runtime } = await buildModelRuntime(tenantDbName, model.tenantId, model.providerKey, projectId);
  if (!runtime.createDecisionRuntime) {
    throw new InvalidRequestError(
      `${resolveDecisionMode(model.settings) === 'native' ? 'Native' : 'Structured'} decision not yet supported for provider ${model.providerDriver}`,
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
      providerResponse: { answers: result.answers, backend: result.backend, ...(result.upstream ? { upstream: result.upstream } : {}) },
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
