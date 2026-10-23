/**
 * The audit tab of the Authorization center (`GET /api/iam/audit`):
 *
 *   denials   requests the policy engine refused (audit rows with `outcome: denied`
 *             and `metadata.iamEnforce`, each with the `decisionId` the caller saw)
 *   changes   who changed policies and settings (audit.ts rows)
 *
 * Offset-paged. Principals are resolved to display labels in one batched read.
 */

import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import { runWithTenantScope, type IAuditLog } from '@/lib/database';
import { TOKEN_DELEGATION_EVENT } from '@/lib/services/apiTokens/delegationAudit';
import { deniedActionOf, IAM_CHANGE_RESOURCE_TYPES } from './audit';
import { resolvePrincipalLabels } from './labels';
import { listPolicies } from './store';
import type { IamTenant, PrincipalType } from './principals';

export type AuditKind = 'denials' | 'changes';
export const AUDIT_KINDS: readonly AuditKind[] = ['denials', 'changes'];

export interface AuditFeedQuery {
  kind: AuditKind;
  from?: Date;
  to?: Date;
  principalType?: PrincipalType;
  principalId?: string;
  service?: string;
  limit: number;
  offset: number;
}

/** A feed page. `warnings` explain why it may be incomplete (rendered by the audit tab). */
export interface AuditFeedPage {
  items: AuditFeedItem[];
  hasMore: boolean;
  warnings?: AuditFeedWarning[];
}

/** `group_members_truncated`: a group filter looked at the first MAX_GROUP_FILTER members only. */
export type AuditFeedWarning = 'group_members_truncated';

/**
 * The sentence of a row as data, so the audit tab can say it in the reader's
 * language (`iamAudit.summaries.<key>`). `summary` is the same sentence in
 * English, the fallback for a key a client does not know.
 */
export interface AuditFeedText {
  key: string;
  params: Record<string, string | number>;
}

export interface AuditFeedItem {
  id: string;
  at: string;
  kind: AuditKind;
  principal: { type: 'user' | 'token'; id: string; label: string } | null;
  actor?: string;
  service: string;
  action: string;
  route?: string;
  method?: string;
  code?: string;
  decisionId?: string;
  policyId?: string;
  summary: string;
  /** `summary` as data (see AuditFeedText). */
  text?: AuditFeedText;
}

/** Edits of a token's expiry / IP allowlist are access-rule changes too (written by apiTokens/restrictionAudit.ts, service `tokens`). */
export const TOKEN_RESTRICTIONS_EVENT = 'token.restrictions.updated';
/** So are the edits of what a token may act for (apiTokens/delegationAudit.ts, service `tokens`). */
export { TOKEN_DELEGATION_EVENT };

/** The sentence of a call that tried to act for a person and was not let in, by the typed reason (static keys: the i18n guard reads this file). */
const DELEGATION_SENTENCES: Record<string, string> = {
  delegation_not_enabled: 'delegationRefused.notEnabled',
  invalid_assertion: 'delegationRefused.invalid',
  expired: 'delegationRefused.expired',
  untrusted_key: 'delegationRefused.untrustedKey',
  replayed: 'delegationRefused.replayed',
  unknown_principal: 'delegationRefused.unknownPerson',
  disabled: 'delegationRefused.disabled',
  seat_limit: 'delegationRefused.seatLimit',
  conflict: 'delegationRefused.conflict',
  delegation_refused: 'delegationRefused.privileged',
  project_not_accessible: 'delegationRefused.project',
  delegation_unavailable: 'delegationRefused.unavailable',
};
const DELEGATION_ENGLISH: Record<string, string> = {
  'delegationRefused.notEnabled': 'the token is not set up to act for users',
  'delegationRefused.invalid': 'the user token was not accepted',
  'delegationRefused.expired': 'the user token has expired',
  'delegationRefused.untrustedKey': 'no trusted key could verify the user token',
  'delegationRefused.replayed': 'the user token was already used',
  'delegationRefused.unknownPerson': 'nobody matches the person in the user token',
  'delegationRefused.disabled': 'the person\'s account is disabled',
  'delegationRefused.seatLimit': 'the licence user limit has been reached',
  'delegationRefused.conflict': 'the person\'s account is linked to another identity',
  'delegationRefused.privileged': 'owners and administrators cannot be acted for',
  'delegationRefused.project': 'the person has no access to the token\'s project',
  'delegationRefused.unavailable': 'acting for users was temporarily unavailable',
};

const ADMIN_SERVICES: ReadonlySet<string> = new Set(RBAC_SERVICE_DEFINITIONS.filter((d) => d.adminService).map((d) => d.id));
/** Without a start date a feed looks at this long: the audit table can hold millions of rows. */
export const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Policy changes are rare and worth keeping in view longer than denials. */
const CHANGES_DEFAULT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
/** Members of a filtered group that are looked at (the directory layer takes at most this many ids per query). */
export const MAX_GROUP_FILTER = 5_000;
/** A server-side scan of the audit collection is abandoned after this long (MongoDB; the table is unindexed for these filters). */
const FEED_MAX_TIME_MS = 8_000;

/** The refusals about a session of an agent (resourceAuthz.ts) and the wording key of each (`denied.<key>[Policy]`). */
const SESSION_ACTION_KEYS: ReadonlyMap<string, string> = new Map([
  ['agent.approve', 'approve'],
  ['agent.session_view_others', 'sessionView'],
  ['agent.session_manage_others', 'sessionManage'],
]);

/** The refusals about the bucket an agent keeps its files in (resourceAuthz.ts) and the wording key of each. */
const BUCKET_ACTION_KEYS: ReadonlyMap<string, string> = new Map([
  ['file-bucket.get', 'bucketChoose'],
  ['file-bucket.update', 'bucketName'],
]);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const iso = (d: Date | string | undefined): string => (d ? new Date(d).toISOString() : new Date(0).toISOString());

// ── denials ──────────────────────────────────────────────────────────────

/** Ids of a group's members, up to MAX_GROUP_FILTER; `truncated` when there are more. */
async function groupMemberIds(
  db: { iamListGroupMemberIds(groupId: string, page: { limit: number; offset?: number }): Promise<{ items: string[]; hasMore: boolean }> },
  groupId: string,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  const PAGE = 200;
  for (let offset = 0; ids.length < MAX_GROUP_FILTER; offset += PAGE) {
    const page = await db.iamListGroupMemberIds(groupId, { limit: Math.min(PAGE, MAX_GROUP_FILTER - ids.length), offset });
    ids.push(...page.items);
    if (!page.hasMore) return { ids, truncated: false };
  }
  return { ids, truncated: true };
}

async function denials(tenant: IamTenant, q: AuditFeedQuery): Promise<AuditFeedPage> {
  const policies = await listPolicies(tenant.tenantDbName);
  const policyName = new Map(policies.map((p) => [p.policyId, p.name]));

  const warnings: AuditFeedWarning[] = [];
  const page = await runWithTenantScope(tenant.tenantDbName, async (db) => {
    let actorUserIds: string[] | undefined;
    if (q.principalType === 'group' && q.principalId) {
      const members = await groupMemberIds(db, q.principalId);
      actorUserIds = members.ids;
      if (members.truncated) warnings.push('group_members_truncated');
    }
    return db.iamListAuditEvents({
      tenantId: tenant.tenantId,
      from: q.from ?? new Date(Date.now() - DEFAULT_WINDOW_MS),
      to: q.to,
      service: q.service,
      outcome: 'denied',
      metadata: { key: 'iamEnforce', value: true },
      actorUserId: q.principalType === 'user' ? q.principalId : undefined,
      actorUserIds,
      apiTokenId: q.principalType === 'token' ? q.principalId : undefined,
      limit: q.limit,
      offset: q.offset,
      maxTimeMs: FEED_MAX_TIME_MS,
    });
  });

  const labels = await resolvePrincipalLabels(tenant, {
    users: page.items.filter((r) => !r.apiTokenId).map((r) => r.actorUserId).filter((x): x is string => !!x),
    tokens: page.items.map((r) => r.apiTokenId).filter((x): x is string => !!x),
  });

  const items = page.items.map((row): AuditFeedItem => {
    const meta = row.metadata ?? {};
    const code = str(meta.code);
    const decisionId = str(meta.decisionId);
    const policyIds = Array.isArray(meta.policyIds) ? meta.policyIds.filter((x): x is string => typeof x === 'string') : [];
    const reasons = Array.isArray(meta.reasons) ? meta.reasons.filter((x): x is string => typeof x === 'string') : [];
    const service = str(meta.deniedService) ?? row.service;
    const required = str(meta.required);
    const action = str(meta.action) ?? deniedActionOf(row, ADMIN_SERVICES) ?? 'security';
    const who = row.apiTokenId
      ? { type: 'token' as const, id: row.apiTokenId, label: labels.tokens.get(row.apiTokenId) ?? row.apiTokenId }
      : row.actorUserId
        ? { type: 'user' as const, id: row.actorUserId, label: labels.users.get(row.actorUserId) ?? row.actorEmail ?? row.actorUserId }
        : null;

    const route = `${row.method ?? ''} ${row.path ?? ''}`.replace(/\s+/g, ' ').trim();
    let summary: string;
    let text: AuditFeedText | undefined;
    if (code === 'route_not_declared') {
      summary = `Blocked: ${route} has no authorization declaration`;
      text = { key: 'undeclared', params: { route } };
    } else if (code === 'authorization_unavailable') {
      summary = `Refused ${route}: authorization was temporarily unavailable`;
      text = { key: 'unavailable', params: { route } };
    } else if (code === 'delegation_refused') {
      // reasons[0] is the typed reason (delegation_not_enabled, invalid_assertion, ... delegation_refused for an owner or admin)
      const reason = reasons[0] ?? 'delegation_refused';
      const key = DELEGATION_SENTENCES[reason] ?? 'delegationRefused.invalid';
      const whoLabel = who?.label ?? 'a token';
      summary = `Refused ${whoLabel} acting for a person: ${DELEGATION_ENGLISH[key]}`;
      text = { key, params: { who: whoLabel } };
    } else if (code === 'ip_not_allowed') {
      const from = row.ipAddress ?? 'this address';
      summary = `Blocked: ${who?.label ?? 'a token'} is not allowed from ${from} (IP allowlist)${row.path ? `: ${route}` : ''}`.replace(/\s+/g, ' ').trim();
      text = { key: row.path ? 'ipNotAllowedAt' : 'ipNotAllowed', params: { who: who?.label ?? '', ip: from, route } };
    } else if (SESSION_ACTION_KEYS.has(action) && (str(meta.channel) !== 'portal' || action === 'agent.approve')) {
      // A refusal about a session of an agent (resourceAuthz.ts): answering a pending request, or looking at / acting
      // on a session somebody else started.
      const kept = meta.policyNames && typeof meta.policyNames === 'object' && !Array.isArray(meta.policyNames)
        ? (meta.policyNames as Record<string, unknown>)
        : {};
      const names = policyIds.map((id) => policyName.get(id) ?? str(kept[id]) ?? id).join('", "');
      const whoLabel = who?.label ?? 'someone';
      const target = str(meta.resourceName) ?? str(meta.resourceId) ?? '';
      const byPolicy = policyIds.length > 0;
      const verb = SESSION_ACTION_KEYS.get(action);
      const phrase = action === 'agent.approve' ? 'approving a tool call of agent'
        : action === 'agent.session_view_others' ? 'viewing someone else\'s session of agent'
          : 'acting on someone else\'s session of agent';
      const noRule = action === 'agent.approve' ? 'because no rule appoints them' : 'because no rule allows it';
      // An approval asked through a portal names the portal apart from the agent (the thing asked about).
      const portal = action === 'agent.approve' && str(meta.channel) === 'portal' ? (str(meta.portalName) ?? str(meta.portalKey)) : undefined;
      const where = portal ? ` in portal "${portal}"` : '';
      summary = `Denied ${whoLabel} ${phrase} "${target}"${where} ${byPolicy ? `by policy "${names}"` : noRule}`;
      text = {
        key: `denied.${verb}${portal ? 'InPortal' : ''}${byPolicy ? 'Policy' : ''}`,
        params: { who: whoLabel, resource: target, policies: names, ...(portal ? { portal } : {}) },
      };
    } else if (BUCKET_ACTION_KEYS.has(action) && str(meta.channel) !== 'portal') {
      // A refusal about a Document Store bucket asked by the agents routes (resourceAuthz.ts): listing it as a choice
      // for an agent's session files, or naming it in the agent's settings.
      const kept = meta.policyNames && typeof meta.policyNames === 'object' && !Array.isArray(meta.policyNames)
        ? (meta.policyNames as Record<string, unknown>)
        : {};
      const names = policyIds.map((id) => policyName.get(id) ?? str(kept[id]) ?? id).join('", "');
      const whoLabel = who?.label ?? 'someone';
      const target = str(meta.resourceName) ?? str(meta.resourceId) ?? '';
      const byPolicy = policyIds.length > 0;
      const phrase = action === 'file-bucket.get' ? 'listing bucket' : 'choosing bucket';
      summary = `Denied ${whoLabel} ${phrase} "${target}" for an agent's files ${byPolicy ? `by policy "${names}"` : 'because no rule allows it'}`;
      text = { key: `denied.${BUCKET_ACTION_KEYS.get(action)}${byPolicy ? 'Policy' : ''}`, params: { who: whoLabel, resource: target, policies: names } };
    } else if (str(meta.channel) === 'portal' && (action === 'portal.use' || action === 'agent.invoke')) {
      // A refusal of the portal runtime (resourceAuthz.ts): about opening one portal, or running one agent through it.
      const kept = meta.policyNames && typeof meta.policyNames === 'object' && !Array.isArray(meta.policyNames)
        ? (meta.policyNames as Record<string, unknown>)
        : {};
      const names = policyIds.map((id) => policyName.get(id) ?? str(kept[id]) ?? id).join('", "');
      const whoLabel = who?.label ?? 'someone';
      const target = str(meta.resourceName) ?? str(meta.resourceId) ?? '';
      const byPolicy = policyIds.length > 0;
      summary = action === 'portal.use'
        ? `Denied ${whoLabel} opening portal "${target}" ${byPolicy ? `by policy "${names}"` : 'because they are not on its access list'}`
        : `Denied ${whoLabel} running agent "${target}" in a portal ${byPolicy ? `by policy "${names}"` : 'because they are not on its access list'}`;
      text = {
        key: action === 'portal.use' ? (byPolicy ? 'denied.portalUsePolicy' : 'denied.portalUse') : (byPolicy ? 'denied.portalInvokePolicy' : 'denied.portalInvoke'),
        params: { who: whoLabel, resource: target, policies: names },
      };
    } else if (str(meta.channel) === 'messaging' && action === 'agent.invoke') {
      // A refusal of the messaging runtime (resourceAuthz.ts): running one agent from Slack or Teams.
      const kept = meta.policyNames && typeof meta.policyNames === 'object' && !Array.isArray(meta.policyNames)
        ? (meta.policyNames as Record<string, unknown>)
        : {};
      const names = policyIds.map((id) => policyName.get(id) ?? str(kept[id]) ?? id).join('", "');
      const whoLabel = who?.label ?? 'someone';
      const target = str(meta.resourceName) ?? str(meta.resourceId) ?? '';
      const byPolicy = policyIds.length > 0;
      summary = `Denied ${whoLabel} running agent "${target}" from Slack or Teams ${byPolicy ? `by policy "${names}"` : 'because they are not on its access list'}`;
      text = {
        key: byPolicy ? 'denied.messagingInvokePolicy' : 'denied.messagingInvoke',
        params: { who: whoLabel, resource: target, policies: names },
      };
    } else {
      const names = policyIds.map((id) => policyName.get(id) ?? id).join('", "');
      const reason = policyIds.length > 0 ? 'policy'
        : reasons.some((r) => r.startsWith('managed:boundary:token-cap')) ? 'tokenScope'
          : reasons.some((r) => r.startsWith('managed:boundary:project')) ? 'project'
            : 'noRule';
      const why = reason === 'policy' ? ` by policy "${names}"`
        : reason === 'tokenScope' ? ' by the token scope'
          : reason === 'project' ? ' by the project permissions'
            : ' because no rule allows it';
      summary = `Denied ${route}: ${service}${required ? ` needs ${required}` : ''}${why}`.replace(/\s+/g, ' ').trim();
      text = { key: `denied.${reason}`, params: { route, service, required: required ?? '', policies: names } };
    }
    return {
      id: String(row._id),
      at: iso(row.createdAt),
      kind: 'denials',
      principal: who,
      service,
      action,
      route: row.path,
      method: row.method,
      ...(code ? { code } : {}),
      ...(decisionId ? { decisionId } : {}),
      ...(policyIds[0] ? { policyId: policyIds[0] } : {}),
      summary,
      ...(text ? { text } : {}),
    };
  });
  return { items, hasMore: page.hasMore, ...(warnings.length > 0 ? { warnings } : {}) };
}

// ── changes ──────────────────────────────────────────────────────────────

function describeChange(row: IAuditLog): { summary: string; text?: AuditFeedText } {
  const m = row.metadata ?? {};
  const name = str(m.name) ? `"${String(m.name)}"` : '';
  const flags = [str(m.effect), m.enabled === false ? 'disabled' : undefined].filter(Boolean).join(', ');
  const policyParams = { name: str(m.name) ?? '', effect: str(m.effect) ?? '', enabled: m.enabled === false ? 0 : 1 };
  switch (row.event) {
    case 'iam.policy.create': return { summary: `Created policy ${name}${flags ? ` (${flags})` : ''}`, text: { key: 'policy.created', params: policyParams } };
    case 'iam.policy.update': return { summary: `Updated policy ${name}${flags ? ` (${flags})` : ''}`, text: { key: 'policy.updated', params: policyParams } };
    case 'iam.policy.delete': return { summary: `Deleted policy ${name}`, text: { key: 'policy.deleted', params: policyParams } };
    case TOKEN_DELEGATION_EVENT: {
      const label = str(m.label) ?? String(row.resourceId ?? '');
      const change = str(m.change) ?? 'updated';
      return {
        summary: `${change === 'removed' ? 'Removed' : change === 'created' ? 'Set up' : 'Changed'} the delegation of token "${label}" (acting for users)`,
        text: { key: 'token.delegation', params: { label, change } },
      };
    }
    case TOKEN_RESTRICTIONS_EVENT: {
      const after = (m.after ?? {}) as { expiresAt?: string | null; allowedIpRanges?: unknown; allowedIpRangeCount?: number; requireUserToken?: boolean };
      const before = (m.before ?? {}) as { expiresAt?: string | null; allowedIpRanges?: unknown; allowedIpRangeCount?: number; requireUserToken?: boolean };
      const parts: string[] = [];
      const expiryChanged = before.expiresAt !== after.expiresAt;
      const ipChanged = (before.allowedIpRangeCount ?? 0) !== (after.allowedIpRangeCount ?? 0)
        || JSON.stringify(before.allowedIpRanges) !== JSON.stringify(after.allowedIpRanges);
      if (expiryChanged) parts.push(`expiry ${before.expiresAt ? before.expiresAt.slice(0, 10) : 'none'} -> ${after.expiresAt ? after.expiresAt.slice(0, 10) : 'none'}`);
      if ((before.requireUserToken === true) !== (after.requireUserToken === true)) parts.push(`user token ${after.requireUserToken === true ? 'now required' : 'no longer required'}`);
      if (ipChanged) parts.push(`IP allowlist ${before.allowedIpRangeCount ?? 0} -> ${after.allowedIpRangeCount ?? 0} ranges`);
      const label = str(m.label) ?? String(row.resourceId ?? '');
      return {
        summary: `Changed the restrictions of token ${str(m.label) ? `"${String(m.label)}"` : String(row.resourceId ?? '')}${parts.length ? ` (${parts.join(', ')})` : ''}`,
        text: {
          key: 'token.restrictions',
          params: {
            label,
            expiryChanged: expiryChanged ? 1 : 0,
            expiryFrom: before.expiresAt ? before.expiresAt.slice(0, 10) : '',
            expiryTo: after.expiresAt ? after.expiresAt.slice(0, 10) : '',
            ipChanged: ipChanged ? 1 : 0,
            ipFrom: before.allowedIpRangeCount ?? 0,
            ipTo: after.allowedIpRangeCount ?? 0,
          },
        },
      };
    }
    case 'iam.settings.update': {
      const t = (m.tokens ?? {}) as { maxLifetimeDays?: number | null; requireExpiry?: boolean };
      const parts: string[] = [];
      if (t.maxLifetimeDays !== undefined) parts.push(`token max lifetime ${t.maxLifetimeDays === null ? 'unlimited' : `${t.maxLifetimeDays} days`}`);
      if (t.requireExpiry !== undefined) parts.push(`token expiry ${t.requireExpiry ? 'required' : 'optional'}`);
      return {
        summary: `Changed IAM settings${parts.length ? `: ${parts.join(', ')}` : ''}`,
        text: {
          key: 'settings.updated',
          params: {
            lifetimeSet: t.maxLifetimeDays !== undefined ? 1 : 0,
            lifetimeDays: t.maxLifetimeDays === null || t.maxLifetimeDays === undefined ? 0 : t.maxLifetimeDays,
            expirySet: t.requireExpiry !== undefined ? 1 : 0,
            expiryRequired: t.requireExpiry ? 1 : 0,
          },
        },
      };
    }
    default: return { summary: row.event };
  }
}

async function changes(tenant: IamTenant, q: AuditFeedQuery): Promise<AuditFeedPage> {
  const page = await runWithTenantScope(tenant.tenantDbName, (db) => db.iamListAuditEvents({
    tenantId: tenant.tenantId,
    // Like the denials, bounded in time: an open-ended read of the audit table is a full scan.
    from: q.from ?? new Date(Date.now() - CHANGES_DEFAULT_WINDOW_MS),
    to: q.to,
    service: 'iam',
    outcome: 'success',
    resourceTypes: [...IAM_CHANGE_RESOURCE_TYPES],
    alsoEvents: [TOKEN_RESTRICTIONS_EVENT, TOKEN_DELEGATION_EVENT],
    // for this segment the principal filter means "who made the change"
    actorUserId: q.principalType === 'user' ? q.principalId : undefined,
    limit: q.limit,
    offset: q.offset,
    maxTimeMs: FEED_MAX_TIME_MS,
  }));
  const items = page.items.map((row): AuditFeedItem => {
    const policyId = row.resourceType === 'iam-policy' ? str(row.resourceId) : undefined;
    return {
      id: String(row._id),
      at: iso(row.createdAt),
      kind: 'changes',
      principal: null,
      actor: row.actorEmail ?? row.actorUserId,
      service: row.event === TOKEN_RESTRICTIONS_EVENT || row.event === TOKEN_DELEGATION_EVENT ? 'tokens' : 'iam',
      action: row.event,
      route: row.path,
      method: row.method,
      ...(policyId ? { policyId } : {}),
      ...describeChange(row),
    };
  });
  return { items, hasMore: page.hasMore };
}

export async function listAuditFeed(tenant: IamTenant, q: AuditFeedQuery): Promise<AuditFeedPage> {
  if (q.kind === 'changes') return changes(tenant, q);
  return denials(tenant, q);
}

// ── CSV ──────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  'time', 'kind', 'principalType', 'principalId', 'principalLabel', 'actor', 'service', 'action',
  'method', 'route', 'code', 'decisionId', 'policyId', 'summary',
] as const;

/** A CSV cell. Cells that a spreadsheet would run as a formula are prefixed with an apostrophe. */
export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function auditItemsToCsv(items: AuditFeedItem[], header = true): string {
  const lines: string[] = header ? [CSV_COLUMNS.join(',')] : [];
  for (const i of items) {
    lines.push([
      i.at, i.kind, i.principal?.type, i.principal?.id, i.principal?.label, i.actor, i.service, i.action,
      i.method, i.route, i.code, i.decisionId, i.policyId, i.summary,
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}
