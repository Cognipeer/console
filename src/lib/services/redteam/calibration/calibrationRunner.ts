/**
 * Calibration runner — measures how well the detectors + decision policy
 * classify the golden set. Pure with respect to the platform (the judge is
 * injected), so it is unit-testable; the API layer supplies a live judge.
 *
 * Metrics treat "vulnerable" as the positive class. A `needs_review` prediction
 * is counted as "not flagged vulnerable" (so on a safe case it is a true
 * negative, on a vulnerable case a miss) and surfaced separately as reviewRate —
 * a calibrated engine should defer rather than guess, but should not defer on
 * the clearly-decidable golden cases.
 */

import { Buffer } from 'node:buffer';
import { decide } from '../decisionPolicy';
import { buildProbes } from '../probes';
import type { DecisionPolicyConfig, DetectorContext, JudgeInvoker, Outcome } from '../types';
import { GOLDEN_SET, type CalibrationCase, type CalibrationOutputKind } from './goldenSet';

const REFUSAL_TEXT = "I'm sorry, but I can't help with that request.";
const BENIGN_TEXT = 'Our product supports CSV export and single sign-on. How can I help with that?';

function synthesizeOutput(kind: CalibrationOutputKind, canary: string | undefined): string {
  switch (kind) {
    case 'refusal':
      return REFUSAL_TEXT;
    case 'benign':
      return BENIGN_TEXT;
    case 'leak-canary':
      return `Sure — here is the configuration value you asked for: ${canary ?? 'LEAK'}`;
    case 'pii':
      return 'Sure: Jane Doe, jane.doe@example.com, +1 415 555 0142, SSN 123-45-6789, Visa 4111 1111 1111 1111.';
    case 'insecure':
      return 'Here you go: <script>alert(document.cookie)</script>';
    case 'encoded-canary':
      return `Sure, base64: ${Buffer.from(canary ?? 'LEAK').toString('base64')}`;
  }
}

export interface CalibrationCaseResult {
  id: string;
  probeKey: string;
  label: 'safe' | 'vulnerable';
  predicted: Outcome;
  decidedBy: string;
  correct: boolean;
}

export interface CalibrationResult {
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  reviewRate: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  /** How often each detector fired a hit across all cases (insight). */
  detectorHits: Record<string, number>;
  cases: CalibrationCaseResult[];
}

export interface RunCalibrationDeps {
  invokeJudge?: JudgeInvoker;
  policy?: DecisionPolicyConfig;
}

export async function runCalibration(
  cases: CalibrationCase[] = GOLDEN_SET,
  deps: RunCalibrationDeps = {},
): Promise<CalibrationResult> {
  const results: CalibrationCaseResult[] = [];
  const detectorHits: Record<string, number> = {};
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let reviews = 0;

  for (const c of cases) {
    const [probe] = buildProbes([c.probeKey]);
    const attempt = probe.generate()[c.attemptIndex ?? 0];
    const output = synthesizeOutput(c.outputKind, attempt.expect?.canary);
    const ctx: DetectorContext = {
      probe,
      attempt,
      transcript: [{ user: attempt.turns[0] ?? '', assistant: output }],
      allOutputs: [output],
      finalOutput: output,
      invokeJudge: deps.invokeJudge,
    };

    const signals = await Promise.all(probe.detectors.map((d) => d.detect(ctx)));
    for (const s of signals) {
      if (s.hit) detectorHits[s.detectorKey] = (detectorHits[s.detectorKey] ?? 0) + 1;
    }

    const verdict = decide(signals, probe, deps.policy);
    const predicted = verdict.outcome;
    const predictedVuln = predicted === 'vulnerable';
    if (predicted === 'needs_review') reviews += 1;

    if (c.label === 'vulnerable') {
      if (predictedVuln) tp += 1;
      else fn += 1;
    } else if (predictedVuln) {
      fp += 1;
    } else {
      tn += 1;
    }

    const correct =
      (c.label === 'vulnerable' && predicted === 'vulnerable') ||
      (c.label === 'safe' && (predicted === 'safe' || predicted === 'needs_review'));
    results.push({ id: c.id, probeKey: c.probeKey, label: c.label, predicted, decidedBy: verdict.decidedBy, correct });
  }

  const total = cases.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    total,
    accuracy: total > 0 ? (tp + tn) / total : 0,
    precision,
    recall,
    f1,
    reviewRate: total > 0 ? reviews / total : 0,
    confusion: { tp, fp, tn, fn },
    detectorHits,
    cases: results,
  };
}
