/**
 * proportionOf: the exact numerator / denominator behind every percentage
 * entity metric. computeEntityMetric derives from it, so a baseline that weighs
 * a rate by its denominator always sees the same counts as the alert formula.
 */

import { describe, expect, it } from 'vitest';
import type { EntityMetricCounters } from '@/lib/database/provider/types.base';
import { emptyCounters } from '@/lib/services/entityMetrics/latencyHistogram';
import { computeEntityMetric, proportionOf } from '@/lib/services/entityMetrics/entityMetricsQuery';
import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';

function counters(partial: Partial<EntityMetricCounters>): EntityMetricCounters {
  return { ...emptyCounters(), ...partial };
}

// Distinct values per counter so a wrong numerator or denominator cannot pass by coincidence.
const SAMPLE = counters({
  requests: 200,
  errors: 13,
  cancelled: 20,
  toolCalls: 90,
  toolErrors: 7,
  aiCalls: 150,
  aiErrors: 11,
  abandoned: 17,
  emptyResults: 29,
});

const EXPECTED: Record<string, { num: number; den: number }> = {
  agent_error_rate: { num: 13, den: 200 },
  agent_tool_error_rate: { num: 7, den: 90 },
  agent_ai_error_rate: { num: 11, den: 150 },
  agent_abandoned_rate: { num: 17, den: 200 },
  model_error_rate: { num: 13, den: 180 },
  kb_error_rate: { num: 13, den: 200 },
  kb_empty_result_rate: { num: 29, den: 187 },
  mcp_server_error_rate: { num: 13, den: 200 },
  tool_error_rate: { num: 13, den: 200 },
};

const entityMetrics = ALERT_METRIC_CATALOG.filter((def) => def.source === 'entity');
const percentMetrics = entityMetrics.filter((def) => def.unit === '%');

describe('proportionOf', () => {
  it('covers every percentage entity metric in the catalog and nothing else', () => {
    expect(percentMetrics.map((def) => def.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const def of percentMetrics) {
    it(`${def.id}: counts match the metric value and sample count`, () => {
      const proportion = proportionOf(def.id, SAMPLE);
      expect(proportion).toEqual(EXPECTED[def.id]);
      const computed = computeEntityMetric(def.id, SAMPLE);
      expect(computed.value).toBeCloseTo((100 * proportion!.num) / proportion!.den, 10);
      expect(computed.sampleCount).toBe(proportion!.den);
    });

    it(`${def.id}: empty denominator gives zero counts and a null value`, () => {
      expect(proportionOf(def.id, emptyCounters())).toEqual({ num: 0, den: 0 });
      expect(computeEntityMetric(def.id, emptyCounters())).toEqual({ value: null, sampleCount: 0 });
    });
  }

  it('clamps the numerator to the denominator like the percentage does', () => {
    const lateCorrections = counters({ requests: 4, errors: 9 });
    expect(proportionOf('agent_error_rate', lateCorrections)).toEqual({ num: 4, den: 4 });
    expect(computeEntityMetric('agent_error_rate', lateCorrections).value).toBe(100);
  });

  it('is null for metrics that are not a ratio of two counters', () => {
    for (const def of entityMetrics.filter((m) => m.unit !== '%')) {
      expect(proportionOf(def.id, SAMPLE)).toBeNull();
    }
    expect(proportionOf('guardrail_fail_rate', SAMPLE)).toBeNull();
  });
});
