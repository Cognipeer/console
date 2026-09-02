/**
 * Metric collector registry.
 *
 * Maps metric names to the collector that can resolve them.
 */

import type { AlertMetric } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';

const logger = createLogger('alert-metrics');
import { ModelUsageCollector } from './modelUsageCollector';
import { InferenceServerCollector } from './inferenceServerCollector';
import { GuardrailCollector } from './guardrailCollector';
import { RagCollector } from './ragCollector';
import { McpCollector } from './mcpCollector';
import { AnalysisCollector } from './analysisCollector';
import { EvaluationCollector } from './evaluationCollector';
import { RedTeamCollector } from './redTeamCollector';
// Hook-plane decisions (block rate, approval rate, risk score, total). Serves
// the four `guardrail_*` decision metrics and their persisted `aegis_*` aliases
// from `guardrail_evaluation_logs`, which every edition writes. The enterprise
// overlay's copy of this file lists it too — that file REPLACES this one, so
// both must register it or one edition silently loses the four metrics
// (`collectMetric` answers 0 for an unregistered metric and the rule never fires).
import { GuardrailDecisionCollector } from './guardrailDecisionCollector';

const collectors: IMetricCollector[] = [];

function register(collector: IMetricCollector): void {
  collectors.push(collector);
}

export function getCollectorForMetric(metric: AlertMetric): IMetricCollector | undefined {
  return collectors.find((c) => c.supportedMetrics.includes(metric));
}

export async function collectMetric(query: MetricQuery): Promise<MetricResult> {
  const collector = getCollectorForMetric(query.metric);
  if (!collector) {
    logger.warn(`No collector for metric "${query.metric}"`);
    return { value: 0, sampleCount: 0 };
  }
  return collector.collect(query);
}

// Auto-register built-in collectors
register(new ModelUsageCollector());
register(new InferenceServerCollector());
register(new GuardrailCollector());
register(new RagCollector());
register(new McpCollector());
register(new AnalysisCollector());
register(new EvaluationCollector());
register(new RedTeamCollector());
register(new GuardrailDecisionCollector());

export type { IMetricCollector, MetricQuery, MetricResult } from './types';
