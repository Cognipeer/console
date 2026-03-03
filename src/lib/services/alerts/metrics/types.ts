/**
 * Metric collector interface.
 *
 * Each collector knows how to query a specific domain (model usage,
 * inference server metrics, …) and aggregate the requested metric over
 * a given time window.
 */

import type { AlertMetric } from '@/lib/database';

export interface MetricQuery {
  tenantDbName: string;
  tenantId: string;
  metric: AlertMetric;
  windowMinutes: number;
  scope?: {
    modelKey?: string;
    serverKey?: string;
    guardrailKey?: string;
    ragModuleKey?: string;
    mcpServerKey?: string;
    projectId?: string;
  };
}

export interface MetricResult {
  value: number;
  sampleCount: number;
}

export interface IMetricCollector {
  /** The metric names this collector can handle */
  readonly supportedMetrics: AlertMetric[];

  /** Compute the metric value for the given query */
  collect(query: MetricQuery): Promise<MetricResult>;
}
