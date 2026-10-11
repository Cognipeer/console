/**
 * External users: the people of a HOST APPLICATION (an intranet, an ERP, a SaaS product) who reach a
 * portal through its embed with an identity the host signed.
 *
 * The portal runtime verifies the host's token (signature, issuer, audience, expiry, single use) and then
 * asks this module who the token's person is in the workspace. The answer is an ordinary user row, so the
 * policy engine, the access list, the groups and the audit trail treat them like anybody else - but the
 * row can do nothing else:
 *
 *   - the identity the token names (issuer + subject, an indexed lookup) is tried FIRST: it finds an external
 *     account provisioned earlier, and a member whose address was linked to the identity at an earlier sign-in;
 *   - a MEMBER is matched by email (`matchBy: 'email'`) only when the address is VERIFIED: the token says
 *     `email_verified: true`, or the portal's mapping says the host is trusted to only sign addresses it checked
 *     (`trustEmails`, default off). The first verified match LINKS the identity to the member, so every later sign-in
 *     is by identity and the address no longer decides anything; the same issuer with another subject for a member
 *     who is already linked is refused, so nobody can take a member over by presenting their address later;
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
 *   - a member's own profile (name, email) is never rewritten from a token, and a member's groups are never touched by
 *     one: members keep the groups the administrators manage (the host's group claim is for external accounts);
 *   - a token never signs in as a workspace owner or admin unless the caller says it may (`allowPrivilegedRoles`), by
 *     the account's EFFECTIVE role: its own role and the workspace role of every group it belongs to, so a host that
 *     vouches for the wrong address does not hand out the workspace;
 *   - a group is only filled from a token when it grants nothing at all: no workspace role, no service permissions, no
 *     project assignment (with its project role and service overrides), no custom policy that names it, and no
 *     directory (LDAP) group. The host cannot grant what a group grants. Such entries are reported as skipped, and a
 *     membership this module added in a group that has since started to grant something is removed.
 *
 * Never throws for an expected refusal: it returns `{ ok: false, code }` (with a `reason` where the code alone is too
 * coarse for the audit trail). A database failure does throw, so the caller refuses the exchange (fail closed).
 */

import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope, type DatabaseProvider, type IGroup, type IUser } from '@/lib/database';
import { loadUserGroups } from '@/lib/iam/groupGrants';
import { listGroupIdsNamedByPolicies } from '@/lib/iam/policyGroupRefs';

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
/** Identities (one per issuer) a member may have linked: a member cannot be made to carry an unbounded list. */
const MAX_LINKED_IDENTITIES = 20;

export function isExternalUser(user: { kind?: unknown } | null | undefined): boolean {
  return user?.kind === 'external';
}

/** Why a token must not fill a group. */
export type ExternalGroupProblem = 'privileged_group' | 'directory_group' | 'project_group' | 'policy_group';

/**
 * The part of the question the group's own document answers: a group a token must not fill because it grants a
 * workspace role or service permissions, or is managed by a directory. Pure; {@link findExternalGroupProblem} adds the
 * parts that need the database (project assignments, custom policies) and is what to ask when the answer matters.
 */
export function externalGroupProblem(group: Pick<IGroup, 'tenantRole' | 'servicePermissions' | 'source'>): 'privileged_group' | 'directory_group' | null {
  if (group.source && group.source !== 'local') return 'directory_group';
  if (group.tenantRole) return 'privileged_group';
  if (group.servicePermissions && Object.keys(group.servicePermissions).length > 0) return 'privileged_group';
  return null;
}

/**
 * Whether a token may put people into this group, all of it: the group's own document ({@link externalGroupProblem}),
 * then whether it is assigned to a project (`group_projects`: a project role and service overrides give its members
 * access to that project's resources), then whether a custom IAM policy names it. `db` is a provider in the workspace's
 * scope. Used when the portal's group map is saved and again at every sign-in, so a group that began to grant something
 * after it was mapped is caught. A database failure throws (the caller refuses: fail closed).
 */
export async function findExternalGroupProblem(
  db: Pick<DatabaseProvider, 'listGroupProjectsByGroup' | 'iamDocGet' | 'iamDocList'>,
  group: IGroup,
): Promise<ExternalGroupProblem | null> {
  const own = externalGroupProblem(group);
  if (own) return own;
  const groupId = String(group._id ?? '');
  if (!groupId) return 'policy_group'; // a group without an id cannot be checked: not one to fill
  const assignments = await db.listGroupProjectsByGroup(groupId);
  if (assignments.length > 0) return 'project_group';
  const named = await listGroupIdsNamedByPolicies(db, group.tenantId ? String(group.tenantId) : undefined);
  return named.has(groupId) ? 'policy_group' : null;
}

export interface ExternalClaims {
  /** The verified `iss` of the token. */
  issuer: string;
  /** The verified `sub` of the token. */
  subject: string;
  email?: string | null;
  /**
   * The token's `email_verified` claim. Only `true` counts: the host vouches that the person controls the address. An
   * address that is not verified never matches a member (unless the mapping trusts the host's addresses).
   */
  emailVerified?: boolean | null;
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
  /**
   * Count the token's email as verified even without `email_verified: true` (default false). Only for a host that never
   * signs an address it did not check itself: a member is matched by the address the host claims.
   */
  trustEmails?: boolean;
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

/**
 * What a refusal under `identity_not_found` was about, for the audit trail (the person is told the same thing either
 * way): `email_unverified` - the token's address would be the only way in and the host did not verify it;
 * `identity_conflict` - the member is already linked to another subject of this issuer (or the identity is taken).
 */
export type ExternalUserRefusalReason = 'email_unverified' | 'identity_conflict';

export interface ExternalGroupSync {
  added: string[];
  removed: string[];
  skipped: Array<{
    groupId: string;
    /** `member_account`: groups of a member are managed by the administrators, never by a token. */
    reason: 'group_not_found' | ExternalGroupProblem | 'member_account';
  }>;
}

export type ResolveExternalUserResult =
  | {
      ok: true;
      user: IUser;
      /** How they were found: the address of a member, or the identity of the token. */
      matchedBy: 'email' | 'external_id';
      /** True when this exchange created the external account. */
      created: boolean;
      /** True when this exchange linked the token's identity to a member (their first verified match by address). */
      linked: boolean;
      /** True when the name or email of an external account was brought in step with the token. */
      profileSynced: boolean;
      groups: ExternalGroupSync;
    }
  | { ok: false; code: ExternalUserFailure; message: string; reason?: ExternalUserRefusalReason };

const refuse = (code: ExternalUserFailure, message: string, reason?: ExternalUserRefusalReason): ResolveExternalUserResult =>
  ({ ok: false, code, message, ...(reason ? { reason } : {}) });

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

interface CleanClaims {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
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
  return { issuer, subject, email, emailVerified: email !== null && claims.emailVerified === true, name, groups };
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

/**
 * Whether an account is an owner or admin in effect: by its own role, or by the workspace role of a group it belongs to
 * (a group's `tenantRole` is unioned with the member's own). A failure to read the groups throws: fail closed.
 */
async function hasPrivilegedAccess(db: DatabaseProvider, user: IUser, tenantId: string): Promise<boolean> {
  if (isPrivilegedRole(user.role)) return true;
  const groups = await loadUserGroups(db, String(user._id), tenantId);
  return groups.some((group) => isPrivilegedRole(group.tenantRole));
}

type LinkOutcome = { ok: true; user: IUser; linked: boolean } | { ok: false };

/**
 * Record that the token's identity is this member (their first verified match by address), so the next sign-in is by
 * identity. Refuses - `{ ok: false }` - when the member is already linked to ANOTHER subject of the same issuer, when the
 * identity is held by another account by now, or when the member carries too many identities.
 */
async function linkIdentity(db: DatabaseProvider, member: IUser, issuer: string, subject: string): Promise<LinkOutcome> {
  const existing = member.externalIdentities ?? [];
  const ofIssuer = existing.filter((identity) => identity.issuer === issuer);
  if (ofIssuer.some((identity) => identity.subject === subject)) return { ok: true, user: member, linked: false };
  if (ofIssuer.length > 0 || existing.length >= MAX_LINKED_IDENTITIES) return { ok: false };
  try {
    const updated = await db.updateUser(String(member._id), { externalIdentities: [...existing, { issuer, subject }] });
    return updated ? { ok: true, user: updated, linked: true } : { ok: false };
  } catch (error) {
    // Someone else holds the identity (two accounts claimed it at once): it is not this member's.
    if (isDuplicateKeyError(error)) return { ok: false };
    throw error;
  }
}

/** The memberships to add and remove so that a person is in the mapped groups their token names. */
async function syncGroups(
  db: DatabaseProvider,
  tenantId: string,
  user: IUser,
  claimGroups: readonly string[],
  groupMap: Readonly<Record<string, string>> | null | undefined,
): Promise<ExternalGroupSync> {
  const result: ExternalGroupSync = { added: [], removed: [], skipped: [] };
  const entries = Object.entries(groupMap ?? {}).filter(([claim, groupId]) => claim !== '' && typeof groupId === 'string' && groupId !== '');
  if (entries.length === 0) return result;

  const userId = String(user._id);
  const mappedGroupIds = [...new Set(entries.map(([, groupId]) => groupId))].slice(0, MAX_MAPPED_GROUPS);
  const claimed = new Set(claimGroups);
  const desired = new Set(entries.filter(([claim]) => claimed.has(claim)).map(([, groupId]) => groupId).filter((groupId) => mappedGroupIds.includes(groupId)));

  // A member's groups are the administrators': the host's group claim is for external accounts.
  if (!isExternalUser(user)) {
    for (const groupId of desired) result.skipped.push({ groupId, reason: 'member_account' });
    return result;
  }

  // Which of the groups the token asks for may be filled from a token at all (the others are not even read).
  const usable = new Set<string>();
  for (const groupId of desired) {
    let group: IGroup | null = null;
    try {
      group = await db.findGroupById(groupId);
    } catch {
      group = null; // an id the provider cannot read is "no such group"
    }
    if (!group || (group.tenantId && String(group.tenantId) !== String(tenantId))) {
      result.skipped.push({ groupId, reason: 'group_not_found' });
      continue;
    }
    const problem = await findExternalGroupProblem(db, group);
    if (problem) {
      result.skipped.push({ groupId, reason: problem });
      continue;
    }
    usable.add(groupId);
  }

  const memberships = await db.listGroupMembersByUser(userId);
  const current = new Map(memberships.map((m) => [String(m.groupId), m]));

  for (const groupId of usable) {
    if (current.has(groupId)) continue; // already in (maybe added by an administrator): leave it as it is
    await db.addGroupMember({ tenantId, groupId, userId, role: 'member', source: EXTERNAL_MEMBERSHIP_SOURCE, addedBy: `system:${EXTERNAL_SOURCE_PORTAL_EMBED}` });
    result.added.push(groupId);
  }
  for (const [groupId, membership] of current) {
    // Only what this module added, and only in groups the host maps: nothing an administrator did is undone. A group the
    // token no longer names, or that may no longer be filled from a token, loses the people this module put there.
    if (membership.source !== EXTERNAL_MEMBERSHIP_SOURCE || !mappedGroupIds.includes(groupId) || usable.has(groupId)) continue;
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
  const { issuer, subject, email, emailVerified, name, groups: claimGroups } = cleaned;
  const { mapping, tenantId } = input;
  const allowPrivileged = mapping.allowPrivilegedRoles === true;
  // The host vouches for the address (the token says so, or the administrator said this host always does).
  const emailTrusted = email !== null && (emailVerified || mapping.trustEmails === true);

  return runWithTenantScope(input.tenantDbName, async (db) => {
    const ofThisWorkspace = (user: IUser | null): IUser | null => (user && (!user.tenantId || String(user.tenantId) === String(tenantId)) ? user : null);

    /**
     * A found account becomes the answer, if it may be. Nothing is written for an account that is refused: the rules about
     * who it is come first, then its identity link, its profile and its groups.
     */
    const accept = async (user: IUser, matchedBy: 'email' | 'external_id', created: boolean, link: boolean): Promise<ResolveExternalUserResult> => {
      if (user.status === 'disabled') return refuse('account_disabled', 'This account is disabled');
      if (!isExternalUser(user) && !allowPrivileged && (await hasPrivilegedAccess(db, user, tenantId))) {
        return refuse('identity_privileged', 'A signed token cannot sign in as a workspace owner or admin');
      }
      let current = user;
      let linked = false;
      if (link) {
        const outcome = await linkIdentity(db, user, issuer, subject);
        if (!outcome.ok) {
          return refuse('identity_not_found', 'The account is linked to another identity of this issuer', 'identity_conflict');
        }
        current = outcome.user;
        linked = outcome.linked;
        if (linked) logger.info('Linked a member to the identity of a host token', { tenantId, portalId: input.portalId, userId: String(current._id), issuer });
      }
      let profileSynced = false;
      // The profile of an EXTERNAL account follows the token; a member's own profile is theirs and the directory's.
      if (isExternalUser(current) && !created) {
        const patch: Partial<IUser> = {};
        if (name && name !== current.name) patch.name = name;
        if (email && email.toLowerCase() !== String(current.email ?? '').toLowerCase()) patch.email = email;
        if (Object.keys(patch).length > 0) {
          const updated = await db.updateUser(String(current._id), patch);
          if (updated) {
            current = updated;
            profileSynced = true;
          }
        }
      }
      const groups = await syncGroups(db, tenantId, current, claimGroups, mapping.groupMap);
      return { ok: true, user: current, matchedBy, created, linked, profileSynced, groups };
    };

    // 1. The identity the token names: an external account provisioned earlier, or a member linked at an earlier sign-in.
    //    First, so that once a member is linked the address no longer decides anything.
    const known = ofThisWorkspace(await db.findUserByExternalIdentity(issuer, subject));
    if (known) return accept(known, 'external_id', false, false);

    // 2. A workspace member by VERIFIED email (members only: an external account is never found by address).
    let unverifiedEmail = false;
    if (mapping.matchBy === 'email' && email) {
      if (!emailTrusted) {
        unverifiedEmail = true;
      } else {
        const member = ofThisWorkspace(await db.findUserByEmail(email));
        // A service account (no sign-in) is not a person a host can vouch for.
        if (member && member.canLogin !== false && !isExternalUser(member)) return accept(member, 'email', false, true);
      }
    }

    // 3. Nobody: provision an external account, or refuse.
    if (!mapping.provision) {
      // (the same refusal whether or not a member has the address: the reason is for the audit trail, not a way to probe)
      return refuse('identity_not_found', 'No person of this workspace matches the token', unverifiedEmail ? 'email_unverified' : undefined);
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
      return accept(winner, 'external_id', false, false);
    }
    logger.info('Provisioned an external user', { tenantId, portalId: input.portalId, userId: String(created._id), issuer });
    return accept(created, 'external_id', true, false);
  });
}

/** How many external accounts the workspace has: the portal users' counter (they are not console seats). */
export async function countExternalUsers(tenantDbName: string): Promise<number> {
  return runWithTenantScope(tenantDbName, (db) => db.countExternalUsers());
}
