import { getDatabase, type IAuditLog } from '@/lib/database';

export interface AuditWriteContext {
  tenantDbName: string;
  tenantId: string;
}

export type AuditLogInput = Omit<IAuditLog, '_id' | 'createdAt' | 'tenantId'>;

/**
 * Write one audit row. Deliberately does NOT catch its own errors: a
 * swallowed failure here used to log at `warn` and resolve normally, so even
 * a caller that awaited this could never tell the write was lost. Letting it
 * reject lets `criticalFireAndForget` (the caller today) log it at `error`
 * with a `critical: true` marker and count it against the critical pending
 * set — or lets any future caller that needs to know retry, alert, or
 * surface the failure to the request itself.
 */
export async function recordAuditLog(
  context: AuditWriteContext,
  input: AuditLogInput,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(context.tenantDbName);
  await db.createAuditLog({
    ...input,
    tenantId: context.tenantId,
  });
}

export interface AuditLogListFilters {
  actorUserId?: string;
  outcome?: IAuditLog['outcome'];
  service?: string;
  action?: string;
  method?: string;
  /** Free-text match against event, path and actorEmail. */
  q?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  skip?: number;
}

export async function listAuditLogs(
  context: AuditWriteContext,
  filters: AuditLogListFilters = {},
): Promise<IAuditLog[]> {
  const db = await getDatabase();
  await db.switchToTenant(context.tenantDbName);
  return db.listAuditLogs(filters);
}

export function sanitizeAuditLog(log: IAuditLog): IAuditLog & { id: string } {
  return {
    ...log,
    id: typeof log._id === 'string' ? log._id : log._id?.toString() ?? '',
  };
}
