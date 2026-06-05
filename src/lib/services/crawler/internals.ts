/**
 * Shared helpers used across crawlerService / crawlerJobService.
 * Kept private to the crawler module.
 */

export function matchesProjectScope(
  recordProjectId: string | undefined,
  ctxProjectId: string | undefined,
): boolean {
  // When the request carries a project context, the record must match.
  // Tenant-wide records (no projectId) are visible from any project view.
  if (!ctxProjectId) return true;
  if (!recordProjectId) return true;
  return recordProjectId === ctxProjectId;
}
