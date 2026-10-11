/**
 * Client of the people-and-access API: one function per endpoint the Principals
 * screens call. Responses go through tolerant parsers (unknown fields ignored,
 * missing ones defaulted), so a payload that drifts a little degrades a column
 * instead of crashing the tab. Pure of React and Next: the node tests drive it
 * with a fetch stub.
 *
 * Errors are thrown as `DirectoryApiError`: the HTTP status, the stable `code`,
 * the server's English message and - for a refusal of the authorization engine
 * (403) or a request it could not decide (503) - the decision id the Access
 * check can explain.
 *
 * A JSON content type is sent only with a body: Fastify rejects a JSON request
 * that has none.
 */

import { normalizeServicePermissions, type UserServicePermissions } from '@/lib/security/rbac';
import {
  asArray,
  asId,
  asNumber,
  asRecord,
  asString,
  IamApiError,
  parseEffective,
  parsePrincipalDetail,
  parsePrincipalPage,
  principalDetailUrl,
  principalsListUrl,
  type EffectiveRow,
  type PrincipalDetail,
  type PrincipalListQuery,
  type PrincipalPage,
  type PrincipalType,
} from './client';

// ── errors ────────────────────────────────────────────────────────────────

export class DirectoryApiError extends IamApiError {
  /** The decision the authorization engine recorded for a refusal; explained in the Access check. */
  readonly decisionId?: string;
  /** The service a refused request needed, and the level (`required`). */
  readonly service?: string;
  readonly required?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown,
    extra: { decisionId?: string; service?: string; required?: string } = {},
  ) {
    super(message, status, code, details);
    this.name = 'DirectoryApiError';
    this.decisionId = extra.decisionId;
    this.service = extra.service;
    this.required = extra.required;
  }
}

export async function toDirectoryApiError(res: Response): Promise<DirectoryApiError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  let details: unknown;
  let decisionId = res.headers.get('x-decision-id') ?? undefined;
  let service: string | undefined;
  let required: string | undefined;
  try {
    const body = asRecord(await res.json());
    message = asString(body.error) ?? asString(body.message) ?? message;
    code = asString(body.code) ?? undefined;
    details = body.details;
    decisionId = asString(body.decisionId) ?? decisionId;
    service = asString(body.service) ?? undefined;
    required = asString(body.required) ?? undefined;
  } catch {
    /* not JSON: the status line stands */
  }
  return new DirectoryApiError(message, res.status, code, details, { decisionId: decisionId || undefined, service, required });
}

export function isDirectoryApiError(err: unknown): err is DirectoryApiError {
  return err instanceof DirectoryApiError;
}

// ── transport ─────────────────────────────────────────────────────────────

type Query = Record<string, string | number | boolean | null | undefined>;

interface CallOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<unknown> {
  const hasBody = options.body !== undefined;
  const res = await fetch(withQuery(path, options.query), {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: options.signal,
    ...(hasBody ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) throw await toDirectoryApiError(res);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new DirectoryApiError('Invalid JSON in response', res.status, 'invalid_response');
  }
}

const seg = encodeURIComponent;

// ── shared result shapes ──────────────────────────────────────────────────

/** A user as the people endpoints answer it (the part the screens read). */
export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: string;
  canLogin: boolean;
  status: string;
  authProvider: string | null;
  directoryManaged: boolean;
  servicePermissions: UserServicePermissions;
}

export function parseUserRecord(raw: unknown): UserRecord | null {
  const r = asRecord(raw);
  const id = asId(r._id) ?? asId(r.id);
  if (!id) return null;
  return {
    id,
    name: asString(r.name) ?? '',
    email: asString(r.email) ?? '',
    role: asString(r.role) ?? 'user',
    canLogin: r.canLogin !== false,
    status: asString(r.status) ?? 'active',
    authProvider: asString(r.authProvider),
    directoryManaged: r.directoryManaged === true,
    servicePermissions: normalizeServicePermissions(r.servicePermissions),
  };
}

// ── capabilities ──────────────────────────────────────────────────────────

export interface DirectoryCapabilities {
  me: { userId: string; role: string } | null;
  /** The viewer may change authorization policies (iam admin). */
  policiesManage: boolean;
  /** The viewer may invite, edit, disable and delete people and manage groups. */
  peopleManage: boolean;
  /** The viewer may grant or remove the admin role. */
  grantAdmin: boolean;
  /** The roles the viewer may hand out. */
  assignableRoles: string[];
  /** The viewer may manage other people's API tokens. */
  tokensManageOthers: boolean;
}

export const NO_CAPABILITIES: DirectoryCapabilities = {
  me: null,
  policiesManage: false,
  peopleManage: false,
  grantAdmin: false,
  assignableRoles: [],
  tokensManageOthers: false,
};

export function parseCapabilities(raw: unknown): DirectoryCapabilities {
  const r = asRecord(raw);
  const me = asRecord(r.me);
  const people = asRecord(r.people);
  const userId = asId(me.userId);
  return {
    me: userId ? { userId, role: asString(me.role) ?? 'user' } : null,
    policiesManage: asRecord(r.policies).manage === true,
    peopleManage: people.manage === true,
    grantAdmin: people.grantAdmin === true,
    assignableRoles: asArray(people.assignableRoles).filter((x): x is string => typeof x === 'string'),
    tokensManageOthers: asRecord(r.tokens).manageOthers === true,
  };
}

// ── group members ─────────────────────────────────────────────────────────

export interface GroupMemberRow {
  userId: string;
  label: string;
  email: string | null;
  role: string | null;
  status: string | null;
  kind: 'person' | 'service' | 'external' | null;
  membershipSource: string;
  /** The membership points at a user that no longer exists: it can still be removed. */
  missing: boolean;
}

export interface GroupMembersPage {
  items: GroupMemberRow[];
  nextCursor: string | null;
  total: number | null;
}

export function parseGroupMembersPage(raw: unknown): GroupMembersPage {
  const r = asRecord(raw);
  const items: GroupMemberRow[] = [];
  const seen = new Set<string>();
  for (const entry of asArray(r.items)) {
    const e = asRecord(entry);
    const userId = asId(e.userId) ?? asId(e.id);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    items.push({
      userId,
      label: asString(e.label) ?? asString(e.name) ?? userId,
      email: asString(e.email),
      role: asString(e.role),
      status: asString(e.status),
      kind: e.kind === 'person' || e.kind === 'service' || e.kind === 'external' ? e.kind : null,
      membershipSource: asString(e.membershipSource) ?? 'local',
      missing: e.missing === true,
    });
  }
  const total = asNumber(r.total);
  return { items, nextCursor: asString(r.nextCursor), total: total === null ? null : Math.max(0, Math.floor(total)) };
}

// ── activity of a person ──────────────────────────────────────────────────

export interface ActivityUsageRow {
  service: string;
  requests: number;
  errors: number;
  totalTokens: number;
  costUsd: number;
  lastDay: string;
  /** The application tokens the calls came through. */
  viaTokens: Array<{ id: string; label: string; requests: number }>;
}

export interface ActivityEventRow {
  id: string;
  at: string;
  service: string;
  event: string;
  method: string | null;
  path: string | null;
  outcome: string;
  statusCode: number | null;
  decisionId: string | null;
  /** The application token that made the call for the person. */
  viaToken: { id: string; label: string } | null;
  /** Who vouched for the person when an application acted for them. */
  issuer: string | null;
}

export interface PersonActivityView {
  windowDays: number;
  usage: ActivityUsageRow[];
  usageTruncated: boolean;
  events: ActivityEventRow[];
  hasMoreEvents: boolean;
}

export function parsePersonActivity(raw: unknown): PersonActivityView {
  const r = asRecord(raw);
  const num = (value: unknown): number => {
    const n = asNumber(value);
    return n === null ? 0 : n;
  };
  const usage = asArray(r.usage).flatMap((entry): ActivityUsageRow[] => {
    const e = asRecord(entry);
    const service = asString(e.service);
    if (!service) return [];
    return [{
      service,
      requests: num(e.requests),
      errors: num(e.errors),
      totalTokens: num(e.totalTokens),
      costUsd: num(e.costUsd),
      lastDay: asString(e.lastDay) ?? '',
      viaTokens: asArray(e.viaTokens).flatMap((via) => {
        const v = asRecord(via);
        const id = asId(v.id);
        return id ? [{ id, label: asString(v.label) ?? id, requests: num(v.requests) }] : [];
      }),
    }];
  });
  const events = asArray(r.events).flatMap((entry): ActivityEventRow[] => {
    const e = asRecord(entry);
    const id = asId(e.id);
    const at = asString(e.at);
    if (!id || !at) return [];
    const viaToken = asRecord(e.viaToken);
    const via = asRecord(e.via);
    const statusCode = asNumber(e.statusCode);
    return [{
      id,
      at,
      service: asString(e.service) ?? '',
      event: asString(e.event) ?? '',
      method: asString(e.method),
      path: asString(e.path),
      outcome: asString(e.outcome) ?? 'success',
      statusCode: statusCode === null ? null : Math.floor(statusCode),
      decisionId: asString(e.decisionId),
      viaToken: asId(viaToken.id) ? { id: asId(viaToken.id) as string, label: asString(viaToken.label) ?? (asId(viaToken.id) as string) } : null,
      issuer: via.kind === 'delegated' ? asString(via.issuer) : null,
    }];
  });
  return {
    windowDays: num(r.windowDays) || 30,
    usage,
    usageTruncated: r.usageTruncated === true,
    events,
    hasMoreEvents: r.hasMoreEvents === true,
  };
}

// ── access preview ────────────────────────────────────────────────────────

export interface AccessPreviewChange {
  service: string;
  from: string;
  to: string;
}

export interface AccessPreview {
  effective: EffectiveRow[];
  changes: AccessPreviewChange[];
  projects: { before: number; after: number } | null;
}

export function parseAccessPreview(raw: unknown): AccessPreview {
  const r = asRecord(raw);
  const projects = asRecord(r.projects);
  const before = asNumber(projects.before);
  const after = asNumber(projects.after);
  return {
    effective: parseEffective(r.effective),
    changes: asArray(r.changes).flatMap((entry): AccessPreviewChange[] => {
      const e = asRecord(entry);
      const service = asString(e.service);
      return service ? [{ service, from: asString(e.from) ?? 'none', to: asString(e.to) ?? 'none' }] : [];
    }),
    projects: before !== null && after !== null ? { before, after } : null,
  };
}

// ── bulk ──────────────────────────────────────────────────────────────────

export const BULK_ACTIONS = ['disable', 'enable', 'revoke-tokens', 'add-to-group', 'remove-from-group'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** Most ids one bulk request carries. */
export const MAX_BULK_IDS = 100;

export interface BulkRequest {
  action: BulkAction;
  ids: string[];
  reason?: string;
  groupId?: string;
  dryRun?: boolean;
}

export type BulkOutcome = 'ok' | 'skipped' | 'failed';

export interface BulkItemResult {
  id: string;
  outcome: BulkOutcome;
  code: string | null;
  message: string | null;
}

export interface BulkResult {
  action: string;
  dryRun: boolean;
  requested: number;
  ok: number;
  skipped: number;
  failed: number;
  batchId: string | null;
  results: BulkItemResult[];
}

function parseOutcome(v: unknown): BulkOutcome {
  return v === 'ok' || v === 'skipped' ? v : 'failed';
}

export function parseBulkResult(raw: unknown): BulkResult {
  const r = asRecord(raw);
  const results = asArray(r.results).flatMap((entry): BulkItemResult[] => {
    const e = asRecord(entry);
    const id = asId(e.id);
    return id ? [{ id, outcome: parseOutcome(e.outcome), code: asString(e.code), message: asString(e.message) }] : [];
  });
  const count = (key: string, outcome: BulkOutcome) =>
    asNumber(r[key]) ?? results.filter((x) => x.outcome === outcome).length;
  return {
    action: asString(r.action) ?? '',
    dryRun: r.dryRun === true,
    requested: asNumber(r.requested) ?? results.length,
    ok: count('ok', 'ok'),
    skipped: count('skipped', 'skipped'),
    failed: count('failed', 'failed'),
    batchId: asString(r.batchId),
    results,
  };
}

/** Result of `POST /api/tokens/revoke`. */
export interface TokenRevokeResult {
  requested: number;
  revoked: number;
  skipped: number;
  failed: number;
  results: BulkItemResult[];
}

export function parseTokenRevokeResult(raw: unknown): TokenRevokeResult {
  const r = asRecord(raw);
  const results = asArray(r.results).flatMap((entry): BulkItemResult[] => {
    const e = asRecord(entry);
    const id = asId(e.id);
    const outcome = e.outcome === 'revoked' || e.outcome === 'ok' ? 'ok' : e.outcome === 'skipped' ? 'skipped' : 'failed';
    return id ? [{ id, outcome, code: asString(e.code), message: asString(e.message) }] : [];
  });
  return {
    requested: asNumber(r.requested) ?? results.length,
    revoked: asNumber(r.revoked) ?? results.filter((x) => x.outcome === 'ok').length,
    skipped: asNumber(r.skipped) ?? results.filter((x) => x.outcome === 'skipped').length,
    failed: asNumber(r.failed) ?? results.filter((x) => x.outcome === 'failed').length,
    results,
  };
}

// ── create / import results ───────────────────────────────────────────────

export interface InviteBody {
  name: string;
  email: string;
  role: string;
  canLogin: boolean;
  sendInvite: boolean;
  servicePermissions: UserServicePermissions;
  projectId?: string;
}

export interface InviteResult {
  userId: string;
  name: string;
  email: string;
  role: string;
  canLogin: boolean;
  /** Set when an invitation was created (copy it, or it went out by email). */
  invitationUrl: string | null;
  invitationEmailSent: boolean;
  /** Shown once: the account has no way back to it. */
  generatedPassword: string | null;
}

export function parseInviteResult(raw: unknown): InviteResult {
  const r = asRecord(raw);
  const user = asRecord(r.user);
  return {
    userId: asId(user.id) ?? asId(user._id) ?? '',
    name: asString(user.name) ?? '',
    email: asString(user.email) ?? '',
    role: asString(user.role) ?? 'user',
    canLogin: user.canLogin !== false,
    invitationUrl: asString(r.invitationUrl),
    invitationEmailSent: r.invitationEmailSent === true,
    generatedPassword: asString(r.generatedPassword),
  };
}

export interface ImportSummary {
  createdCount: number;
  skippedExisting: string[];
  invalid: string[];
  invalidCount: number;
  /** The import stopped early (the plan's user limit). */
  halted: boolean;
}

export function parseImportSummary(raw: unknown): ImportSummary {
  const r = asRecord(raw);
  const strings = (v: unknown) => asArray(v).filter((x): x is string => typeof x === 'string');
  const invalid = strings(r.invalid);
  return {
    createdCount: asNumber(r.createdCount) ?? asArray(r.created).length,
    skippedExisting: strings(r.skippedExisting),
    invalid,
    invalidCount: asNumber(r.invalidCount) ?? invalid.length,
    halted: r.halted !== undefined && r.halted !== null && r.halted !== false,
  };
}

// ── projects ──────────────────────────────────────────────────────────────

export interface ProjectChoice {
  id: string;
  name: string;
}

/** One member row of a project, as the project members API lists it (the part the access editor needs). */
export interface ProjectMemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  servicePermissions: UserServicePermissions | null;
  ignoredServices: string[];
  implicit: boolean;
}

export function parseProjectMember(raw: unknown): ProjectMemberRow | null {
  const r = asRecord(raw);
  const userId = asId(r.userId);
  if (!userId) return null;
  return {
    userId,
    name: asString(r.name) ?? '',
    email: asString(r.email) ?? '',
    role: asString(r.role) ?? 'user',
    servicePermissions:
      r.servicePermissions && typeof r.servicePermissions === 'object'
        ? normalizeServicePermissions(r.servicePermissions)
        : null,
    ignoredServices: asArray(r.ignoredServices).filter((x): x is string => typeof x === 'string'),
    implicit: r.implicit === true,
  };
}

// ── the client ────────────────────────────────────────────────────────────

export const directoryApi = {
  // reads
  async list(query: PrincipalListQuery, signal?: AbortSignal): Promise<PrincipalPage> {
    return parsePrincipalPage(await call('GET', principalsListUrl(query), { signal }), query.type);
  },

  async detail(
    type: PrincipalType,
    id: string,
    options: { projectId?: string | null; effective?: boolean; signal?: AbortSignal } = {},
  ): Promise<PrincipalDetail> {
    const url = principalDetailUrl(type, id, options.projectId ?? null, { effective: options.effective });
    return parsePrincipalDetail(await call('GET', url, { signal: options.signal }), type, id);
  },

  async groupMembers(
    groupId: string,
    options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {},
  ): Promise<GroupMembersPage> {
    return parseGroupMembersPage(
      await call('GET', `/api/iam/principals/group/${seg(groupId)}/members`, {
        query: { limit: options.limit, cursor: options.cursor },
        signal: options.signal,
      }),
    );
  },

  async activity(userId: string, options: { days?: number; limit?: number; signal?: AbortSignal } = {}): Promise<PersonActivityView> {
    return parsePersonActivity(
      await call('GET', `/api/iam/principals/user/${seg(userId)}/activity`, {
        query: { days: options.days, limit: options.limit },
        signal: options.signal,
      }),
    );
  },

  async previewAccess(
    userId: string,
    draft: { role?: string; servicePermissions?: UserServicePermissions },
    signal?: AbortSignal,
  ): Promise<AccessPreview> {
    return parseAccessPreview(await call('POST', `/api/iam/principals/user/${seg(userId)}/preview`, { body: draft, signal }));
  },

  async capabilities(signal?: AbortSignal): Promise<DirectoryCapabilities> {
    return parseCapabilities(await call('GET', '/api/iam/capabilities', { signal }));
  },

  async listProjects(signal?: AbortSignal): Promise<{ activeProjectId: string | null; projects: ProjectChoice[] }> {
    const r = asRecord(await call('GET', '/api/projects', { signal }));
    return {
      activeProjectId: asId(r.activeProjectId),
      projects: asArray(r.projects).flatMap((entry): ProjectChoice[] => {
        const p = asRecord(entry);
        const id = asId(p._id) ?? asId(p.id);
        return id ? [{ id, name: asString(p.name) ?? id }] : [];
      }),
    };
  },

  async projectMember(projectId: string, userId: string, signal?: AbortSignal): Promise<ProjectMemberRow | null> {
    const r = asRecord(await call('GET', `/api/projects/${seg(projectId)}/members`, { signal }));
    return asArray(r.members).map(parseProjectMember).find((m) => m?.userId === userId) ?? null;
  },

  // people
  async patchUser(
    id: string,
    patch: { name?: string; email?: string; role?: string },
  ): Promise<{ user: UserRecord | null; changed: string[] }> {
    const r = asRecord(await call('PATCH', `/api/users/${seg(id)}`, { body: patch }));
    return {
      user: parseUserRecord(r.user),
      changed: asArray(r.changed).filter((x): x is string => typeof x === 'string'),
    };
  },

  async deleteUser(id: string): Promise<{ revokedTokens: number; removedGroupMemberships: number; removedProjectMemberships: number }> {
    const r = asRecord(await call('DELETE', `/api/users/${seg(id)}`));
    const cleanup = asRecord(r.cleanup);
    return {
      revokedTokens: asNumber(cleanup.revokedTokens) ?? 0,
      removedGroupMemberships: asNumber(cleanup.removedGroupMemberships) ?? 0,
      removedProjectMemberships: asNumber(cleanup.removedProjectMemberships) ?? 0,
    };
  },

  async setPermissions(id: string, servicePermissions: UserServicePermissions): Promise<UserRecord | null> {
    const r = asRecord(await call('PATCH', `/api/users/${seg(id)}/permissions`, { body: { servicePermissions } }));
    return parseUserRecord(r.user);
  },

  async disableUser(id: string, reason?: string): Promise<void> {
    await call('POST', `/api/users/${seg(id)}/disable`, { body: reason ? { reason } : {} });
  },

  async enableUser(id: string): Promise<void> {
    await call('POST', `/api/users/${seg(id)}/enable`, { body: {} });
  },

  async invitationLink(id: string): Promise<string> {
    const r = asRecord(await call('POST', `/api/users/${seg(id)}/invitation-link`, { body: {} }));
    const url = asString(r.invitationUrl);
    if (!url) throw new DirectoryApiError('No invitation link', 404, 'no_pending_invite');
    return url;
  },

  async invite(body: InviteBody): Promise<InviteResult> {
    return parseInviteResult(await call('POST', '/api/users/invite', { body }));
  },

  async bulkImport(body: { csv: string; role: string; projectId?: string }): Promise<ImportSummary> {
    return parseImportSummary(await call('POST', '/api/users/bulk-import', { body }));
  },

  async bulk(request: BulkRequest): Promise<BulkResult> {
    return parseBulkResult(await call('POST', '/api/users/bulk', { body: request }));
  },

  // groups
  async addGroupMember(groupId: string, userId: string): Promise<void> {
    await call('POST', `/api/groups/${seg(groupId)}/members`, { body: { userId, role: 'member' } });
  },

  async removeGroupMember(groupId: string, userId: string): Promise<void> {
    await call('DELETE', `/api/groups/${seg(groupId)}/members/${seg(userId)}`);
  },

  async createGroup(body: {
    name: string;
    description?: string;
    tenantRole: string | null;
    servicePermissions: UserServicePermissions;
  }): Promise<string> {
    const r = asRecord(await call('POST', '/api/groups', { body }));
    return asId(asRecord(r.group)._id) ?? asId(asRecord(r.group).id) ?? '';
  },

  async patchGroup(
    id: string,
    body: { name?: string; description?: string; tenantRole?: string | null; servicePermissions?: UserServicePermissions },
  ): Promise<void> {
    await call('PATCH', `/api/groups/${seg(id)}`, { body });
  },

  async deleteGroup(id: string): Promise<void> {
    await call('DELETE', `/api/groups/${seg(id)}`);
  },

  async assignGroupProject(groupId: string, body: { projectId: string; role: 'member' | 'project_admin' }): Promise<void> {
    await call('POST', `/api/groups/${seg(groupId)}/projects`, { body });
  },

  async removeGroupProject(groupId: string, projectId: string): Promise<void> {
    await call('DELETE', `/api/groups/${seg(groupId)}/projects/${seg(projectId)}`);
  },

  // project memberships (the project members API)
  async addProjectMember(projectId: string, body: { userId: string; role: 'member' | 'project_admin' }): Promise<void> {
    await call('POST', `/api/projects/${seg(projectId)}/members`, { body });
  },

  async setProjectMemberRole(projectId: string, body: { userId: string; role: 'member' | 'project_admin' }): Promise<void> {
    await call('PATCH', `/api/projects/${seg(projectId)}/members`, { body });
  },

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    await call('DELETE', `/api/projects/${seg(projectId)}/members`, { body: { userId } });
  },

  async saveProjectPermissions(projectId: string, userId: string, servicePermissions: UserServicePermissions): Promise<void> {
    await call('PATCH', `/api/projects/${seg(projectId)}/members/permissions`, { body: { userId, servicePermissions } });
  },

  // tokens
  async revokeTokens(ids: string[]): Promise<TokenRevokeResult> {
    return parseTokenRevokeResult(await call('POST', '/api/tokens/revoke', { body: { ids } }));
  },
};

/** Split `ids` into requests of at most `MAX_BULK_IDS`. */
export function chunkIds(ids: readonly string[], size = MAX_BULK_IDS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Folds the results of several bulk requests (one per chunk of ids) into one. */
export function mergeBulkResults(parts: readonly BulkResult[]): BulkResult {
  const results = parts.flatMap((p) => p.results);
  return {
    action: parts[0]?.action ?? '',
    dryRun: parts.every((p) => p.dryRun),
    requested: parts.reduce((n, p) => n + p.requested, 0),
    ok: parts.reduce((n, p) => n + p.ok, 0),
    skipped: parts.reduce((n, p) => n + p.skipped, 0),
    failed: parts.reduce((n, p) => n + p.failed, 0),
    batchId: parts[0]?.batchId ?? null,
    results,
  };
}
