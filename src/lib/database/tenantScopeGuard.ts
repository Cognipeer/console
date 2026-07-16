/**
 * Guard for the process-global tenant-handle fallback.
 *
 * `getTenantDb()` prefers the AsyncLocalStorage binding established by
 * `runWithTenant`/`runWithTenantScope`. When a caller never established that
 * scope (bare `switchToTenant` whose `enterWith` binding died at the caller's
 * continuation), it falls back to the process-global handle — which a
 * concurrent request for ANOTHER tenant can overwrite, causing cross-tenant
 * reads/writes. Every such fallback is a latent bug.
 *
 * This module makes those stragglers visible: a rate-limited warning with the
 * offending call stack in normal operation, or a hard throw when
 * `TENANT_SCOPE_STRICT=1` (recommended for dev/CI).
 */

import { createLogger } from '@/lib/core/logger';

const logger = createLogger('database:tenant-scope');

const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;
let suppressedSinceLastWarn = 0;

export function warnGlobalTenantFallback(fallbackDbName: string): void {
  if (process.env.TENANT_SCOPE_STRICT === '1') {
    throw new Error(
      `Tenant query without a runWithTenant scope (would fall back to global handle "${fallbackDbName}"). `
      + 'Wrap the calling entry point in runWithTenantScope().',
    );
  }
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) {
    suppressedSinceLastWarn += 1;
    return;
  }
  lastWarnAt = now;
  const suppressed = suppressedSinceLastWarn;
  suppressedSinceLastWarn = 0;
  // Capture the caller so the unwrapped entry point is identifiable from logs.
  const stack = new Error().stack?.split('\n').slice(2, 8).join('\n');
  logger.warn('Tenant query outside a runWithTenant scope — using process-global fallback', {
    fallbackDbName,
    suppressedSinceLastWarn: suppressed,
    stack,
  });
}
