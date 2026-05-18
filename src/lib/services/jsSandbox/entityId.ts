/** Stable identifier for a JS sandbox runtime in cluster assignments. */
export function jsSandboxEntityId(tenantId: string, runtimeIdOrKey: string): string {
  return `${tenantId}:${runtimeIdOrKey}`;
}
