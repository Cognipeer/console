/**
 * Who a directory entry stands for, and which directory users a console person is.
 *
 * `identity.ts` answers "which keys does THIS person hold" with one directory lookup per rule. The views of the
 * dashboard ask the other way round: which people hold this key, which console people a directory user is tied to,
 * how many users a set of rules would match. All of them are folds over the same join of console people and a
 * directory, so the pieces live here, free of any I/O, and `identity.ts` runs on the very same pieces
 * (`ruleQueryOf`, `applyRuleHit`, `externalIdFallback`, ...): what a screen shows cannot drift from what a search
 * decides. A directory is a `DirectoryFinder` the caller builds from rows it read (`memoryFinder`); nothing here
 * touches a database, a logger or a clock.
 */

import type {
  IGroup,
  IRagIdentityLink,
  IRagIdentityUser,
  IRagIdentityUserMatchRule,
  IUser,
} from '@/lib/database';
import { foldIdentityValue, resolveRagIdentityLookup } from '@/lib/database/provider/ragAccess';
import { EVERYONE_PRINCIPAL, formatPrincipal, isValidIdentityDomainKey, normalizeEmail } from './principals';

/** Directory users one rule may match for one person (same e-mail on a member and a guest account, ...). */
export const MAX_DIRECTORY_MATCHES = 10;

export type DirectoryField = 'extId' | 'email' | 'upn' | `attr:${string}`;

/**
 * A directory looked up without I/O: the same answer as `db.findRagIdentityUsers(domainKey, field, values)`
 * (`extId` compared as given, every other field lower-cased; ordered by `extId`).
 */
export type DirectoryFinder = (field: DirectoryField, values: readonly string[]) => readonly IRagIdentityUser[];

export interface PersonIdentityMatch {
  domain: string;
  /** How the person was matched: a `userMatch` rule, a manual link, or their external id taken as the domain's user id. */
  via: 'rule' | 'link' | 'external_id' | 'group_external_id';
  rule?: IRagIdentityUserMatchRule;
  /** External user ids (or, for group matches, external group ids) the match produced. */
  externalIds: string[];
}

/** Everything `loadPersonPrincipals` reads about one console person. */
export interface MatchablePerson {
  userId: string;
  /** The account exists and is not disabled. Anyone else holds only `everyone`. */
  active: boolean;
  /** An account of a host application (`kind: 'external'`): no e-mail key, no rule matching; its links and groups still count. */
  hostApp: boolean;
  /** The stored e-mail, normalized (undefined for a host-application account and for an address that is none). */
  email?: string;
  /** The SSO / LDAP anchor (`IUser.externalId`), trimmed; undefined when blank. */
  externalId?: string;
  /** Console groups the person belongs to (membership rows, whether or not the group still exists). */
  groupIds: readonly string[];
  /** Distinct, trimmed external ids of those groups. */
  groupExternalIds: readonly string[];
}

/** One identity domain as the matching sees it. */
export interface DomainRules {
  key: string;
  /** The rules in force (`userMatchRulesOf(domain)`) or a candidate list, in order. */
  rules: readonly IRagIdentityUserMatchRule[];
  /** `domain.matchGroupsByExternalId !== false`. */
  matchGroupsByExternalId: boolean;
  /** Manual links of the domain (`listRagIdentityLinks({ domain })`); only those that reach a person count for them. */
  links: readonly IRagIdentityLink[];
}

// ── the person ─────────────────────────────────────────────────────────

/** Distinct, trimmed, non-empty external ids of console groups. */
export function groupExternalIdsOf(groups: ReadonlyArray<Pick<IGroup, 'externalId'>>): string[] {
  return [...new Set(groups
    .map((g) => (typeof g.externalId === 'string' ? g.externalId.trim() : ''))
    .filter(Boolean))];
}

/**
 * The person `loadPersonPrincipals` works with. `groups` are the groups the person belongs to (an entry without an
 * `externalId` is fine: it only adds the id).
 */
export function matchablePersonOf(
  user: Pick<IUser, '_id' | 'email' | 'emailLower' | 'externalId' | 'kind' | 'status'>,
  groups: ReadonlyArray<Pick<IGroup, '_id' | 'externalId'>>,
): MatchablePerson {
  // An account of a host application carries the address the application claimed, which nobody checked here: it is no
  // identity, so such an account holds no e-mail key and is matched to no directory user by e-mail, UPN, attribute or id.
  const hostApp = user.kind === 'external';
  const email = hostApp ? undefined : normalizeEmail(user.emailLower || user.email) ?? undefined;
  const anchor = typeof user.externalId === 'string' ? user.externalId.trim() : '';
  return {
    userId: String(user._id ?? ''),
    active: user.status !== 'disabled',
    hostApp,
    ...(email ? { email } : {}),
    ...(anchor ? { externalId: anchor } : {}),
    groupIds: [...new Set(groups.map((g) => String(g._id)))],
    groupExternalIds: groupExternalIdsOf(groups),
  };
}

/** `everyone`, the person's own keys, their e-mail and their console groups; a disabled account holds `everyone` only. */
export function consoleKeysOf(person: MatchablePerson): string[] {
  const keys = new Set<string>([EVERYONE_PRINCIPAL]);
  if (!person.active) return [...keys];
  const userKey = formatPrincipal({ kind: 'user', id: person.userId });
  if (userKey) keys.add(userKey);
  if (person.email) {
    const emailKey = formatPrincipal({ kind: 'email', email: person.email });
    if (emailKey) keys.add(emailKey);
  }
  for (const groupId of person.groupIds) {
    const groupKey = formatPrincipal({ kind: 'group', id: groupId });
    if (groupKey) keys.add(groupKey);
  }
  return [...keys];
}

// ── rules ──────────────────────────────────────────────────────────────

/** The directory field a rule's `external` side names, or null when it names none. */
export function directoryField(external: IRagIdentityUserMatchRule['external']): DirectoryField | null {
  if (external === 'id') return 'extId';
  if (external === 'email' || external === 'upn') return external;
  if (typeof external === 'string' && external.startsWith('attr:') && external.length > 5) return external;
  return null;
}

/**
 * The person's values a rule's `console` side names. `externalId` is the SSO / LDAP anchor (`IUser.externalId`) only:
 * `IUser.externalIds` holds what host applications call their people, names the application (or its users) chooses,
 * so they are never an identity in a customer's directory.
 */
export function consoleValues(person: Pick<MatchablePerson, 'email' | 'externalId'>, side: IRagIdentityUserMatchRule['console']): string[] {
  if (side === 'email') return person.email ? [person.email] : [];
  return person.externalId ? [person.externalId] : [];
}

/** What one rule asks of the directory for one person, or null when the rule has nothing to compare (no value, unknown field). */
export function ruleQueryOf(
  person: Pick<MatchablePerson, 'email' | 'externalId'>,
  rule: IRagIdentityUserMatchRule,
): { field: DirectoryField; values: string[] } | null {
  const field = directoryField(rule.external);
  if (!field) return null;
  const raw = consoleValues(person, rule.console);
  if (raw.length === 0) return null;
  // Directory e-mails, UPNs and attributes are stored lower-cased; ids are compared as they are.
  const values = field === 'extId' ? raw : [...new Set(raw.map((v) => v.toLowerCase()))];
  return { field, values };
}

/** The directory users the first rule that found any decided on. */
export interface RuleHit {
  /** Position of the rule in the list that was walked. */
  ruleIndex: number;
  rule: IRagIdentityUserMatchRule;
  /** At most MAX_DIRECTORY_MATCHES, in `extId` order. */
  users: IRagIdentityUser[];
}

export function ruleHitOf(ruleIndex: number, rule: IRagIdentityUserMatchRule, found: readonly IRagIdentityUser[]): RuleHit {
  return { ruleIndex, rule, users: found.slice(0, MAX_DIRECTORY_MATCHES) };
}

/**
 * Walk the rules in order; the first one that finds directory users decides. A rule the person has no value for, and a
 * rule that finds nobody, are skipped. Nobody matches who is disabled or an account of a host application.
 */
export function firstRuleHit(
  person: MatchablePerson,
  rules: readonly IRagIdentityUserMatchRule[],
  find: DirectoryFinder,
): RuleHit | null {
  if (!person.active || person.hostApp) return null;
  for (let index = 0; index < rules.length; index += 1) {
    const query = ruleQueryOf(person, rules[index]);
    if (!query) continue;
    const found = find(query.field, query.values);
    if (found.length > 0) return ruleHitOf(index, rules[index], found);
  }
  return null;
}

// ── keys of a directory ────────────────────────────────────────────────

/** The keys a directory user stands for: itself, each of its groups (nested ones as the integration reported them) and, for members, the domain-wide key. */
export function addDirectoryUserKeys(keys: Set<string>, domainKey: string, users: readonly IRagIdentityUser[]): void {
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

/** Add what a rule's hit gives the person; the record of how they were matched. */
export function applyRuleHit(keys: Set<string>, domainKey: string, hit: RuleHit): PersonIdentityMatch {
  addDirectoryUserKeys(keys, domainKey, hit.users);
  return { domain: domainKey, via: 'rule', rule: hit.rule, externalIds: hit.users.map((u) => u.extId) };
}

/**
 * No rule found anyone: an `externalId -> id` rule still names the person's SSO / LDAP id as their id in the domain. It
 * needs no directory row, and gives no groups and no domain-wide key.
 */
export function externalIdFallback(
  keys: Set<string>,
  person: MatchablePerson,
  domainKey: string,
  rules: readonly IRagIdentityUserMatchRule[],
): PersonIdentityMatch | null {
  if (person.hostApp) return null;
  const direct = rules.some((r) => r.console === 'externalId' && r.external === 'id') ? consoleValues(person, 'externalId') : [];
  const added: string[] = [];
  for (const id of direct) {
    const key = formatPrincipal({ kind: 'external_user', domain: domainKey, id });
    if (key) { keys.add(key); added.push(id); }
  }
  return added.length > 0 ? { domain: domainKey, via: 'external_id', externalIds: added } : null;
}

/** A console group whose external id is the id of a directory group stands for that group (the caller checks the domain allows it). */
export function groupExternalIdKeys(keys: Set<string>, person: MatchablePerson, domainKey: string): PersonIdentityMatch | null {
  const added: string[] = [];
  for (const id of person.groupExternalIds) {
    const key = formatPrincipal({ kind: 'external_group', domain: domainKey, id });
    if (key) { keys.add(key); added.push(id); }
  }
  return added.length > 0 ? { domain: domainKey, via: 'group_external_id', externalIds: added } : null;
}

/** A link to an external GROUP (from a console user or a console group). */
export function addLinkedGroupKey(keys: Set<string>, domainKey: string, externalId: string): PersonIdentityMatch {
  const key = formatPrincipal({ kind: 'external_group', domain: domainKey, id: externalId });
  if (key) keys.add(key);
  return { domain: domainKey, via: 'link', externalIds: [externalId] };
}

/** Links to external USERS make the person those users, their groups included (`directoryUsers`: the ones the directory has). */
export function addLinkedUserKeys(
  keys: Set<string>,
  domainKey: string,
  externalIds: readonly string[],
  directoryUsers: readonly IRagIdentityUser[],
): PersonIdentityMatch {
  for (const id of externalIds) {
    const key = formatPrincipal({ kind: 'external_user', domain: domainKey, id });
    if (key) keys.add(key);
  }
  addDirectoryUserKeys(keys, domainKey, directoryUsers);
  return { domain: domainKey, via: 'link', externalIds: [...externalIds] };
}

/** Whether a manual link applies to the person: it names them, or one of their console groups. */
export function linkReaches(
  link: Pick<IRagIdentityLink, 'consoleKind' | 'consoleId'>,
  person: Pick<MatchablePerson, 'userId' | 'groupIds'>,
): boolean {
  if (link.consoleKind === 'user') return link.consoleId === person.userId;
  if (link.consoleKind === 'group') return person.groupIds.includes(link.consoleId);
  return false;
}

/**
 * The keys one identity domain gives a person, and how they were matched: the first rule that finds directory users,
 * else the `externalId -> id` fallback, the console groups whose external id is a directory group's, and the manual
 * links. These are unioned (a link applies even when a rule matched); nothing is denied. Exactly what
 * `loadPersonPrincipals` does for the domain, over a finder instead of the database.
 */
export function domainKeysOf(
  person: MatchablePerson,
  d: DomainRules,
  find: DirectoryFinder,
): { keys: string[]; matches: PersonIdentityMatch[] } {
  if (!person.active || !isValidIdentityDomainKey(d.key)) return { keys: [], matches: [] };
  const keys = new Set<string>();
  const matches: PersonIdentityMatch[] = [];

  const hit = person.hostApp ? null : firstRuleHit(person, d.rules, find);
  if (hit) {
    matches.push(applyRuleHit(keys, d.key, hit));
  } else if (!person.hostApp) {
    const direct = externalIdFallback(keys, person, d.key, d.rules);
    if (direct) matches.push(direct);
  }

  if (d.matchGroupsByExternalId) {
    const viaGroups = groupExternalIdKeys(keys, person, d.key);
    if (viaGroups) matches.push(viaGroups);
  }

  // Links of the person first, then those of their groups (the order the engine reads them in).
  const reaching = d.links.filter((link) => link.domain === d.key && linkReaches(link, person));
  const ordered = [
    ...reaching.filter((link) => link.consoleKind === 'user'),
    ...reaching.filter((link) => link.consoleKind === 'group'),
  ];
  const linkedUsers: string[] = [];
  for (const link of ordered) {
    if (link.externalKind === 'group') {
      matches.push(addLinkedGroupKey(keys, d.key, link.externalId));
    } else if (link.consoleKind === 'user') {
      linkedUsers.push(link.externalId);
    }
    // A console GROUP linked to an external USER is not a valid link (refused on create); ignored here.
  }
  if (linkedUsers.length > 0) {
    matches.push(addLinkedUserKeys(keys, d.key, linkedUsers, find('extId', linkedUsers)));
  }
  return { keys: [...keys], matches };
}

// ── the directory without I/O ──────────────────────────────────────────

/** Strings in the order both stores sort them in: byte order of their UTF-8 form, which is code point order ('Z' before 'a'). */
function compareBinary(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}

/**
 * A finder over directory users already read. It compares the way the stores do: `extId` as given, e-mail, UPN and
 * attribute values lower-cased on both sides, and answers ordered by `extId`. Rows read for one lookup also answer
 * another, which is only right when every lookup asked of it was prefetched (the rows hold every user whose field is
 * one of the values asked for).
 */
export function memoryFinder(rows: readonly IRagIdentityUser[]): DirectoryFinder {
  const byExtId = new Map<string, IRagIdentityUser>();
  for (const row of rows) if (typeof row.extId === 'string' && row.extId.length > 0) byExtId.set(row.extId, row);
  const unique = [...byExtId.values()];
  const indexes = new Map<string, Map<string, IRagIdentityUser[]>>();

  const indexOf = (name: string, valueOf: (row: IRagIdentityUser) => string | undefined): Map<string, IRagIdentityUser[]> => {
    let index = indexes.get(name);
    if (!index) {
      index = new Map();
      for (const row of unique) {
        const value = valueOf(row);
        if (value === undefined) continue;
        const list = index.get(value);
        if (list) list.push(row); else index.set(value, [row]);
      }
      indexes.set(name, index);
    }
    return index;
  };

  return (field, values) => {
    const lookup = resolveRagIdentityLookup(field, values);
    if (!lookup) return [];
    let index: Map<string, IRagIdentityUser[]>;
    if (lookup.kind === 'extId') {
      index = indexOf('extId', (row) => row.extId);
    } else if (lookup.kind === 'attr') {
      const name = lookup.name;
      index = indexOf(`attr:${name}`, (row) => foldIdentityValue(row.attrs?.[name]));
    } else {
      const column = lookup.kind;
      index = indexOf(column, (row) => foldIdentityValue(row[column]));
    }
    const found = new Map<string, IRagIdentityUser>();
    for (const value of lookup.values) for (const row of index.get(value) ?? []) found.set(row.extId, row);
    return [...found.values()].sort((a, b) => compareBinary(a.extId, b.extId));
  };
}

// ── the other way round ────────────────────────────────────────────────

/** key -> the people who hold it, from every person's keys. */
export function holdersByKey(held: ReadonlyMap<string, Iterable<string>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [userId, keys] of held) {
    for (const key of new Set(keys)) {
      const list = out.get(key);
      if (list) list.push(userId); else out.set(key, [userId]);
    }
  }
  return out;
}

/** One console person a directory user is tied to. */
export interface DirectoryMatch {
  userId: string;
  via: 'rule' | 'link';
  /** Position of the deciding rule in the list walked (rule matches only). */
  ruleIndex?: number;
  /** The manual link (link matches only). */
  linkId?: string;
}

/**
 * directory user id -> the console people tied to it. A rule ties a user to every person it is the first rule to find
 * the user for (a person is matched by one rule only: the first that finds anyone). A link ties the user it names to
 * the console person it names. Links to ids the directory does not list tie nobody; those only give their person the
 * key (`domainKeysOf`). Disabled people and accounts of host applications are not matched by rules; a link to the
 * latter still counts.
 */
export function indexDirectoryMatches(
  people: readonly MatchablePerson[],
  d: Pick<DomainRules, 'key' | 'rules' | 'links'>,
  find: DirectoryFinder,
): Map<string, DirectoryMatch[]> {
  const index = new Map<string, DirectoryMatch[]>();
  const add = (extId: string, match: DirectoryMatch): void => {
    const list = index.get(extId);
    if (list) list.push(match); else index.set(extId, [match]);
  };
  const active = new Map<string, MatchablePerson>();
  for (const person of people) if (person.active) active.set(person.userId, person);

  for (const person of active.values()) {
    const hit = firstRuleHit(person, d.rules, find);
    if (!hit) continue;
    for (const user of hit.users) add(user.extId, { userId: person.userId, via: 'rule', ruleIndex: hit.ruleIndex });
  }

  const userLinks = d.links.filter((link) => link.domain === d.key
    && link.externalKind === 'user' && link.consoleKind === 'user' && active.has(link.consoleId));
  if (userLinks.length > 0) {
    const listed = new Set(find('extId', userLinks.map((link) => link.externalId)).map((u) => u.extId));
    for (const link of userLinks) {
      if (!listed.has(link.externalId)) continue;
      add(link.externalId, {
        userId: link.consoleId,
        via: 'link',
        ...(link._id !== undefined ? { linkId: String(link._id) } : {}),
      });
    }
  }
  return index;
}

export interface MatchPreview {
  /** The rules that were walked, in order. */
  rules: IRagIdentityUserMatchRule[];
  /** Active people looked at. */
  considered: number;
  /** Active people tied to at least one directory user (by a rule or a link). */
  matchedPeople: number;
  /** Ids of the directory users tied to at least one person. */
  matchedExtIds: Set<string>;
  /**
   * Per rule: the directory users it decided. A user counts for the first (lowest) rule that ties any person to it,
   * so the counts never add up to more than the users matched; a user only links tie belong to no rule.
   */
  decidedByRule: number[];
  byDirectoryUser: Map<string, DirectoryMatch[]>;
}

/** What a list of rules would match: the numbers a settings screen shows before the rules are saved. */
export function previewUserMatch(
  candidate: readonly IRagIdentityUserMatchRule[],
  people: readonly MatchablePerson[],
  d: Pick<DomainRules, 'key' | 'links'>,
  find: DirectoryFinder,
): MatchPreview {
  const byDirectoryUser = indexDirectoryMatches(people, { key: d.key, rules: candidate, links: d.links }, find);
  const decidedByRule = candidate.map(() => 0);
  const matchedPeople = new Set<string>();
  for (const matches of byDirectoryUser.values()) {
    let first = -1;
    for (const match of matches) {
      matchedPeople.add(match.userId);
      if (match.via === 'rule' && match.ruleIndex !== undefined && (first < 0 || match.ruleIndex < first)) first = match.ruleIndex;
    }
    if (first >= 0) decidedByRule[first] += 1;
  }
  const considered = new Set<string>();
  for (const person of people) if (person.active) considered.add(person.userId);
  return {
    rules: [...candidate],
    considered: considered.size,
    matchedPeople: matchedPeople.size,
    matchedExtIds: new Set(byDirectoryUser.keys()),
    decidedByRule,
    byDirectoryUser,
  };
}
