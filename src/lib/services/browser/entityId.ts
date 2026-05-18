/**
 * Stable identifier for a Browser definition in cluster assignments.
 *
 * Note: live browser sessions are sticky to the node that created them
 * (Playwright contexts live in that process). If the assignment for a
 * browser is changed while sessions are open, those sessions stay on
 * the original node until they're closed or reaped.
 */
export function browserEntityId(tenantId: string, browserId: string): string {
  return `${tenantId}:${browserId}`;
}
