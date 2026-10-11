/**
 * External users: the people of a HOST APPLICATION (an intranet, an ERP, a SaaS product) who reach a
 * portal through its embed with an identity the host signed.
 *
 * The portal runtime verifies the host's token (signature, issuer, audience, expiry, single use) and then
 * asks this module who the token's person is in the workspace. The answer is an ordinary user row, so the
 * policy engine, the access list, the groups and the audit trail treat them like anybody else - but the
 * row can do nothing else:
 *
 *   - a MEMBER is matched by email (`matchBy: 'email'`) or by the identity the token names
 *     (`matchBy: 'external_id'`: issuer + subject, an indexed lookup);
 *   - nobody found and `provision` on: an EXTERNAL user is created (`kind: 'external'`, `source:
 *     'portal-embed'`, role `user`, no password, `canLogin: false`). It cannot sign in to the dashboard,
 *     cannot hold API tokens, is left out of the workspace's pickers and seat counts, and is listed in the
 *     Authorization center with a badge. They are counted as PORTAL users (`countExternalUsers`), not seats;
 *   - nobody found and `provision` off: the exchange is refused (`identity_not_found`);
 *   - every exchange keeps an external user's name and email in step with the token, and keeps the
 *     groups the host maps (`groupMap`: token claim value -> console group) in step too. Only memberships
 *     this module added are ever removed; a membership an administrator added stays.
 *
 * Deliberate limits, because the token is a claim by a party the administrator configured, not by the person:
 *
 *   - a member's own profile (name, email) is never rewritten from a token;
 *   - a token never signs in as a workspace owner or admin unless the caller says it may
 *     (`allowPrivilegedRoles`), so a host that vouches for the wrong address does not hand out the workspace;
 *   - a group that carries a workspace role or service permissions, and a directory (LDAP) group, is never
 *     filled from a token: the host cannot grant what a group grants. Such entries are reported as skipped.
 *
 * Never throws for an expected refusal: it returns `{ ok: false, code }`. A database failure does throw, so the
 * caller refuses the exchange (fail closed).
 */

import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope, type DatabaseProvider, type IGroup, type IUser } from '@/lib/database';

const logger = createLogger('service:users:external');

export const EXTERNAL_SOURCE_PORTAL_EMBED = 'portal-embed';
/** The membership source of the group rows this module adds (and the only ones it ever removes). */
export const EXTERNAL_MEMBERSHIP_SOURCE = 'portal-embed';
/** Not a hash of anything: no password can ever match it, so the account cannot sign in by password. */
export const EXTERNAL_PASSWORD_PLACEHOLDER = '!external-account';
/** External accounts one workspace may have unless the caller passes its own cap (a runaway host must not fill the table). */
export const DEFAULT_MAX_EXTERNAL_USERS = 100_000;

const MAX_ISSUER = 512;
const MAX_SUBJECT = 512;
const MAX_EMAIL = 320;
const MAX_NAME = 200;
const MAX_CLAIM_GROUPS = 100;
const MAX_CLAIM_GROUP_LENGTH = 200;
const MAX_MAPPED_GROUPS = 200;

export function isExternalUser(user: { kind?: unknown } | null | undefined): boolean {
  return user?.kind === 'external';
}

/** A group a token must not fill: it grants a workspace role or service permissions, or it is managed by a directory. */
export function externalGroupProblem(group: Pick<IGroup, 'tenantRole' | 'servicePermissions' | 'source'>): 'privileged_group' | 'directory_group' | null {
  if (group.source && group.source !== 'local') return 'directory_group';
  if (group.tenantRole) return 'privileged_group';
  if (group.servicePermissions && Object.keys(group.servicePermissions).length > 0) return 'privileged_group';
  return null;
}

export interface ExternalClaims {
  /** The verified `iss` of the token. */
  issuer: string;
  /** The verified `sub` of the token. */
  subject: string;
  email?: string | null;
  name?: string | null;
  /** The token's group claim values. */
  groups?: readonly string[] | null;
}

export interface ExternalUserMapping {
  matchBy: 'email' | 'external_id';
  /** Create an external user when nobody matches (otherwise the exchange is refused). */
  provision: boolean;
  /** Token claim value -> console group id. Absent or empty: groups are not touched. */
  groupMap?: Readonly<Record<string, string>> | null;
  /** Let a token sign in as a workspace owner or admin (default false). */
  allowPrivilegedRoles?: boolean;
  /** Most external accounts the workspace may have (default DEFAULT_MAX_EXTERNAL_USERS). */
  maxExternalUsers?: number;
}

export interface ResolveExternalUserInput {
  tenantDbName: string;
  tenantId: string;
  claims: ExternalClaims;
  mapping: ExternalUserMapping;
  /** The portal whose embed is being used (kept in the log line of a provisioning, not on the row). */
  portalId?: string;
}

export type ExternalUserFailure =
  | 'invalid_claims'
  | 'identity_not_found'
  | 'identity_privileged'
  | 'account_disabled'
  | 'quota_exceeded';

export interface ExternalGroupSync {
  added: string[];
  removed: string[];
  skipped: Array<{ groupId: string; reason: 'group_not_found' | 'privileged_group' | 'directory_group' }>;
}

export type ResolveExternalUserResult =
  | {
      ok: true;
      user: IUser;
      /** How they were found: the address of a member, or the identity of the token. */
      matchedBy: 'email' | 'external_id';
      /** True when this exchange created the external account. */
      created: boolean;
      /** True when the name or email of an external account was brought in step with the token. */
      profileSynced: boolean;
      groups: ExternalGroupSync;
    }
  | { ok: false; code: ExternalUserFailure; message: string };

const refuse = (code: ExternalUserFailure, message: string): ResolveExternalUserResult => ({ ok: false, code, message });

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

interface CleanClaims {
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  groups: string[];
}

function cleanClaims(claims: ExternalClaims): CleanClaims | string {
  const issuer = typeof claims?.issuer === 'string' ? claims.issuer.trim() : '';
  const subject = typeof claims?.subject === 'string' ? claims.subject.trim() : '';
  if (!issuer || issuer.length > MAX_ISSUER) return 'The token has no usable issuer';
  if (!subject || subject.length > MAX_SUBJECT) return 'The token has no usable subject';
  let email: string | null = null;
  if (claims.email !== undefined && claims.email !== null && claims.email !== '') {
    const trimmed = typeof claims.email === 'string' ? claims.email.trim() : '';
    if (!trimmed || trimmed.length > MAX_EMAIL || !EMAIL_PATTERN.test(trimmed)) return 'The token carries an email that is not an address';
    email = trimmed;
  }
  let name: string | null = null;
  if (typeof claims.name === 'string' && claims.name.trim()) name = clip(claims.name.trim(), MAX_NAME);
  const groups = Array.isArray(claims.groups)
    ? [...new Set(claims.groups.filter((g): g is string => typeof g === 'string' && g !== '' && g.length <= MAX_CLAIM_GROUP_LENGTH))].slice(0, MAX_CLAIM_GROUPS)
    : [];
  return { issuer, subject, email, name, groups };
}

const isDuplicateKeyError = (error: unknown): boolean => {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 11000) return true; // MongoDB duplicate key
  const code = typeof e.code === 'string' ? e.code : '';
  if (code.startsWith('SQLITE_CONSTRAINT')) return true;
  return typeof e.message === 'string' && /E11000|UNIQUE constraint|duplicate key/i.test(e.message);
};

const isPrivilegedRole = (role: unknown): boolean => role === 'owner' || role === 'admin';

/** The memberships to add and remove so that a person is in the mapped groups their token names. */
async function syncGroups(
  db: DatabaseProvider,
  tenantId: string,
  userId: string,
  claimGroups: readonly string[],
  groupMap: Readonly<Record<string, string>> | null | undefined,
): Promise<ExternalGroupSync> {
  const result: ExternalGroupSync = { added: [], removed: [], skipped: [] };
  const entries = Object.entries(groupMap ?? {}).filter(([claim, groupId]) => claim !== '' && typeof groupId === 'string' && groupId !== '');
  if (entries.length === 0) return result;

  const mappedGroupIds = [...new Set(entries.map(([, groupId]) => groupId))].slice(0, MAX_MAPPED_GROUPS);
  const claimed = new Set(claimGroups);
  const desired = new Set(entries.filter(([claim]) => claimed.has(claim)).map(([, groupId]) => groupId));

  // Which mapped groups may be filled from a token at all.
  const usable = new Set<string>();
  for (const groupId of mappedGroupIds) {
    let group: IGroup | null = null;
    try {
      group = await db.findGroupById(groupId);
    } catch {
      group = null; // an id the provider cannot read is "no such group"
    }
    if (!group || (group.tenantId && String(group.tenantId) !== String(tenantId))) {
      if (desired.has(groupId)) result.skipped.push({ groupId, reason: 'group_not_found' });
      continue;
    }
    const problem = externalGroupProblem(group);
    if (problem) {
      if (desired.has(groupId)) result.skipped.push({ groupId, reason: problem });
      continue;
    }
    usable.add(groupId);
  }

  const memberships = await db.listGroupMembersByUser(userId);
  const current = new Map(memberships.map((m) => [String(m.groupId), m]));

  for (const groupId of desired) {
    if (!usable.has(groupId) || current.has(groupId)) continue; // already in (maybe added by an administrator): leave it as it is
    await db.addGroupMember({ tenantId, groupId, userId, role: 'member', source: EXTERNAL_MEMBERSHIP_SOURCE, addedBy: `system:${EXTERNAL_SOURCE_PORTAL_EMBED}` });
    result.added.push(groupId);
  }
  for (const [groupId, membership] of current) {
    // Only what this module added, and only in groups the host maps: nothing an administrator did is undone.
    if (membership.source !== EXTERNAL_MEMBERSHIP_SOURCE || !mappedGroupIds.includes(groupId) || desired.has(groupId)) continue;
    if (await db.removeGroupMember(groupId, userId)) result.removed.push(groupId);
  }
  return result;
}

/**
 * Who is the person a verified token names? See the module comment for the rules. Runs in the workspace's
 * database scope; the caller has already verified the token.
 */
export async function resolveExternalUser(input: ResolveExternalUserInput): Promise<ResolveExternalUserResult> {
  const cleaned = cleanClaims(input.claims);
  if (typeof cleaned === 'string') return refuse('invalid_claims', cleaned);
  const { issuer, subject, email, name, groups: claimGroups } = cleaned;
  const { mapping, tenantId } = input;
  const allowPrivileged = mapping.allowPrivilegedRoles === true;

  return runWithTenantScope(input.tenantDbName, async (db) => {
    const ofThisWorkspace = (user: IUser | null): IUser | null => (user && (!user.tenantId || String(user.tenantId) === String(tenantId)) ? user : null);

    /** A found account becomes the answer, if it may be. */
    const accept = async (user: IUser, matchedBy: 'email' | 'external_id', created: boolean): Promise<ResolveExternalUserResult> => {
      if (user.status === 'disabled') return refuse('account_disabled', 'This account is disabled');
      if (!isExternalUser(user) && !allowPrivileged && isPrivilegedRole(user.role)) {
        return refuse('identity_privileged', 'A signed token cannot sign in as a workspace owner or admin');
      }
      let current = user;
      let profileSynced = false;
      // The profile of an EXTERNAL account follows the token; a member's own profile is theirs and the directory's.
      if (isExternalUser(user) && !created) {
        const patch: Partial<IUser> = {};
        if (name && name !== user.name) patch.name = name;
        if (email && email.toLowerCase() !== String(user.email ?? '').toLowerCase()) patch.email = email;
        if (Object.keys(patch).length > 0) {
          const updated = await db.updateUser(String(user._id), patch);
          if (updated) {
            current = updated;
            profileSynced = true;
          }
        }
      }
      const groups = await syncGroups(db, tenantId, String(current._id), claimGroups, mapping.groupMap);
      return { ok: true, user: current, matchedBy, created, profileSynced, groups };
    };

    // 1. A workspace member by email (members only: an external account is never found by address).
    if (mapping.matchBy === 'email' && email) {
      const member = ofThisWorkspace(await db.findUserByEmail(email));
      // A service account (no sign-in) is not a person a host can vouch for.
      if (member && member.canLogin !== false) return accept(member, 'email', false);
    }

    // 2. The identity the token names (an external account provisioned earlier, or a member an administrator linked).
    const known = ofThisWorkspace(await db.findUserByExternalIdentity(issuer, subject));
    if (known) return accept(known, 'external_id', false);

    // 3. Nobody: provision an external account, or refuse.
    if (!mapping.provision) {
      return refuse('identity_not_found', 'No person of this workspace matches the token');
    }
    const cap = Math.max(1, Math.floor(mapping.maxExternalUsers ?? DEFAULT_MAX_EXTERNAL_USERS));
    if ((await db.countExternalUsers()) >= cap) {
      return refuse('quota_exceeded', 'The workspace has reached the limit of external accounts');
    }
    const tenant = await db.findTenantById(tenantId);
    let created: IUser;
    try {
      created = await db.createUser({
        tenantId,
        email: email ?? '',
        password: EXTERNAL_PASSWORD_PLACEHOLDER,
        name: name ?? email ?? subject,
        role: 'user',
        licenseId: tenant?.licenseType ?? 'FREE',
        features: [],
        authProvider: 'local',
        canLogin: false,
        mustChangePassword: false,
        kind: 'external',
        source: EXTERNAL_SOURCE_PORTAL_EMBED,
        externalIdentities: [{ issuer, subject }],
      });
    } catch (error) {
      // Two first sign-ins of the same person at once: the other one won, use their account.
      if (!isDuplicateKeyError(error)) throw error;
      const winner = ofThisWorkspace(await db.findUserByExternalIdentity(issuer, subject));
      if (!winner) throw error;
      return accept(winner, 'external_id', false);
    }
    logger.info('Provisioned an external user', { tenantId, portalId: input.portalId, userId: String(created._id), issuer });
    return accept(created, 'external_id', true);
  });
}

/** How many external accounts the workspace has: the portal users' counter (they are not console seats). */
export async function countExternalUsers(tenantDbName: string): Promise<number> {
  return runWithTenantScope(tenantDbName, (db) => db.countExternalUsers());
}
