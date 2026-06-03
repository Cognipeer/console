/**
 * Evaluation runner — orchestrates target invocation + scoring across a
 * dataset with bounded concurrency, then aggregates pass-rate / score /
 * latency. Pure with respect to the platform: targets and judges are injected.
 */

import type {
  DatasetItem,
  JudgeInvoker,
  RunAggregate,
  RunConfig,
  RunItemResult,
  RunResult,
  ScorerConfig,
  ScoreResult,
  TargetInvoker,
} from './types';
import { runScorers } from './scorers';

export interface RunEvaluationParams {
  items: DatasetItem[];
  scorers: ScorerConfig[];
  invokeTarget: TargetInvoker;
  invokeJudge?: JudgeInvoker;
  config?: RunConfig;
  /** Progress hook, invoked once per completed item. */
  onItem?: (result: RunItemResult, index: number) => void;
}

export async function runEvaluation(params: RunEvaluationParams): Promise<RunResult> {
  const { items, scorers, invokeTarget, invokeJudge, config, onItem } = params;
  const concurrency = Math.max(1, config?.concurrency ?? 4);
  const results = new Array<RunItemResult>(items.length);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const result = await runItem(items[index], scorers, invokeTarget, invokeJudge);
      results[index] = result;
      onItem?.(result, index);
    }
  };

  const poolSize = Math.min(concurrency, items.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return { aggregate: aggregate(results), items: results };
}

async function runItem(
  item: DatasetItem,
  scorers: ScorerConfig[],
  invokeTarget: TargetInvoker,
  invokeJudge: JudgeInvoker | undefined,
): Promise<RunItemResult> {
  const started = Date.now();
  try {
    const output = await invokeTarget(item);
    const scores = await runScorers(item, output, scorers, { invokeJudge });
    const { score, passed } = combine(scores);
    return {
      itemId: item.id,
      output,
      scores,
      score,
      passed,
      latencyMs: output.latencyMs ?? Date.now() - started,
    };
  } catch (err) {
    return {
      itemId: item.id,
      scores: [],
      score: 0,
      passed: false,
      error: (err as Error).message,
      latencyMs: Date.now() - started,
    };
  }
}

/** Weighted mean of scorer scores; an item passes only if every scorer did. */
function combine(scores: ScoreResult[]): { score: number; passed: boolean } {
  if (scores.length === 0) return { score: 0, passed: false };
  const totalWeight = scores.reduce((sum, s) => sum + (s.weight ?? 1), 0) || scores.length;
  const weighted = scores.reduce((sum, s) => sum + s.score * (s.weight ?? 1), 0);
  return { score: weighted / totalWeight, passed: scores.every((s) => s.passed) };
}

function aggregate(items: RunItemResult[]): RunAggregate {
  const total = items.length;
  const completedItems = items.filter((i) => !i.error);
  const completed = completedItems.length;
  const failed = total - completed;
  const passed = items.filter((i) => i.passed).length;

  const latencies = items.map((i) => i.latencyMs).filter((v): v is number => typeof v === 'number');
  const avgLatencyMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const avgScore = completed ? completedItems.reduce((a, b) => a + b.score, 0) / completed : 0;

  return {
    total,
    completed,
    failed,
    passed,
    passRate: completed ? passed / completed : 0,
    avgScore,
    avgLatencyMs,
  };
}
