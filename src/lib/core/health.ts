/**
 * Health Check Registry
 *
 * Services register health contributors. The health endpoint
 * aggregates all contributors into a single response.
 *
 * Usage:
 *   import { registerHealthCheck, checkHealth } from '@/lib/core/health';
 *
 *   registerHealthCheck('mongodb', async () => {
 *     await db.command({ ping: 1 });
 *     return { status: 'ok' };
 *   });
 *
 *   const report = await checkHealth();
 *   // { status: 'ok', checks: { mongodb: { status: 'ok' } }, uptime: 12345 }
 */

import { createLogger } from './logger';

const log = createLogger('health');

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthCheckResult {
  status: HealthStatus;
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  status: HealthStatus;
  uptime: number;
  timestamp: string;
  checks: Record<string, HealthCheckResult>;
}

export type HealthCheckFn = () => Promise<HealthCheckResult>;

/* ------------------------------------------------------------------ */
/*  Registry                                                          */
/* ------------------------------------------------------------------ */

const healthChecks = new Map<string, HealthCheckFn>();
const startTime = Date.now();

/**
 * Register a named health check contributor.
 */
export function registerHealthCheck(name: string, check: HealthCheckFn): void {
  healthChecks.set(name, check);
}

/**
 * Run all registered health checks and produce a report.
 */
export async function checkHealth(): Promise<HealthReport> {
  const checks: Record<string, HealthCheckResult> = {};
  let overallStatus: HealthStatus = 'ok';

  const entries = Array.from(healthChecks.entries());

  await Promise.all(
    entries.map(async ([name, checkFn]) => {
      const start = Date.now();
      try {
        const result = await checkFn();
        result.latencyMs = Date.now() - start;
        checks[name] = result;

        if (result.status === 'down') {
          overallStatus = 'down';
        } else if (result.status === 'degraded' && overallStatus !== 'down') {
          overallStatus = 'degraded';
        }
      } catch (error) {
        checks[name] = {
          status: 'down',
          message: error instanceof Error ? error.message : String(error),
          latencyMs: Date.now() - start,
        };
        overallStatus = 'down';
        log.error(`Health check "${name}" failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return {
    status: overallStatus,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    checks,
  };
}

/**
 * Simple liveness check — always ok if the process is running.
 */
export function checkLiveness(): { status: 'ok'; uptime: number } {
  return {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}
