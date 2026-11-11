/**
 * JSON-shape scorer — does the output have the same STRUCTURE as the
 * reference, not merely the same gist?
 *
 * Why this is separate from the semantic scorer: embedding similarity reads
 * prose. Given a reference of
 *   {"reply":true,"message":"…","pinMessage":false,"suggestedReplies":[], …}
 * and an output of
 *   {"message":"…"}
 * the two texts are *about* the same thing, so cosine similarity is high and
 * the item passes — while six required fields are simply missing and the
 * response would break anything consuming it. Structure has to be checked
 * structurally.
 *
 * The expected shape is DERIVED from `expected.reference` when that parses as
 * JSON, so captured-traffic datasets get this for free: the reference is a
 * real production response, and its keys are the contract.
 *
 * Deterministic, model-free. Items whose reference is missing or not JSON are
 * skipped (the scorer does not apply: no free pass, no failure) so mixed
 * datasets stay usable. `strict` also counts keys the reference lacks.
 */

import type { DatasetItem, JsonShapeScorerConfig, ScoreResult, TargetOutput } from '../types';
import { extractJson, hasOwn } from './json';

type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'object') return 'object';
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'null';
}

export interface ShapeDiff {
  missingKeys: string[];
  extraKeys: string[];
  typeMismatches: Array<{ path: string; expected: JsonType; got: JsonType }>;
  /** Keys compared across both sides (missing ones included). */
  comparedKeys: number;
}

/**
 * Compare structure recursively. Arrays are compared by ELEMENT SHAPE, not
 * length or order — a reference with two entries and an output with one is a
 * content difference, not a structural one, and content is the semantic
 * scorer's job.
 */
export function diffShape(expected: unknown, actual: unknown, path = '', diff?: ShapeDiff): ShapeDiff {
  const out: ShapeDiff = diff ?? { missingKeys: [], extraKeys: [], typeMismatches: [], comparedKeys: 0 };
  const et = typeOf(expected);
  const at = typeOf(actual);

  // `null` in the reference tells us nothing about the intended type.
  if (et !== at && et !== 'null') {
    out.typeMismatches.push({ path: path || '$', expected: et, got: at });
    return out;
  }

  if (et === 'object') {
    const e = expected as Record<string, unknown>;
    const a = (actual ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      const child = path ? `${path}.${key}` : key;
      out.comparedKeys += 1;
      if (!hasOwn(a, key)) {
        out.missingKeys.push(child);
        continue;
      }
      diffShape(e[key], a[key], child, out);
    }
    for (const key of Object.keys(a)) {
      if (!hasOwn(e, key)) out.extraKeys.push(path ? `${path}.${key}` : key);
    }
    return out;
  }

  if (et === 'array') {
    const e = expected as unknown[];
    const a = (actual ?? []) as unknown[];
    // Only element shape matters; use the first reference element as the model.
    if (e.length > 0 && a.length > 0) diffShape(e[0], a[0], `${path}[]`, out);
    // An empty output where the reference has elements dropped all the content
    // (an empty list is not a "same shape" answer): count it as a missing key.
    else if (e.length > 0) {
      out.comparedKeys += 1;
      out.missingKeys.push(`${path || '$'}[]`);
    }
    return out;
  }

  return out;
}

const DEFAULT_THRESHOLD = 1;

function skipped(weight: number, reason: string): ScoreResult {
  return { scorerType: 'json-shape', score: 0, passed: false, weight, skipped: true, detail: { reason } };
}

export function scoreJsonShape(
  item: DatasetItem,
  output: TargetOutput,
  config: JsonShapeScorerConfig,
): ScoreResult {
  const weight = config.weight ?? 1;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const reference = item.expected?.reference;

  if (typeof reference !== 'string' || !reference.trim()) {
    return skipped(weight, 'no reference output');
  }
  const expectedJson = extractJson(reference);
  if (!expectedJson.ok || (typeOf(expectedJson.value) !== 'object' && typeOf(expectedJson.value) !== 'array')) {
    // Reference is prose — structure is not part of this item's contract.
    return skipped(weight, 'reference is not JSON');
  }

  const actualJson = extractJson(output.text ?? '');
  if (!actualJson.ok) {
    return {
      scorerType: 'json-shape',
      score: 0,
      passed: false,
      weight,
      detail: { reason: 'expected a JSON response, got unparseable output', error: actualJson.error },
    };
  }

  const diff = diffShape(expectedJson.value, actualJson.value);
  const strictExtras = config.strict === true ? diff.extraKeys.length : 0;
  const problems = diff.missingKeys.length + diff.typeMismatches.length + strictExtras;
  // Score = fraction of the reference's own keys that arrived correctly; in
  // strict mode the keys the reference lacks join both sides of the fraction.
  const denominator = diff.comparedKeys + strictExtras;
  const score = denominator > 0 ? Math.max(0, (denominator - problems) / denominator) : (problems ? 0 : 1);
  const passed = score >= threshold;

  return {
    scorerType: 'json-shape',
    score,
    passed,
    weight,
    detail: {
      missingKeys: diff.missingKeys,
      extraKeys: diff.extraKeys,
      typeMismatches: diff.typeMismatches,
      comparedKeys: diff.comparedKeys,
      ...(passed ? {} : {
        reasoning: [
          diff.missingKeys.length ? `missing: ${diff.missingKeys.join(', ')}` : '',
          strictExtras ? `unexpected: ${diff.extraKeys.join(', ')}` : '',
          diff.typeMismatches.length ? `wrong type: ${diff.typeMismatches.map((m) => `${m.path} expected ${m.expected}, got ${m.got}`).join('; ')}` : '',
        ].filter(Boolean).join(' | '),
      }),
    },
  };
}
