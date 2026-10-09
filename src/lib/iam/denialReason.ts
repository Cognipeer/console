/**
 * The human-readable reason of a service-level 403, worded once for every mode.
 *
 * Legacy mode has always answered `403 { error: 'Forbidden: mcp requires write
 * permission' }`, and SDKs and the dashboard surface `body.error`. Enforce mode
 * keeps that contract: the very same string is `error` (and `message`), and the
 * structured fields (`code`, `service`, `required`, `decisionId`) ride next to it.
 * Both gates build the sentence here, so the two can never drift apart.
 *
 * Type-only imports on purpose: the legacy gate (fastify-utils.ts) loads this on
 * every request, while enforce.ts, which uses it too, is only loaded for enforce
 * tenants.
 */

import type { PermissionService, ServicePermissionLevel } from '@/lib/security/rbac';

/**
 * `required` is optional only because the legacy verdict types it so (it is
 * absent solely on an allowed request that resolves to no service); a denial
 * always carries it.
 */
export function serviceDenialReason(
  service: PermissionService,
  required: ServicePermissionLevel | undefined,
): string {
  return `Forbidden: ${service} requires ${required} permission`;
}
