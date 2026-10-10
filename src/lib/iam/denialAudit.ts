/**
 * The audit row of a refusal the engine made about a RESOURCE - opening a portal,
 * running an agent through one (resourceAuthz.ts).
 *
 * The request gates write their denials from the HTTP response hooks. The portal
 * runtime answers through the chat server, which hijacks the reply, so none of
 * those hooks fire there: the helper that decided writes the row itself, in the
 * same shape, so everything that reads a gate denial reads this one too - the
 * denials feed (`metadata.iamEnforce`), the decision lookup (`metadata.decisionId`)
 * and the Access check replay.
 *
 *   service  'portals'        action 'read' (portal.use) | 'write' (agent.invoke)
 *   event    the action id    outcome 'denied'   statusCode 403 (503 when the engine could not decide)
 *   metadata { iamEnforce, code, decisionId, action, channel, resourceType, resourceId, resourceName?,
 *              portalId, portalKey?, source, reasons[<=10], policyIds[<=10], policyNames?, contextIp? }
 *
 * Fire-and-forget: the refusal must not wait for, or fail on, the audit write. It
 * runs under the caller's tenant scope (never the process-global binding, which a
 * concurrent request of another workspace could have moved).
 */

import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import { normalizeIp } from './context';
import { getPolicy } from './store';

const logger = createLogger('iam:resource-audit');

export interface ResourceDenialEntry {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  userRole?: string;
  /** `forbidden`: the engine decided. `authorization_unavailable`: it could not. */
  code: 'forbidden' | 'authorization_unavailable';
  decisionId: string;
  action: string;
  channel: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  portalId: string;
  portalKey?: string;
  source: 'engine' | 'unavailable';
  reasons: string[];
  policyIds: string[];
  client?: {
    ip?: string | null;
    requestId?: string;
    userAgent?: string;
    method?: string;
    path?: string;
  };
}

const MAX_LISTED = 10;
const MAX_TEXT = 300;

const clip = (value: string | undefined): string | undefined => (value ? value.slice(0, MAX_TEXT) : undefined);

/** `read` for the action that only looks (portal.use), `write` for the one that runs something (agent.invoke). */
export function auditLevelOf(action: string): 'read' | 'write' {
  return action === 'agent.invoke' ? 'write' : 'read';
}

/** Names of the custom policies behind a denial, while they exist (a deleted one is resolved from the changes feed later). */
async function policyNamesOf(tenantDbName: string, policyIds: readonly string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const id of policyIds.slice(0, MAX_LISTED)) {
    try {
      const policy = await getPolicy(tenantDbName, id);
      if (policy?.name) names[id] = policy.name.slice(0, 200);
    } catch {
      // a name is a nicety; the id is the record
    }
  }
  return names;
}

async function write(entry: ResourceDenialEntry): Promise<void> {
  const policyNames = entry.policyIds.length > 0 ? await policyNamesOf(entry.tenantDbName, entry.policyIds) : {};
  const contextIp = normalizeIp(entry.client?.ip);
  const unavailable = entry.code === 'authorization_unavailable';
  await runWithTenantScope(entry.tenantDbName, (db) => db.createAuditLog({
    tenantId: entry.tenantId,
    actorType: 'user',
    actorUserId: entry.userId,
    ...(entry.userRole ? { actorRole: entry.userRole } : {}),
    service: 'portals',
    action: auditLevelOf(entry.action),
    event: entry.action,
    method: entry.client?.method?.toUpperCase(),
    path: clip(entry.client?.path),
    statusCode: unavailable ? 503 : 403,
    outcome: 'denied',
    ipAddress: entry.client?.ip ?? undefined,
    userAgent: clip(entry.client?.userAgent),
    requestId: entry.client?.requestId,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    metadata: {
      iamEnforce: true,
      code: entry.code,
      decisionId: entry.decisionId,
      action: entry.action,
      channel: entry.channel,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      ...(entry.resourceName ? { resourceName: entry.resourceName.slice(0, 200) } : {}),
      portalId: entry.portalId,
      ...(entry.portalKey ? { portalKey: entry.portalKey.slice(0, 120) } : {}),
      source: entry.source,
      ...(entry.reasons.length ? { reasons: entry.reasons.slice(0, MAX_LISTED) } : {}),
      ...(entry.policyIds.length ? { policyIds: entry.policyIds.slice(0, MAX_LISTED) } : {}),
      ...(Object.keys(policyNames).length ? { policyNames } : {}),
      // The address the engine evaluated (the one a replay must use), not only the audit IP.
      ...(contextIp ? { contextIp } : {}),
    },
  }));
}

/** Record the refusal (never throws, never awaited). */
export function recordResourceDenial(entry: ResourceDenialEntry): void {
  try {
    criticalFireAndForget('iam-resource-denial-audit', () => write(entry));
  } catch (error) {
    logger.error('Could not schedule the audit row of a refusal', {
      decisionId: entry.decisionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
