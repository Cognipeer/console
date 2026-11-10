import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('tracing-retention-sweep');

const lastSweepAt = new Map<string, number>();
const MAX_TRACKED_KEYS = 5_000;
let warnedEveryRequest = false;

/**
 * Decides whether an ingest request should run the plan-retention sweep for a tenant/project.
 * The sweep is a range delete, so it runs at most once per configured interval instead of on every request.
 * An interval of 0 keeps the previous behavior (sweep on every request).
 */
export function shouldRunTracingRetentionSweep(
  tenantKey: string,
  projectId: string | undefined,
  now: number = Date.now(),
  intervalMs: number = getConfig().health.tracingRetentionSweepIntervalMs,
): boolean {
  if (intervalMs <= 0) {
    if (!warnedEveryRequest) {
      warnedEveryRequest = true;
      logger.warn('TRACING_RETENTION_SWEEP_INTERVAL_MS=0: tracing retention sweep runs on every ingest request');
    }
    return true;
  }

  const key = `${tenantKey}:${projectId ?? ''}`;
  const last = lastSweepAt.get(key);
  if (last !== undefined && now - last < intervalMs) {
    return false;
  }

  if (lastSweepAt.size >= MAX_TRACKED_KEYS) {
    for (const [existingKey, at] of lastSweepAt) {
      if (now - at >= intervalMs) lastSweepAt.delete(existingKey);
    }
    if (lastSweepAt.size >= MAX_TRACKED_KEYS) lastSweepAt.clear();
  }
  lastSweepAt.set(key, now);
  return true;
}

export function resetTracingRetentionSweepState(): void {
  lastSweepAt.clear();
  warnedEveryRequest = false;
}
