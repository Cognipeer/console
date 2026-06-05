/**
 * Stable identifier for an agent in the cluster instance-assignment table.
 *
 * Scoped with tenantId so that two tenants with the same agent key do not
 * share an assignment. Assignments survive renames of the display name
 * because they key on the user-facing `key` field which is stable.
 */
export function agentEntityId(tenantId: string, agentKey: string): string {
  return `${tenantId}:${agentKey}`;
}
