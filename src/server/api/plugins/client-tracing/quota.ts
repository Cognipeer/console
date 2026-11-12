import { getConfig } from '@/lib/core/config';
import type { LicenseType } from '@/lib/license/license-manager';
import {
  getApiTokenContextForRequest,
} from '../../fastify-utils';

export const getMaxBodySizeBytes = () => getConfig().limits.tracingMaxBodySizeMb * 1024 * 1024;

export function getTracingQuotaContext(
  ctx: Awaited<ReturnType<typeof getApiTokenContextForRequest>>,
  resourceKey: string,
) {
  return {
    domain: 'tracing' as const,
    licenseType: ctx.tenant.licenseType as LicenseType,
    projectId: ctx.projectId,
    resourceKey,
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    tokenId: ctx.tokenRecord._id?.toString() ?? ctx.token,
    userId: ctx.tokenRecord.userId,
  };
}
