/**
 * Analysis runner — orchestrates extraction and/or decision-model answers +
 * (optional) judge + (optional) accuracy across a batch of conversations with
 * bounded concurrency, then aggregates pass-rate / avg judge score / avg
 * extraction accuracy / decision answers. Pure with respect to the platform:
 * the models are injected.
 */

import type {
  AnalysisAggregate,
  AnalysisConversation,
  AnalysisDecision,
  AnalysisItemResult,
  AnalysisResult,
  AnalysisRunConfig,
  AnalysisSpec,
  DecisionAggregate,
  DecisionInvoker,
  ExtractionResult,
  FieldSet,
  ModelInvoker,
} from './types';
import { extractFields } from './extraction';
import { applyReviewFlags, decideFields, isDecisionField, type DecisionFieldsResult } from './decision';
import { judgeConversation } from './judge';
import { scoreAccuracy } from './accuracy';

export interface RunAnalysisParams {
  conversations: AnalysisConversation[];
  spec: AnalysisSpec;
  /** Model used for field extraction (not needed when every field goes to the decision model). */
  invokeExtraction?: ModelInvoker;
  /** Decision model for Yes/No, Choice and Score fields (used when spec.useDecisionModel is set). */
  invokeDecision?: DecisionInvoker;
  /** Model used for the LLM judge (required when modes.judge is set). */
  invokeJudge?: ModelInvoker;
  config?: AnalysisRunConfig;
  onItem?: (result: AnalysisItemResult, index: number) => void;
}

export async function runAnalysis(params: RunAnalysisParams): Promise<AnalysisResult> {
  const { conversations, spec, invokeExtraction, invokeDecision, invokeJudge, config, onItem } = params;
  const concurrency = Math.max(1, config?.concurrency ?? 4);
  const results = new Array<AnalysisItemResult>(conversations.length);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= conversations.length) return;
      const result = await analyseOne(conversations[index], spec, invokeExtraction, invokeDecision, invokeJudge);
      results[index] = result;
      onItem?.(result, index);
    }
  };

  const poolSize = Math.min(concurrency, conversations.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return { aggregate: aggregateItems(results, spec.fieldSet, spec), items: results };
}

async function analyseOne(
  conversation: AnalysisConversation,
  spec: AnalysisSpec,
  invokeExtraction: ModelInvoker | undefined,
  invokeDecision: DecisionInvoker | undefined,
  invokeJudge: ModelInvoker | undefined,
): Promise<AnalysisItemResult> {
  // Decision fields without a decision invoker fall back to extraction.
  const routing = { useDecisionModel: !!spec.useDecisionModel && !!invokeDecision };
  const decisionFields = spec.fieldSet.filter((f) => isDecisionField(f, routing));
  const extractionFields = spec.fieldSet.filter((f) => !isDecisionField(f, routing));

  // An empty field-set still runs extraction, as it always has.
  const needsExtraction = extractionFields.length > 0 || decisionFields.length === 0;
  const requiredKeys = extractionFields.filter((f) => f.required).map((f) => f.key);

  const [extraction, decision] = await Promise.all([
    needsExtraction
      ? invokeExtraction
        ? extractFields(conversation, extractionFields, spec.extractionInstructions, invokeExtraction)
        : Promise.resolve<ExtractionResult>({ fields: {}, missing: requiredKeys, error: 'No extraction model configured' })
      : Promise.resolve<ExtractionResult | undefined>(undefined),
    decisionFields.length > 0 && invokeDecision
      ? decideFields(conversation, decisionFields, spec, invokeDecision)
      : Promise.resolve<DecisionFieldsResult | undefined>(undefined),
  ]);

  // Merge in field-set order so the item reads like the definition.
  const values: Record<string, unknown> = { ...extraction?.fields, ...decision?.fields };
  const fields: Record<string, unknown> = {};
  for (const field of spec.fieldSet) {
    if (field.key in values) fields[field.key] = values[field.key];
  }
  const missing = [...(extraction?.missing ?? []), ...(decision?.missing ?? [])];
  const errors = [extraction?.error, decision?.error].filter((e): e is string => !!e);

  const result: AnalysisItemResult = {
    conversationId: conversation.id,
    extractedFields: fields,
    missing,
    passed: false,
    error: errors.length ? errors.join('; ') : undefined,
  };

  if (decision && Object.keys(decision.decisions).length > 0) {
    const flags = applyReviewFlags(decision.decisions, decisionFields, spec, conversation.id);
    result.decisions = flags.decisions;
    result.needsReview = flags.needsReview;
    result.minConfidence = flags.minConfidence;
    if (flags.reviewReason) result.reviewReason = flags.reviewReason;
    if (decision.rationale) result.rationale = decision.rationale;
  }

  if (spec.modes.judge && invokeJudge) {
    result.judge = await judgeConversation(
      conversation,
      spec.modes.judge.rubric,
      spec.modes.judge.threshold ?? 0.5,
      invokeJudge,
    );
  }

  if (spec.modes.accuracy && conversation.referenceFields) {
    result.accuracy = scoreAccuracy(fields, conversation.referenceFields, spec.fieldSet);
  }

  const extractionOk = errors.length === 0 && missing.length === 0;
  const judgeOk = result.judge ? result.judge.passed !== false && !result.judge.error : true;
  result.passed = extractionOk && judgeOk;

  return result;
}

function decisionKey(answer: AnalysisDecision['answer']): string {
  return typeof answer === 'boolean' ? (answer ? 'yes' : 'no') : String(answer);
}

/** Per decision field: answer counts, refusals, flags and mean confidence (and mean level for scores). */
function aggregateDecisions(
  items: AnalysisItemResult[],
  fieldSet: FieldSet,
  spec: Pick<AnalysisSpec, 'useDecisionModel'>,
): Record<string, DecisionAggregate> | undefined {
  if (!items.some((i) => i.decisions && Object.keys(i.decisions).length > 0)) return undefined;

  const out: Record<string, DecisionAggregate> = {};
  for (const field of fieldSet) {
    if (!isDecisionField(field, spec)) continue;
    const agg: DecisionAggregate = { answered: 0, refused: 0, needsReview: 0, counts: {}, avgConfidence: null };
    let confidenceSum = 0;
    let scoreSum = 0;
    let scored = 0;
    for (const item of items) {
      const d = item.decisions?.[field.key];
      if (!d) continue;
      if (d.needsReview) agg.needsReview += 1;
      if (d.refused || d.answer === undefined) {
        agg.refused += 1;
        continue;
      }
      agg.answered += 1;
      confidenceSum += d.confidence;
      const key = decisionKey(d.answer);
      agg.counts[key] = (agg.counts[key] ?? 0) + 1;
      if (typeof d.score === 'number') {
        scoreSum += d.score;
        scored += 1;
      }
    }
    agg.avgConfidence = agg.answered ? confidenceSum / agg.answered : null;
    if (field.type === 'score') agg.avgScore = scored ? scoreSum / scored : null;
    out[field.key] = agg;
  }
  return out;
}

/**
 * Aggregate item results. Exported so the service can aggregate a run that it
 * processed in chunks.
 */
export function aggregateItems(
  items: AnalysisItemResult[],
  fieldSet: FieldSet,
  spec: Pick<AnalysisSpec, 'useDecisionModel'>,
): AnalysisAggregate {
  const total = items.length;
  const completedItems = items.filter((i) => !i.error);
  const completed = completedItems.length;
  const failed = total - completed;
  const passed = items.filter((i) => i.passed).length;

  const judged = items.filter((i) => i.judge && !i.judge.error);
  const avgJudgeScore = judged.length
    ? judged.reduce((sum, i) => sum + (i.judge?.score ?? 0), 0) / judged.length
    : null;

  const scoredAccuracy = items.filter((i) => i.accuracy && i.accuracy.comparedCount > 0);
  const avgExtractionAccuracy = scoredAccuracy.length
    ? scoredAccuracy.reduce((sum, i) => sum + (i.accuracy?.score ?? 0), 0) / scoredAccuracy.length
    : null;

  const decisions = aggregateDecisions(items, fieldSet, spec);

  return {
    total,
    completed,
    failed,
    passed,
    passRate: completed ? passed / completed : 0,
    avgJudgeScore,
    avgExtractionAccuracy,
    needsReview: items.filter((i) => i.needsReview).length,
    ...(decisions ? { decisions } : {}),
  };
}
