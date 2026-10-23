/** Shared display helpers for decision-model answers in the Analysis screens. */

import type { AnalysisDecisionView, AnalysisFieldType } from './types';

export const FIELD_TYPE_LABELS: Record<AnalysisFieldType, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Yes / No',
  enum: 'Choice',
  score: 'Score',
};

/** Field types a decision model answers (with probabilities) when the definition names one. */
export function isDecisionType(type: AnalysisFieldType): boolean {
  return type === 'boolean' || type === 'enum' || type === 'score';
}

export function formatAnswer(decision: AnalysisDecisionView | undefined): string {
  if (!decision || decision.refused || decision.answer === undefined) return 'Refused';
  if (typeof decision.answer === 'boolean') return decision.answer ? 'Yes' : 'No';
  return decision.answer;
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

export function decisionBadgeClass(decision: AnalysisDecisionView | undefined): string {
  if (!decision || decision.refused || decision.needsReview) return 'ds-badge ds-badge-warn';
  return 'ds-badge ds-badge-teal';
}
