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
 * The pieces of that matching (what a rule asks, what a hit adds, how links
 * apply) are in `audience.ts` and are shared with the dashboard's views, which
 * ask the same question for many people at once. This file adds what only a
 * single lookup needs: one directory query per rule, run lazily, and the cache.
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
  type IRagIdentityUserMatchRule,
} from '@/lib/database';
import { fetchGroupsByIds, listUserGroupIds } from '@/lib/iam/groupGrants';
import {
  addLinkedGroupKey,
  addLinkedUserKeys,
  applyRuleHit,
  consoleKeysOf,
  directoryField,
  externalIdFallback,
  groupExternalIdKeys,
  groupExternalIdsOf,
  matchablePersonOf,
  ruleHitOf,
  ruleQueryOf,
  type MatchablePerson,
  type PersonIdentityMatch,
  type RuleHit,
} from './audience';
import type { KbCaller } from './caller';
import {
  EVERYONE_PRINCIPAL,
  formatPrincipal,
  isValidIdentityDomainKey,
} from './principals';

const logger = createLogger('rag:access:identity');

const PERSON_CACHE_TTL_MS = 15_000;
const PERSON_CACHE_MAX = 2_000;
/** A principal set larger than this is cut (fewer keys can only mean less access). */
export const MAX_CALLER_PRINCIPALS = 5_000;

export const DEFAULT_USER_MATCH: readonly IRagIdentityUserMatchRule[] = Object.freeze([
  { console: 'email', external: 'email' },
  { console: 'email', external: 'upn' },
]) as readonly IRagIdentityUserMatchRule[];

export type { PersonIdentityMatch };

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
/** Bumped by every invalidation of all tenants, so tenants that have no counter of their own change too. */
let globalEpoch = 0;

function cacheKey(tenantDbName: string, userId: string): string {
  return `${tenantDbName}\u0000${userId}`;
}

function generationOf(tenantDbName: string): number {
  return (generations.get(tenantDbName) ?? 0) + globalEpoch;
}

/**
 * Changes whenever `invalidateRagIdentityCache` is called for the tenant (or for all). A cache of something derived
 * from identity domains, directory users or links compares it before it serves and before it stores.
 */
export function ragIdentityCacheGeneration(tenantDbName: string): number {
  return generationOf(tenantDbName);
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
    globalEpoch += 1;
    return;
  }
  generations.set(tenantDbName, (generations.get(tenantDbName) ?? 0) + 1);
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

/**
 * The first rule that finds directory users. One query per rule, in order, and none after a hit: a person is looked up
 * one rule at a time, so a hit on the first rule costs one query.
 */
async function matchDirectoryUsers(
  db: IdentityDb,
  domainKey: string,
  person: MatchablePerson,
  rules: readonly IRagIdentityUserMatchRule[],
): Promise<RuleHit | null> {
  for (let index = 0; index < rules.length; index += 1) {
    const query = ruleQueryOf(person, rules[index]);
    if (!query) continue;
    const found = await db.findRagIdentityUsers(domainKey, query.field, query.values);
    if (Array.isArray(found) && found.length > 0) return ruleHitOf(index, rules[index], found);
  }
  return null;
}

async function loadPersonPrincipals(db: IdentityDb, tenantId: string, userId: string): Promise<PersonPrincipals> {
  const user = await db.findUserById(userId);
  if (!user || user.status === 'disabled') {
    return { userId, active: false, groupIds: [], principals: [EVERYONE_PRINCIPAL], matches: [] };
  }

  const groupIds = await listUserGroupIds(db, userId);
  // An account of a host application (kind 'external') carries the address the application claimed, which nobody checked
  // here: it is no identity, so such an account holds no e-mail key and is matched to no directory user by e-mail, UPN,
  // attribute or external id. Its user and group keys, and the links an admin made by hand, still count.
  const base = matchablePersonOf(user, groupIds.map((id) => ({ _id: id })));
  const keys = new Set<string>(consoleKeysOf({ ...base, userId }));

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
    const person: MatchablePerson = { ...base, userId, groupExternalIds: groupExternalIdsOf(groups) };

    for (const domain of domains) {
      const rules = userMatchRulesOf(domain);
      const hit = person.hostApp ? null : await matchDirectoryUsers(db, domain.key, person, rules);
      if (hit) {
        matches.push(applyRuleHit(keys, domain.key, hit));
      } else if (!person.hostApp) {
        // No directory row: an `externalId -> id` rule still names the person's id in that domain.
        const direct = externalIdFallback(keys, person, domain.key, rules);
        if (direct) matches.push(direct);
      }

      if (domain.matchGroupsByExternalId !== false) {
        const viaGroups = groupExternalIdKeys(keys, person, domain.key);
        if (viaGroups) matches.push(viaGroups);
      }
    }

    // Manual links. A link to an external USER makes the person that user, groups included.
    const linkedUsersByDomain = new Map<string, string[]>();
    for (const link of [...userLinks, ...groupLinks]) {
      if (!domainKeys.has(link.domain)) continue;
      if (link.externalKind === 'group') {
        matches.push(addLinkedGroupKey(keys, link.domain, link.externalId));
      } else if (link.consoleKind === 'user') {
        const list = linkedUsersByDomain.get(link.domain) ?? [];
        list.push(link.externalId);
        linkedUsersByDomain.set(link.domain, list);
      }
      // A console GROUP linked to an external USER is not a valid link (refused on create); ignored here.
    }
    for (const [domainKey, externalIds] of linkedUsersByDomain) {
      const directoryUsers = await db.findRagIdentityUsers(domainKey, 'extId', externalIds);
      matches.push(addLinkedUserKeys(keys, domainKey, externalIds, Array.isArray(directoryUsers) ? directoryUsers : []));
    }
  }

  let principals = [...keys];
  let truncated: boolean | undefined;
  if (principals.length > MAX_CALLER_PRINCIPALS) {
    logger.warn('Knowledge Engine principal set cut', { size: principals.length, kept: MAX_CALLER_PRINCIPALS });
    principals = principals.slice(0, MAX_CALLER_PRINCIPALS);
    truncated = true;
  }
  const email = base.email;
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
