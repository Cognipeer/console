/**
 * Calibration — how often the decision model agrees with the human review,
 * per question, and the confidence threshold that would reach a target
 * accuracy. Pure: it takes reviewed result rows and the field-set.
 */

import type { FieldDef } from './types';

/** The slice of a stored result the calibration reads (kept structural: the engine has no DB imports). */
export interface CalibrationResultRow {
  decisions: Record<
    string,
    { answer?: string | boolean; score?: number; confidence: number; refused?: boolean }
  >;
  review?: { values: Record<string, unknown> } | null;
  reviewReason?: string;
}

export interface CalibrationQuestion {
  key: string;
  type: 'enum' | 'boolean' | 'score';
  /** Reviewed answers compared for this question (refusals excluded). */
  reviewed: number;
  accuracy: number | null;
  avgConfidence: number | null;
  /** Expected calibration error over 10 equal-width confidence buckets. */
  ece: number | null;
  /** `score` only: mean absolute distance between the model's expected level and the human's. */
  mae?: number | null;
  /** The field's effective review threshold. */
  threshold: number;
  /** Smallest threshold (0.50 to 0.95) whose answers reach the target accuracy with enough support. */
  suggestedThreshold: number | null;
}

export interface CalibrationReport {
  targetAccuracy: number;
  reviewed: number;
  spotChecks: number;
  questions: CalibrationQuestion[];
}

const BUCKETS = 10;
const CANDIDATE_THRESHOLDS = Array.from({ length: 10 }, (_, i) => Math.round((0.5 + i * 0.05) * 100) / 100);

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function roundOrNull(n: number | null): number | null {
  return n === null ? null : round4(n);
}

function toBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null;
}

function norm(value: unknown): string {
  return String(value).trim().toLowerCase();
}

/**
 * Per decision question (Choice, Yes / No, Score): accuracy against the human
 * answers, mean confidence, ECE, and a suggested review threshold.
 */
export function computeCalibration(
  results: CalibrationResultRow[],
  fieldSet: FieldDef[],
  opts: { defaultThreshold: number; targetAccuracy?: number; minSupport?: number },
): CalibrationReport {
  const targetAccuracy = opts.targetAccuracy ?? 0.9;
  const minSupport = opts.minSupport ?? 10;
  const reviewedRows = results.filter((r) => r.review);

  const questions: CalibrationQuestion[] = [];
  for (const field of fieldSet) {
    if (field.type !== 'enum' && field.type !== 'boolean' && field.type !== 'score') continue;

    const pairs: Array<{ confidence: number; match: boolean; absError?: number }> = [];
    for (const row of reviewedRows) {
      const human = row.review?.values?.[field.key];
      const decision = row.decisions?.[field.key];
      if (human === undefined || human === null || !decision || decision.refused || decision.answer === undefined) continue;

      let match: boolean;
      let absError: number | undefined;
      if (field.type === 'boolean') {
        match = toBool(human) === decision.answer;
      } else {
        match = norm(human) === norm(decision.answer);
        if (field.type === 'score' && typeof decision.score === 'number') {
          const index = (field.levels ?? []).findIndex((l) => norm(l) === norm(human));
          if (index >= 0) absError = Math.abs(decision.score - index);
        }
      }
      pairs.push({ confidence: decision.confidence, match, absError });
    }

    const n = pairs.length;
    const accuracy = n ? pairs.filter((p) => p.match).length / n : null;
    const avgConfidence = n ? pairs.reduce((s, p) => s + p.confidence, 0) / n : null;

    let ece: number | null = null;
    if (n) {
      const buckets = Array.from({ length: BUCKETS }, () => ({ n: 0, hits: 0, conf: 0 }));
      for (const p of pairs) {
        const b = buckets[Math.min(BUCKETS - 1, Math.max(0, Math.floor(p.confidence * BUCKETS)))];
        b.n += 1;
        b.conf += p.confidence;
        if (p.match) b.hits += 1;
      }
      ece = buckets.reduce((s, b) => (b.n ? s + (b.n / n) * Math.abs(b.hits / b.n - b.conf / b.n) : s), 0);
    }

    let suggestedThreshold: number | null = null;
    for (const t of CANDIDATE_THRESHOLDS) {
      const kept = pairs.filter((p) => p.confidence >= t - 1e-9);
      if (kept.length >= minSupport && kept.filter((p) => p.match).length / kept.length >= targetAccuracy) {
        suggestedThreshold = t;
        break;
      }
    }

    const question: CalibrationQuestion = {
      key: field.key,
      type: field.type,
      reviewed: n,
      accuracy: roundOrNull(accuracy),
      avgConfidence: roundOrNull(avgConfidence),
      ece: roundOrNull(ece),
      threshold: field.reviewBelow ?? opts.defaultThreshold,
      suggestedThreshold,
    };
    if (field.type === 'score') {
      const errors = pairs.map((p) => p.absError).filter((e): e is number => e !== undefined);
      question.mae = errors.length ? round4(errors.reduce((s, e) => s + e, 0) / errors.length) : null;
    }
    questions.push(question);
  }

  return {
    targetAccuracy,
    reviewed: reviewedRows.length,
    spotChecks: reviewedRows.filter((r) => r.reviewReason === 'spot_check').length,
    questions,
  };
}
