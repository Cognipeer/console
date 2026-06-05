import type { IInferenceServer, IInferenceServerMetrics } from '@/lib/database';
import type { VllmMetricsSnapshot } from './vllmPoller';

/**
 * Parse Prometheus-style text output.
 * Identical helper to the one in vllmPoller; kept local to avoid coupling.
 */
function parsePrometheusMetrics(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+([\d.eE+-]+|NaN|Inf|-Inf)$/,
    );
    if (match) {
      const val = parseFloat(match[2]);
      if (!isNaN(val)) {
        result[match[1]] = val;
      }
    }
  }
  return result;
}

function get(raw: Record<string, number>, key: string, fallback = 0): number {
  return raw[key] ?? fallback;
}

/**
 * Map llama.cpp Prometheus metrics to a VllmMetricsSnapshot shape so the
 * rest of the pipeline (snapshotToMetrics, UI cards) works unchanged.
 *
 * Metric mapping
 * ─────────────────────────────────────────────────────────
 * numRequestsRunning        ← llamacpp:requests_processing
 * numRequestsWaiting        ← llamacpp:requests_deferred
 * gpuCacheUsagePercent      ← (not available → 0)
 * cpuCacheUsagePercent      ← (not available → 0)
 * promptTokensThroughput    ← llamacpp:prompt_tokens_seconds   (tok/s gauge)
 * generationTokensThroughput← llamacpp:predicted_tokens_seconds (tok/s gauge)
 * timeToFirstTokenSeconds   ← llamacpp:prompt_seconds_total / llamacpp:n_decode_total
 * timePerOutputTokenSeconds ← llamacpp:tokens_predicted_seconds_total / llamacpp:tokens_predicted_total
 * e2eRequestLatencySeconds  ← (sum of prompt + predict per decode, best approximation)
 * requestsPerSecond         ← llamacpp:n_decode_total (cumulative count; live rate not available)
 */
function snapshotFromLlamaCpp(raw: Record<string, number>): VllmMetricsSnapshot {
  const promptSec = get(raw, 'llamacpp:prompt_seconds_total');
  const promptTok = get(raw, 'llamacpp:prompt_tokens_total');
  const predictSec = get(raw, 'llamacpp:tokens_predicted_seconds_total');
  const predictTok = get(raw, 'llamacpp:tokens_predicted_total');
  const nDecode = get(raw, 'llamacpp:n_decode_total');

  const timeToFirstToken = promptTok > 0 ? promptSec / promptTok : 0;
  const timePerOutputToken = predictTok > 0 ? predictSec / predictTok : 0;
  const e2eLatency = nDecode > 0 ? (promptSec + predictSec) / nDecode : 0;

  return {
    numRequestsRunning: get(raw, 'llamacpp:requests_processing'),
    numRequestsWaiting: get(raw, 'llamacpp:requests_deferred'),
    gpuCacheUsagePercent: 0,
    cpuCacheUsagePercent: 0,
    promptTokensThroughput: get(raw, 'llamacpp:prompt_tokens_seconds'),
    generationTokensThroughput: get(raw, 'llamacpp:predicted_tokens_seconds'),
    timeToFirstTokenSeconds: timeToFirstToken,
    timePerOutputTokenSeconds: timePerOutputToken,
    e2eRequestLatencySeconds: e2eLatency,
    requestsPerSecond: nDecode,
    runningModels: [],
    raw,
  };
}

/**
 * Poll a llama.cpp server's /metrics endpoint and return a VllmMetricsSnapshot.
 */
export async function pollLlamaCppServer(
  server: IInferenceServer,
): Promise<VllmMetricsSnapshot> {
  const parsed = new URL('/metrics', server.baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are supported for polling');
  }

  const headers: Record<string, string> = { Accept: 'text/plain' };
  if (server.apiKey) {
    headers['Authorization'] = `Bearer ${server.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(parsed.toString(), {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `llama.cpp server returned ${response.status}: ${response.statusText}`,
      );
    }

    const text = await response.text();
    const raw = parsePrometheusMetrics(text);
    return snapshotFromLlamaCpp(raw);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert a VllmMetricsSnapshot into an IInferenceServerMetrics document.
 * (Identical shape; reuse snapshotToMetrics from vllmPoller.)
 */
export { snapshotToMetrics } from './vllmPoller';

export type { VllmMetricsSnapshot } from './vllmPoller';

/**
 * Convert llama.cpp snapshot directly to a storable metrics document.
 */
export function llamaCppSnapshotToMetrics(
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
