/**
 * Evaluation runner — orchestrates target invocation + scoring across a
 * dataset with bounded concurrency, then aggregates pass-rate / score /
 * latency. Pure with respect to the platform: targets and judges are injected.
 */

import type {
  DatasetItem,
  EmbedInvoker,
  EvalMessage,
  EvalUsage,
  JudgeInvoker,
  ReplayTurn,
  RunAggregate,
  RunConfig,
  RunItemResult,
  RunResult,
  ScorerConfig,
  ScoreResult,
  TargetInvoker,
  TargetOutput,
} from './types';
import { runScorers } from './scorers';

export interface RunEvaluationParams {
  items: DatasetItem[];
  scorers: ScorerConfig[];
  invokeTarget: TargetInvoker;
  invokeJudge?: JudgeInvoker;
  invokeEmbed?: EmbedInvoker;
  config?: RunConfig;
  /** Progress hook, invoked once per completed item. */
  onItem?: (result: RunItemResult, index: number) => void;
}

export async function runEvaluation(params: RunEvaluationParams): Promise<RunResult> {
  const { items, scorers, invokeTarget, invokeJudge, invokeEmbed, config, onItem } = params;
  const concurrency = Math.max(1, config?.concurrency ?? 4);
  const results = new Array<RunItemResult>(items.length);
  // `perTurn` wraps the invoker rather than changing the scoring path: an item
  // still produces exactly ONE output and ONE score either way, so runs in the
  // two modes stay directly comparable.
  const invoke: TargetInvoker = config?.turnMode === 'perTurn'
    ? (item) => replayPerTurn(item, invokeTarget)
    : invokeTarget;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const result = await runItem(items[index], scorers, invoke, invokeJudge, invokeEmbed);
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
  invokeEmbed: EmbedInvoker | undefined,
): Promise<RunItemResult> {
  const started = Date.now();
  try {
    const output = await invokeTarget(item);
    const scores = await runScorers(item, output, scorers, { invokeJudge, invokeEmbed });
    const { score, passed } = combine(scores);
    return {
      itemId: item.id,
      output,
      scores,
      score,
      passed,
      latencyMs: output.latencyMs ?? Date.now() - started,
      usage: output.usage,
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

const REPLAY_QUESTION_PREVIEW_CHARS = 200;

/**
 * Replay a multi-turn item turn by turn, feeding the model its OWN answers.
 *
 * `single` mode sends the whole recorded prefix and calls the model once, so
 * every earlier assistant turn is the one production actually produced. That
 * isolates each decision against a known-good history — a clean regression
 * signal, and cheap — but it structurally cannot catch drift: an agent that
 * answers every turn correctly in isolation and still loses the thread once it
 * is reading its own output passes with full marks.
 *
 * Here each user turn triggers a call, and the answer is appended as history
 * for the next one, so errors compound the way they do in a live session.
 *
 * What is NOT regenerated: recorded tool exchanges. A tool result is a fact
 * about the environment that a test cannot reproduce (nothing is executed
 * here), so those turns replay verbatim; only the model's own words are
 * replaced. Recorded assistant MESSAGE turns are dropped, because the model's
 * answer now stands in their place — keeping both would show the model two
 * answers to the same question.
 *
 * The LAST turn's output is what gets scored: the item's `expected` describes
 * the assistant action recorded at the END of its prefix, so grading any
 * earlier turn against it would compare the answer to question 1 with the
 * answer to question 3. Every turn is kept on `turns` as evidence.
 *
 * A single-turn item takes the same path and produces exactly one call, so the
 * two modes agree on such datasets by construction.
 */
export async function replayPerTurn(
  item: DatasetItem,
  invokeTarget: TargetInvoker,
): Promise<TargetOutput> {
  const system = item.input.filter((m) => m.role === 'system');
  const conversation = item.input.filter((m) => m.role !== 'system');
  // Nothing to drive without a user turn (e.g. a system-only probe): fall back
  // to the single-shot path rather than inventing a turn.
  if (!conversation.some((m) => m.role === 'user')) return invokeTarget(item);

  const history: EvalMessage[] = [...system];
  const turns: ReplayTurn[] = [];
  let last: TargetOutput | undefined;
  /** True while the model's answer stands in for a not-yet-seen recorded one. */
  let answerPending = false;

  for (const turn of conversation) {
    if (turn.role === 'assistant' && !turn.toolCalls?.length && answerPending) {
      answerPending = false;
      continue; // replaced by the model's own answer, already in `history`
    }
    history.push(turn);
    if (turn.role !== 'user') continue;

    const output = await invokeTarget({
      ...item,
      id: `${item.id}#turn-${turns.length + 1}`,
      input: [...history],
    });
    last = output;
    turns.push({
      index: turns.length + 1,
      question: turn.content.slice(0, REPLAY_QUESTION_PREVIEW_CHARS),
      text: output.text,
      ...(output.toolCalls?.length ? { toolCalls: output.toolCalls } : {}),
      ...(output.latencyMs !== undefined ? { latencyMs: output.latencyMs } : {}),
      ...(output.usage ? { usage: output.usage } : {}),
    });
    history.push({
      role: 'assistant',
      content: output.text,
      ...(output.toolCalls?.length
        ? { toolCalls: output.toolCalls.map((call) => ({ name: call.name, args: call.args })) }
        : {}),
    });
    answerPending = true;
  }

  // `last` is set whenever a user turn was found, which the guard above ensures.
  const final = last as TargetOutput;
  return {
    ...final,
    // Latency and spend are the WHOLE replay's, not the last call's — a
    // per-turn run costs several calls per item and the cost report has to say
    // so, or `perTurn` looks free next to `single`.
    latencyMs: sumDefined(turns.map((t) => t.latencyMs)),
    usage: sumUsage(turns.map((t) => t.usage)),
    turns,
  };
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => typeof v === 'number');
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : undefined;
}

/** Totals across a replay's turns. Absent everywhere stays absent — a zero
 *  would report "free" where the truth is "the provider told us nothing". */
function sumUsage(usages: Array<EvalUsage | undefined>): EvalUsage | undefined {
  const present = usages.filter((u): u is EvalUsage => Boolean(u));
  if (present.length === 0) return undefined;
  const total: EvalUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'costUsd'] as const) {
    const sum = sumDefined(present.map((u) => u[key]));
    if (sum !== undefined) total[key] = sum;
  }
  return total;
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

  // Usage totals are only meaningful when at least one item reported usage —
  // otherwise leave them undefined so "no usage data" stays distinguishable
  // from "zero cost".
  const withUsage = items.filter((i) => i.usage);
  const totals = withUsage.length
    ? {
        totalCostUsd: withUsage.reduce((sum, i) => sum + (i.usage?.costUsd ?? 0), 0),
        totalTokens: withUsage.reduce(
          (sum, i) =>
            sum +
            (i.usage?.inputTokens ?? 0) +
            (i.usage?.outputTokens ?? 0) +
            (i.usage?.cachedInputTokens ?? 0),
          0,
        ),
      }
    : {};

  return {
    total,
    completed,
    failed,
    passed,
    passRate: completed ? passed / completed : 0,
    avgScore,
    avgLatencyMs,
    ...totals,
  };
}
