/**
 * Tool-call (trajectory) scorer — pure, deterministic, no LLM involved.
 *
 * Compares the tool calls a target actually emitted against the expected
 * trajectory on three axes, combined as a weighted mean (weights renormalised
 * over the components present):
 *   - selection (default 0.5): F1 between the expected and actual tool-name
 *     multisets — did the target pick the right tools?
 *   - sequence  (default 0.2): 1 − normalised Levenshtein distance between the
 *     expected and actual tool-name sequences — did it call them in order?
 *   - args      (default 0.3): per expected call (matched to an actual call with
 *     the same name; calls sharing a name are assigned so the total args
 *     score is maximal, ties going to the earlier actual call), argument comparison per its
 *     `argsMatch` mode: 'exact' (canonical-JSON equality), 'subset' (every
 *     expected key/value deep-present in actual), 'schema' (minimal JSON-schema
 *     validation via ./json), 'ignore' (excluded from args scoring).
 *
 * With no expected calls and no actual calls the score is 1 (correct
 * abstention). Pass threshold defaults to 0.75. `detail` carries a per-call
 * breakdown for the dashboard.
 */

import type { DatasetItem, ExpectedToolCall, NormalizedToolCall, ScoreResult, ToolCallScorerConfig } from '../types';
import { deepEqual, hasOwn, UnsupportedSchemaError, validateSchema } from './json';

const DEFAULT_SELECTION_WEIGHT = 0.5;
const DEFAULT_SEQUENCE_WEIGHT = 0.2;
const DEFAULT_ARGS_WEIGHT = 0.3;
const DEFAULT_THRESHOLD = 0.75;

/**
 * Stable JSON stringify: object keys sorted recursively, string values
 * trimmed. Undefined object values are omitted (JSON semantics); undefined
 * inside arrays serialises as null. Exported for reuse (e.g. the
 * `toolResults` key format: `name + '(' + canonicalJson(args) + ')'`).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalise(v)));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = canonicalise(source[key]);
    }
    return sorted;
  }
  return value;
}

/** F1 between two name multisets (1 when both are empty). */
function selectionScore(expected: string[], actual: string[]): number {
  if (expected.length === 0 && actual.length === 0) return 1;
  const expectedCounts = countByName(expected);
  const actualCounts = countByName(actual);
  let intersection = 0;
  for (const [name, count] of expectedCounts) {
    intersection += Math.min(count, actualCounts.get(name) ?? 0);
  }
  const precision = actual.length ? intersection / actual.length : 0;
  const recall = expected.length ? intersection / expected.length : 0;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** 1 − Levenshtein(expected, actual) / max(len) (1 when both are empty). */
function sequenceScore(expected: string[], actual: string[]): number {
  const maxLen = Math.max(expected.length, actual.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(expected, actual) / maxLen;
}

function levenshtein(a: string[], b: string[]): number {
  // Single-row dynamic programming over token sequences.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

function countByName(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

/** Explicit argsMatch wins; else infer from which expectation fields are set. */
function resolveArgsMatch(call: ExpectedToolCall): NonNullable<ExpectedToolCall['argsMatch']> {
  if (call.argsMatch) return call.argsMatch;
  if (call.args !== undefined) return 'exact';
  if (call.argsSchema !== undefined) return 'schema';
  return 'ignore';
}

/** Every expected key/value deep-present in actual (arrays compare exactly). */
function isDeepSubset(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;
    return Object.keys(expectedObj).every(
      (key) => hasOwn(actualObj, key) && isDeepSubset(expectedObj[key], actualObj[key]),
    );
  }
  return deepEqual(expected, actual);
}

interface CallBreakdown {
  name: string;
  argsMatch: NonNullable<ExpectedToolCall['argsMatch']>;
  matched: boolean;
  /** Args score for this call (absent for 'ignore' / unmatched calls). */
  argsScore?: number;
  detail?: string;
}

function scoreArgs(
  expectedCall: ExpectedToolCall,
  argsMatch: NonNullable<ExpectedToolCall['argsMatch']>,
  actualArgs: Record<string, unknown>,
): { score: number; detail?: string } {
  if (argsMatch === 'ignore') return { score: 1 };
  if (argsMatch === 'exact') {
    const same = canonicalJson(expectedCall.args ?? {}) === canonicalJson(actualArgs);
    return same ? { score: 1 } : { score: 0, detail: 'args differ from expected' };
  }
  if (argsMatch === 'subset') {
    const ok = isDeepSubset(expectedCall.args ?? {}, actualArgs);
    return ok ? { score: 1 } : { score: 0, detail: 'expected args not a subset of actual' };
  }
  // 'schema'
  if (!expectedCall.argsSchema) return { score: 1, detail: 'no argsSchema provided — nothing to validate' };
  const errors = validateSchema(actualArgs, expectedCall.argsSchema);
  return { score: errors.length === 0 ? 1 : 0, detail: errors[0] };
}

/** Exact assignment is exponential in the same-name actual calls; beyond this fall back to two-pass greedy. */
const MAX_EXACT_ACTUAL = 12;
const MAX_EXACT_STATES = 200_000;

/**
 * Pair each expected call with an actual call of the same name. Greedy
 * "first unused" breaks when same-name calls arrive in a different order than
 * expected (search(a), search(b) vs search(b), search(a)), so within a name the
 * assignment maximises matched calls first, then total args score, preferring
 * earlier actual calls on ties. Returns the actual index per expected index
 * (-1 when unmatched).
 */
function assignCalls(expected: ExpectedToolCall[], actual: NormalizedToolCall[]): number[] {
  const result = new Array<number>(expected.length).fill(-1);
  const names = new Set(expected.map((c) => c.name));
  for (const name of names) {
    const eIdx: number[] = [];
    expected.forEach((c, i) => { if (c.name === name) eIdx.push(i); });
    const aIdx: number[] = [];
    actual.forEach((c, i) => { if (c.name === name) aIdx.push(i); });
    if (aIdx.length === 0) continue;

    // gain[e][a]: 1 when the pair satisfies the expected call's args mode, else 0.
    const gain = eIdx.map((ei) => {
      const call = expected[ei];
      const argsMatch = resolveArgsMatch(call);
      return aIdx.map((ai) => (argsMatch === 'ignore' ? 0 : scoreArgs(call, argsMatch, actual[ai].args ?? {}).score));
    });

    if (aIdx.length <= MAX_EXACT_ACTUAL && eIdx.length * (1 << aIdx.length) <= MAX_EXACT_STATES) {
      const matchWeight = eIdx.length + 1; // a match always outranks any args gain
      const memo = new Map<number, number>();
      const choice = new Map<number, number>();
      const best = (e: number, mask: number): number => {
        if (e === eIdx.length) return 0;
        const key = e * (1 << aIdx.length) + mask;
        const cached = memo.get(key);
        if (cached !== undefined) return cached;
        let bestValue = -1;
        let bestChoice = -1;
        for (let a = 0; a < aIdx.length; a += 1) {
          if (mask & (1 << a)) continue;
          const value = matchWeight + gain[e][a] + best(e + 1, mask | (1 << a));
          if (value > bestValue) { bestValue = value; bestChoice = a; }
        }
        const skip = best(e + 1, mask);
        if (skip > bestValue) { bestValue = skip; bestChoice = -1; }
        memo.set(key, bestValue);
        choice.set(key, bestChoice);
        return bestValue;
      };
      best(0, 0);
      let mask = 0;
      for (let e = 0; e < eIdx.length; e += 1) {
        const picked = choice.get(e * (1 << aIdx.length) + mask) ?? -1;
        if (picked >= 0) {
          result[eIdx[e]] = aIdx[picked];
          mask |= 1 << picked;
        }
      }
      continue;
    }

    // Fallback: first take actual calls that satisfy the args, then any leftover.
    const used = new Set<number>();
    for (const pass of [1, 0]) {
      eIdx.forEach((ei, e) => {
        if (result[ei] !== -1) return;
        const a = aIdx.findIndex((_, k) => !used.has(k) && (pass === 0 || gain[e][k] === 1 || resolveArgsMatch(expected[ei]) === 'ignore'));
        if (a !== -1) { used.add(a); result[ei] = aIdx[a]; }
      });
    }
  }
  return result;
}

export function scoreToolCall(
  item: DatasetItem,
  output: { toolCalls?: NormalizedToolCall[] },
  config: ToolCallScorerConfig,
): ScoreResult {
  try {
    return scoreToolCallUnchecked(item, output, config);
  } catch (err) {
    // A schema this validator cannot honour is a configuration problem, not a wrong answer.
    if (err instanceof UnsupportedSchemaError) {
      return {
        scorerType: 'tool-call',
        score: 0,
        passed: false,
        weight: config.weight ?? 1,
        error: `tool-call argsSchema: ${err.message}`,
      };
    }
    throw err;
  }
}

function scoreToolCallUnchecked(
  item: DatasetItem,
  output: { toolCalls?: NormalizedToolCall[] },
  config: ToolCallScorerConfig,
): ScoreResult {
  const weight = config.weight ?? 1;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const allowExtraCalls = config.allowExtraCalls !== false;
  const expected = item.expected?.toolCalls ?? [];
  const actual = output.toolCalls ?? [];

  // Correct abstention: nothing expected, nothing called.
  if (expected.length === 0 && actual.length === 0) {
    return {
      scorerType: 'tool-call',
      score: 1,
      passed: true,
      weight,
      detail: { selection: 1, sequence: 1, calls: [], expectedCount: 0, actualCount: 0 },
    };
  }

  const expectedNames = expected.map((c) => c.name);
  const actualNames = actual.map((c) => c.name);
  const selection = selectionScore(expectedNames, actualNames);
  const sequence = sequenceScore(expectedNames, actualNames);

  // Pair expected with actual calls (optimal within a name), then score each
  // pair's args per the resolved argsMatch mode.
  const assignment = assignCalls(expected, actual);
  const usedActual = new Set<number>(assignment.filter((i) => i !== -1));
  const calls: CallBreakdown[] = [];
  const argsScores: number[] = [];
  expected.forEach((expectedCall, e) => {
    const matchIndex = assignment[e];
    const matched = matchIndex !== -1;
    const argsMatch = resolveArgsMatch(expectedCall);

    if (argsMatch === 'ignore') {
      calls.push({ name: expectedCall.name, argsMatch, matched });
      return;
    }
    if (!matched) {
      calls.push({ name: expectedCall.name, argsMatch, matched, argsScore: 0, detail: 'no matching call' });
      argsScores.push(0);
      return;
    }

    const { score: argsScore, detail } = scoreArgs(expectedCall, argsMatch, actual[matchIndex].args ?? {});
    calls.push({ name: expectedCall.name, argsMatch, matched, argsScore, detail });
    argsScores.push(argsScore);
  });

  // Weighted combine, renormalised over the components present (args is
  // absent when no expected call participates in args scoring).
  const components: Array<{ score: number; weight: number }> = [
    { score: selection, weight: config.selectionWeight ?? DEFAULT_SELECTION_WEIGHT },
    { score: sequence, weight: config.sequenceWeight ?? DEFAULT_SEQUENCE_WEIGHT },
  ];
  const argsScore = argsScores.length
    ? argsScores.reduce((a, b) => a + b, 0) / argsScores.length
    : undefined;
  if (argsScore !== undefined) {
    components.push({ score: argsScore, weight: config.argsWeight ?? DEFAULT_ARGS_WEIGHT });
  }
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = totalWeight > 0
    ? components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight
    : 0;

  const unexpectedCalls = actual.filter((_, i) => !usedActual.has(i)).map((c) => c.name);
  const extraRejected = !allowExtraCalls && unexpectedCalls.length > 0;

  return {
    scorerType: 'tool-call',
    score,
    passed: score >= threshold && !extraRejected,
    weight,
    detail: {
      selection,
      sequence,
      ...(argsScore !== undefined ? { args: argsScore } : {}),
      calls,
      unexpectedCalls,
      ...(extraRejected ? { reason: `unexpected tool calls not allowed: ${unexpectedCalls.join(', ')}` } : {}),
      expectedCount: expected.length,
      actualCount: actual.length,
      threshold,
    },
  };
}
