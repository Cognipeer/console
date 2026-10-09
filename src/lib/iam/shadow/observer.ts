/**
 * Request-gate hooks of shadow mode. This is the ONLY file the legacy gates
 * (enforceSessionRbac / enforceApiTokenRbac in fastify-utils.ts) touch.
 *
 * Contract, relied on by the "shadow never changes responses" tests:
 *  - synchronous, returns void, NEVER throws, never awaits anything;
 *  - while the tenant mode is `legacy` (the default) the cost is one Map lookup
 *    and the observation is not even built (callers pass a lazy factory);
 *  - IAM_SHADOW_DISABLED=1 (kill switch) behaves exactly like `legacy`;
 *  - IAM_SHADOW_SAMPLE_RATE (0..1, default 1) samples gate evaluations, and the
 *    rate drops to a quarter while the queue is more than half full;
 *  - in `shadow` mode (and in `enforce`, where it is the legacy-vs-engine audit
 *    trail) the work is queued (bounded, droppable) and the heavy
 *    evaluation module — Cedar, entity builders — is imported on first use, so
 *    a legacy-mode process never loads the WASM engine for this.
 */

import { createLogger } from '@/lib/core/logger';
import { recordShadowEvent } from './aggregate';
import { peekAuthzMode, recordsShadow } from './mode';
import { MAX_QUEUE, getShadowQueueDepth, submitShadowJob } from './queue';
import type { GateObservation, UnmappedObservation } from './types';

const logger = createLogger('iam:shadow');

function swallow(error: unknown): void {
  try {
    logger.debug('Shadow observation skipped', { error: error instanceof Error ? error.message : String(error) });
  } catch {
    // nothing may escape into the request path
  }
}

function sampleRate(): number {
  const raw = process.env.IAM_SHADOW_SAMPLE_RATE;
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function shouldSample(): boolean {
  let rate = sampleRate();
  if (rate >= 1 && getShadowQueueDepth().queued <= MAX_QUEUE / 2) return true;
  if (getShadowQueueDepth().queued > MAX_QUEUE / 2) rate *= 0.25;
  return Math.random() < rate;
}

/** A mapped request whose legacy decision has just been computed. */
export function observeGateDecision(tenantDbName: string, build: () => GateObservation): void {
  try {
    if (!recordsShadow(peekAuthzMode(tenantDbName))) return;
    if (!shouldSample()) return;
    const observation = build();
    submitShadowJob(async () => {
      const { evaluateGateObservation } = await import('./evaluate');
      await evaluateGateObservation(observation);
    }, tenantDbName);
  } catch (error) {
    swallow(error);
  }
}

/**
 * An authenticated request to a route that is neither declared nor mapped to a
 * permission service ("undeclared"): enforce mode refuses it (403
 * route_not_declared), so this is where the report shows what that would hit.
 */
export function observeUnmappedPath(tenantDbName: string, build: () => UnmappedObservation): void {
  try {
    if (!recordsShadow(peekAuthzMode(tenantDbName))) return;
    const o = build();
    recordShadowEvent(tenantDbName, {
      category: 'unmapped-path',
      service: '(none)',
      method: o.method,
      route: o.route,
      // Today nothing gates it; a default-deny target would need a mapping first.
      legacyAllowed: true,
      targetAllowed: false,
      sample: {
        requestId: o.requestId,
        userId: o.userId,
        tokenId: o.tokenId,
        role: o.role,
        at: new Date().toISOString(),
      },
    });
  } catch (error) {
    swallow(error);
  }
}
