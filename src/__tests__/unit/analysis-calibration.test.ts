/**
 * Unit tests — analysis calibration: per-question accuracy against human
 * reviews, ECE, score MAE and the suggested review threshold.
 */

import { describe, it, expect } from 'vitest';
import { computeCalibration, type CalibrationResultRow } from '@/lib/services/analysis/calibration';
import type { FieldDef } from '@/lib/services/analysis/types';

const INTENT: FieldDef = { key: 'intent', type: 'enum', enumValues: ['a', 'b'] };
const RESOLVED: FieldDef = { key: 'resolved', type: 'boolean' };
const TONE: FieldDef = { key: 'tone', type: 'score', levels: ['bad', 'ok', 'good'] };
const OPTS = { defaultThreshold: 0.7 };

function row(
  decisions: CalibrationResultRow['decisions'],
  human?: Record<string, unknown>,
  reviewReason?: string,
): CalibrationResultRow {
  return { decisions, review: human ? { values: human } : null, reviewReason };
}

describe('computeCalibration', () => {
  it('returns an empty report without reviews', () => {
    const report = computeCalibration([row({ intent: { answer: 'a', confidence: 0.9 } })], [INTENT], OPTS);
    expect(report).toEqual({
      targetAccuracy: 0.9,
      reviewed: 0,
      spotChecks: 0,
      questions: [
        { key: 'intent', type: 'enum', reviewed: 0, accuracy: null, avgConfidence: null, ece: null, threshold: 0.7, suggestedThreshold: null },
      ],
    });
  });

  it('computes accuracy, mean confidence and ECE for a choice', () => {
    const results = [
      row({ intent: { answer: 'a', confidence: 0.9 } }, { intent: ' A ' }),
      row({ intent: { answer: 'a', confidence: 0.9 } }, { intent: 'b' }),
      row({ intent: { answer: 'b', confidence: 0.55 } }, { intent: 'b' }),
      row({ intent: { answer: 'b', confidence: 0.55 } }, { intent: 'b' }, 'spot_check'),
      row({ intent: { answer: 'b', confidence: 0.99 } }), // not reviewed
    ];
    const report = computeCalibration(results, [INTENT], OPTS);
    const q = report.questions[0];
    expect(report.reviewed).toBe(4);
    expect(report.spotChecks).toBe(1);
    expect(q.reviewed).toBe(4);
    expect(q.accuracy).toBe(0.75);
    expect(q.avgConfidence).toBe(0.725);
    // bucket 9: 2 answers, acc .5, conf .9 -> .4 * .5; bucket 5: 2 answers, acc 1, conf .55 -> .45 * .5
    expect(q.ece).toBe(0.425);
  });

  it('skips refusals and compares booleans leniently', () => {
    const results = [
      row({ resolved: { answer: true, confidence: 0.8 } }, { resolved: 'Yes' }),
      row({ resolved: { answer: false, confidence: 0.8 } }, { resolved: true }),
      row({ resolved: { answer: false, confidence: 0.8 } }, { resolved: 'no' }),
      row({ resolved: { confidence: 0, refused: true } }, { resolved: true }),
    ];
    const q = computeCalibration(results, [RESOLVED], OPTS).questions[0];
    expect(q.reviewed).toBe(3);
    expect(q.accuracy).toBeCloseTo(0.6667, 4);
  });

  it('adds MAE for score questions', () => {
    const results = [
      row({ tone: { answer: 'good', score: 1.6, confidence: 0.6 } }, { tone: 'good' }), // |1.6-2| = .4
      row({ tone: { answer: 'ok', score: 1.0, confidence: 0.6 } }, { tone: 'bad' }), // 1
    ];
    const q = computeCalibration(results, [TONE], OPTS).questions[0];
    expect(q.accuracy).toBe(0.5);
    expect(q.mae).toBe(0.7);
  });

  it('suggests the smallest threshold that reaches the target with enough support', () => {
    const results: CalibrationResultRow[] = [];
    // 10 wrong answers at 0.6, 12 right answers at 0.9.
    for (let i = 0; i < 10; i++) results.push(row({ intent: { answer: 'a', confidence: 0.6 } }, { intent: 'b' }));
    for (let i = 0; i < 12; i++) results.push(row({ intent: { answer: 'a', confidence: 0.9 } }, { intent: 'a' }));
    const q = computeCalibration(results, [INTENT], OPTS).questions[0];
    expect(q.suggestedThreshold).toBe(0.65);
    const strict = computeCalibration(results, [INTENT], { ...OPTS, minSupport: 13 }).questions[0];
    expect(strict.suggestedThreshold).toBeNull();
  });

  it('reports the field threshold override', () => {
    const q = computeCalibration([], [{ ...INTENT, reviewBelow: 0.85 }], OPTS).questions[0];
    expect(q.threshold).toBe(0.85);
  });

  it('ignores non-decision fields', () => {
    const report = computeCalibration([], [{ key: 's', type: 'string' }, { key: 'n', type: 'number' }], OPTS);
    expect(report.questions).toEqual([]);
  });
});
