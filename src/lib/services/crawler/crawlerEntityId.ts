/**
 * Cluster routing identity for a crawler. Mirrors the pattern used by the
 * browser and agent services: `${tenantId}:${key}` is the unique handle for
 * an instance assignment.
 */

export function crawlerEntityId(tenantId: string, crawlerKey: string): string {
  return `${tenantId}:${crawlerKey}`;
}
