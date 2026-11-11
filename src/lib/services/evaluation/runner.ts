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
import { EVAL_MAX_CONCURRENCY } from './types';
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
  /** Runs one item (`run`: its target call and scorers) in a context of the caller's, e.g. to mark what it used. */
  scope?: (item: DatasetItem, run: () => Promise<RunItemResult>) => Promise<RunItemResult>;
  /**
   * Polled before each new item is dispatched. Once it returns true no further
   * item starts, items already in flight finish, and the result holds only the
   * processed items (aggregate over them) with `stopped: true`.
   */
  shouldStop?: () => boolean;
}

function clampConcurrency(raw: number | undefined): number {
  const n = typeof raw === 'number' && !Number.isNaN(raw) ? Math.floor(raw) : 4;
  return Math.min(EVAL_MAX_CONCURRENCY, Math.max(1, n));
}

export async function runEvaluation(params: RunEvaluationParams): Promise<RunResult> {
  const { items, scorers, invokeTarget, invokeJudge, invokeEmbed, config, onItem } = params;
  const concurrency = clampConcurrency(config?.concurrency);
  const results = new Array<RunItemResult>(items.length);
  // `perTurn` wraps the invoker rather than changing the scoring path: an item
  // still produces exactly ONE output and ONE score either way, so runs in the
  // two modes stay directly comparable.
  const invoke: TargetInvoker = config?.turnMode === 'perTurn'
    ? (item) => replayPerTurn(item, invokeTarget)
    : invokeTarget;

  let cursor = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      if (index >= items.length) return;
      if (params.shouldStop?.()) {
        stopped = true;
        return;
      }
      cursor += 1;
      const run = () => runItem(items[index], scorers, invoke, invokeJudge, invokeEmbed);
      const result = await (params.scope ? params.scope(items[index], run) : run());
      results[index] = result;
      onItem?.(result, index);
    }
  };

  const poolSize = Math.min(concurrency, items.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  // Items never dispatched (stopped) leave holes; `filter` skips them, keeping dataset order.
  const processed = results.filter((r): r is RunItemResult => r !== undefined);
  return { aggregate: aggregate(processed), items: processed, ...(stopped ? { stopped: true } : {}) };
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
    const outcome = combine(scores);
    const scoringUsage = sumUsage(scores.map((s) => s.usage));
    return {
      itemId: item.id,
      output,
      scores,
      score: outcome.score,
      passed: outcome.passed,
      ...(outcome.skipped ? { skipped: true } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      latencyMs: output.latencyMs ?? Date.now() - started,
      usage: output.usage,
      ...(scoringUsage ? { scoringUsage } : {}),
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
 * answers to the same question. A recorded tool-calling assistant turn takes
 * the place of the model's answer at that point (the model's text moves behind
 * the recorded exchange, where the recorded prose was).
 *
 * The LAST turn's output is what gets scored: the item's `expected` describes
 * the assistant action recorded at the END of its prefix, so grading any
 * earlier turn against it would compare the answer to question 1 with the
 * answer to question 3. A recording that ends on a tool result gets one more
 * call with the full history, so the scored output is always the action at the
 * end of the prefix, like `single` mode. Every turn is kept on `turns` as
 * evidence.
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
  let anyTruncated = false;
  /** True while the model's answer stands in for a not-yet-seen recorded one. */
  let answerPending = false;
  /**
   * The model's answer, parked while a recorded tool exchange replays: in the
   * recording the final prose comes AFTER the tool exchange, so that is where
   * the model's answer belongs (and it must not sit next to the recorded call).
   */
  let deferredAnswer: EvalMessage | undefined;
  /** Recorded assistant-call / tool turns seen since the last model call. */
  let tailPending = false;

  const record = (output: TargetOutput, question: string): void => {
    last = output;
    if (output.truncated) anyTruncated = true;
    turns.push({
      index: turns.length + 1,
      question: question.slice(0, REPLAY_QUESTION_PREVIEW_CHARS),
      text: output.text,
      ...(output.toolCalls?.length ? { toolCalls: output.toolCalls } : {}),
      ...(output.latencyMs !== undefined ? { latencyMs: output.latencyMs } : {}),
      ...(output.usage ? { usage: output.usage } : {}),
    });
  };

  for (const turn of conversation) {
    if (turn.role === 'assistant' && turn.toolCalls?.length && answerPending && !deferredAnswer) {
      // Recorded tool-calling turn: the recorded exchange replaces the model's
      // answer here. Keep only the model's TEXT (its own calls would be closed
      // with stand-in results); they stay on `turns[].toolCalls` as evidence.
      const parked = history.pop();
      if (parked) deferredAnswer = { role: 'assistant', content: parked.content };
    }
    if (turn.role === 'assistant' && !turn.toolCalls?.length && answerPending) {
      answerPending = false;
      if (deferredAnswer) {
        history.push(deferredAnswer);
        deferredAnswer = undefined;
      }
      continue; // replaced by the model's own answer
    }
    if (turn.role === 'user' && deferredAnswer) {
      // The recorded exchange never ended in prose: the parked answer goes back before the next question.
      history.push(deferredAnswer);
      deferredAnswer = undefined;
      answerPending = false;
    }
    history.push(turn);
    if (turn.role !== 'user') {
      tailPending = true;
      continue;
    }
    tailPending = false;

    const output = await invokeTarget({
      ...item,
      id: `${item.id}#turn-${turns.length + 1}`,
      input: [...history],
    });
    record(output, turn.content);
    history.push({
      role: 'assistant',
      content: output.text,
      ...(output.toolCalls?.length
        ? { toolCalls: output.toolCalls.map((call) => ({ name: call.name, args: call.args })) }
        : {}),
    });
    answerPending = true;
  }

  // The recording ends with a tool result: the action `expected` describes is
  // the model's decision AFTER it, which no user turn triggered. Ask for it
  // (matching what `single` mode does) and score that instead.
  const tail = history[history.length - 1];
  if (tailPending && tail?.role === 'tool') {
    const output = await invokeTarget({
      ...item,
      id: `${item.id}#turn-${turns.length + 1}`,
      input: [...history],
    });
    record(output, `[tool result] ${tail.name ?? tail.toolCallId ?? ''}`.trim());
  }

  // `last` is set whenever a user turn was found, which the guard above ensures.
  const final = last as unknown as TargetOutput;
  return {
    ...final,
    // Latency and spend are the WHOLE replay's, not the last call's — a
    // per-turn run costs several calls per item and the cost report has to say
    // so, or `perTurn` looks free next to `single`.
    latencyMs: sumDefined(turns.map((t) => t.latencyMs)),
    usage: sumUsage(turns.map((t) => t.usage)),
    // Cut off at ANY turn: the later turns were fed a partial answer.
    ...(anyTruncated ? { truncated: true } : {}),
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
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cachedWriteTokens', 'reasoningTokens', 'costUsd'] as const) {
    const sum = sumDefined(present.map((u) => u[key]));
    if (sum !== undefined) total[key] = sum;
  }
  return total;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Weighted mean; invalid weights count as 0, and all-zero weights fall back to equal weights. */
function weightedMean(scores: ScoreResult[]): number {
  if (scores.length === 0) return 0;
  const weights = scores.map((s) => {
    const w = s.weight ?? 1; // a score built without a weight counts as the default 1
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  const effective = sumWeights > 0 ? weights : weights.map(() => 1);
  const denominator = sumWeights > 0 ? sumWeights : scores.length;
  const sum = scores.reduce((acc, s, i) => acc + (Number.isFinite(s.score) ? s.score : 0) * effective[i], 0);
  return clamp01(sum / denominator);
}

/**
 * Item outcome from its scores. Skipped scores (the scorer does not apply) are
 * ignored; a scorer that ERRORED makes the item errored — a broken judge must
 * not read as "the model failed" nor hide behind the scorers that did run; an
 * item where nothing applied is skipped rather than passed or failed.
 */
function combine(scores: ScoreResult[]): { score: number; passed: boolean; skipped?: boolean; error?: string } {
  const errored = scores.filter((s) => s.error);
  const applicable = scores.filter((s) => !s.skipped && !s.error);
  if (errored.length > 0) {
    return {
      score: weightedMean(applicable),
      passed: false,
      error: `Scoring failed — ${errored.map((s) => `${s.scorerType}: ${s.error}`).join('; ')}`,
    };
  }
  if (applicable.length === 0) return { score: 0, passed: false, skipped: true };
  return { score: weightedMean(applicable), passed: applicable.every((s) => s.passed) };
}

function aggregate(items: RunItemResult[]): RunAggregate {
  const total = items.length;
  const completedItems = items.filter((i) => !i.error);
  const completed = completedItems.length;
  const failed = total - completed;
  const skipped = completedItems.filter((i) => i.skipped).length;
  const scoredItems = completedItems.filter((i) => !i.skipped);
  const passed = items.filter((i) => i.passed).length;

  // Latency is a property of items that actually ran to a result.
  const latencies = completedItems.map((i) => i.latencyMs).filter((v): v is number => typeof v === 'number');
  const avgLatencyMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const avgScore = scoredItems.length ? scoredItems.reduce((a, b) => a + b.score, 0) / scoredItems.length : 0;
  const truncatedCount = completedItems.filter((i) => i.output?.truncated).length;

  // Usage totals are only meaningful when at least one item reported usage —
  // otherwise leave them undefined so "no usage data" stays distinguishable
  // from "zero cost".
  const withUsage = items.filter((i) => i.usage);
  const totals = withUsage.length
    ? {
        usageItems: withUsage.length,
        totalCostUsd: withUsage.reduce((sum, i) => sum + (i.usage?.costUsd ?? 0), 0),
        // Cached and reasoning tokens are subsets of input / output: never added on top.
        totalTokens: withUsage.reduce(
          (sum, i) => sum + (i.usage?.inputTokens ?? 0) + (i.usage?.outputTokens ?? 0),
          0,
        ),
      }
    : {};

  // Judge spend stays apart from the target totals (parity compares those).
  const withScoring = items.filter((i) => i.scoringUsage);
  const scoringTotals = withScoring.length
    ? {
        scoringCostUsd: withScoring.reduce((sum, i) => sum + (i.scoringUsage?.costUsd ?? 0), 0),
        scoringTokens: withScoring.reduce(
          (sum, i) => sum + (i.scoringUsage?.inputTokens ?? 0) + (i.scoringUsage?.outputTokens ?? 0),
          0,
        ),
      }
    : {};

  return {
    total,
    completed,
    failed,
    passed,
    skipped,
    passRate: scoredItems.length ? passed / scoredItems.length : 0,
    errorRate: total ? failed / total : 0,
    avgScore,
    avgLatencyMs,
    truncatedCount,
    ...totals,
    ...scoringTotals,
  };
}
