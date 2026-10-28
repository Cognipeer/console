/**
 * The principal keys a caller holds.
 *
 * A person holds their console keys (user, e-mail, groups) plus the keys of the
 * external identities they are matched to. Matching happens per identity domain
 * (an external directory such as the Entra tenant behind a SharePoint source):
 *
 *  1. `userMatch` rules, in order, compare one of the person's values (stored
 *     e-mail, or the SSO / LDAP external id) with a field of the domain's
 *     directory snapshot (e-mail, UPN, id, an attribute). The first rule that
 *     finds directory users decides; those users' ids, groups (nested ones
 *     included, as the integration reported them) and, for members, the
 *     domain-wide key are added.
 *  2. A rule `externalId -> id` also works without a directory: when no rule
 *     found anyone, the person's external id is taken as the domain's user id.
 *  3. A console group whose externalId equals an external group id stands for
 *     that group (unless the domain turns it off).
 *  4. Manual links connect a console user or group to an external user or group.
 *
 * Accounts of host applications (`kind: 'external'`) take no part in 1 and 2:
 * the address and the subject of such an account are what the application
 * claimed, not something a directory vouches for.
 *
 * Nothing here is stored on documents or vectors, so changing a rule or a link
 * takes effect on the next query without re-syncing anything. The person part
 * is cached for 15 seconds per process (as IAM's principal context is).
 */

import { createLogger } from '@/lib/core/logger';
import {
  runWithTenantScope,
  type DatabaseProvider,
  type IRagIdentityDomain,
  type IRagIdentityLink,
  type IRagIdentityUser,
  type IRagIdentityUserMatchRule,
  type IUser,
} from '@/lib/database';
import { fetchGroupsByIds, listUserGroupIds } from '@/lib/iam/groupGrants';
import type { KbCaller } from './caller';
import {
  EVERYONE_PRINCIPAL,
  formatPrincipal,
  isValidIdentityDomainKey,
  normalizeEmail,
} from './principals';

const logger = createLogger('rag:access:identity');

const PERSON_CACHE_TTL_MS = 15_000;
const PERSON_CACHE_MAX = 2_000;
/** Directory users one rule may match for one person (same e-mail on a member and a guest account, ...). */
const MAX_DIRECTORY_MATCHES = 10;
/** A principal set larger than this is cut (fewer keys can only mean less access). */
export const MAX_CALLER_PRINCIPALS = 5_000;

export const DEFAULT_USER_MATCH: readonly IRagIdentityUserMatchRule[] = Object.freeze([
  { console: 'email', external: 'email' },
  { console: 'email', external: 'upn' },
]) as readonly IRagIdentityUserMatchRule[];

export interface PersonIdentityMatch {
  domain: string;
  /** How the person was matched: a `userMatch` rule, a manual link, or their external id taken as the domain's user id. */
  via: 'rule' | 'link' | 'external_id' | 'group_external_id';
  rule?: IRagIdentityUserMatchRule;
  /** External user ids (or, for group matches, external group ids) the match produced. */
  externalIds: string[];
}

export interface PersonPrincipals {
  userId: string;
  /** The user row exists and is not disabled. Otherwise the person holds only `everyone`. */
  active: boolean;
  email?: string;
  groupIds: string[];
  principals: string[];
  matches: PersonIdentityMatch[];
  /** The set was cut at MAX_CALLER_PRINCIPALS. */
  truncated?: boolean;
}

type IdentityDb = Pick<
  DatabaseProvider,
  | 'findUserById'
  | 'listGroupMembersByUser'
  | 'findGroupById'
  | 'listRagIdentityDomains'
  | 'findRagIdentityUsers'
  | 'listRagIdentityLinks'
> & Partial<Pick<DatabaseProvider, 'iamListGroups'>>;

// ── cache ──────────────────────────────────────────────────────────────

const personCache = new Map<string, { value: PersonPrincipals; expiresAt: number }>();
const personInflight = new Map<string, Promise<PersonPrincipals>>();
/** Per tenant: bumped by every invalidation, so a load that started before it is not cached. */
const generations = new Map<string, number>();

function cacheKey(tenantDbName: string, userId: string): string {
  return `${tenantDbName}\u0000${userId}`;
}

function generationOf(tenantDbName: string): number {
  return generations.get(tenantDbName) ?? 0;
}

/**
 * Forget cached principal sets (this process only; other replicas follow
 * within PERSON_CACHE_TTL_MS). Call after writing identity domains, directory
 * users or links.
 */
export function invalidateRagIdentityCache(tenantDbName?: string): void {
  if (!tenantDbName) {
    personCache.clear();
    personInflight.clear();
    for (const key of [...generations.keys()]) generations.set(key, generationOf(key) + 1);
    return;
  }
  generations.set(tenantDbName, generationOf(tenantDbName) + 1);
  const prefix = `${tenantDbName}\u0000`;
  for (const key of [...personCache.keys()]) if (key.startsWith(prefix)) personCache.delete(key);
  for (const key of [...personInflight.keys()]) if (key.startsWith(prefix)) personInflight.delete(key);
}

function remember(key: string, value: PersonPrincipals): void {
  personCache.delete(key);
  personCache.set(key, { value, expiresAt: Date.now() + PERSON_CACHE_TTL_MS });
  while (personCache.size > PERSON_CACHE_MAX) {
    const oldest = personCache.keys().next().value;
    if (oldest === undefined) break;
    personCache.delete(oldest);
  }
}

// ── matching ───────────────────────────────────────────────────────────

/**
 * The person's values a rule's `console` side names. `externalId` is the SSO / LDAP anchor (`IUser.externalId`) only:
 * `IUser.externalIds` holds what host applications call their people, names the application (or its users) chooses,
 * so they are never an identity in a customer's directory.
 */
function consoleValues(user: IUser, side: IRagIdentityUserMatchRule['console'], email: string | undefined): string[] {
  if (side === 'email') return email ? [email] : [];
  const anchor = typeof user.externalId === 'string' ? user.externalId.trim() : '';
  return anchor ? [anchor] : [];
}

function directoryField(external: IRagIdentityUserMatchRule['external']): 'extId' | 'email' | 'upn' | `attr:${string}` | null {
  if (external === 'id') return 'extId';
  if (external === 'email' || external === 'upn') return external;
  if (typeof external === 'string' && external.startsWith('attr:') && external.length > 5) return external;
  return null;
}

/** Whether `value` is a rule the matching understands (what a directory's settings are validated with). */
export function isUserMatchRule(value: unknown): value is IRagIdentityUserMatchRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Record<string, unknown>;
  return (rule.console === 'email' || rule.console === 'externalId')
    && typeof rule.external === 'string'
    && directoryField(rule.external as IRagIdentityUserMatchRule['external']) !== null;
}

export function userMatchRulesOf(domain: Pick<IRagIdentityDomain, 'userMatch'>): IRagIdentityUserMatchRule[] {
  const rules = Array.isArray(domain.userMatch) ? domain.userMatch.filter(isUserMatchRule) : [];
  return rules.length > 0 ? rules : [...DEFAULT_USER_MATCH];
}

async function matchDirectoryUsers(
  db: IdentityDb,
  domain: IRagIdentityDomain,
  user: IUser,
  email: string | undefined,
): Promise<{ rule: IRagIdentityUserMatchRule; users: IRagIdentityUser[] } | null> {
  for (const rule of userMatchRulesOf(domain)) {
    const field = directoryField(rule.external);
    if (!field) continue;
    const raw = consoleValues(user, rule.console, email);
    if (raw.length === 0) continue;
    // Directory e-mails, UPNs and attributes are stored lower-cased; ids are compared as they are.
    const values = field === 'extId' ? raw : [...new Set(raw.map((v) => v.toLowerCase()))];
    const found = await db.findRagIdentityUsers(domain.key, field, values);
    if (Array.isArray(found) && found.length > 0) {
      return { rule, users: found.slice(0, MAX_DIRECTORY_MATCHES) };
    }
  }
  return null;
}

function addDirectoryUserKeys(keys: Set<string>, domainKey: string, users: IRagIdentityUser[]): void {
  for (const directoryUser of users) {
    const userKey = formatPrincipal({ kind: 'external_user', domain: domainKey, id: directoryUser.extId });
    if (userKey) keys.add(userKey);
    for (const groupId of Array.isArray(directoryUser.groups) ? directoryUser.groups : []) {
      const groupKey = formatPrincipal({ kind: 'external_group', domain: domainKey, id: groupId });
      if (groupKey) keys.add(groupKey);
    }
    if (directoryUser.type !== 'guest') {
      const allKey = formatPrincipal({ kind: 'external_all', domain: domainKey });
      if (allKey) keys.add(allKey);
    }
  }
}

async function loadPersonPrincipals(db: IdentityDb, tenantId: string, userId: string): Promise<PersonPrincipals> {
  const user = await db.findUserById(userId);
  if (!user || user.status === 'disabled') {
    return { userId, active: false, groupIds: [], principals: [EVERYONE_PRINCIPAL], matches: [] };
  }

  const keys = new Set<string>([EVERYONE_PRINCIPAL]);
  const userKey = formatPrincipal({ kind: 'user', id: userId });
  if (userKey) keys.add(userKey);
  // An account of a host application (kind 'external') carries the address the application claimed, which nobody checked
  // here: it is no identity, so such an account holds no e-mail key and is matched to no directory user by e-mail, UPN,
  // attribute or external id. Its user and group keys, and the links an admin made by hand, still count.
  const hostApp = user.kind === 'external';
  const email = hostApp ? undefined : normalizeEmail(user.emailLower || user.email) ?? undefined;
  if (email) {
    const emailKey = formatPrincipal({ kind: 'email', email });
    if (emailKey) keys.add(emailKey);
  }

  const groupIds = await listUserGroupIds(db, userId);
  for (const groupId of groupIds) {
    const groupKey = formatPrincipal({ kind: 'group', id: groupId });
    if (groupKey) keys.add(groupKey);
  }

  const matches: PersonIdentityMatch[] = [];
  const domains = (await db.listRagIdentityDomains()).filter((d) => isValidIdentityDomainKey(d.key));
  if (domains.length > 0) {
    const domainKeys = new Set(domains.map((d) => d.key));
    const wantsGroupExternalIds = domains.some((d) => d.matchGroupsByExternalId !== false);
    const [groups, userLinks, groupLinks] = await Promise.all([
      wantsGroupExternalIds && groupIds.length > 0 ? fetchGroupsByIds(db, tenantId, groupIds) : Promise.resolve([]),
      db.listRagIdentityLinks({ consoleKind: 'user', consoleIds: [userId] }),
      groupIds.length > 0 ? db.listRagIdentityLinks({ consoleKind: 'group', consoleIds: groupIds }) : Promise.resolve([] as IRagIdentityLink[]),
    ]);
    const groupExternalIds = [...new Set(groups
      .map((g) => (typeof g.externalId === 'string' ? g.externalId.trim() : ''))
      .filter(Boolean))];

    for (const domain of domains) {
      const matched = hostApp ? null : await matchDirectoryUsers(db, domain, user, email);
      if (matched) {
        addDirectoryUserKeys(keys, domain.key, matched.users);
        matches.push({ domain: domain.key, via: 'rule', rule: matched.rule, externalIds: matched.users.map((u) => u.extId) });
      } else if (!hostApp) {
        // No directory row: an `externalId -> id` rule still names the person's id in that domain.
        const direct = userMatchRulesOf(domain).some((r) => r.console === 'externalId' && r.external === 'id')
          ? consoleValues(user, 'externalId', email)
          : [];
        const added: string[] = [];
        for (const id of direct) {
          const key = formatPrincipal({ kind: 'external_user', domain: domain.key, id });
          if (key) { keys.add(key); added.push(id); }
        }
        if (added.length > 0) matches.push({ domain: domain.key, via: 'external_id', externalIds: added });
      }

      if (domain.matchGroupsByExternalId !== false && groupExternalIds.length > 0) {
        const added: string[] = [];
        for (const id of groupExternalIds) {
          const key = formatPrincipal({ kind: 'external_group', domain: domain.key, id });
          if (key) { keys.add(key); added.push(id); }
        }
        if (added.length > 0) matches.push({ domain: domain.key, via: 'group_external_id', externalIds: added });
      }
    }

    // Manual links. A link to an external USER makes the person that user, groups included.
    const linkedUsersByDomain = new Map<string, string[]>();
    for (const link of [...userLinks, ...groupLinks]) {
      if (!domainKeys.has(link.domain)) continue;
      if (link.externalKind === 'group') {
        const key = formatPrincipal({ kind: 'external_group', domain: link.domain, id: link.externalId });
        if (key) keys.add(key);
        matches.push({ domain: link.domain, via: 'link', externalIds: [link.externalId] });
      } else if (link.consoleKind === 'user') {
        const list = linkedUsersByDomain.get(link.domain) ?? [];
        list.push(link.externalId);
        linkedUsersByDomain.set(link.domain, list);
      }
      // A console GROUP linked to an external USER is not a valid link (refused on create); ignored here.
    }
    for (const [domainKey, externalIds] of linkedUsersByDomain) {
      for (const id of externalIds) {
        const key = formatPrincipal({ kind: 'external_user', domain: domainKey, id });
        if (key) keys.add(key);
      }
      const directoryUsers = await db.findRagIdentityUsers(domainKey, 'extId', externalIds);
      addDirectoryUserKeys(keys, domainKey, Array.isArray(directoryUsers) ? directoryUsers : []);
      matches.push({ domain: domainKey, via: 'link', externalIds });
    }
  }

  let principals = [...keys];
  let truncated: boolean | undefined;
  if (principals.length > MAX_CALLER_PRINCIPALS) {
    logger.warn('Knowledge Engine principal set cut', { size: principals.length, kept: MAX_CALLER_PRINCIPALS });
    principals = principals.slice(0, MAX_CALLER_PRINCIPALS);
    truncated = true;
  }
  return { userId, active: true, ...(email ? { email } : {}), groupIds, principals, matches, ...(truncated ? { truncated } : {}) };
}

/**
 * The principal keys of a console person. `fresh` skips the cache (the
 * explain view, tests).
 */
export async function resolvePersonPrincipals(
  tenantDbName: string,
  tenantId: string,
  userId: string,
  options: { fresh?: boolean } = {},
): Promise<PersonPrincipals> {
  const key = cacheKey(tenantDbName, userId);
  if (!options.fresh) {
    const hit = personCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const pending = personInflight.get(key);
    if (pending) return pending;
  }
  const generation = generationOf(tenantDbName);
  const load = runWithTenantScope(tenantDbName, (db) => loadPersonPrincipals(db, tenantId, userId));
  if (options.fresh) return load;
  personInflight.set(key, load);
  try {
    const value = await load;
    if (generationOf(tenantDbName) === generation) remember(key, value);
    return value;
  } finally {
    if (personInflight.get(key) === load) personInflight.delete(key);
  }
}

/** The principal keys a caller holds. Tokens and anonymous callers never read the database. */
export async function resolveCallerPrincipals(
  tenantDbName: string,
  tenantId: string,
  caller: KbCaller,
): Promise<{ principals: ReadonlySet<string>; person?: PersonPrincipals }> {
  switch (caller.kind) {
    case 'person': {
      // A delegated call holds the person's keys only: the application's token grants are for calls without a person.
      const person = await resolvePersonPrincipals(tenantDbName, tenantId, caller.userId);
      return { principals: new Set(person.principals), person };
    }
    case 'token': {
      const keys = new Set<string>([EVERYONE_PRINCIPAL]);
      const tokenKey = formatPrincipal({ kind: 'token', id: caller.tokenId });
      if (tokenKey) keys.add(tokenKey);
      return { principals: keys };
    }
    default:
      return { principals: new Set([EVERYONE_PRINCIPAL]) };
  }
}
