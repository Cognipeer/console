/**
 * Reference-based accuracy scoring — compares extracted field values against
 * ground-truth reference values, per field, type-aware. Only fields present in
 * the reference are compared; the score is matches / comparedCount.
 */

import type { AccuracyResult, FieldAccuracy, FieldSet, FieldType } from './types';

function normalise(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (['true', 'yes', '1'].includes(s)) return true;
        if (['false', 'no', '0'].includes(s)) return false;
      }
      return null;
    }
    default:
      // string + enum: case-insensitive, trimmed comparison
      return String(value).trim().toLowerCase();
  }
}

export function valuesMatch(expected: unknown, actual: unknown, type: FieldType): boolean {
  const e = normalise(expected, type);
  const a = normalise(actual, type);
  if (e === null || a === null) return e === a;
  return e === a;
}

export function scoreAccuracy(
  extracted: Record<string, unknown>,
  reference: Record<string, unknown>,
  fieldSet: FieldSet,
): AccuracyResult {
  const perField: Record<string, FieldAccuracy> = {};
  let matches = 0;
  let compared = 0;

  for (const field of fieldSet) {
    if (!(field.key in reference)) continue;
    compared += 1;
    const expected = reference[field.key];
    const actual = extracted[field.key];
    const match = valuesMatch(expected, actual, field.type);
    perField[field.key] = { expected, actual, match };
    if (match) matches += 1;
  }

  return {
    score: compared === 0 ? 1 : matches / compared,
    perField,
    comparedCount: compared,
  };
}
