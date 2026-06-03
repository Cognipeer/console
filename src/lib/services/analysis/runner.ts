/**
 * Analysis runner — orchestrates extraction + (optional) judge + (optional)
 * accuracy across a batch of conversations with bounded concurrency, then
 * aggregates pass-rate / avg judge score / avg extraction accuracy. Pure with
 * respect to the platform: the model is injected.
 */

import type {
  AnalysisAggregate,
  AnalysisConversation,
  AnalysisItemResult,
  AnalysisResult,
  AnalysisRunConfig,
  AnalysisSpec,
  ModelInvoker,
} from './types';
import { extractFields } from './extraction';
import { judgeConversation } from './judge';
import { scoreAccuracy } from './accuracy';

export interface RunAnalysisParams {
  conversations: AnalysisConversation[];
  spec: AnalysisSpec;
  /** Model used for field extraction. */
  invokeExtraction: ModelInvoker;
  /** Model used for the LLM judge (required when modes.judge is set). */
  invokeJudge?: ModelInvoker;
  config?: AnalysisRunConfig;
  onItem?: (result: AnalysisItemResult, index: number) => void;
}

export async function runAnalysis(params: RunAnalysisParams): Promise<AnalysisResult> {
  const { conversations, spec, invokeExtraction, invokeJudge, config, onItem } = params;
  const concurrency = Math.max(1, config?.concurrency ?? 4);
  const results = new Array<AnalysisItemResult>(conversations.length);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= conversations.length) return;
      const result = await analyseOne(conversations[index], spec, invokeExtraction, invokeJudge);
      results[index] = result;
      onItem?.(result, index);
    }
  };

  const poolSize = Math.min(concurrency, conversations.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return { aggregate: aggregate(results), items: results };
}

async function analyseOne(
  conversation: AnalysisConversation,
  spec: AnalysisSpec,
  invokeExtraction: ModelInvoker,
  invokeJudge: ModelInvoker | undefined,
): Promise<AnalysisItemResult> {
  const extraction = await extractFields(conversation, spec.fieldSet, spec.extractionInstructions, invokeExtraction);

  const result: AnalysisItemResult = {
    conversationId: conversation.id,
    extractedFields: extraction.fields,
    missing: extraction.missing,
    passed: false,
    error: extraction.error,
  };

  if (spec.modes.judge && invokeJudge) {
    result.judge = await judgeConversation(
      conversation,
      spec.modes.judge.rubric,
      spec.modes.judge.threshold ?? 0.5,
      invokeJudge,
    );
  }

  if (spec.modes.accuracy && conversation.referenceFields) {
    result.accuracy = scoreAccuracy(extraction.fields, conversation.referenceFields, spec.fieldSet);
  }

  const extractionOk = !extraction.error && extraction.missing.length === 0;
  const judgeOk = result.judge ? result.judge.passed !== false && !result.judge.error : true;
  result.passed = extractionOk && judgeOk;

  return result;
}

function aggregate(items: AnalysisItemResult[]): AnalysisAggregate {
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

  return {
    total,
    completed,
    failed,
    passed,
    passRate: completed ? passed / completed : 0,
    avgJudgeScore,
    avgExtractionAccuracy,
  };
}
