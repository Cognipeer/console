/**
 * The audit row of a refusal the engine made about a RESOURCE - opening a portal,
 * running an agent through one, answering a pending request, looking at / acting on
 * somebody else's session (resourceAuthz.ts).
 *
 * The request gates write their denials from the HTTP response hooks. The portal
 * runtime answers through the chat server, which hijacks the reply, so none of
 * those hooks fire there; and a handler's resource decision carries what decided it
 * (the rules, the session) which the hook does not know. So the helper that decided
 * writes the row itself, in the same shape, so everything that reads a gate denial
 * reads this one too - the denials feed (`metadata.iamEnforce`), the decision lookup
 * (`metadata.decisionId`) and the Access check replay.
 *
 *   service  'portals' (the portal runtime asked) | 'channels' (the Slack / Teams runtime asked) | 'agents' (an agent route)   action 'read' | 'write' (the level of the action)
 *   actor    the person; for a token the owner AND the token (`apiTokenId`, actorType 'api_token')
 *   event    the action id    outcome 'denied'   statusCode 403 (503 when the engine could not decide)
 *   metadata { iamEnforce, code, decisionId, action, channel, resourceType, resourceId, resourceName?,
 *              portalId?, portalKey?, portalName?, deploymentId?, connectionId?, ownerId?, approvers?, contextProjectId?, source, reasons[<=10],
 *              policyIds[<=10], policyNames?, contextIp? }
 *
 * Fire-and-forget: the refusal must not wait for, or fail on, the audit write. It
 * runs under the caller's tenant scope (never the process-global binding, which a
 * concurrent request of another workspace could have moved).
 */

import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import { RESOURCE_EXTRA_VERBS } from './actions';
import { normalizeIp } from './context';
import { getPolicy } from './store';

const logger = createLogger('iam:resource-audit');

export interface ResourceDenialEntry {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  userRole?: string;
  /** Set when a token asked: the row names the token as well as its owner. */
  apiTokenId?: string;
  /** `forbidden`: the engine decided. `authorization_unavailable`: it could not. */
  code: 'forbidden' | 'authorization_unavailable';
  decisionId: string;
  action: string;
  channel: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  /** The portal an action was asked through (portal channel). */
  portalId?: string;
  portalKey?: string;
  /** The portal's display name (portal channel); the row names it apart from the resource, which is the agent. */
  portalName?: string;
  /** The deployment (and its connection) an action was asked through (messaging channel); the replay needs the deployment. */
  deploymentId?: string;
  connectionId?: string;
  /** The project the request ran in (dashboard / API). */
  projectId?: string;
  /** The request was a TEST SESSION / came through an EMBED: part of the question, so a replay must ask it the same way. */
  contextTest?: boolean;
  contextEmbedded?: boolean;
  /** A session action: who started the session (the first owner) and which answerers the agent accepts, so a replay can rebuild the question. */
  ownerId?: string;
  approvers?: string;
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

/** The level of an action, from the catalog's own tables: `read` for one that only looks (portal.use, session_view_others, get), `write` for one that acts. */
export function auditLevelOf(action: string): 'read' | 'write' {
  const [type, verb] = action.split('.');
  const extra = RESOURCE_EXTRA_VERBS.find((v) => v.type === type && v.verb === verb);
  if (extra) return extra.level === 'write' ? 'write' : 'read';
  // The plain CRUD verbs of a registry type (`file-bucket.update`).
  return verb === 'create' || verb === 'update' || verb === 'delete' ? 'write' : 'read';
}

/** The services whose resources the agents routes ask about besides their own (a bucket is the Document Store's). */
const SERVICE_OF_TYPE: Readonly<Record<string, string>> = { 'file-bucket': 'files' };

/**
 * The service a refusal is filed under: the portals' for anything the portal runtime asked, the channels' for the
 * Slack / Teams runtime, else the service of
 * the resource the action is about (the agents' for the agent routes, the Document Store's for a bucket).
 */
export function auditServiceOf(channel: string, action?: string): string {
  if (channel === 'portal') return 'portals';
  if (channel === 'messaging') return 'channels';
  return (action && SERVICE_OF_TYPE[action.split('.')[0]]) || 'agents';
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
    actorType: entry.apiTokenId ? 'api_token' : 'user',
    actorUserId: entry.userId,
    ...(entry.apiTokenId ? { apiTokenId: entry.apiTokenId } : {}),
    ...(entry.userRole ? { actorRole: entry.userRole } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    service: auditServiceOf(entry.channel, entry.action),
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
      ...(entry.portalId ? { portalId: entry.portalId } : {}),
      ...(entry.portalKey ? { portalKey: entry.portalKey.slice(0, 120) } : {}),
      ...(entry.portalName ? { portalName: entry.portalName.slice(0, 200) } : {}),
      ...(entry.deploymentId ? { deploymentId: entry.deploymentId } : {}),
      ...(entry.connectionId ? { connectionId: entry.connectionId } : {}),
      ...(entry.projectId ? { contextProjectId: entry.projectId } : {}),
      ...(entry.contextTest ? { contextTest: true } : {}),
      ...(entry.contextEmbedded ? { contextEmbedded: true } : {}),
      ...(entry.ownerId ? { ownerId: entry.ownerId.slice(0, 200) } : {}),
      ...(entry.approvers ? { approvers: entry.approvers.slice(0, 40) } : {}),
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

// ── test sessions ────────────────────────────────────────────────────────

export interface PortalTestSessionEntry {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  userRole?: string;
  /** The action the engine allowed (`portal.use`, `agent.invoke`, `agent.approve`). */
  action: string;
  portalId: string;
  portalKey?: string;
  portalName?: string;
  resourceType: string;
  resourceId: string;
  client?: ResourceDenialEntry['client'];
}

/**
 * The audit row of an ALLOWED test session: a workspace owner or admin used a portal without being on its access list.
 * Filed under the portals' service with the event `portal.test_session`, outcome `success`; it carries no `iamEnforce`
 * marker, so it is a plain audit event and never shows up in the denials feed.
 */
async function writeTestSession(entry: PortalTestSessionEntry): Promise<void> {
  await runWithTenantScope(entry.tenantDbName, (db) => db.createAuditLog({
    tenantId: entry.tenantId,
    actorType: 'user',
    actorUserId: entry.userId,
    ...(entry.userRole ? { actorRole: entry.userRole } : {}),
    service: 'portals',
    action: 'security',
    event: 'portal.test_session',
    method: entry.client?.method?.toUpperCase(),
    path: clip(entry.client?.path),
    statusCode: 200,
    outcome: 'success',
    ipAddress: entry.client?.ip ?? undefined,
    userAgent: clip(entry.client?.userAgent),
    requestId: entry.client?.requestId,
    resourceType: 'portal',
    resourceId: entry.portalId,
    metadata: {
      testSession: true,
      action: entry.action,
      channel: 'portal',
      portalId: entry.portalId,
      ...(entry.portalKey ? { portalKey: entry.portalKey.slice(0, 120) } : {}),
      ...(entry.portalName ? { portalName: entry.portalName.slice(0, 200) } : {}),
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
    },
  }));
}

/** Record an allowed test session (never throws, never awaited). */
export function recordPortalTestSession(entry: PortalTestSessionEntry): void {
  try {
    criticalFireAndForget('iam-portal-test-session-audit', () => writeTestSession(entry));
  } catch (error) {
    logger.error('Could not schedule the audit row of a test session', {
      portalId: entry.portalId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
