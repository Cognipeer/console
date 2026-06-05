/** Stable identifier for an MCP server in the cluster assignment table. */
export function mcpEntityId(tenantId: string, mcpKey: string): string {
  return `${tenantId}:${mcpKey}`;
}
