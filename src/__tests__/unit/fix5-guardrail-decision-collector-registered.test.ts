/**
 * The community metric registry must serve the four guardrail decision metrics.
 *
 * `GuardrailDecisionCollector` replaced the enterprise-only AegisCollector and
 * reads `guardrail_evaluation_logs`, which every edition writes — but it was
 * registered only in the enterprise overlay's copy of `metrics/index.ts`. In a
 * community build `getCollectorForMetric('guardrail_block_rate')` answered
 * undefined, `collectMetric` logged "No collector" and returned 0, and a rule
 * such as `guardrail_block_rate > 20` could never fire. The `aegis_*` ids
 * persisted on older rules went silent the same way.
 *
 * The overlay file REPLACES this one rather than extending it, so both copies
 * must list the collector; this test pins the community side.
 */

import { describe, expect, it, vi } from 'vitest';

// Sync factory: the collectors bind `getTenantDatabase` from the barrel at
// import time, and an async factory does not intercept in this repo.
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));

import type { AlertMetric } from '@/lib/database';
import { getCollectorForMetric } from '@/lib/services/alerts/metrics';
import { GuardrailDecisionCollector } from '@/lib/services/alerts/metrics/guardrailDecisionCollector';

const DECISION_METRICS: AlertMetric[] = [
  'guardrail_block_rate',
  'guardrail_approval_rate',
  'guardrail_avg_risk_score',
  'guardrail_total_decisions',
];

/** Persisted on rules authored before the rename; still served, never re-authored. */
const LEGACY_ALIASES: AlertMetric[] = [
  'aegis_block_rate',
  'aegis_approval_rate',
  'aegis_avg_risk_score',
  'aegis_total_decisions',
];

describe('community metric registry — guardrail decision metrics', () => {
  it.each(DECISION_METRICS)('resolves %s to the GuardrailDecisionCollector', (metric) => {
    const collector = getCollectorForMetric(metric);
    expect(collector).toBeDefined();
    expect(collector).toBeInstanceOf(GuardrailDecisionCollector);
  });

  it.each(LEGACY_ALIASES)('keeps the persisted alias %s resolvable', (metric) => {
    expect(getCollectorForMetric(metric)).toBeInstanceOf(GuardrailDecisionCollector);
  });

  it('does not let the decision collector shadow the evaluation metrics', () => {
    // Same module, different collector: the three evaluation metrics keep
    // resolving to the collector that reads pass/fail and latency.
    const evaluation = getCollectorForMetric('guardrail_fail_rate');
    expect(evaluation).toBeDefined();
    expect(evaluation).not.toBeInstanceOf(GuardrailDecisionCollector);
  });
});
