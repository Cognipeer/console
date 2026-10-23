/**
 * Decision-model routing for Analysis — Yes/No, Choice and Score fields are
 * answered by a Model Hub `decision` model (one call per conversation, with a
 * probability per option) instead of being extracted. This module is pure:
 * the model call is the injected `DecisionInvoker`, and the Model Hub types
 * are imported type-only.
 */

import type { DecisionAnswer, DecisionQuestion } from '@/lib/providers/domains/decision';
import type {
  AnalysisConversation,
  AnalysisDecision,
  AnalysisSpec,
  DecisionInvoker,
  FieldDef,
  ReviewReason,
} from './types';

/** Under the decision service's 200,000-character input cap, with headroom for the question prompt. */
export const MAX_DECISION_INPUT_CHARS = 190_000;

/** Default confidence below which a decision answer is flagged for review. */
export const DEFAULT_REVIEW_THRESHOLD = 0.7;

/** Share of the budget kept from the start of an over-long transcript; the rest comes from the end. */
const HEAD_SHARE = 0.3;

/** Whether a field is answered by the decision model (same rule for the engine, estimate and UI). */
export function isDecisionField(field: Pick<FieldDef, 'type'>, spec: Pick<AnalysisSpec, 'useDecisionModel'>): boolean {
  return !!spec.useDecisionModel && (field.type === 'enum' || field.type === 'boolean' || field.type === 'score');
}

/**
 * Render a conversation as the decision model's input. A transcript over the
 * cap keeps its first 30% and last 70% (the outcome of a conversation is
 * usually at the end) with an omission marker in between.
 */
export function renderDecisionInput(conversation: AnalysisConversation, instructions?: string): string {
  const prefix = instructions?.trim() ? `Context: ${instructions.trim()}\n\nTranscript:\n` : 'Transcript:\n';
  const body = conversation.transcript.map((m) => `[${m.role}] ${m.content}`).join('\n');
  if (prefix.length + body.length <= MAX_DECISION_INPUT_CHARS) return prefix + body;

  // The marker's own length depends on the omitted count; size it from the upper bound.
  const markerBudget = `\n[… ${body.length} characters omitted …]\n`.length;
  const keep = Math.max(0, MAX_DECISION_INPUT_CHARS - prefix.length - markerBudget);
  const head = Math.floor(keep * HEAD_SHARE);
  const tail = keep - head;
  const omitted = body.length - keep;
  return `${prefix}${body.slice(0, head)}\n[… ${omitted} characters omitted …]\n${tail > 0 ? body.slice(body.length - tail) : ''}`;
}

/** Turn decision-routed fields into the decision service's questions, keyed by field key. */
export function buildDecisionQuestions(fields: FieldDef[]): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const field of fields) {
    const description = field.description?.trim();
    if (field.type === 'enum') {
      questions[field.key] = {
        type: 'choice',
        instructions: description || `Which option best describes "${field.key}" in this conversation?`,
        choices: Object.fromEntries((field.enumValues ?? []).map((v) => [v, v])),
      };
    } else if (field.type === 'boolean') {
      questions[field.key] = {
        type: 'boolean',
        instructions: description || `Yes or no: ${field.key.replace(/[_-]+/g, ' ')}?`,
      };
    } else if (field.type === 'score') {
      questions[field.key] = {
        type: 'score',
        instructions: description || `Rate "${field.key}" for this conversation.`,
        levels: field.levels ?? [],
      };
    }
  }
  return questions;
}

const REFUSED: AnalysisDecision = { confidence: 0, refused: true };

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function maxOf(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

/**
 * Map one decision-service answer to an Analysis decision plus the plain
 * value stored in the item's fields. A refusal, an answer of the wrong shape
 * or a missing answer is a refused decision with no value.
 */
export function mapDecisionAnswer(
  field: FieldDef,
  answer: DecisionAnswer | undefined,
  backendKind: 'native' | 'structured',
): { decision: AnalysisDecision; value?: unknown } {
  if (!answer) return { decision: { ...REFUSED } };
  const fallbackSource = backendKind === 'structured' ? 'self_reported' : 'native';

  if (field.type === 'enum' && answer.type === 'choice' && typeof answer.choice === 'string') {
    const probabilities = answer.probabilities ?? {};
    const confidence = isNum(answer.confidence) ? answer.confidence : maxOf(Object.values(probabilities).filter(isNum));
    return {
      decision: {
        answer: answer.choice,
        probabilities,
        confidence,
        confidenceSource: answer.confidence_source ?? fallbackSource,
      },
      value: answer.choice,
    };
  }

  if (field.type === 'boolean' && answer.type === 'boolean' && isNum(answer.probability)) {
    const p = clamp01(answer.probability);
    const yes = p >= 0.5;
    return {
      decision: {
        answer: yes,
        probabilities: { yes: p, no: 1 - p },
        confidence: Math.max(p, 1 - p),
        confidenceSource: fallbackSource,
      },
      value: yes,
    };
  }

  if (field.type === 'score' && answer.type === 'score' && isNum(answer.score)) {
    const levels = field.levels ?? [];
    if (levels.length === 0) return { decision: { ...REFUSED } };
    // The answer is the most likely level, so the confidence shown (and calibrated) is the
    // probability of that very answer. `score`, the expected level, is kept for averages.
    // Ties go to the lower level; without a distribution the rounded score stands in.
    const byIndex = levels.map((_, index) => answer.probabilities?.[String(index)]);
    const hasDistribution = byIndex.some(isNum);
    let level = Math.min(levels.length - 1, Math.max(0, Math.round(answer.score)));
    if (hasDistribution) {
      level = byIndex.reduce<number>((best, p, index) => (isNum(p) && p > (byIndex[best] ?? -1) ? index : best), 0);
    }
    // The service keys probabilities by level index; re-key them by label so they read on their own.
    const probabilities: Record<string, number> = {};
    for (const [index, p] of Object.entries(answer.probabilities ?? {})) {
      probabilities[levels[Number(index)] ?? index] = p;
    }
    const levelP = byIndex[level];
    const confidence = hasDistribution && isNum(levelP)
      ? levelP
      : isNum(answer.confidence) ? answer.confidence : 0;
    return {
      decision: {
        answer: levels[level],
        score: answer.score,
        probabilities,
        confidence,
        confidenceSource: answer.confidence_source ?? fallbackSource,
      },
      value: levels[level],
    };
  }

  return { decision: { ...REFUSED } };
}

export interface DecisionFieldsResult {
  decisions: Record<string, AnalysisDecision>;
  /** Plain values by field key (absent for refused answers). */
  fields: Record<string, unknown>;
  /** Required decision fields without a value. */
  missing: string[];
  rationale?: string;
  error?: string;
}

/** Ask the decision model every decision field of a conversation in one call. Never throws. */
export async function decideFields(
  conversation: AnalysisConversation,
  fields: FieldDef[],
  spec: Pick<AnalysisSpec, 'extractionInstructions'>,
  invoke: DecisionInvoker,
): Promise<DecisionFieldsResult> {
  try {
    const response = await invoke({
      input: renderDecisionInput(conversation, spec.extractionInstructions),
      questions: buildDecisionQuestions(fields),
      includeRationale: true,
    });
    const decisions: Record<string, AnalysisDecision> = {};
    const values: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const field of fields) {
      const { decision, value } = mapDecisionAnswer(field, response.answers?.[field.key], response.backendKind);
      decisions[field.key] = decision;
      if (value !== undefined) values[field.key] = value;
      else if (field.required) missing.push(field.key);
    }
    const rationale = response.rationale?.trim();
    return { decisions, fields: values, missing, ...(rationale ? { rationale } : {}) };
  } catch (err) {
    return {
      decisions: {},
      fields: {},
      missing: fields.filter((f) => f.required).map((f) => f.key),
      error: (err as Error).message,
    };
  }
}

/** FNV-1a, 32 bit, over the UTF-8 bytes: a cheap stable hash, the base of the spot-check pick. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** FNV-1a clusters for ids that differ only in their last characters; a murmur3 finalizer evens the pick out. */
function spotCheckUnit(text: string): number {
  let h = fnv1a32(text);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}

export interface ReviewFlags {
  /** The decisions, with `needsReview` set on the ones below their threshold. */
  decisions: Record<string, AnalysisDecision>;
  needsReview: boolean;
  reviewReason?: ReviewReason;
  /** Lowest decision confidence (0 = a refusal); 1 when there are no decisions. */
  minConfidence: number;
}

/**
 * Flag decisions for human review: a refusal or a confidence below the
 * field's threshold is flagged ('low_confidence'); otherwise a deterministic
 * share of conversations (spotCheckPct) is picked ('spot_check') so
 * calibration also sees confident answers.
 */
export function applyReviewFlags(
  decisions: Record<string, AnalysisDecision>,
  fields: FieldDef[],
  spec: Pick<AnalysisSpec, 'review' | 'spotCheckSalt'>,
  conversationId: string,
): ReviewFlags {
  const keys = Object.keys(decisions);
  if (keys.length === 0) return { decisions, needsReview: false, minConfidence: 1 };

  const byKey = new Map(fields.map((f) => [f.key, f]));
  const flagged: Record<string, AnalysisDecision> = {};
  let low = false;
  let minConfidence = 1;
  for (const key of keys) {
    const decision = decisions[key];
    const threshold = byKey.get(key)?.reviewBelow ?? spec.review?.threshold ?? DEFAULT_REVIEW_THRESHOLD;
    const flag = !!decision.refused || decision.confidence < threshold;
    flagged[key] = flag ? { ...decision, needsReview: true } : decision;
    if (flag) low = true;
    minConfidence = Math.min(minConfidence, decision.refused ? 0 : decision.confidence);
  }
  if (low) return { decisions: flagged, needsReview: true, reviewReason: 'low_confidence', minConfidence };

  const pct = spec.review?.spotCheckPct ?? 0;
  if (pct > 0 && spotCheckUnit(`${spec.spotCheckSalt ?? ''}:${conversationId}`) < pct / 100) {
    return { decisions: flagged, needsReview: true, reviewReason: 'spot_check', minConfidence };
  }
  return { decisions: flagged, needsReview: false, minConfidence };
}
