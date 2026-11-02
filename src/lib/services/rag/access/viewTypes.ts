/**
 * Answer shapes of the access-control views a knowledge base's admins read: the
 * summary of the Access tab, permission states of listed rows, who a principal
 * stands for, pickers, and the people of an identity directory with how they
 * match console people.
 *
 * Types only, so the dashboard client (`components/rag/access/ragAccessApi.ts`)
 * and the routes share one contract. Times are ISO strings, as they arrive.
 */

import type { IRagIdentityUserMatchRule } from '@/lib/database';
import type { RagPrincipalKind } from './principals';

/** How many items of one kind have their own permissions, come from a connected source, or are readable by nobody. */
export interface RagAccessNodeCounts {
  total: number;
  /** Items with their own permissions (synced ones included). */
  own: number;
  /** Items whose folder and permissions a connected source owns. */
  synced: number;
  /** Items with their own permissions and no entry: readable by nobody but admins with the admin exception. */
  closed: number;
}

export interface RagAccessClosedItem {
  type: 'folder' | 'document';
  id: string;
  name: string;
  /** Folder path (folders only). */
  path?: string;
  /** The folder a document sits in; absent = top level (documents only). */
  folderId?: string;
}

export interface RagAccessDirectoryUse {
  /** Identity directory key (the `<domain>` of `x:<domain>:...` principals). */
  key: string;
  label: string;
  /** The connector that keeps the directory, when one does. */
  connectorId?: string;
  /** Documents and folders of this knowledge base with entries that name the directory. */
  documents: number;
  folders: number;
}

export interface RagAccessSummaryView {
  enabled: boolean;
  /** In force (absent in the module = true). */
  adminBypass: boolean;
  root: { entries: number; openToEveryone: boolean };
  folders: RagAccessNodeCounts;
  documents: RagAccessNodeCounts;
  /** Up to 50 items readable by nobody: closed folders first, then documents, newest first. */
  closed: RagAccessClosedItem[];
  /** false when the scan for closed documents stopped before the end. */
  closedComplete: boolean;
  directories: RagAccessDirectoryUse[];
}

/** Permission state of one listed folder or document. Keyed `folder:<id>` / `document:<id>`. */
export interface RagAccessNodeState {
  mode: 'own' | 'inherit';
  managed?: 'sync';
  /** Entries of its own list (0 while it inherits). */
  entries: number;
}

/** Who one principal key stands for, for the lists of the permission editor. */
export interface RagAccessAudienceItem {
  kind: RagPrincipalKind;
  /** Name of the person, group, token or directory entry, when known. */
  label?: string;
  /** E-mail of a person, directory label of an `x:` key. */
  detail?: string;
  /** The named user, group, token or directory exists. */
  exists: boolean;
  /**
   * Active console people the key reaches: 1/0 for a person, members of a group, people with the address for an
   * e-mail, matched people for a directory key. null when not counted (everyone, tokens, and directory keys for
   * callers who are not workspace-level admins).
   */
  people: number | null;
}

export interface RagAccessPrincipalOption {
  /** The key to store: `user:<id>`, `group:<id>` or `token:<id>`. */
  principal: string;
  kind: 'user' | 'group' | 'token';
  label: string;
  detail?: string;
}

export interface RagConsolePersonOption {
  id: string;
  kind: 'user' | 'group';
  label: string;
  detail?: string;
}

/** How a directory user is tied to one console person. */
export interface RagIdentityConsoleMatch {
  userId: string;
  name?: string;
  email?: string;
  via: 'rule' | 'link';
  /** Index into `RagIdentityMatchSummary.rules` (rule matches only). */
  rule?: number;
  /** The manual link (link matches only). */
  linkId?: string;
}

export interface RagIdentityDirectoryUserView {
  extId: string;
  name?: string;
  email?: string;
  upn?: string;
  type: 'member' | 'guest';
  /** Groups the user belongs to in the directory. */
  groups: number;
  console: RagIdentityConsoleMatch[];
}

export interface RagIdentityMatchSummary {
  directoryUsers: number;
  /** Directory users tied to at least one console person. */
  matchedUsers: number;
  /** Active console people looked at. */
  consolePeople: number;
  /** Active console people tied to at least one directory user. */
  matchedPeople: number;
  groups: number;
  /** The rules in force, in order (the defaults when none are stored). */
  rules: IRagIdentityUserMatchRule[];
  /** No rules are stored: the defaults apply. */
  defaults: boolean;
  matchGroupsByExternalId: boolean;
  /** Console people were cut at the matching limit. */
  truncated?: true;
}

export interface RagIdentityPeoplePage {
  users: RagIdentityDirectoryUserView[];
  total: number;
  summary: RagIdentityMatchSummary;
}

export interface RagIdentityUnmatchedUser {
  extId: string;
  name?: string;
  email?: string;
  upn?: string;
  type: 'member' | 'guest';
}

export interface RagIdentityMatchPreview {
  rules: IRagIdentityUserMatchRule[];
  directoryUsers: number;
  matchedUsers: number;
  consolePeople: number;
  matchedPeople: number;
  /** Directory users each rule decided (the first rule that finds a console person decides), by rule index. */
  decidedByRule: number[];
  /** The first 20 directory users nobody matches. */
  unmatchedUsers: RagIdentityUnmatchedUser[];
  truncated?: true;
}

export interface RagIdentityGroupView {
  id: string;
  name?: string;
  /** Directory users in the group. */
  users: number;
  console: Array<{ id: string; name: string; via: 'external_id' | 'link'; linkId?: string }>;
}

export interface RagIdentityLinkView {
  _id: string;
  externalKind: 'user' | 'group';
  externalId: string;
  externalName?: string;
  consoleKind: 'user' | 'group';
  consoleId: string;
  consoleName?: string;
  consoleDetail?: string;
  createdAt?: string;
}
