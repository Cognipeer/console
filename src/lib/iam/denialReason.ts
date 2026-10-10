/**
 * The human-readable reason of a service-level 403.
 *
 * The API has always answered `403 { error: 'Forbidden: mcp requires write
 * permission' }`, and SDKs and the dashboard surface `body.error`. The engine
 * keeps that contract: the very same string is `error` (and `message`), and the
 * structured fields (`code`, `service`, `required`, `decisionId`) ride next to it.
 * Everything that words a service denial builds the sentence here, so the
 * wordings can never drift apart.
 *
 * Type-only imports on purpose: this file stays free of the engine.
 */

import type { PermissionService, ServicePermissionLevel } from '@/lib/security/rbac';

/**
 * `required` is optional only so that a caller holding a partial verdict can
 * still call this; a denial always carries it.
 */
export function serviceDenialReason(
  service: PermissionService,
  required: ServicePermissionLevel | undefined,
): string {
  return `Forbidden: ${service} requires ${required} permission`;
}
