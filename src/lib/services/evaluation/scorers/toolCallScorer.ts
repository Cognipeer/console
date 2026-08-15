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
 *   - args      (default 0.3): per expected call (matched to the first unused
 *     actual call with the same name, in order), argument comparison per its
 *     `argsMatch` mode: 'exact' (canonical-JSON equality), 'subset' (every
 *     expected key/value deep-present in actual), 'schema' (minimal JSON-schema
 *     validation via ./json), 'ignore' (excluded from args scoring).
 *
 * With no expected calls and no actual calls the score is 1 (correct
 * abstention). Pass threshold defaults to 0.75. `detail` carries a per-call
 * breakdown for the dashboard.
 */

import type { DatasetItem, ExpectedToolCall, NormalizedToolCall, ScoreResult, ToolCallScorerConfig } from '../types';
import { deepEqual, validateSchema } from './json';

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
      (key) => key in actualObj && isDeepSubset(expectedObj[key], actualObj[key]),
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

export function scoreToolCall(
  item: DatasetItem,
  output: { toolCalls?: NormalizedToolCall[] },
  config: ToolCallScorerConfig,
): ScoreResult {
  const weight = config.weight ?? 1;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
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

  // Match each expected call to the first unused actual call of the same name
  // (in order), then score its args per the resolved argsMatch mode.
  const usedActual = new Set<number>();
  const calls: CallBreakdown[] = [];
  const argsScores: number[] = [];
  for (const expectedCall of expected) {
    const matchIndex = actual.findIndex((a, i) => !usedActual.has(i) && a.name === expectedCall.name);
    const matched = matchIndex !== -1;
    if (matched) usedActual.add(matchIndex);
    const argsMatch = resolveArgsMatch(expectedCall);

    if (argsMatch === 'ignore') {
      calls.push({ name: expectedCall.name, argsMatch, matched });
      continue;
    }
    if (!matched) {
      calls.push({ name: expectedCall.name, argsMatch, matched, argsScore: 0, detail: 'no matching call' });
      argsScores.push(0);
      continue;
    }

    const actualArgs = actual[matchIndex].args;
    let argsScore = 0;
    let detail: string | undefined;
    if (argsMatch === 'exact') {
      argsScore = canonicalJson(expectedCall.args ?? {}) === canonicalJson(actualArgs) ? 1 : 0;
      if (argsScore === 0) detail = 'args differ from expected';
    } else if (argsMatch === 'subset') {
      argsScore = isDeepSubset(expectedCall.args ?? {}, actualArgs) ? 1 : 0;
      if (argsScore === 0) detail = 'expected args not a subset of actual';
    } else {
      // 'schema'
      if (!expectedCall.argsSchema) {
        argsScore = 1;
        detail = 'no argsSchema provided — nothing to validate';
      } else {
        const errors = validateSchema(actualArgs, expectedCall.argsSchema);
        argsScore = errors.length === 0 ? 1 : 0;
        detail = errors[0];
      }
    }
    calls.push({ name: expectedCall.name, argsMatch, matched, argsScore, detail });
    argsScores.push(argsScore);
  }

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

  return {
    scorerType: 'tool-call',
    score,
    passed: score >= threshold,
    weight,
    detail: {
      selection,
      sequence,
      ...(argsScore !== undefined ? { args: argsScore } : {}),
      calls,
      unexpectedCalls: actual.filter((_, i) => !usedActual.has(i)).map((c) => c.name),
      expectedCount: expected.length,
      actualCount: actual.length,
      threshold,
    },
  };
}
