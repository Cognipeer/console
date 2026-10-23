/**
 * Decisions about a RESOURCE, asked by a runtime that is not an HTTP gate: may this
 * person open this portal (`portal.use`), may they run this agent through it
 * (`agent.invoke`), may they answer a pending request of a session (`agent.approve`),
 * may they look at / act on a session somebody else started (`agent.session_view_others`,
 * `agent.session_manage_others`).
 *
 * Two entry points, one decision:
 *
 *  - `authorizeResourceAccess`: the enterprise portal runtime, on every portal request
 *    and before every message (and before an approval is answered through a portal);
 *  - `authorizeResourceForPrincipal`: an agent route of the dashboard or the API, with
 *    the principal the request gate already built (project narrowing, the token's scope
 *    as a cap) - `authorizeResourceForRequest` in server/api/fastify-utils.ts is its
 *    HTTP wrapper, and the way a handler asks.
 *
 * It is the same engine, with the same managed rules and custom policies as the
 * gates, asked in the `portal` channel (and, for running an agent from Slack or Teams, in the
 * `messaging` channel, which follows the same rules with the access list of the agent's DEPLOYMENT
 * as the only grant: managed:messaging:*; a decision there without `subject.deploymentId` is refused):
 *
 *  - The portal's ACCESS LIST is the portal's built-in policy (managed:portal:*,
 *    managedPolicies.ts): it grants, and nothing else does - no RBAC level, no
 *    custom permit, no workspace role (an owner who is not on the list is not let
 *    in). Custom deny rules still apply on top and can block a person, a group, a
 *    portal or a single agent.
 *  - The person is described the way the dashboard describes them (role, groups,
 *    projects) but WITHOUT project narrowing: a portal has no active project, and
 *    using one needs no project membership.
 *  - The context carries `channel: 'portal'` and what the host knows of the request
 *    (address, method, path); never a project.
 *
 * In the dashboard and API channels the person is described exactly as the gate describes
 * them (project narrowing, the token's scope as a cap) and the context carries the project
 * the request runs in; the resource is the agent together with the session it is asked
 * about (agentEntities.ts).
 *
 * Failure semantics (the same as the gates'): if the person or the engine cannot be
 * loaded, nothing is allowed and nothing is decided by anything else - the answer
 * is a refusal with `unavailable: true` and its own decision id, which the caller
 * shows as "try again" (503), not as "no access" (403).
 *
 * Every refusal carries a decision id. The first refusal of a kind is audited (the
 * denials feed, the decision lookup and the Access check read that row); the same
 * refusal repeated within a minute reuses the id and writes nothing, and a
 * workspace writes at most TENANT_AUDIT_ROWS_PER_MINUTE of them, so a client that
 * retries in a loop cannot flood the audit trail. An allow writes and logs nothing -
 * with one exception: a TEST SESSION of a portal (`client.test`) that the engine
 * allowed is recorded, at most once a minute per person and portal, because it is the
 * one way in that does not go through the access list (denialAudit.ts).
 *
 * Two flags of the request come from the portal runtime and from nowhere else:
 * `client.embedded` (the person arrived through the portal's embed with an identity the
 * host application signed and the portal verified) and `client.test` (a workspace owner
 * or admin trying the portal out; the managed rules check the role themselves).
 * Never throws.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import type { RbacUserLike } from '@/lib/security/rbac';
import { RUNTIME_ENFORCED_ACTIONS } from './actions';
import { IAM_CHANNELS, isRuntimeIamChannel, type IamChannel } from './context';
import { recordPortalTestSession, recordResourceDenial } from './denialAudit';
import { authorize, customPolicyIdsOf } from './engine';
import { recordAuthorizationUnavailable, type EnforceUnavailableReason } from './enforce';
import { userPrincipal, type IamPrincipal, type IamResource } from './entities';
import { getPrincipalContext } from './principalCache';
import { countResourceAuditSuppressed, countResourceAuthz } from './resourceAuthzStats';

const logger = createLogger('iam:resource-authz');
let lastUnusableLogAt = 0;

export const RESOURCE_AUTHZ_ACTIONS = [
  'portal.use',
  // The conversations tab of a portal (dashboard, API): reading what its people said.
  'portal.conversations_view',
  'agent.invoke',
  'agent.approve',
  'agent.session_view_others',
  'agent.session_manage_others',
  // The bucket an agent keeps its session files in (a Files decision about that bucket, asked by the agents routes).
  'file-bucket.get',
  'file-bucket.update',
] as const;
export type ResourceAuthzAction = (typeof RESOURCE_AUTHZ_ACTIONS)[number];

/** A repeat of the same refusal inside this window reuses its decision id and writes no audit row. */
export const DENIAL_WINDOW_MS = 60_000;
/** Audit rows one workspace may get from this helper per minute; beyond it a refusal still has its id (and is logged), but no row. */
export const TENANT_AUDIT_ROWS_PER_MINUTE = 600;
const MAX_TRACKED = 5_000;
const MAX_REASONS = 10;

/** What the host knows about the request it is asking for (all optional). */
export interface ResourceAuthzClient {
  /** The caller's address as the host's trust-proxy setting resolves it (policy context `ip`). */
  ip?: string | null;
  requestId?: string;
  userAgent?: string;
  /** HTTP method and path (without the query string): policy context `method` / `path`, and the audit row. */
  method?: string;
  path?: string;
  /**
   * The person reached the portal through its EMBED with an identity the host application signed and the portal verified
   * (policy context `embedded`). Only the portal runtime may set it, from its own session store - never from a header.
   */
  embedded?: boolean;
  /**
   * A TEST SESSION: a workspace owner or admin trying the portal out (policy context `test`). The managed rules admit it for
   * those two roles only, so a caller who sets it without being one gains nothing. An allowed test session is audited.
   */
  test?: boolean;
}

/** Who is asking, as far as the resource builder needs to know (to cut a long access list down to the requester's slice). */
export interface ResourceAuthzRequester {
  userId: string;
  groupIds: string[];
}

/** What the audit row and the decision lookup name about the thing asked. */
export interface ResourceAuthzSubject {
  /** The portal the action is asked through. Required in the `portal` channel: the replay needs it. */
  portalId?: string;
  portalKey?: string;
  /** The portal's display name: named separately in the audit row, never as the resource (that is the agent). */
  portalName?: string;
  /** The deployment (agent on a Slack / Teams connection) the action is asked through. Required in the `messaging` channel: the replay needs it. */
  deploymentId?: string;
  connectionId?: string;
  /**
   * What the row calls the thing asked about: the agent for an approval or a session action (its key or name -
   * never the portal it was reached through), the portal for `portal.use`, the bucket for a bucket action.
   */
  resourceName?: string;
}

/**
 * A decision of a runtime (not of a gate). `portal`: the portal runtime, which names the portal (`subject.portalId` is
 * required: the replay needs it). `messaging`: the Slack / Teams runtime running an agent through a deployment, which names
 * the deployment (`subject.deploymentId` is required). Both are checked at run time: a decision without its id is refused
 * as unusable (503), never decided.
 */
export interface ResourceAuthzInput {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  /** The user's row when the caller has it; omitted = it is read (and cached for a few seconds). */
  user?: RbacUserLike & { projectIds?: string[] };
  channel: 'portal' | 'messaging';
  action: ResourceAuthzAction;
  /**
   * What the action is about: a portal (`portalResource`), an agent run through one
   * (`portalAgentResource`) or the agent of a session answered through one
   * (`portalAgentSessionResource`); in the messaging channel an agent run through a deployment
   * (`messagingAgentResource`). A function receives the requester's
   * groups once they are loaded, so a long access list can be cut down to their slice.
   */
  resource: IamResource | ((requester: ResourceAuthzRequester) => IamResource);
  /** What the audit row and the decision lookup name: `portalId` in the portal channel, `deploymentId` in the messaging channel. */
  subject: ResourceAuthzSubject;
  client?: ResourceAuthzClient;
}

/** A decision for a request of the dashboard or the API: the principal is the one the request gate built. */
export interface ResourcePrincipalAuthzInput {
  tenantDbName: string;
  tenantId: string;
  /** The session user, or the token's OWNER. */
  userId: string;
  /** The principal, built the way the gate builds it (`buildEnforcePrincipal`): narrowing, token scope and all. */
  principal: IamPrincipal;
  channel: 'dashboard' | 'api';
  action: ResourceAuthzAction;
  /** The agent of the session (agentSessionResource). */
  resource: IamResource;
  subject?: ResourceAuthzSubject;
  client?: ResourceAuthzClient;
  /**
   * Write the audit row of an "authorization unavailable" refusal. The HTTP wrapper turns it into the
   * 503 the audit hook records itself (`request.iamDenial`), so it asks for none here.
   */
  auditUnavailable?: boolean;
  /**
   * The answer shapes a response rather than refuses a request (a list that shows only the caller's own
   * sessions): a "no" is counted but gets no decision id, no log line and no audit row.
   */
  quiet?: boolean;
}

export interface ResourceAuthzResult {
  allowed: boolean;
  /** Present on EVERY refusal (also when the engine could not decide): the code a person quotes, and the key of the audit row. */
  decisionId?: string;
  /** The engine (or the person's record) could not be loaded: `allowed` is false but nobody decided; answer 503, not 403. */
  unavailable?: true;
  source: 'engine' | 'unavailable';
  /** Cedar ids of the policies that determined a refusal (empty: no rule allowed it). */
  reasons: string[];
  /** The custom policies among `reasons`. */
  policyIds: string[];
}

// ── repeated refusals ────────────────────────────────────────────────────

const recentDenials = new Map<string, { decisionId: string; at: number }>();
const tenantAuditWindows = new Map<string, { startedAt: number; rows: number }>();

export function resetResourceAuthzThrottleForTests(): void {
  recentDenials.clear();
  tenantAuditWindows.clear();
}

function makeRoom(now: number): void {
  if (recentDenials.size < MAX_TRACKED) return;
  for (const [key, entry] of recentDenials) {
    if (now - entry.at >= DENIAL_WINDOW_MS) recentDenials.delete(key);
  }
  if (recentDenials.size < MAX_TRACKED) return;
  // Still full of live entries (a flood of different refusals): forget the oldest half.
  let dropped = 0;
  for (const key of recentDenials.keys()) {
    recentDenials.delete(key);
    if (++dropped >= MAX_TRACKED / 2) break;
  }
}

function takeAuditSlot(tenantDbName: string, now: number): boolean {
  let window = tenantAuditWindows.get(tenantDbName);
  if (!window || now - window.startedAt >= 60_000) {
    if (!window && tenantAuditWindows.size >= MAX_TRACKED) tenantAuditWindows.clear();
    window = { startedAt: now, rows: 0 };
    tenantAuditWindows.set(tenantDbName, window);
  }
  if (window.rows >= TENANT_AUDIT_ROWS_PER_MINUTE) return false;
  window.rows++;
  return true;
}

/** The decision id of a refusal, and whether it is the first of its kind (so its audit row is due). */
function claim(key: string, tenantDbName: string, mint: () => string): { decisionId: string; audit: boolean } {
  const now = Date.now();
  const hit = recentDenials.get(key);
  if (hit && now - hit.at < DENIAL_WINDOW_MS) return { decisionId: hit.decisionId, audit: false };
  const decisionId = mint();
  makeRoom(now);
  recentDenials.set(key, { decisionId, at: now });
  const audit = takeAuditSlot(tenantDbName, now);
  if (!audit) countResourceAuditSuppressed();
  return { decisionId, audit };
}

// ── decision ─────────────────────────────────────────────────────────────

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function resourceRefOf(resource: IamResource | null): { type: string; id: string } {
  return resource && resource.kind === 'resource' ? { type: resource.type, id: resource.id } : { type: 'unknown', id: '' };
}

/** The session facts a replay needs (who started it, which answerers the agent accepts), read back from the resource. */
function sessionFactsOf(resource: IamResource | null): { ownerId?: string; approvers?: string } {
  if (!resource || resource.kind !== 'resource') return {};
  const attrs = resource.attrs ?? {};
  const owners = Array.isArray(attrs.owners) ? attrs.owners : [];
  const first = owners[0] as { __entity?: { id?: unknown } } | undefined;
  const ownerId = typeof first?.__entity?.id === 'string' ? first.__entity.id : undefined;
  const approvers = typeof attrs.approvers === 'string' ? attrs.approvers : undefined;
  return { ...(ownerId ? { ownerId } : {}), ...(approvers ? { approvers } : {}) };
}

/** One decision, whichever entry point asked: who, what, in which channel, and where the principal comes from. */
interface Decision {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  channel: IamChannel;
  action: ResourceAuthzAction;
  resource: IamResource | ((requester: ResourceAuthzRequester) => IamResource);
  subject: ResourceAuthzSubject;
  client?: ResourceAuthzClient;
  /** The user's row, when the portal caller has it. */
  user?: RbacUserLike & { projectIds?: string[] };
  /** Set by `authorizeResourceForPrincipal`: the request's own principal. Absent = built like the portal does. */
  principal?: IamPrincipal;
  auditUnavailable: boolean;
  /** A "no" is an answer, not a refusal: no decision id, log or audit row (see `ResourcePrincipalAuthzInput.quiet`). */
  quiet?: boolean;
}

interface Refusal {
  input: Decision;
  resource: IamResource | null;
  principal: IamPrincipal | null;
}

const tokenIdOf = (principal: IamPrincipal | null): string | undefined => (principal?.kind === 'token' ? principal.token?.id : undefined);

function audit(
  refusal: Refusal,
  decisionId: string,
  code: 'forbidden' | 'authorization_unavailable',
  source: 'engine' | 'unavailable',
  reasons: string[],
  policyIds: string[],
): void {
  const { input, resource, principal } = refusal;
  const ref = resourceRefOf(resource);
  const session = sessionFactsOf(resource);
  const tokenId = tokenIdOf(principal);
  recordResourceDenial({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    userId: input.userId,
    ...(principal?.role ? { userRole: principal.role } : {}),
    ...(tokenId ? { apiTokenId: tokenId } : {}),
    code,
    decisionId,
    action: input.action,
    channel: input.channel,
    resourceType: ref.type,
    resourceId: ref.id,
    ...(input.subject.resourceName ? { resourceName: input.subject.resourceName } : {}),
    ...(input.subject.portalId ? { portalId: input.subject.portalId } : {}),
    ...(input.subject.portalKey ? { portalKey: input.subject.portalKey } : {}),
    ...(input.subject.portalName ? { portalName: input.subject.portalName } : {}),
    ...(input.subject.deploymentId ? { deploymentId: input.subject.deploymentId } : {}),
    ...(input.subject.connectionId ? { connectionId: input.subject.connectionId } : {}),
    ...(input.client?.embedded === true ? { contextEmbedded: true } : {}),
    ...(input.client?.test === true ? { contextTest: true } : {}),
    ...(principal?.contextProjectId ? { projectId: principal.contextProjectId } : {}),
    ...(session.ownerId ? { ownerId: session.ownerId } : {}),
    ...(session.approvers ? { approvers: session.approvers } : {}),
    source,
    reasons,
    policyIds,
    client: input.client,
  });
}

/** What tells one asker from another in the throttle: a person and a token of theirs are different askers. */
const askerKey = (input: Decision, principal: IamPrincipal | null): string => `${input.userId}${tokenIdOf(principal) ? `/${tokenIdOf(principal)}` : ''}`;

function refuseUnavailable(
  refusal: Refusal,
  reason: EnforceUnavailableReason,
  error: unknown,
): ResourceAuthzResult {
  const { input } = refusal;
  countResourceAuthz(input.action, 'unavailable');
  const ref = resourceRefOf(refusal.resource);
  // Counted and logged like the gates' refusals (and so visible to the readiness report), one decision id per refusal.
  const minted = recordAuthorizationUnavailable(input.tenantDbName, reason, error, {
    channel: input.channel,
    action: input.action,
    ...(input.subject.portalId ? { portalId: input.subject.portalId } : {}),
    ...(input.subject.deploymentId ? { deploymentId: input.subject.deploymentId } : {}),
  });
  const key = [
    input.tenantDbName, askerKey(input, refusal.principal ?? input.principal ?? null), input.action, `${ref.type}:${ref.id}`, input.subject.portalId ?? input.subject.deploymentId ?? '', 'unavailable',
  ].join('|');
  const claimed = claim(key, input.tenantDbName, () => minted);
  if (claimed.audit && input.auditUnavailable) audit(refusal, claimed.decisionId, 'authorization_unavailable', 'unavailable', [], []);
  return { allowed: false, unavailable: true, decisionId: claimed.decisionId, source: 'unavailable', reasons: [], policyIds: [] };
}

function validDecision(input: unknown): input is Decision {
  const i = input as Partial<Decision> | null;
  if (!i || typeof i !== 'object') return false;
  if (!(isText(i.tenantDbName) && isText(i.tenantId) && isText(i.userId))) return false;
  if (!(typeof i.resource === 'function' || (!!i.resource && typeof i.resource === 'object'))) return false;
  if (!(IAM_CHANNELS as readonly string[]).includes(i.channel as string)) return false;
  if (!(RESOURCE_AUTHZ_ACTIONS as readonly string[]).includes(i.action as string)) return false;
  // An action is only ever asked in the channels its runtime decides it in (actions.ts).
  if (!RUNTIME_ENFORCED_ACTIONS[i.action as string]?.includes(i.channel as IamChannel)) return false;
  if (i.channel === 'portal') return !!i.subject && isText(i.subject.portalId);
  // The messaging runtime describes the person itself (no prebuilt principal: a token never speaks for a person here) and
  // must name the deployment whose access list decides: without one the decision could not be replayed, so it is not made.
  if (i.channel === 'messaging') return !!i.subject && isText(i.subject.deploymentId) && !i.principal;
  // The dashboard and the API ask for the request's own principal; nothing else describes it.
  return !!i.principal && typeof i.principal === 'object' && !!i.subject;
}

async function decide(input: Decision): Promise<ResourceAuthzResult> {
  const refusal: Refusal = { input, resource: null, principal: input.principal ?? null };

  let principal: IamPrincipal;
  let requester: ResourceAuthzRequester;
  if (input.principal) {
    principal = input.principal;
    requester = { userId: input.userId, groupIds: principal.groupIds };
  } else {
    try {
      const ctx = await getPrincipalContext({
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        userId: input.userId,
        user: input.user,
        // Role, groups AND projects, like the dashboard sees the person; project narrowing is not applied (a portal has no project).
        withProjects: true,
      });
      principal = userPrincipal({
        userId: input.userId,
        user: ctx.user,
        groupGrants: ctx.groupGrants,
        groupIds: ctx.groupIds,
        projects: ctx.projects,
        adminProjects: ctx.adminProjects,
      });
      requester = { userId: input.userId, groupIds: ctx.groupIds };
      refusal.principal = principal;
    } catch (error) {
      return refuseUnavailable(refusal, 'principal_unavailable', error);
    }
  }

  let resource: IamResource;

  try {
    resource = typeof input.resource === 'function' ? input.resource(requester) : input.resource;
    refusal.resource = resource;
  } catch (error) {
    return refuseUnavailable(refusal, 'evaluation_error', error);
  }

  const result = await authorize({
    tenant: input.tenantDbName,
    principal,
    action: input.action,
    resource,
    context: {
      channel: input.channel,
      // A runtime channel (portal, messaging) has no project; a request of the dashboard or the API runs in one.
      ...(!isRuntimeIamChannel(input.channel) && principal.contextProjectId ? { projectId: principal.contextProjectId } : {}),
      ip: input.client?.ip,
      method: input.client?.method,
      path: input.client?.path,
      // The runtime's own flags (portal channel only: a dashboard or API request carries none).
      ...(input.channel === 'portal' && input.client?.embedded === true ? { embedded: true } : {}),
      ...(input.channel === 'portal' && input.client?.test === true ? { test: true } : {}),
    },
  });
  if (result.failed) return refuseUnavailable(refusal, 'engine_unavailable', result.errors.join(' | ') || 'engine failure');

  if (result.allowed) {
    countResourceAuthz(input.action, 'allow');
    if (input.channel === 'portal' && input.client?.test === true) auditTestSession(input, principal, resource);
    return { allowed: true, source: 'engine', reasons: [], policyIds: [] };
  }

  countResourceAuthz(input.action, 'deny');
  const reasons = result.reasons.slice(0, MAX_REASONS);
  const policyIds = customPolicyIdsOf(result.reasons).slice(0, MAX_REASONS);
  if (input.quiet) return { allowed: false, source: 'engine', reasons, policyIds };
  const ref = resourceRefOf(resource);
  // The session is part of what was refused: the same person refused on two sessions of one agent is two refusals.
  const session = sessionFactsOf(resource);
  const key = [
    input.tenantDbName, askerKey(input, principal), input.action, `${ref.type}:${ref.id}`, input.subject.portalId ?? input.subject.deploymentId ?? '',
    session.ownerId ?? '', [...reasons].sort().join(','),
  ].join('|');
  const claimed = claim(key, input.tenantDbName, randomUUID);
  if (claimed.audit) {
    logger.info('IAM: resource request denied', {
      tenantDbName: input.tenantDbName,
      decisionId: claimed.decisionId,
      userId: input.userId,
      ...(tokenIdOf(principal) ? { tokenId: tokenIdOf(principal) } : {}),
      action: input.action,
      channel: input.channel,
      resourceType: ref.type,
      resourceId: ref.id,
      ...(input.subject.portalId ? { portalId: input.subject.portalId } : {}),
      ...(input.subject.deploymentId ? { deploymentId: input.subject.deploymentId } : {}),
      reasons,
    });
    audit(refusal, claimed.decisionId, 'forbidden', 'engine', reasons, policyIds);
  }
  return { allowed: false, decisionId: claimed.decisionId, source: 'engine', reasons, policyIds };
}

/** An allowed test session, recorded once a minute per person and portal (it is the way in that skips the access list). */
function auditTestSession(input: Decision, principal: IamPrincipal, resource: IamResource): void {
  const portalId = input.subject.portalId;
  if (!portalId) return;
  const key = ['test-session', input.tenantDbName, input.userId, portalId].join('|');
  if (!claim(key, input.tenantDbName, randomUUID).audit) return;
  const ref = resourceRefOf(resource);
  recordPortalTestSession({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    userId: input.userId,
    ...(principal.role ? { userRole: principal.role } : {}),
    action: input.action,
    portalId,
    ...(input.subject.portalKey ? { portalKey: input.subject.portalKey } : {}),
    ...(input.subject.portalName ? { portalName: input.subject.portalName } : {}),
    resourceType: ref.type,
    resourceId: ref.id,
    client: input.client,
  });
}

/** A caller bug, not a decision: refused like any outage, with an id that at least appears in the log. */
function refuseUnusable(): ResourceAuthzResult {
  const decisionId = randomUUID();
  countResourceAuthz('other', 'unavailable');
  // A caller with this bug asks on every request: one line per 10 s is enough to find it.
  if (Date.now() - lastUnusableLogAt >= 10_000) {
    lastUnusableLogAt = Date.now();
    logger.error('A resource authorization was asked with an unusable request', { decisionId });
  }
  return { allowed: false, unavailable: true, decisionId, source: 'unavailable', reasons: [], policyIds: [] };
}

async function run(decision: Decision): Promise<ResourceAuthzResult> {
  if (!validDecision(decision)) return refuseUnusable();
  try {
    return await decide(decision);
  } catch (error) {
    // decide() answers its own failures; this is the last line, so that nothing ever throws into a request.
    return refuseUnavailable({ input: decision, resource: null, principal: decision.principal ?? null }, 'evaluation_error', error);
  }
}

/**
 * Is `userId` allowed to do `action` on the resource in the portal channel? See the
 * module comment for the rules; the result never throws and a refusal always has a
 * `decisionId`.
 */
export async function authorizeResourceAccess(input: ResourceAuthzInput): Promise<ResourceAuthzResult> {
  const i = (input ?? {}) as Partial<ResourceAuthzInput>;
  return run({
    tenantDbName: i.tenantDbName as string,
    tenantId: i.tenantId as string,
    userId: i.userId as string,
    user: i.user,
    channel: i.channel as IamChannel,
    action: i.action as ResourceAuthzAction,
    resource: i.resource as Decision['resource'],
    subject: (i.subject ?? {}) as ResourceAuthzSubject,
    client: i.client,
    // The portal runtime answers through a server that hijacks the reply: no hook writes this row for it.
    auditUnavailable: true,
  });
}

/**
 * Is the request's principal allowed to do `action` on the resource, in the dashboard or the API
 * channel? The principal is the one the request gate built (`buildEnforcePrincipal`): the person or the
 * token's owner with the project narrowing and the token scope as a cap, so a rule that names a project
 * or a channel sees what the gate saw. The result never throws and a refusal always has a `decisionId`.
 */
export async function authorizeResourceForPrincipal(input: ResourcePrincipalAuthzInput): Promise<ResourceAuthzResult> {
  const i = (input ?? {}) as Partial<ResourcePrincipalAuthzInput>;
  return run({
    tenantDbName: i.tenantDbName as string,
    tenantId: i.tenantId as string,
    userId: i.userId as string,
    channel: i.channel as IamChannel,
    action: i.action as ResourceAuthzAction,
    resource: i.resource as Decision['resource'],
    subject: i.subject ?? {},
    client: i.client,
    principal: i.principal,
    auditUnavailable: i.auditUnavailable ?? true,
    quiet: i.quiet === true,
  });
}
