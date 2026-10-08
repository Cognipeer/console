/**
 * Pure request builders and response normalizers for the NATIVE decision
 * backends: OpenAI `POST /v1/decisions` and Alibaba Model Studio
 * `POST /compatible-mode/v1/systemone` ("System One").
 *
 * Wire formats are taken from the vendors' published docs (OpenAI Decisions
 * reference/guide, Alibaba Model Studio "Decision Model API"), not from live
 * calls. The rule for answers is the console contract's: copy what the vendor
 * sent, omit what it did not, never derive a confidence the vendor did not
 * report. `confidence_source` is therefore `'native'` exactly when the vendor
 * sent a `confidence`.
 */
import type {
  DecisionAnswer,
  DecisionInputPart,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from '../domains/decision';
import { DecisionRequestError } from './decisionHelpers';
import { DecisionBackendError } from './structuredDecisionRuntime';

export const OPENAI_DECISION_LIMITS = {
  maxImages: 128,
  minChoices: 2,
  maxChoices: 255,
} as const;

/** Model Studio's published region codes, keyed by the console's region setting. */
export const ALIBABA_REGIONS = {
  singapore: 'ap-southeast-1',
  beijing: 'cn-beijing',
} as const;
export type AlibabaRegion = keyof typeof ALIBABA_REGIONS;

export type NativeDecisionOutput = Pick<DecisionResult, 'answers' | 'usage' | 'upstream'>;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function malformed(vendor: string, detail: string): DecisionBackendError {
  return new DecisionBackendError(`${vendor} returned an unexpected decision response: ${detail}`);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textOf(input: readonly DecisionInputPart[]): string {
  return input
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

/** Confidence exactly as the vendor sent it, with its provenance; nothing when absent. */
function nativeConfidence(value: unknown): { confidence?: number; confidence_source?: 'native' } {
  const confidence = num(value);
  return confidence === undefined ? {} : { confidence, confidence_source: 'native' };
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

function assertDataUrlImage(url: string, index: number): void {
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) {
    throw new DecisionRequestError(
      `input[${index}]: the OpenAI Decisions API accepts base64 image data URLs only (no http(s) URLs or file ids)`,
      { param: `input[${index}]` },
    );
  }
}

function openAiQuestion(id: string, question: DecisionQuestion): Json {
  const instructions = question.instructions ?? id;
  switch (question.type) {
    case 'boolean':
      return { type: 'predicate', name: id, instructions };
    case 'choice': {
      const keys = Object.keys(question.choices);
      if (keys.length < OPENAI_DECISION_LIMITS.minChoices || keys.length > OPENAI_DECISION_LIMITS.maxChoices) {
        throw new DecisionRequestError(
          `Question "${id}": the OpenAI Decisions API needs ${OPENAI_DECISION_LIMITS.minChoices}..${OPENAI_DECISION_LIMITS.maxChoices} choices (got ${keys.length})`,
          { param: `questions.${id}.choices`, questionId: id },
        );
      }
      return {
        type: 'choice',
        name: id,
        instructions,
        choices: keys.map((key) => ({
          value: key,
          ...(question.choices[key] ? { description: question.choices[key] } : {}),
        })),
      };
    }
    case 'score':
      return {
        type: 'score',
        name: id,
        instructions,
        levels: question.levels.map((label) => ({ label })),
      };
  }
}

export function buildOpenAiDecisionBody(modelId: string, request: DecisionRequest): Json {
  const images = request.input.filter((part) => part.type === 'image');
  if (images.length > OPENAI_DECISION_LIMITS.maxImages) {
    throw new DecisionRequestError(
      `The OpenAI Decisions API accepts at most ${OPENAI_DECISION_LIMITS.maxImages} images per request`,
      { param: 'input' },
    );
  }
  request.input.forEach((part, index) => {
    if (part.type === 'image') assertDataUrlImage(part.data_url, index);
  });

  const input = images.length === 0
    ? textOf(request.input)
    : [{
        role: 'user',
        content: request.input.map((part) =>
          part.type === 'text'
            ? { type: 'input_text', text: part.text }
            : { type: 'input_image', image_url: part.data_url }),
      }];

  return {
    model: modelId,
    input,
    questions: Object.entries(request.questions).map(([id, question]) => openAiQuestion(id, question)),
  };
}

function normalizeOpenAiAnswer(id: string, question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isObject(raw)) throw malformed('OpenAI', `answer "${id}" is not an object`);
  if (raw.type === 'refusal') return { type: 'refusal' };

  const expected = question.type === 'boolean' ? 'predicate' : question.type;
  if (raw.type !== expected) {
    throw malformed('OpenAI', `answer "${id}" has type ${String(raw.type)}, expected ${expected}`);
  }

  if (question.type === 'boolean') {
    const probability = num(raw.probability);
    if (probability === undefined) throw malformed('OpenAI', `predicate "${id}" has no probability`);
    return { type: 'boolean', probability };
  }

  if (question.type === 'choice') {
    const choice = raw.choice;
    if (typeof choice !== 'string' || !(choice in question.choices)) {
      throw malformed('OpenAI', `choice "${id}" answered a value that was not offered`);
    }
    const probabilities: Record<string, number> = {};
    for (const entry of Array.isArray(raw.probabilities) ? raw.probabilities : []) {
      if (isObject(entry) && typeof entry.value === 'string' && num(entry.probability) !== undefined) {
        probabilities[entry.value] = entry.probability as number;
      }
    }
    return { type: 'choice', choice, probabilities, ...nativeConfidence(raw.confidence) };
  }

  const score = num(raw.score);
  if (score === undefined) throw malformed('OpenAI', `score "${id}" has no score`);
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  for (const entry of Array.isArray(raw.probabilities) ? raw.probabilities : []) {
    if (!isObject(entry)) continue;
    const key = num(entry.value) !== undefined ? String(entry.value) : undefined;
    if (key === undefined) continue;
    if (num(entry.probability) !== undefined) probabilities[key] = entry.probability as number;
    if (typeof entry.label === 'string') legend[key] = entry.label;
  }
  return {
    type: 'score',
    score,
    probabilities,
    ...(Object.keys(legend).length > 0 ? { legend } : {}),
    ...nativeConfidence(raw.confidence),
  };
}

export function normalizeOpenAiDecisionResponse(raw: unknown, request: DecisionRequest): NativeDecisionOutput {
  if (!isObject(raw) || !Array.isArray(raw.answers)) {
    throw malformed('OpenAI', 'no `answers` array');
  }
  const rawAnswers: unknown[] = raw.answers;
  const ids = Object.keys(request.questions);
  if (rawAnswers.length !== ids.length) {
    throw malformed('OpenAI', `expected ${ids.length} answers, got ${rawAnswers.length}`);
  }
  // Answers come back in question order; `name` (echoed from the request) wins
  // when present so a reordering upstream cannot swap two answers.
  const byName = new Map<string, unknown>();
  rawAnswers.forEach((answer) => {
    if (isObject(answer) && typeof answer.name === 'string') byName.set(answer.name, answer);
  });
  const answers: Record<string, DecisionAnswer> = {};
  ids.forEach((id, index) => {
    answers[id] = normalizeOpenAiAnswer(id, request.questions[id], byName.get(id) ?? rawAnswers[index]);
  });

  const usage = isObject(raw.usage) ? num(raw.usage.input_tokens) : undefined;
  return {
    answers,
    // Input tokens only: the Decisions API bills no output tokens.
    ...(usage !== undefined ? { usage: { inputTokens: usage, outputTokens: 0 } } : {}),
  };
}

// ── Alibaba Model Studio (System One) ───────────────────────────────────────

export function isAlibabaRegion(value: unknown): value is AlibabaRegion {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALIBABA_REGIONS, value);
}

/** workspace ids are DNS labels; anything else must never reach a hostname. */
export function isValidWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);
}

export function buildSystemOneUrl(workspaceId: string, region: string): string {
  if (!isValidWorkspaceId(workspaceId)) {
    throw new Error('Alibaba Model Studio workspace id must be a DNS label (letters, digits, hyphens)');
  }
  if (!isAlibabaRegion(region)) {
    throw new Error('Alibaba Model Studio region must be "beijing" or "singapore"');
  }
  return `https://${workspaceId.toLowerCase()}.${ALIBABA_REGIONS[region]}.maas.aliyuncs.com/compatible-mode/v1/systemone`;
}

function systemOneQuestion(question: DecisionQuestion): Json {
  const base = question.instructions ? { instructions: question.instructions } : {};
  switch (question.type) {
    case 'boolean':
      return { type: 'noul', ...base };
    case 'choice':
      return { type: 'choice', ...base, criteria: { ...question.choices } };
    case 'score':
      return { type: 'score', ...base, criteria: [...question.levels] };
  }
}

export function buildSystemOneBody(modelId: string, request: DecisionRequest): Json {
  const imageIndex = request.input.findIndex((part) => part.type === 'image');
  if (imageIndex >= 0) {
    throw new DecisionRequestError(
      'The Alibaba decision model accepts text input only; image parts are not supported',
      { param: `input[${imageIndex}]` },
    );
  }
  return {
    model: modelId,
    state: textOf(request.input),
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, systemOneQuestion(question)]),
    ),
  };
}

function numberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const n = num(value);
      if (n !== undefined) out[key] = n;
    }
  }
  return out;
}

function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') out[key] = value;
    }
  }
  return out;
}

function normalizeSystemOneAnswer(id: string, question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isObject(raw)) throw malformed('Alibaba', `answer "${id}" is not an object`);
  if (raw.type === 'refusal') return { type: 'refusal' };

  const expected = question.type === 'boolean' ? 'noul' : question.type;
  if (raw.type !== expected) {
    throw malformed('Alibaba', `answer "${id}" has type ${String(raw.type)}, expected ${expected}`);
  }

  if (question.type === 'boolean') {
    const probability = num(raw.noul);
    if (probability === undefined) throw malformed('Alibaba', `noul "${id}" has no probability`);
    return { type: 'boolean', probability };
  }

  if (question.type === 'choice') {
    const choice = raw.choice;
    if (typeof choice !== 'string' || !(choice in question.choices)) {
      throw malformed('Alibaba', `choice "${id}" answered a value that was not offered`);
    }
    return {
      type: 'choice',
      choice,
      probabilities: numberMap(raw.probabilities),
      ...nativeConfidence(raw.confidence),
    };
  }

  const score = num(raw.score);
  if (score === undefined) throw malformed('Alibaba', `score "${id}" has no score`);
  const legend = stringMap(raw.legend);
  return {
    type: 'score',
    score,
    probabilities: numberMap(raw.probabilities),
    ...(Object.keys(legend).length > 0 ? { legend } : {}),
    ...nativeConfidence(raw.confidence),
  };
}

export function normalizeSystemOneResponse(raw: unknown, request: DecisionRequest): NativeDecisionOutput {
  if (!isObject(raw) || !isObject(raw.answers)) {
    throw malformed('Alibaba', 'no `answers` object');
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (!(id in raw.answers)) throw malformed('Alibaba', `no answer for question "${id}"`);
    answers[id] = normalizeSystemOneAnswer(id, question, raw.answers[id]);
  }

  const inputTokens = isObject(raw.usage) ? num(raw.usage.input_tokens) : undefined;
  const upstream = {
    ...(typeof raw.request_id === 'string' ? { request_id: raw.request_id } : {}),
    ...(num(raw.latency_ms) !== undefined ? { latency_ms: num(raw.latency_ms) } : {}),
  };
  return {
    answers,
    ...(inputTokens !== undefined ? { usage: { inputTokens, outputTokens: 0 } } : {}),
    ...(Object.keys(upstream).length > 0 ? { upstream } : {}),
  };
}
