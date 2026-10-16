/**
 * From a VERIFIED identity (the issuer and subject of an assertion that `identityAssertion.ts` checked) to the account
 * of the workspace it stands for - the one place that decides who "person X of application Y" is here.
 *
 * Matching, in this order, over the strategies the administrator enabled (`mapping.matchBy`):
 *   1. `externalId`     the account that holds `externalIds[issuer] === subject`. The identity is qualified by its
 *                       issuer, so two issuers can never be mistaken for each other;
 *   2. `verifiedEmail`  a MEMBER with the assertion's address - only when the issuer said the address is verified
 *                       (`emailVerified === true`). With `externalId` also enabled the match is recorded as a link
 *                       (`externalIds[issuer] = subject`), so the next sign-in is by identity and nobody else can take
 *                       the address over: an account already linked to ANOTHER subject of the issuer is a conflict.
 *                       External accounts are never found by address, and a service account is not a person an
 *                       issuer can vouch for.
 *   3. nobody           `mapping.jit` decides: `none` refuses (`unknown_principal`); `person` creates an ordinary
 *                       person account managed by the identity provider (no password; it needs a verified address and
 *                       the address must be free); `external` creates an account of kind `external` (cannot sign in
 *                       to the dashboard, cannot own API tokens, always the User role, found only by its identity).
 *                       Either counts toward the licence's user limit (`seat_limit`).
 *
 * What it will not do: rewrite a member's own profile (name, email) from an assertion - only an external account's
 * profile follows the assertion; decide whether the person may act as an owner or administrator (the caller's gate does,
 * through `accountGuard` - this module only says who they are); trust a claimed address that was not verified.
 *
 * Disabled accounts are refused (`disabled`) before anything else is written. So are the accounts a caller's
 * `accountGuard` refuses: it is asked with every account that already existed, BEFORE the account is linked to the
 * identity, before its profile follows the assertion and before its groups do, so a refused call leaves the account exactly
 * as it was.
 *
 * The lookup by identity is not indexed (no migration, no new index), so a short in-process cache remembers which
 * account an identity resolved to. It is only a hint: the account is read again every time and the identity checked
 * against it, so a deleted, disabled or relinked account is never served from the cache. The same goes for the lookup that
 * found nobody: a person nobody has an account for (or one who is refused) would otherwise cost the scan on every call, so a
 * miss is remembered for a few seconds - only the scan is skipped, the verified address is still tried and a person is still
 * created as configured, and any account made or linked for the identity ends the memory of the miss.
 *
 * `groupMap` keeps the person's memberships in the groups that exist for this issuer (never a local group) in step
 * with the assertion's group claim; see `syncDelegatedGroups`.
 */

import { getRequestContext } from '@/lib/core/requestContext';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, runWithTenantScope, type DatabaseProvider, type IUser } from '@/lib/database';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { lookupDefaultProjectId } from './projectNarrowing';
import { recordPeopleAudit } from '@/lib/services/users/peopleAudit';
import { MAX_EXTERNAL_ISSUER_LENGTH, MAX_EXTERNAL_SUBJECT_LENGTH } from '@/lib/database/provider/externalIds';
import { DELEGATED_PASSWORD_PLACEHOLDER, createExternalAccount, delegatedAccountBase } from './externalAccount';
import { syncDelegatedGroups, validateGroupMap, type DelegatedGroupMapEntry, type GroupSyncResult } from './delegatedGroups';

const logger = createLogger('iam:delegated-identity');

// ── contract ─────────────────────────────────────────────────────────────

export const DELEGATED_MATCH_STRATEGIES = ['externalId', 'verifiedEmail'] as const;
export type DelegatedMatchStrategy = (typeof DELEGATED_MATCH_STRATEGIES)[number];

export const DELEGATED_JIT_MODES = ['none', 'person', 'external'] as const;
export type DelegatedJitMode = (typeof DELEGATED_JIT_MODES)[number];

export type { DelegatedGroupMapEntry } from './delegatedGroups';

export interface DelegatedMapping {
  /** The strategies to try, in the fixed order identity first, then address. */
  matchBy: DelegatedMatchStrategy[];
  /** What to do when nobody matches. */
  jit: DelegatedJitMode;
  /** Identity-provider group -> console group (a group created for this issuer); absent = groups are not touched. */
  groupMap?: DelegatedGroupMapEntry[];
  /**
   * Treat the assertion's email address as verified even without `email_verified: true` (default false). Only for
   * issuers that never assert an address they did not check themselves.
   */
  trustEmails?: boolean;
}

export interface ResolveDelegatedPrincipalInput {
  tenantDbName: string;
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  groups?: string[];
  mapping: DelegatedMapping;
  /**
   * The workspace's id, when the caller has it (it saves a lookup). Without it the id is taken from the request being served
   * or looked up from `tenantDbName`.
   */
  tenantId?: string;
  /**
   * A rule about the accounts that already exist (for example "never the workspace owner"). `check` is asked with the account
   * that was found, BEFORE anything is written for it (a link by address, its profile, its groups), and refuses by throwing a
   * {@link DelegatedAccountRefusal}; any other error it throws fails the resolution as a failure of the stores would. An
   * account this call creates is not asked (a new account has no roles). `key` names the rule: resolutions with different rules
   * never share one in-flight lookup.
   */
  accountGuard?: { key: string; check: (user: IUser) => Promise<void> };
}

export type DelegatedPrincipalKind = 'person' | 'external';

export interface DelegatedPrincipal {
  user: IUser;
  /** `external` for an account of kind `external`, else `person`. */
  kind: DelegatedPrincipalKind;
  issuer: string;
  subject: string;
  /** True when this call created the account. */
  created: boolean;
  /** How the account was found: its identity, a verified address (then linked when `externalId` is enabled), or not found. */
  matchedBy: 'externalId' | 'verifiedEmail' | 'created';
  /** What happened to the groups (empty without a `groupMap`). */
  groups: GroupSyncResult;
}

export type DelegatedIdentityErrorCode = 'unknown_principal' | 'disabled' | 'seat_limit' | 'conflict';

export class DelegatedIdentityError extends Error {
  readonly code: DelegatedIdentityErrorCode;

  constructor(code: DelegatedIdentityErrorCode, message: string) {
    super(message);
    this.name = 'DelegatedIdentityError';
    this.code = code;
  }
}

/** What an `accountGuard` throws to refuse an account it was asked about. Nothing has been written for the account. */
export class DelegatedAccountRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegatedAccountRefusal';
  }
}

export { DELEGATED_PASSWORD_PLACEHOLDER };

// ── mapping check ────────────────────────────────────────────────────────

/** What is wrong with a mapping, in plain words (empty = usable). The save path and every resolution run it. */
export function validateDelegatedMapping(mapping: unknown): string[] {
  const problems: string[] = [];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return ['The identity mapping must be an object'];
  const m = mapping as Partial<DelegatedMapping>;
  if (!Array.isArray(m.matchBy) || m.matchBy.length === 0
    || m.matchBy.some((s) => !(DELEGATED_MATCH_STRATEGIES as readonly unknown[]).includes(s))
    || new Set(m.matchBy).size !== m.matchBy.length) {
    problems.push(`Match by must list one or both of: ${DELEGATED_MATCH_STRATEGIES.join(', ')}`);
  }
  if (!(DELEGATED_JIT_MODES as readonly unknown[]).includes(m.jit)) {
    problems.push(`Provisioning must be one of: ${DELEGATED_JIT_MODES.join(', ')}`);
  }
  if (m.groupMap !== undefined) problems.push(...validateGroupMap(m.groupMap));
  if (m.trustEmails !== undefined && typeof m.trustEmails !== 'boolean') problems.push('Trust emails must be true or false');
  return problems;
}

// ── caches ───────────────────────────────────────────────────────────────

/**
 * A hint is only ever a hint - the account is read again and must still hold the identity - so it can live long; what it
 * saves is the scan of the workspace's accounts that finding an account by identity costs (there is no index).
 */
const IDENTITY_CACHE_TTL_MS = 10 * 60_000;
const IDENTITY_CACHE_MAX = 50_000;
/** How long "nobody holds this identity" is remembered. Short: a person made elsewhere is recognized within this long. */
const IDENTITY_MISS_TTL_MS = 30_000;
/** Misses have a map of their own, so a flood of unknown people cannot push the hints of the known ones out. */
const IDENTITY_MISS_MAX = 10_000;
const TENANT_CACHE_TTL_MS = 5 * 60_000;
const TENANT_CACHE_MAX = 5_000;

interface IdentityHint {
  userId: string;
  expiresAt: number;
  /** The group claim the memberships were last brought in step with (a hash), so an unchanged claim costs little. */
  groupsKey?: string;
  /** When they were (an unchanged claim is still checked now and then: an administrator may have deleted a group). */
  groupsSyncedAt?: number;
}

const identityHints = new Map<string, IdentityHint>();
/** Identities nobody held when last looked for, by key: until when to believe it. */
const identityMisses = new Map<string, number>();
const tenantIds = new Map<string, { tenantId: string; expiresAt: number }>();
/** Resolutions in flight, per identity: two requests for the same new person must not create two accounts. */
const inFlight = new Map<string, Promise<DelegatedPrincipal>>();

const identityKey = (tenantDbName: string, issuer: string, subject: string): string =>
  `${tenantDbName}\u0000${issuer}\u0000${subject}`;

function rememberHint(key: string, hint: Omit<IdentityHint, 'expiresAt'>): void {
  identityMisses.delete(key); // somebody holds it now
  identityHints.delete(key);
  if (identityHints.size >= IDENTITY_CACHE_MAX) {
    const oldest = identityHints.keys().next().value as string | undefined;
    if (oldest !== undefined) identityHints.delete(oldest);
  }
  identityHints.set(key, { ...hint, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS });
}

function isKnownMiss(key: string): boolean {
  const until = identityMisses.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  identityMisses.delete(key);
  return false;
}

function rememberMiss(key: string): void {
  identityMisses.delete(key);
  if (identityMisses.size >= IDENTITY_MISS_MAX) {
    const oldest = identityMisses.keys().next().value as string | undefined;
    if (oldest !== undefined) identityMisses.delete(oldest);
  }
  identityMisses.set(key, Date.now() + IDENTITY_MISS_TTL_MS);
}

/** What the next resolution of the same person needs to know about the groups just synced. */
function groupsHint(sync: { key?: string; synced: boolean }, previous: IdentityHint | undefined): Pick<IdentityHint, 'groupsKey' | 'groupsSyncedAt'> {
  if (sync.key === undefined) return {};
  return { groupsKey: sync.key, groupsSyncedAt: sync.synced ? Date.now() : previous?.groupsSyncedAt };
}

/** Forget what was learned about identities (tests, and the writes that make a hint wrong: a delete is caught by the re-read). */
export function resetDelegatedIdentityCachesForTests(): void {
  identityHints.clear();
  identityMisses.clear();
  tenantIds.clear();
  inFlight.clear();
}

/** Forget the hints of one workspace (an administrator relinked or deleted accounts). */
export function invalidateDelegatedIdentityHints(tenantDbName: string): void {
  const prefix = `${tenantDbName}\u0000`;
  for (const key of [...identityHints.keys()]) {
    if (key.startsWith(prefix)) identityHints.delete(key);
  }
  for (const key of [...identityMisses.keys()]) {
    if (key.startsWith(prefix)) identityMisses.delete(key);
  }
}

// ── the workspace ────────────────────────────────────────────────────────

async function workspaceId(tenantDbName: string, given?: string): Promise<string> {
  const db = await getDatabase();
  if (given) {
    const tenant = await db.findTenantById(given);
    if (!tenant || tenant.dbName !== tenantDbName) throw new Error('The workspace id does not belong to this workspace database');
    return given;
  }
  const hit = tenantIds.get(tenantDbName);
  if (hit && hit.expiresAt > Date.now()) return hit.tenantId;

  let tenantId: string | undefined;
  const inRequest = getRequestContext()?.tenantId;
  if (inRequest) {
    const tenant = await db.findTenantById(inRequest);
    if (tenant?.dbName === tenantDbName) tenantId = inRequest;
  }
  if (!tenantId) {
    const tenant = (await db.listTenants()).find((candidate) => candidate.dbName === tenantDbName);
    if (!tenant?._id) throw new Error('The workspace could not be found');
    tenantId = String(tenant._id);
  }
  if (tenantIds.size >= TENANT_CACHE_MAX) {
    const oldest = tenantIds.keys().next().value as string | undefined;
    if (oldest !== undefined) tenantIds.delete(oldest);
  }
  tenantIds.set(tenantDbName, { tenantId, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
  return tenantId;
}

// ── helpers ──────────────────────────────────────────────────────────────

const isExternal = (user: Pick<IUser, 'kind'>): boolean => user.kind === 'external';
const isServiceAccount = (user: Pick<IUser, 'kind' | 'canLogin'>): boolean => user.kind !== 'external' && user.canLogin === false;
const kindOf = (user: Pick<IUser, 'kind'>): DelegatedPrincipalKind => (isExternal(user) ? 'external' : 'person');
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 320;

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanEmail(value: unknown): string | undefined {
  const email = cleanText(value, MAX_EMAIL_LENGTH);
  return email && EMAIL_PATTERN.test(email) ? email : undefined;
}

function auditActor(issuer: string) {
  const requestId = getRequestContext()?.requestId;
  return { type: 'system' as const, userId: `delegated:${issuer}`.slice(0, 600), ...(requestId ? { requestId } : {}) };
}

/** The oldest of the accounts that hold an identity; the others are the losers of a race and are only reported. */
function pickHolder(holders: IUser[], tenantId: string, issuer: string): IUser | null {
  const ofThisWorkspace = holders.filter((user) => !user.tenantId || String(user.tenantId) === String(tenantId));
  if (ofThisWorkspace.length > 1) {
    logger.warn('Several accounts hold one external identity; the oldest is used', { issuer, accounts: ofThisWorkspace.length });
  }
  return ofThisWorkspace[0] ?? null;
}

// ── the resolution ───────────────────────────────────────────────────────

/**
 * Who is the person a verified assertion names? See the module comment. Throws {@link DelegatedIdentityError} for the four
 * expected refusals; a database failure throws as it is (the caller refuses the request: fail closed).
 */
export async function resolveDelegatedPrincipal(input: ResolveDelegatedPrincipalInput): Promise<DelegatedPrincipal> {
  const { tenantDbName, mapping } = input;
  const issuer = typeof input.issuer === 'string' ? input.issuer : '';
  const subject = typeof input.subject === 'string' ? input.subject : '';
  if (!issuer || issuer.length > MAX_EXTERNAL_ISSUER_LENGTH || !subject || subject.length > MAX_EXTERNAL_SUBJECT_LENGTH) {
    throw new DelegatedIdentityError('unknown_principal', 'The assertion has no usable issuer and subject');
  }
  const problems = validateDelegatedMapping(mapping);
  if (problems.length > 0) {
    logger.warn('The identity mapping cannot be used', { tenantDbName, problem: problems[0] });
    throw new DelegatedIdentityError('unknown_principal', 'The identity mapping of this application is not usable');
  }

  // (the mapping and the rule about existing accounts are part of the key: two tokens with different ones are two questions)
  const key = `${identityKey(tenantDbName, issuer, subject)}\u0000${JSON.stringify(mapping)}\u0000${input.accountGuard?.key ?? ''}`;
  const running = inFlight.get(key);
  if (running) return running;
  const promise = resolve({ ...input, issuer, subject }).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function resolve(input: ResolveDelegatedPrincipalInput): Promise<DelegatedPrincipal> {
  const { tenantDbName, issuer, subject, mapping } = input;
  const tenantId = await workspaceId(tenantDbName, input.tenantId);
  const email = cleanEmail(input.email);
  const emailVerified = (input.emailVerified === true || mapping.trustEmails === true) && email !== undefined;
  const name = cleanText(input.name, MAX_NAME_LENGTH);
  const claimGroups = Array.isArray(input.groups) ? input.groups.filter((g): g is string => typeof g === 'string') : [];
  const byIdentity = mapping.matchBy.includes('externalId');
  const byEmail = mapping.matchBy.includes('verifiedEmail');
  const key = identityKey(tenantDbName, issuer, subject);

  return runWithTenantScope(tenantDbName, async (db): Promise<DelegatedPrincipal> => {
    const ofThisWorkspace = (user: IUser | null): IUser | null =>
      user && (!user.tenantId || String(user.tenantId) === String(tenantId)) ? user : null;

    /** The caller's rule about an account that already existed, asked once per account and before anything is written for it. */
    const accountGuard = input.accountGuard?.check;
    let guardedUserId: string | null = null;
    const guardAccount = async (candidate: IUser): Promise<void> => {
      if (!accountGuard || guardedUserId === String(candidate._id)) return;
      await accountGuard(candidate);
      guardedUserId = String(candidate._id);
    };

    /** The account the identity resolved to last time, if it still holds it. */
    const fromHint = async (): Promise<IUser | null> => {
      const hint = identityHints.get(key);
      if (!hint || hint.expiresAt <= Date.now()) {
        identityHints.delete(key);
        return null;
      }
      let user: IUser | null = null;
      try {
        user = ofThisWorkspace(await db.findUserById(hint.userId));
      } catch {
        user = null; // an id the provider cannot read is "no such account"
      }
      if (user && user.externalIds?.[issuer] === subject) return user;
      identityHints.delete(key);
      return null;
    };

    let user: IUser | null = null;
    let matchedBy: DelegatedPrincipal['matchedBy'] = 'externalId';

    // 1. the identity
    if (byIdentity) {
      user = await fromHint();
      if (!user && !isKnownMiss(key)) {
        user = pickHolder(await db.findUsersByExternalIdentity(issuer, subject), tenantId, issuer);
        if (!user) {
          rememberMiss(key);
        } else if (!identityHints.has(key)) {
          // Found: remember who, even when the call is refused below (a disabled account, an administrator the setup does not
          // admit) - the refused person's next call is then no scan either.
          rememberHint(key, { userId: String(user._id) });
        }
      }
    }

    // 2. a verified address (members only)
    if (!user && byEmail && emailVerified && email) {
      const member = ofThisWorkspace(await db.findUserByEmail(email));
      if (member && !isServiceAccount(member)) {
        if (member.status === 'disabled') throw new DelegatedIdentityError('disabled', 'This account is disabled');
        await guardAccount(member); // before the link below is written
        if (byIdentity) {
          const link = await db.linkUserExternalIdentity(String(member._id), issuer, subject);
          if (link === 'conflict') {
            throw new DelegatedIdentityError('conflict', 'This account is already linked to another identity of this issuer');
          }
          if (link !== 'not_found') identityMisses.delete(key); // somebody holds it now, whatever happens next in this call
          if (link === 'linked') {
            recordPeopleAudit({ tenantDbName, tenantId }, auditActor(issuer), {
              event: 'user.identity.link',
              resourceType: 'user',
              resourceId: String(member._id),
              metadata: { issuer, via: 'verified_email' },
            });
          }
          user = link === 'not_found' ? null : (await db.findUserById(String(member._id))) ?? member;
        } else {
          user = member;
        }
        matchedBy = 'verifiedEmail';
      }
    }

    // 3. a matched account must be a person who may be let in
    if (user) {
      if (isServiceAccount(user)) throw new DelegatedIdentityError('unknown_principal', 'No person of this workspace matches the assertion');
      if (user.status === 'disabled') throw new DelegatedIdentityError('disabled', 'This account is disabled');
      await guardAccount(user); // before its profile or its groups follow the assertion
      const synced = await followProfile(db, user, { name, email });
      const groups = await syncDelegatedGroups({ db, tenantDbName, tenantId, user: synced, issuer, claimGroups, groupMap: mapping.groupMap, hint: identityHints.get(key) });
      rememberHint(key, { userId: String(synced._id), ...groupsHint(groups, identityHints.get(key)) });
      return { user: synced, kind: kindOf(synced), issuer, subject, created: false, matchedBy, groups: groups.result };
    }

    // 4. nobody: provision, or refuse
    if (mapping.jit === 'none') {
      throw new DelegatedIdentityError('unknown_principal', 'No person of this workspace matches the assertion');
    }
    const created = await provision(db, { tenantDbName, tenantId, issuer, subject, email, emailVerified, name, jit: mapping.jit });
    identityMisses.delete(key); // somebody holds it now, whatever happens next in this call
    // (an account this call just made has no roles; one that a concurrent call made first is an existing account)
    if (!created.created) await guardAccount(created.user);
    const groups = await syncDelegatedGroups({ db, tenantDbName, tenantId, user: created.user, issuer, claimGroups, groupMap: mapping.groupMap, hint: undefined });
    rememberHint(key, { userId: String(created.user._id), ...groupsHint(groups, undefined) });
    return { user: created.user, kind: kindOf(created.user), issuer, subject, created: created.created, matchedBy: created.created ? 'created' : 'externalId', groups: groups.result };
  });
}

/** An external account's profile follows the assertion; anybody else's is their own. */
async function followProfile(db: DatabaseProvider, user: IUser, claims: { name?: string; email?: string }): Promise<IUser> {
  if (!isExternal(user)) return user;
  const patch: Partial<IUser> = {};
  if (claims.name && claims.name !== user.name) patch.name = claims.name;
  if (claims.email && claims.email.toLowerCase() !== String(user.email ?? '').toLowerCase()) patch.email = claims.email;
  if (Object.keys(patch).length === 0) return user;
  return (await db.updateUser(String(user._id), patch)) ?? user;
}

interface ProvisionInput {
  tenantDbName: string;
  tenantId: string;
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  jit: Exclude<DelegatedJitMode, 'none'>;
}

async function provision(db: DatabaseProvider, input: ProvisionInput): Promise<{ user: IUser; created: boolean }> {
  const { tenantDbName, tenantId, issuer, subject, email, emailVerified, name, jit } = input;

  if (jit === 'person') {
    // An ordinary person account needs an address nobody else holds, and the issuer must stand behind it.
    if (!email || !emailVerified) {
      throw new DelegatedIdentityError('unknown_principal', 'A verified email address is needed to create a person for this identity');
    }
    if (await db.findUserByEmail(email)) {
      throw new DelegatedIdentityError('conflict', 'An account with this email address already exists');
    }
  }

  // The licence's user limit counts every account of the workspace, the ones created here included - the same check, in the
  // same (default project) context, that inviting a person makes.
  const quota = await checkResourceQuota(
    { domain: 'global', tenantDbName, tenantId, projectId: (await lookupDefaultProjectId(tenantDbName, tenantId)) ?? '' },
    'users',
    await db.iamCountUsers({ tenantId }),
  );
  if (!quota.allowed) {
    throw new DelegatedIdentityError('seat_limit', quota.reason || 'The licence user limit has been reached');
  }

  const tenant = await (await getDatabase()).findTenantById(tenantId);
  const licenseId = tenant?.licenseType ?? 'FREE';
  const user = jit === 'person'
    ? await db.createUser({
      ...delegatedAccountBase({ tenantId, issuer, subject, licenseId }),
      email: email as string,
      name: name ?? (email as string).split('@')[0],
      // Managed by the identity provider: name, email and password are not edited here.
      authProvider: 'oidc',
      canLogin: true,
    })
    : await createExternalAccount(db, { tenantId, issuer, subject, licenseId, email, name });

  // No unique index (by design): of the accounts that now hold the identity, the OLDEST wins; a later one removes itself.
  const holders = await db.findUsersByExternalIdentity(issuer, subject);
  const winner = holders.find((candidate) => !candidate.tenantId || String(candidate.tenantId) === String(tenantId));
  if (winner && String(winner._id) !== String(user._id)) {
    await db.deleteUser(String(user._id)).catch((error: unknown) => {
      logger.warn('Could not remove the duplicate of a concurrently created account', { error: error instanceof Error ? error.message : String(error) });
    });
    return { user: winner, created: false };
  }

  recordPeopleAudit({ tenantDbName, tenantId }, auditActor(issuer), {
    event: 'user.jit.create',
    resourceType: 'user',
    resourceId: String(user._id),
    metadata: { issuer, kind: jit },
  });
  logger.info('Created an account for a verified identity', { tenantDbName, issuer, kind: jit, userId: String(user._id) });
  return { user, created: true };
}
