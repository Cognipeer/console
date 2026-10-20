/**
 * Guardrails and PII detection fail OPEN when their service is switched off:
 * the call goes through unchecked rather than being refused. That is the
 * operator's decision, so it is made visible — a warning log and one audit
 * event per tenant and service per process — instead of passing silently.
 */

import { createLogger } from '@/lib/core/logger';
import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { runWithTenantScope } from '@/lib/database';
import { recordAuditLog } from '@/lib/services/audit';
import { reportSkippedSafetyCheck, resolveTenantId, serviceOffReason, type ServiceScope } from './serviceAvailability';

const logger = createLogger('service-availability');

export type SafetyService = 'guardrails' | 'pii';

/**
 * True when the safety check for `service` must be skipped for this tenant.
 * The first skip per tenant and service writes the audit event; later ones are
 * silent, so a busy tenant does not fill its audit trail.
 */
export async function safetyCheckSkipped(
  scope: ServiceScope,
  service: SafetyService,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const off = await serviceOffReason(scope, service);
  if (!off) return false;

  const tenantId = await resolveTenantId(scope);
  const tenantKey = tenantId ?? scope.tenantDbName ?? 'unknown';
  const first = reportSkippedSafetyCheck(tenantKey, service, { ...detail, source: off.source, ...(off.via ? { via: off.via } : {}) });
  if (first && scope.tenantDbName && tenantId) {
    const { tenantDbName } = scope;
    criticalFireAndForget('service-safety-check-skipped-audit', () =>
      runWithTenantScope(tenantDbName, () => recordAuditLog(
        { tenantDbName, tenantId },
        {
          actorType: 'system',
          service,
          action: 'security',
          event: 'service.safety_check_skipped',
          // Not a denial: the check did not run, which is what an auditor needs to see.
          outcome: 'failure',
          metadata: {
            service,
            code: off.source === 'env' ? 'service_disabled' : 'service_not_licensed',
            source: off.source,
            ...(off.via ? { via: off.via } : {}),
            ...detail,
          },
        },
      )),
    );
  } else if (first) {
    logger.debug('Safety check skip not audited: no tenant database to write to', { service });
  }
  return true;
}
