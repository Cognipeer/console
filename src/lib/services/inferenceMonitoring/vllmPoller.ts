import type { IInferenceServer, IInferenceServerMetrics } from '@/lib/database';

/**
 * Parsed vLLM metrics from the /metrics Prometheus endpoint.
 */
export interface VllmMetricsSnapshot {
  numRequestsRunning: number;
  numRequestsWaiting: number;
  gpuCacheUsagePercent: number;
  cpuCacheUsagePercent: number;
  promptTokensThroughput: number;
  generationTokensThroughput: number;
  timeToFirstTokenSeconds: number;
  timePerOutputTokenSeconds: number;
  e2eRequestLatencySeconds: number;
  requestsPerSecond: number;
  runningModels: string[];
  raw: Record<string, number>;
}

/**
 * Parse Prometheus-style text output from vLLM /metrics endpoint.
 */
function parsePrometheusMetrics(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // format: metric_name{labels} value  or  metric_name value
    const match = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+([\d.eE+-]+|NaN|Inf|-Inf)$/);
    if (match) {
      const val = parseFloat(match[2]);
      if (!isNaN(val)) {
        result[match[1]] = val;
      }
    }
  }
  return result;
}

function extractGauge(raw: Record<string, number>, prefix: string): number {
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith(prefix) && !key.includes('_total') && !key.includes('_bucket') && !key.includes('_count') && !key.includes('_sum')) {
      return val;
    }
  }
  return 0;
}

function extractHistogramAvg(raw: Record<string, number>, prefix: string): number {
  let sum = 0;
  let count = 0;
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith(prefix + '_sum')) sum = val;
    if (key.startsWith(prefix + '_count')) count = val;
  }
  return count > 0 ? sum / count : 0;
}

function extractRunningModels(raw: Record<string, number>): string[] {
  const models = new Set<string>();
  for (const key of Object.keys(raw)) {
    const match = key.match(/model_name="([^"]+)"/);
    if (match) {
      models.add(match[1]);
    }
  }
  return Array.from(models);
}

/**
 * Poll a vLLM server's /metrics endpoint and parse the response.
 */
export async function pollVllmServer(
  server: IInferenceServer,
): Promise<VllmMetricsSnapshot> {
  const url = new URL('/metrics', server.baseUrl).toString();

  const headers: Record<string, string> = { Accept: 'text/plain' };
  if (server.apiKey) {
    headers['Authorization'] = `Bearer ${server.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`vLLM server returned ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    const raw = parsePrometheusMetrics(text);

    return {
      numRequestsRunning: extractGauge(raw, 'vllm:num_requests_running'),
      numRequestsWaiting: extractGauge(raw, 'vllm:num_requests_waiting'),
      gpuCacheUsagePercent: extractGauge(raw, 'vllm:gpu_cache_usage_perc'),
      cpuCacheUsagePercent: extractGauge(raw, 'vllm:cpu_cache_usage_perc'),
      promptTokensThroughput: extractGauge(raw, 'vllm:prompt_tokens_total')
        || extractGauge(raw, 'vllm:avg_prompt_throughput_toks_per_s'),
      generationTokensThroughput: extractGauge(raw, 'vllm:generation_tokens_total')
        || extractGauge(raw, 'vllm:avg_generation_throughput_toks_per_s'),
      timeToFirstTokenSeconds: extractHistogramAvg(raw, 'vllm:time_to_first_token_seconds')
        || extractHistogramAvg(raw, 'vllm:e2e_time_to_first_token_seconds'),
      timePerOutputTokenSeconds: extractHistogramAvg(raw, 'vllm:time_per_output_token_seconds')
        || extractHistogramAvg(raw, 'vllm:e2e_time_per_output_token_seconds'),
      e2eRequestLatencySeconds: extractHistogramAvg(raw, 'vllm:e2e_request_latency_seconds'),
      requestsPerSecond: extractGauge(raw, 'vllm:request_success')
        || extractGauge(raw, 'vllm:request_success_total'),
      runningModels: extractRunningModels(raw),
      raw,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert a VllmMetricsSnapshot into an IInferenceServerMetrics document (without _id / createdAt).
 */
export function snapshotToMetrics(
  tenantId: string,
  serverKey: string,
  snapshot: VllmMetricsSnapshot,
): Omit<IInferenceServerMetrics, '_id' | 'createdAt'> {
  return {
    tenantId,
    serverKey,
    timestamp: new Date(),
    numRequestsRunning: snapshot.numRequestsRunning,
    numRequestsWaiting: snapshot.numRequestsWaiting,
    gpuCacheUsagePercent: snapshot.gpuCacheUsagePercent,
    cpuCacheUsagePercent: snapshot.cpuCacheUsagePercent,
    promptTokensThroughput: snapshot.promptTokensThroughput,
    generationTokensThroughput: snapshot.generationTokensThroughput,
    timeToFirstTokenSeconds: snapshot.timeToFirstTokenSeconds,
    timePerOutputTokenSeconds: snapshot.timePerOutputTokenSeconds,
    e2eRequestLatencySeconds: snapshot.e2eRequestLatencySeconds,
    requestsPerSecond: snapshot.requestsPerSecond,
    runningModels: snapshot.runningModels,
    raw: snapshot.raw,
  };
}
