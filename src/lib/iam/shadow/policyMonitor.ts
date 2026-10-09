/**
 * Monitor-mode policy findings (A5): when a policy in `monitor` mode would
 * change the decision of a request, count it - per policy, route and direction -
 * in the shadow aggregates, wherever the engine decides or observes:
 *
 *   - enforce tenants: enforce.ts records the engine's real decision;
 *   - shadow tenants: shadow/evaluate.ts records the evaluation it already runs.
 *
 * Never from simulate / preview (those would double count and are not traffic).
 * Synchronous, never throws, adds nothing to the request path but a Map update.
 */

import type { AuthorizeResult } from '../engine';
import { recordShadowEvent } from './aggregate';
import { POLICY_MONITOR_CATEGORY } from './types';

export interface PolicyMonitorSubject {
  service: string;
  method: string;
  /** Canonical route pattern (ids masked), as for the other shadow findings. */
  route: string;
  requestId: string;
  /** Session user, or the token OWNER. */
  userId: string;
  tokenId?: string;
  role: string;
}

/** Direction of a flip: the decision in force -> what the monitor policy would make it. */
export function monitorDirection(legacyAllowed: boolean, targetAllowed: boolean): 'allow-to-deny' | 'deny-to-allow' | 'none' {
  if (legacyAllowed === targetAllowed) return 'none';
  return legacyAllowed ? 'allow-to-deny' : 'deny-to-allow';
}

export function recordPolicyMonitor(
  tenantDbName: string,
  result: Pick<AuthorizeResult, 'allowed' | 'monitor'>,
  subject: PolicyMonitorSubject,
): void {
  try {
    const monitor = result.monitor;
    if (!monitor || !monitor.differs) return;
    const policyIds = monitor.policyIds.length > 0 ? monitor.policyIds : ['(unknown)'];
    const at = new Date().toISOString();
    for (const policyId of policyIds) {
      recordShadowEvent(tenantDbName, {
        category: POLICY_MONITOR_CATEGORY,
        service: subject.service,
        method: subject.method.toUpperCase(),
        route: subject.route,
        legacyAllowed: result.allowed,
        targetAllowed: monitor.allowed,
        policyId,
        sample: {
          requestId: subject.requestId,
          userId: subject.userId,
          tokenId: subject.tokenId,
          role: subject.role,
          at,
          detail: monitor.allowed ? 'the monitor policy would allow this request' : 'the monitor policy would deny this request',
        },
      });
    }
  } catch {
    // diagnostics only
  }
}
