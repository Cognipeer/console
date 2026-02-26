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

export type { IMetricCollector, MetricQuery, MetricResult } from './types';
