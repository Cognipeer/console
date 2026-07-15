import { createLogger } from '@/lib/core/logger';
import { getDatabase, type IAuditLog } from '@/lib/database';

const logger = createLogger('audit-service');

export interface AuditWriteContext {
  tenantDbName: string;
  tenantId: string;
}

export type AuditLogInput = Omit<IAuditLog, '_id' | 'createdAt' | 'tenantId'>;

export async function recordAuditLog(
  context: AuditWriteContext,
  input: AuditLogInput,
): Promise<void> {
  try {
    const db = await getDatabase();
    await db.switchToTenant(context.tenantDbName);
    await db.createAuditLog({
      ...input,
      tenantId: context.tenantId,
    });
  } catch (error) {
    logger.warn('Failed to write audit log', {
      error: error instanceof Error ? error.message : String(error),
      service: input.service,
      event: input.event,
    });
  }
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
