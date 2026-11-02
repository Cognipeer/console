/**
 * How the access screens name things: a principal key as a person reads it, the rule that matched someone, the
 * sentences that depend on a count. Pure functions (no React, no fetch), so the screens and their tests share one
 * wording and the rules are tested on their own.
 *
 * A key reaches the screen with up to three sources of a name, best first: the live answer of the audience route
 * (current name, current head count), the label stored with the entry when it was added, and the key itself.
 */

import {
  EVERYONE_PRINCIPAL,
  MAX_ACL_ENTRIES_PER_NODE,
  MAX_ACL_LABEL_LENGTH,
  emailPrincipal,
  normalizeEmail,
  parsePrincipal,
  principalDomain,
  type RagPrincipalKind,
} from '@/lib/services/rag/access/principals';
import type {
  IRagIdentityUserMatchRule,
  RagAccessAudienceItem,
  RagAclEntryInput,
  RagAclEntryView,
  RagAclNodeKey,
  RagAclNodeType,
  RagIdentityMatchView,
  RagNodeAclView,
} from './ragAccessApi';
import { ACCESS_TEXT } from './ragAccessText';

/** A list holds at most this many entries (the server refuses more). */
export const MAX_ENTRIES = MAX_ACL_ENTRIES_PER_NODE;

/** What the audience route said about each key asked, by key. */
export type AudienceMap = Readonly<Record<string, RagAccessAudienceItem | undefined>>;

/* ── Counts ──────────────────────────────────────────────────────────────── */

const numbers = new Intl.NumberFormat('en-US');

/** 1,240 */
export function formatCount(value: number): string {
  return numbers.format(value);
}

/** "1 folder", "3 folders". */
export function countOf(value: number, one: string, many = `${one}s`): string {
  return `${formatCount(value)} ${value === 1 ? one : many}`;
}

/** "1 person", "24 people". */
export function peopleText(value: number): string {
  return value === 1 ? '1 person' : `${formatCount(value)} people`;
}

/** "no console person yet", "1 console person", "14 console people". */
export function consolePeopleText(value: number): string {
  if (value === 0) return 'no console person yet';
  return value === 1 ? '1 console person' : `${formatCount(value)} console people`;
}

/** "23 documents keep their source permissions", "1 document keeps its source permissions", "3 documents and 1 folder keep ...". */
export function keepsPermissionsText(documents: number, folders: number): string {
  const parts: string[] = [];
  if (documents > 0) parts.push(countOf(documents, 'document'));
  if (folders > 0) parts.push(countOf(folders, 'folder'));
  if (parts.length === 0) return 'nothing keeps its source permissions yet';
  return `${parts.join(' and ')} ${documents + folders === 1 ? 'keeps its' : 'keep their'} source permissions`;
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
export function listSentence(phrases: readonly string[], max = 3): string {
  if (phrases.length === 0) return '';
  const shown = phrases.slice(0, max);
  const rest = phrases.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length === 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** "Policies/Leave" -> "Policies / Leave". */
export function folderPathText(path: string): string {
  return path.split('/').map((segment) => segment.trim()).filter(Boolean).join(' / ');
}

/* ── One entry ───────────────────────────────────────────────────────────── */

/** The directory an `x:` key belongs to, as the screen names it: the directory's label, else its key. */
function directoryName(principal: string, audience?: RagAccessAudienceItem): string {
  const parsed = parsePrincipal(principal);
  const domain = parsed ? principalDomain(parsed) : undefined;
  return audience?.detail?.trim() || domain || 'directory';
}

/** The name of the person, group, token or address a key stands for. */
export function entryTitle(principal: string, label?: string, audience?: RagAccessAudienceItem): string {
  const live = audience?.label?.trim();
  if (live) return live;
  const stored = label?.trim();
  if (stored) return stored;
  const parsed = parsePrincipal(principal);
  switch (parsed?.kind) {
    case 'everyone':
      return ACCESS_TEXT.everyoneDefault;
    case 'email':
      return parsed.email;
    case 'external_all':
      return 'All members';
    case 'external_user':
    case 'external_group':
      return parsed.id;
    default:
      return principal;
  }
}

export interface EntryDetail {
  text: string;
  /** The entry points at something that is gone: drawn in orange. */
  warn?: boolean;
}

/** The second line of an entry's row: what kind of thing it is and how many people it reaches. */
export function entryDetail(principal: string, audience?: RagAccessAudienceItem): EntryDetail {
  const parsed = parsePrincipal(principal);
  if (!parsed) return { text: 'Not a valid key', warn: true };
  const gone = audience !== undefined && !audience.exists;
  switch (parsed.kind) {
    case 'everyone':
      return { text: 'Everyone · including calls without a person' };
    case 'user':
      if (gone) return { text: 'Person · no longer exists', warn: true };
      return { text: audience?.detail ? `Person · ${audience.detail}` : 'Person' };
    case 'group':
      if (gone) return { text: 'Group · no longer exists', warn: true };
      return { text: audience?.people != null ? `Group · ${peopleText(audience.people)}` : 'Group' };
    case 'token':
      if (gone) return { text: 'API token · no longer exists', warn: true };
      return { text: 'API token · for calls without a person' };
    case 'email':
      if (audience?.people === 0) return { text: 'E-mail · no console person with this address yet' };
      return { text: audience?.people != null ? `E-mail · ${peopleText(audience.people)}` : 'E-mail' };
    default: {
      const directory = directoryName(principal, audience);
      if (gone) return { text: `${directory} · this directory no longer exists`, warn: true };
      const matches = audience?.people != null ? ` · matches ${consolePeopleText(audience.people)}` : '';
      if (parsed.kind === 'external_all') return { text: `${directory} · guests not included${matches}` };
      return { text: `${directory} ${parsed.kind === 'external_user' ? 'user' : 'group'}${matches}` };
    }
  }
}

/** One key in running text ("Group HR", "SharePoint group HR Team"): a key listed on its own line. */
export function entryPhrase(principal: string, label?: string, audience?: RagAccessAudienceItem): string {
  const parsed = parsePrincipal(principal);
  const name = entryTitle(principal, label, audience);
  switch (parsed?.kind) {
    case 'everyone':
      return 'Everyone';
    case 'group':
      return `Group ${name}`;
    case 'token':
      return `API token ${name}`;
    case 'external_user':
      return `${directoryName(principal, audience)} user ${name}`;
    case 'external_group':
      return `${directoryName(principal, audience)} group ${name}`;
    case 'external_all':
      return `All ${directoryName(principal, audience)} members`;
    default:
      return name;
  }
}

/** The kind of a stored or typed key; null when it is not a valid key. */
export function kindOf(principal: string): RagPrincipalKind | null {
  return parsePrincipal(principal)?.kind ?? null;
}

/* ── A list of entries ───────────────────────────────────────────────────── */

/** What is stored for an entry: the key and, when there is one, its label. */
export function entryInput(principal: string, label?: string): RagAclEntryInput {
  const flat = label?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const clean = flat && flat.length > MAX_ACL_LABEL_LENGTH ? flat.slice(0, MAX_ACL_LABEL_LENGTH) : flat;
  return clean ? { principal, label: clean } : { principal };
}

export function toInput(entry: Pick<RagAclEntryView, 'principal' | 'label'>): RagAclEntryInput {
  return entryInput(entry.principal, entry.label);
}

/** The entry for an address typed by hand, or why it is refused. */
export function emailEntry(raw: string): { entry: RagAclEntryInput } | { error: string } {
  const address = normalizeEmail(raw);
  const principal = address ? emailPrincipal(address) : null;
  if (!address || !principal) return { error: ACCESS_TEXT.emailInvalid };
  return { entry: entryInput(principal, address) };
}

/** Whether two lists name the same keys (order and labels are not a difference). */
export function sameEntries(a: readonly RagAclEntryInput[], b: readonly RagAclEntryInput[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map((entry) => entry.principal));
  return b.every((entry) => keys.has(entry.principal)) && keys.size === a.length;
}

/**
 * The list a node starts with when it gets its own permissions: a copy of what it reads from now. A root nobody is
 * named on reads as everyone, and an empty copy would close the node, so that copy is the `everyone` key.
 */
export function startingEntries(effective: RagNodeAclView['effective'] | null | undefined): RagAclEntryInput[] {
  if (!effective) return [];
  if (effective.openToEveryone) return [{ principal: EVERYONE_PRINCIPAL }];
  return effective.entries.map(toInput);
}

/** "Now readable by Group HR, Ayşe Yılmaz and legal@contoso.com." for what a node inherits. */
export function inheritedSentence(
  effective: RagNodeAclView['effective'] | null | undefined,
  audience: AudienceMap,
): string {
  if (!effective) return '';
  if (effective.node.type === 'missing') return 'Now readable by nobody: a folder above it is missing.';
  if (effective.openToEveryone) return 'Now readable by everyone who can open this knowledge engine.';
  if (effective.entries.length === 0) return 'Now readable by nobody.';
  const phrases = effective.entries.map((entry) => (entry.principal === EVERYONE_PRINCIPAL
    ? 'everyone who can open this knowledge engine'
    : entryPhrase(entry.principal, entry.label, audience[entry.principal])));
  return `Now readable by ${listSentence(phrases)}.`;
}

/** What an empty own list means, by the admin exception. */
export function emptyListSentence(adminBypass: boolean): string {
  return adminBypass ? ACCESS_TEXT.bypassOnSentence : ACCESS_TEXT.bypassOffSentence;
}

/* ── The node ────────────────────────────────────────────────────────────── */

const segments = (path?: string): string[] => (path ?? '').split('/').map((part) => part.trim()).filter(Boolean);

/** "Folder · HR Policies / Policies / Leave", "Document · HR Policies / Policies / handbook.pdf", "Default access · HR Policies". */
export function nodeSubtitle(node: RagAclNodeKey, name: string, path: string | undefined, moduleName: string): string {
  if (node === 'module') return `Default access · ${moduleName}`;
  if (node.startsWith('folder:')) {
    const own = segments(path);
    return `Folder · ${[moduleName, ...(own.length > 0 ? own : [name])].join(' / ')}`;
  }
  return `Document · ${[moduleName, ...segments(path), name].join(' / ')}`;
}

/** The node that decides, as a phrase: "the document's own permissions", "the default access", ... */
export function decidedByText(effective: { type: RagAclNodeType | 'missing'; id: string }, folderPath?: string): string {
  switch (effective.type) {
    case 'document':
      return "the document's own permissions";
    case 'folder':
      return folderPath ? `the permissions of the folder ${folderPathText(folderPath)}` : 'the permissions of its folder';
    case 'module':
      return 'the default access';
    default:
      return 'a broken folder chain: a folder above the document is missing, so nobody can read it';
  }
}

/** "Administers this knowledge engine" as the check shows it. */
export function administersText(manage: boolean, bypass: boolean): string {
  if (!manage) return 'No';
  return bypass
    ? 'Yes · the admin exception applies, so they read every document'
    : 'Yes · the admin exception is off, so they read only what the permissions allow';
}

/* ── Matching rules ──────────────────────────────────────────────────────── */

/**
 * The rules a directory applies when none are stored. The engine keeps the same list (`DEFAULT_USER_MATCH` in
 * access/identity.ts, a server module this screen cannot import); a test holds the two together.
 */
export const DEFAULT_MATCH_RULES: readonly IRagIdentityUserMatchRule[] = [
  { console: 'email', external: 'email' },
  { console: 'email', external: 'upn' },
];

/** The rules in force: the stored ones, or the defaults when there are none. */
export function effectiveRules(userMatch: readonly IRagIdentityUserMatchRule[] | null | undefined): IRagIdentityUserMatchRule[] {
  return userMatch && userMatch.length > 0 ? [...userMatch] : [...DEFAULT_MATCH_RULES];
}

/** The 1-based position of a rule among the rules in force; undefined when it is not one of them. */
export function ruleNumber(rule: IRagIdentityUserMatchRule, rules: readonly IRagIdentityUserMatchRule[]): number | undefined {
  const index = rules.findIndex((candidate) => candidate.console === rule.console && candidate.external === rule.external);
  return index < 0 ? undefined : index + 1;
}

export function consoleSideText(side: IRagIdentityUserMatchRule['console']): string {
  return side === 'email' ? 'e-mail' : 'external ID (SSO / LDAP)';
}

export function externalSideText(side: IRagIdentityUserMatchRule['external']): string {
  if (side === 'email') return 'e-mail';
  if (side === 'upn') return 'UPN';
  if (side === 'id') return 'ID';
  return side.startsWith('attr:') ? `attribute "${side.slice(5)}"` : side;
}

/** "console e-mail = directory e-mail" */
export function ruleText(rule: IRagIdentityUserMatchRule): string {
  return `console ${consoleSideText(rule.console)} = directory ${externalSideText(rule.external)}`;
}

/** How a directory matched a person: "HR SharePoint, rule 1: console e-mail = directory e-mail", "HR SharePoint: manual link", ... */
export function describeMatch(
  match: RagIdentityMatchView,
  directory?: { label?: string; userMatch?: readonly IRagIdentityUserMatchRule[] } | null,
): string {
  const label = directory?.label?.trim() || match.domain;
  switch (match.via) {
    case 'rule': {
      if (!match.rule) return `${label}: matched by a rule`;
      // The place of a rule is only known against the rules of its directory.
      const number = directory ? ruleNumber(match.rule, effectiveRules(directory.userMatch)) : undefined;
      return `${label}${number ? `, rule ${number}` : ''}: ${ruleText(match.rule)}`;
    }
    case 'link':
      return `${label}: manual link`;
    case 'external_id':
      return `${label}: the external ID (SSO / LDAP) of the person is taken as the directory user ID`;
    default:
      return `${label}: the external ID of one of their groups is the ID of a directory group`;
  }
}
