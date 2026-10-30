/**
 * Read-only views of Knowledge Engine access control for the dashboard: the summary of a knowledge base's Access tab,
 * the permission state of listed rows, who a principal key stands for, the pickers of people / groups / tokens, and
 * the people, groups and links of an identity directory with how they match console people.
 *
 * The answer shapes are `access/viewTypes.ts`. Nothing here writes, and every function takes the caller's tenant
 * (and project) from the route; who may ask is the route's job (module views: Knowledge Engine admin of the project;
 * directory views: Knowledge Engine admin of the workspace, and the audience view only counts a directory's people
 * for those).
 *
 * How a console person and a directory user are matched is `access/audience.ts`, the code the search-time engine
 * (`access/identity.ts`) also runs, applied to every person at once over rows read in bulk. That join costs a
 * handful of queries however many people there are, so it is built once per (directory, rules) and kept for 30
 * seconds in this process; it is dropped as soon as the identity cache is invalidated (a directory, its users or
 * its links were written). Console people are read up to MAX_MATCHED_PEOPLE; a larger workspace is cut there and
 * the answers say so (`truncated`).
 */

import { createLogger } from '@/lib/core/logger';
import {
  runWithTenantScope,
  type DatabaseProvider,
  type IApiToken,
  type IGroup,
  type IRagDocument,
  type IRagFolder,
  type IRagIdentityDomain,
  type IRagIdentityLink,
  type IRagIdentityUser,
  type IRagIdentityUserMatchRule,
  type IRagModule,
  type IUser,
  type RagAclNodeType,
} from '@/lib/database';
import { fetchGroupsByIds } from '@/lib/iam/groupGrants';
import {
  domainKeysOf,
  holdersByKey,
  matchablePersonOf,
  memoryFinder,
  previewUserMatch,
  ruleQueryOf,
  type DirectoryField,
  type DirectoryFinder,
  type DirectoryMatch,
  type MatchablePerson,
  type MatchPreview,
} from './access/audience';
import { DEFAULT_USER_MATCH, isUserMatchRule, ragIdentityCacheGeneration, userMatchRulesOf } from './access/identity';
import {
  groupPrincipal,
  isValidIdentityDomainKey,
  normalizeEmail,
  normalizePrincipal,
  parsePrincipal,
  tokenPrincipal,
  userPrincipal,
  type RagPrincipal,
} from './access/principals';
import type {
  RagAccessAudienceItem,
  RagAccessClosedItem,
  RagAccessDirectoryUse,
  RagAccessNodeState,
  RagAccessPrincipalOption,
  RagAccessSummaryView,
  RagConsolePersonOption,
  RagIdentityConsoleMatch,
  RagIdentityDirectoryUserView,
  RagIdentityGroupView,
  RagIdentityLinkView,
  RagIdentityMatchPreview,
  RagIdentityMatchSummary,
  RagIdentityPeoplePage,
  RagIdentityUnmatchedUser,
} from './access/viewTypes';
import { RagAccessError, cleanUserMatchRules, type RagAccessContext } from './ragAccessService';

export type {
  RagAccessAudienceItem,
  RagAccessClosedItem,
  RagAccessDirectoryUse,
  RagAccessNodeCounts,
  RagAccessNodeState,
  RagAccessPrincipalOption,
  RagAccessSummaryView,
  RagConsolePersonOption,
  RagIdentityConsoleMatch,
  RagIdentityDirectoryUserView,
  RagIdentityGroupView,
  RagIdentityLinkView,
  RagIdentityMatchPreview,
  RagIdentityMatchSummary,
  RagIdentityPeoplePage,
  RagIdentityUnmatchedUser,
} from './access/viewTypes';

const logger = createLogger('rag:access:views');

type Db = DatabaseProvider;

/** What a view needs of the request: the tenant, and the project the module is looked up in. */
export type RagAccessViewContext = Pick<RagAccessContext, 'tenantDbName' | 'tenantId' | 'projectId'>;

/** Ids one `nodes` call may ask about, per kind. */
export const MAX_NODE_STATE_IDS = 500;
/** Keys one `audience` call may ask about. */
export const MAX_AUDIENCE_PRINCIPALS = 1000;
/** Console people read for matching; a larger workspace is cut here. */
export const MAX_MATCHED_PEOPLE = 50_000;

const CLOSED_LIST_MAX = 50;
const CLOSED_SCAN_PAGE = 200;
const CLOSED_SCAN_MAX = 5_000;
/** `countRagAclEntriesByNode` takes pages of at most this many ids. */
const ACL_ID_PAGE = 1_000;
/** `iamListUsers` / `iamListGroups` serve at most this many rows a page. */
const IAM_PAGE = 200;
/** Values per `findRagIdentityUsers` call. */
const DIRECTORY_LOOKUP_CHUNK = 1_000;
/** Directory users a people filter may name (the matched ones, or the ones to leave out). */
const MAX_FILTER_IDS = 50_000;
const PICKER_LIMIT_DEFAULT = 20;
const PICKER_LIMIT_MAX = 50;
const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;
const UNMATCHED_SAMPLE = 20;
/** Console people shown for one directory user (a shared address could match many). */
const MAX_CONSOLE_MATCHES_PER_USER = 20;
const MAX_LINK_VIEWS = 5_000;
const BOUNDED_READS = 8;

// ── shared helpers ─────────────────────────────────────────────────────

function inTenant<T>(ctx: Pick<RagAccessViewContext, 'tenantDbName'>, fn: (db: Db) => Promise<T>): Promise<T> {
  return runWithTenantScope(ctx.tenantDbName, fn);
}

async function requireModule(db: Db, ctx: RagAccessViewContext, ragModuleKey: string): Promise<IRagModule> {
  const ragModule = await db.findRagModuleByKey(ragModuleKey, ctx.projectId);
  if (!ragModule) throw new RagAccessError('module_not_found', `Knowledge Engine module "${ragModuleKey}" not found`);
  return ragModule;
}

async function requireDomain(db: Db, key: string): Promise<IRagIdentityDomain> {
  const domain = typeof key === 'string' && key ? await db.findRagIdentityDomain(key) : null;
  if (!domain) throw new RagAccessError('domain_not_found', 'Directory not found');
  return domain;
}

function sameProject(a: string | undefined | null, b: string | undefined | null): boolean {
  return (a ?? '') === (b ?? '');
}

/** Module keys are unique per project only; rows written before documents carried a project are the module's too. */
function inModuleProject(doc: Pick<IRagDocument, 'projectId'>, ragModule: Pick<IRagModule, 'projectId'>): boolean {
  return !doc.projectId || sameProject(String(doc.projectId), ragModule.projectId);
}

/** A record by id; an id the store cannot parse (a MongoDB ObjectId needs 24 hex characters) names nothing. */
async function findById<T>(find: () => Promise<T | null>): Promise<T | null> {
  try {
    return await find();
  } catch (error) {
    if (error instanceof Error && error.name === 'BSONError') return null;
    throw error;
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `fn` over `items` with at most `limit` calls in flight; results in the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function distinctStrings(values: readonly unknown[] | undefined, max: number): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))].slice(0, max);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, 1), max);
}

function clampOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(Math.trunc(value), 0) : 0;
}

function cleanSearch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, 200);
  return trimmed || undefined;
}

function isoOf(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function timeOf(value: unknown): number {
  const iso = isoOf(value);
  return iso ? Date.parse(iso) : 0;
}

function peopleDetail(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}

function personLabel(user: Pick<IUser, 'name' | 'email'>): string {
  const name = typeof user.name === 'string' ? user.name.trim() : '';
  return name || user.email || '';
}

/** Users by id, in pages the store serves. Without `status`, disabled accounts and accounts of host applications too. */
async function fetchUsers(db: Db, tenantId: string, ids: readonly string[], status?: 'active'): Promise<IUser[]> {
  const out: IUser[] = [];
  for (const part of chunk(ids, IAM_PAGE)) {
    const page = await db.iamListUsers({ tenantId, ids: part, limit: IAM_PAGE, ...(status ? { status } : {}) });
    out.push(...page.items);
  }
  return out;
}

/** Entries per node: node id -> count, nodes without entries absent. */
async function entryCounts(
  db: Db,
  ragModule: Pick<IRagModule, 'key' | 'projectId'>,
  nodeType: RagAclNodeType,
  nodeIds: readonly string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const part of chunk(nodeIds, ACL_ID_PAGE)) {
    const counts = await db.countRagAclEntriesByNode(ragModule.key, { projectId: ragModule.projectId, nodeType, nodeIds: part });
    for (const [id, n] of Object.entries(counts)) if (n > 0) out[id] = n;
  }
  return out;
}

/** Folder path (`A/B/C`) of every folder, as the folder list prints it (a broken chain shows the folder's own name). */
function folderPathsOf(folders: readonly IRagFolder[]): Map<string, string> {
  const byId = new Map<string, IRagFolder>();
  for (const folder of folders) if (folder._id) byId.set(String(folder._id), folder);
  const paths = new Map<string, string>();
  for (const id of byId.keys()) {
    const chain: string[] = [];
    const seen = new Set<string>([id]);
    let parent = byId.get(id)?.parentId ? String(byId.get(id)?.parentId) : undefined;
    let broken = false;
    while (parent !== undefined) {
      if (seen.has(parent)) { broken = true; break; }
      seen.add(parent);
      const node = byId.get(parent);
      if (!node) { broken = true; break; }
      chain.push(parent);
      parent = node.parentId ? String(node.parentId) : undefined;
    }
    const ids = broken ? [id] : [...chain.reverse(), id];
    paths.set(id, ids.map((x) => byId.get(x)?.name ?? '?').join('/'));
  }
  return paths;
}

// ── R1: the summary of the Access tab ───────────────────────────────────

/**
 * What the Access tab opens with: how many folders and documents have their own permissions or come from a source,
 * which of them nobody can read (own permissions, no entry), whether the root is open, and which identity
 * directories the permissions name. A knowledge base with access control off still answers (`enabled: false`).
 */
export async function getRagAccessSummary(ctx: RagAccessViewContext, ragModuleKey: string): Promise<RagAccessSummaryView> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, ragModuleKey);
    const key = ragModule.key;
    const projectId = ragModule.projectId;
    // What the module owns, rows from before documents carried a project included.
    const owned = { withUnscoped: true } as const;

    const [folders, documentsTotal, documentsOwn, documentsSynced, documentsWithEntries, rootCounts, domains] = await Promise.all([
      db.listRagFolders(key, { projectId }),
      db.countRagDocuments(key, projectId, owned),
      db.countRagDocuments(key, projectId, { ...owned, aclMode: 'own' }),
      db.countRagDocuments(key, projectId, { ...owned, aclManaged: 'sync' }),
      db.countRagAclNodes(key, { projectId, nodeType: 'document' }),
      db.countRagAclEntriesByNode(key, { projectId, nodeType: 'module', nodeIds: [key] }),
      db.listRagIdentityDomains(),
    ]);

    // Folders: the closed ones are own folders no entry names anybody in.
    const ownFolders = folders.filter((f) => f._id && f.aclMode === 'own');
    const folderEntries = await entryCounts(db, ragModule, 'folder', ownFolders.map((f) => String(f._id)));
    const paths = folderPathsOf(folders);
    const closedFolders = ownFolders
      .filter((f) => !folderEntries[String(f._id)])
      .map((f) => ({ id: String(f._id), name: f.name, path: paths.get(String(f._id)) ?? f.name }))
      .sort((a, b) => byText(a.path, b.path) || byText(a.id, b.id));

    // Documents: counted, then (only when some are closed) scanned newest first for the list.
    const documentsClosed = Math.max(0, documentsOwn - documentsWithEntries);
    const room = Math.max(0, CLOSED_LIST_MAX - closedFolders.length);
    const closedDocIds: string[] = [];
    let scanExhausted = false;
    if (room > 0 && documentsClosed > 0) {
      let scanned = 0;
      let offset = 0;
      while (closedDocIds.length <= room && scanned < CLOSED_SCAN_MAX) {
        const ids = await db.listRagDocumentIds(key, {
          projectId,
          ...owned,
          aclMode: 'own',
          limit: CLOSED_SCAN_PAGE,
          offset,
        });
        if (ids.length === 0) { scanExhausted = true; break; }
        offset += ids.length;
        scanned += ids.length;
        const counts = await entryCounts(db, ragModule, 'document', ids);
        for (const id of ids) if (!counts[id]) closedDocIds.push(id);
        if (ids.length < CLOSED_SCAN_PAGE) { scanExhausted = true; break; }
      }
    }
    const shownDocIds = closedDocIds.slice(0, room);
    const docsById = new Map<string, IRagDocument>();
    if (shownDocIds.length > 0) {
      for (const doc of await db.findRagDocumentsByIds(shownDocIds)) {
        if (doc._id && doc.ragModuleKey === key && inModuleProject(doc, ragModule)) docsById.set(String(doc._id), doc);
      }
    }

    const closed: RagAccessClosedItem[] = [
      ...closedFolders.slice(0, CLOSED_LIST_MAX).map((f): RagAccessClosedItem => ({ type: 'folder', id: f.id, name: f.name, path: f.path })),
      ...shownDocIds.flatMap((id): RagAccessClosedItem[] => {
        const doc = docsById.get(id);
        return doc ? [{ type: 'document', id, name: doc.fileName, ...(doc.folderId ? { folderId: String(doc.folderId) } : {}) }] : [];
      }),
    ];
    // Complete when nothing closed is left out: no 51st item, and the scan reached its end.
    const closedComplete = room === 0
      ? closedFolders.length === CLOSED_LIST_MAX && documentsClosed === 0
      : documentsClosed === 0 || (closedDocIds.length <= room && scanExhausted);

    // Directories whose people the permissions of this knowledge base name.
    const uses = await mapLimit(
      domains.filter((d) => isValidIdentityDomainKey(d.key)),
      4,
      async (domain) => {
        const principalPrefix = `x:${domain.key}:`;
        const [documents, foldersUsing] = await Promise.all([
          db.countRagAclNodes(key, { projectId, nodeType: 'document', principalPrefix }),
          db.countRagAclNodes(key, { projectId, nodeType: 'folder', principalPrefix }),
        ]);
        return { domain, documents, folders: foldersUsing };
      },
    );
    const directories: RagAccessDirectoryUse[] = uses
      .filter((use) => use.documents > 0 || use.folders > 0)
      .map((use): RagAccessDirectoryUse => ({
        key: use.domain.key,
        label: use.domain.label,
        ...(use.domain.source?.connectorId ? { connectorId: use.domain.source.connectorId } : {}),
        documents: use.documents,
        folders: use.folders,
      }))
      .sort((a, b) => byText(a.key, b.key));

    const rootEntries = rootCounts[key] ?? 0;
    return {
      enabled: ragModule.access?.enabled === true,
      adminBypass: ragModule.access?.adminBypass !== false,
      root: { entries: rootEntries, openToEveryone: rootEntries === 0 },
      folders: {
        total: folders.length,
        own: ownFolders.length,
        synced: folders.filter((f) => f.aclManaged === 'sync').length,
        closed: closedFolders.length,
      },
      documents: { total: documentsTotal, own: documentsOwn, synced: documentsSynced, closed: documentsClosed },
      closed,
      closedComplete,
      directories,
    };
  });
}

// ── R2: permission states of listed rows ────────────────────────────────

/**
 * The permission state of the folders and documents a screen lists, keyed `folder:<id>` / `document:<id>`. Ids that
 * are not in this knowledge base are left out (they are not an error: a list may be a moment older than the data).
 */
export async function getRagNodeStates(
  ctx: RagAccessViewContext,
  ragModuleKey: string,
  ids: { folderIds?: readonly string[]; documentIds?: readonly string[] },
): Promise<Record<string, RagAccessNodeState>> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, ragModuleKey);
    const folderIds = distinctStrings(ids.folderIds, MAX_NODE_STATE_IDS);
    const documentIds = distinctStrings(ids.documentIds, MAX_NODE_STATE_IDS);

    const [folders, documents] = await Promise.all([
      folderIds.length > 0 ? db.listRagFolders(ragModule.key, { projectId: ragModule.projectId, ids: folderIds }) : Promise.resolve([] as IRagFolder[]),
      documentIds.length > 0 ? db.findRagDocumentsByIds(documentIds) : Promise.resolve([] as IRagDocument[]),
    ]);
    const ownDocuments = documents.filter((d) => d._id && d.ragModuleKey === ragModule.key && inModuleProject(d, ragModule));
    const [folderEntries, documentEntries] = await Promise.all([
      entryCounts(db, ragModule, 'folder', folders.filter((f) => f._id && f.aclMode === 'own').map((f) => String(f._id))),
      entryCounts(db, ragModule, 'document', ownDocuments.filter((d) => d.aclMode === 'own').map((d) => String(d._id))),
    ]);

    const out: Record<string, RagAccessNodeState> = {};
    for (const folder of folders) {
      if (!folder._id) continue;
      const id = String(folder._id);
      const own = folder.aclMode === 'own';
      out[`folder:${id}`] = {
        mode: own ? 'own' : 'inherit',
        ...(folder.aclManaged === 'sync' ? { managed: 'sync' as const } : {}),
        entries: own ? folderEntries[id] ?? 0 : 0,
      };
    }
    for (const doc of ownDocuments) {
      const id = String(doc._id);
      const own = doc.aclMode === 'own';
      out[`document:${id}`] = {
        mode: own ? 'own' : 'inherit',
        ...(doc.aclManaged === 'sync' ? { managed: 'sync' as const } : {}),
        entries: own ? documentEntries[id] ?? 0 : 0,
      };
    }
    return out;
  });
}

// ── the directory join ──────────────────────────────────────────────────

interface DirectoryGroup {
  name?: string;
  users: number;
}

/** Everything the people, preview, groups and audience views of one directory (with one list of rules) share. */
interface DomainIndex {
  key: string;
  rules: IRagIdentityUserMatchRule[];
  matchGroupsByExternalId: boolean;
  links: IRagIdentityLink[];
  find: DirectoryFinder;
  people: MatchablePerson[];
  /** Name and (verified) address of each console person, by id. */
  display: Map<string, { name?: string; email?: string }>;
  /** Console people were cut at MAX_MATCHED_PEOPLE. */
  truncated: boolean;
  preview: MatchPreview;
  /** key -> the active console people who hold it (computed when first asked). */
  holders(): Map<string, string[]>;
  /** The directory's groups: ids of its users' groups plus the ones permissions name (computed when first asked). */
  groups(db: Db): Promise<Map<string, DirectoryGroup>>;
}

/** Active workspace people (not host-application accounts), read in pages up to MAX_MATCHED_PEOPLE. */
async function loadWorkspacePeople(db: Db, tenantId: string): Promise<{ users: IUser[]; truncated: boolean }> {
  const users: IUser[] = [];
  let offset = 0;
  for (;;) {
    const page = await db.iamListUsers({ tenantId, status: 'active', external: false, limit: IAM_PAGE, offset });
    users.push(...page.items);
    if (!page.hasMore || page.items.length === 0) return { users, truncated: false };
    offset += page.items.length;
    if (users.length >= MAX_MATCHED_PEOPLE) {
      logger.warn('Directory matching cut at the people limit', { tenantId, limit: MAX_MATCHED_PEOPLE });
      return { users, truncated: true };
    }
  }
}

async function directoryGroupsOf(db: Db, domainKey: string): Promise<Map<string, DirectoryGroup>> {
  const prefix = `x:${domainKey}:g:`;
  const [counts, labels] = await Promise.all([
    db.listRagIdentityGroupCounts(domainKey),
    db.listRagAclPrincipalLabels(prefix),
  ]);
  const groups = new Map<string, DirectoryGroup>();
  for (const count of counts) groups.set(count.id, { users: count.users });
  for (const entry of labels) {
    const id = entry.principal.startsWith(prefix) ? entry.principal.slice(prefix.length) : '';
    if (!id) continue;
    const known = groups.get(id);
    if (known) known.name = entry.label; else groups.set(id, { name: entry.label, users: 0 });
  }
  return groups;
}

async function buildDomainIndex(
  db: Db,
  tenantId: string,
  domainKey: string,
  rules: IRagIdentityUserMatchRule[],
  matchGroupsByExternalId: boolean,
): Promise<DomainIndex> {
  const [links, loaded, memberships, groupRows] = await Promise.all([
    db.listRagIdentityLinks({ domain: domainKey }),
    loadWorkspacePeople(db, tenantId),
    db.listGroupMembersByTenant(tenantId),
    db.listGroups(tenantId),
  ]);

  // Console people the manual links name that the list above does not hold (accounts of host applications, or people
  // past the limit): a link to them counts.
  const users = [...loaded.users];
  const listed = new Set(users.map((u) => String(u._id)));
  const linkedUserIds = [...new Set(links
    .filter((l) => l.externalKind === 'user' && l.consoleKind === 'user' && !listed.has(l.consoleId))
    .map((l) => l.consoleId))];
  if (linkedUserIds.length > 0) users.push(...await fetchUsers(db, tenantId, linkedUserIds, 'active'));

  const groupById = new Map(groupRows.map((g) => [String(g._id), g] as const));
  const groupIdsOf = new Map<string, string[]>();
  for (const member of memberships) {
    const userId = String(member.userId);
    const list = groupIdsOf.get(userId);
    if (list) list.push(String(member.groupId)); else groupIdsOf.set(userId, [String(member.groupId)]);
  }

  const people: MatchablePerson[] = [];
  const display = new Map<string, { name?: string; email?: string }>();
  for (const user of users) {
    const memberOf = (groupIdsOf.get(String(user._id)) ?? []).map((id) => ({ _id: id, externalId: groupById.get(id)?.externalId }));
    const person = matchablePersonOf(user, memberOf);
    people.push(person);
    const name = typeof user.name === 'string' ? user.name.trim() : '';
    display.set(person.userId, { ...(name ? { name } : {}), ...(person.email ? { email: person.email } : {}) });
  }

  // Every lookup the matching will make, asked in bulk: the finder answers from these rows only.
  const wanted = new Map<DirectoryField, Set<string>>();
  const want = (field: DirectoryField, values: Iterable<string>): void => {
    let set = wanted.get(field);
    if (!set) { set = new Set(); wanted.set(field, set); }
    for (const value of values) set.add(value);
  };
  for (const person of people) {
    if (!person.active || person.hostApp) continue;
    for (const rule of rules) {
      const query = ruleQueryOf(person, rule);
      if (query) want(query.field, query.values);
    }
  }
  want('extId', links.filter((l) => l.externalKind === 'user' && l.consoleKind === 'user').map((l) => l.externalId));
  const jobs = [...wanted].flatMap(([field, values]) => chunk([...values], DIRECTORY_LOOKUP_CHUNK).map((part) => ({ field, part })));
  const fetched = await mapLimit(jobs, 4, (job) => db.findRagIdentityUsers(domainKey, job.field, job.part));
  const find = memoryFinder(fetched.flat());

  const preview = previewUserMatch(rules, people, { key: domainKey, links }, find);

  let holders: Map<string, string[]> | undefined;
  let groups: Promise<Map<string, DirectoryGroup>> | undefined;
  return {
    key: domainKey,
    rules,
    matchGroupsByExternalId,
    links,
    find,
    people,
    display,
    truncated: loaded.truncated,
    preview,
    holders: () => {
      if (!holders) {
        const d = { key: domainKey, rules, matchGroupsByExternalId, links };
        const held = new Map<string, string[]>();
        for (const person of people) if (person.active) held.set(person.userId, domainKeysOf(person, d, find).keys);
        holders = holdersByKey(held);
      }
      return holders;
    },
    groups: (handle) => {
      if (!groups) {
        groups = directoryGroupsOf(handle, domainKey);
        groups.catch(() => { groups = undefined; });
      }
      return groups;
    },
  };
}

const INDEX_TTL_MS = 30_000;
const INDEX_MAX = 8;
const indexCache = new Map<string, { generation: number; expiresAt: number; promise: Promise<DomainIndex> }>();

function indexCacheKey(tenantDbName: string, domainKey: string, rules: readonly IRagIdentityUserMatchRule[], matchGroups: boolean): string {
  return JSON.stringify([tenantDbName, domainKey, rules.map((r) => [r.console, r.external]), matchGroups]);
}

/**
 * The join of one directory with the workspace's people for a list of rules (the rules in force, or a candidate
 * list). Concurrent callers share one load; it is kept for INDEX_TTL_MS and not used past an invalidation of the
 * identity cache.
 */
async function domainIndexOf(
  db: Db,
  ctx: RagAccessViewContext,
  domain: IRagIdentityDomain,
  rules: IRagIdentityUserMatchRule[] = userMatchRulesOf(domain),
): Promise<DomainIndex> {
  const matchGroups = domain.matchGroupsByExternalId !== false;
  const cacheKey = indexCacheKey(ctx.tenantDbName, domain.key, rules, matchGroups);
  const generation = ragIdentityCacheGeneration(ctx.tenantDbName);
  const hit = indexCache.get(cacheKey);
  if (hit && hit.generation === generation && hit.expiresAt > Date.now()) return hit.promise;

  const promise = buildDomainIndex(db, ctx.tenantId, domain.key, rules, matchGroups);
  const entry = { generation, expiresAt: Date.now() + INDEX_TTL_MS, promise };
  indexCache.delete(cacheKey);
  indexCache.set(cacheKey, entry);
  while (indexCache.size > INDEX_MAX) {
    const oldest = indexCache.keys().next().value;
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
  promise.catch(() => {
    if (indexCache.get(cacheKey) === entry) indexCache.delete(cacheKey);
  });
  return promise;
}

/** Forget every kept directory join (tests; production drops them through the identity cache generation). */
export function resetRagAccessViewCaches(): void {
  indexCache.clear();
}

// ── R3: who a key stands for ────────────────────────────────────────────

/**
 * Who each principal key stands for, for the lists of the permission editor. Keyed by the key as asked; keys that
 * are not valid principals are left out. `directoryCounts` (workspace-level Knowledge Engine admins) also counts the
 * console people a directory key reaches and names a directory user; without it those stay `null` / unnamed, since
 * a directory's people are not for the project's admins to read.
 */
export async function getRagAccessAudience(
  ctx: RagAccessViewContext,
  ragModuleKey: string,
  principals: readonly string[],
  options: { directoryCounts?: boolean } = {},
): Promise<Record<string, RagAccessAudienceItem>> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, ragModuleKey);
    const directoryCounts = options.directoryCounts === true;

    const wanted = new Map<string, RagPrincipal>();
    for (const raw of principals.slice(0, MAX_AUDIENCE_PRINCIPALS)) {
      if (typeof raw !== 'string' || wanted.has(raw)) continue;
      const parsed = parsePrincipal(raw);
      if (parsed) wanted.set(raw, parsed);
    }
    const ofKind = <K extends RagPrincipal['kind']>(kind: K) =>
      [...wanted].filter((entry): entry is [string, Extract<RagPrincipal, { kind: K }>] => entry[1].kind === kind);

    const out: Record<string, RagAccessAudienceItem> = {};

    for (const [raw, principal] of wanted) {
      if (principal.kind === 'everyone') out[raw] = { kind: 'everyone', exists: true, people: null };
    }

    // People.
    const userEntries = ofKind('user');
    if (userEntries.length > 0) {
      const users = new Map<string, IUser>();
      for (const user of await fetchUsers(db, ctx.tenantId, [...new Set(userEntries.map(([, p]) => p.id))])) users.set(String(user._id), user);
      for (const [raw, principal] of userEntries) {
        const user = users.get(principal.id);
        out[raw] = user
          ? {
            kind: 'user',
            label: personLabel(user),
            ...(user.email ? { detail: user.email } : {}),
            exists: true,
            people: user.status === 'disabled' ? 0 : 1,
          }
          : { kind: 'user', exists: false, people: 0 };
      }
    }

    // Groups: their active members.
    const groupEntries = ofKind('group');
    if (groupEntries.length > 0) {
      const groups = new Map<string, IGroup>();
      for (const group of await fetchGroupsByIds(db, ctx.tenantId, [...new Set(groupEntries.map(([, p]) => p.id))])) groups.set(String(group._id), group);
      const counts = new Map<string, number>();
      await mapLimit([...groups.keys()], BOUNDED_READS, async (groupId) => {
        counts.set(groupId, await db.iamCountUsers({ tenantId: ctx.tenantId, groupId, status: 'active' }));
      });
      for (const [raw, principal] of groupEntries) {
        const group = groups.get(principal.id);
        out[raw] = group
          ? { kind: 'group', label: group.name, exists: true, people: counts.get(principal.id) ?? 0 }
          : { kind: 'group', exists: false, people: 0 };
      }
    }

    // API tokens: named, never counted.
    const tokenEntries = ofKind('token');
    if (tokenEntries.length > 0) {
      const tokens = await mapLimit(tokenEntries, BOUNDED_READS, async ([, principal]): Promise<IApiToken | null> =>
        findById(() => db.findApiTokenById(principal.id, ctx.tenantId)));
      tokenEntries.forEach(([raw], index) => {
        const token = tokens[index];
        out[raw] = token
          ? {
            kind: 'token',
            ...(token.label ? { label: token.label } : {}),
            ...(token.tokenPrefix ? { detail: token.tokenPrefix } : {}),
            exists: true,
            people: null,
          }
          : { kind: 'token', exists: false, people: null };
      });
    }

    // Addresses: the active people (not accounts of host applications) who have this stored address.
    const emailEntries = ofKind('email');
    if (emailEntries.length > 0) {
      const counts = await mapLimit(emailEntries, BOUNDED_READS, async ([, principal]) => {
        const page = await db.iamListUsers({ tenantId: ctx.tenantId, q: principal.email, status: 'active', external: false, limit: IAM_PAGE });
        return page.items.filter((user) => normalizeEmail(user.emailLower || user.email) === principal.email).length;
      });
      emailEntries.forEach(([raw, principal], index) => {
        out[raw] = { kind: 'email', label: principal.email, exists: true, people: counts[index] };
      });
    }

    // Directory keys.
    const externalEntries = [
      ...ofKind('external_user'),
      ...ofKind('external_group'),
      ...ofKind('external_all'),
    ];
    if (externalEntries.length > 0) {
      const domains = new Map((await db.listRagIdentityDomains()).map((d) => [d.key, d] as const));
      const askedDomains = [...new Set(externalEntries.map(([, p]) => p.domain))].filter((key) => domains.has(key));

      // The label a permission stored for the key. A workspace-level admin reads it from every knowledge base (a
      // source's own label first); anyone else only from this knowledge base's permissions, which they manage anyway.
      const storedLabels = new Map<string, string>();
      if (directoryCounts) {
        await mapLimit(askedDomains, BOUNDED_READS, async (key) => {
          for (const entry of await db.listRagAclPrincipalLabels(`x:${key}:`)) storedLabels.set(entry.principal, entry.label);
        });
      } else {
        const keys = [...new Set(externalEntries
          .filter(([, p]) => domains.has(p.domain))
          .map(([raw]) => normalizePrincipal(raw) ?? raw))];
        // The same choice as the tenant-wide read: a source's label first, then the greatest.
        const fromSource = new Set<string>();
        const better = (principal: string, label: string, synced: boolean) => {
          const current = storedLabels.get(principal);
          if (current === undefined) return true;
          if (synced !== fromSource.has(principal)) return synced;
          return label > current;
        };
        for (const part of chunk(keys, DIRECTORY_LOOKUP_CHUNK)) {
          for (const entry of await db.listRagAclEntries(ragModule.key, { projectId: ragModule.projectId, principals: part })) {
            const synced = entry.managed === 'sync';
            if (!entry.label || !better(entry.principal, entry.label, synced)) continue;
            storedLabels.set(entry.principal, entry.label);
            if (synced) fromSource.add(entry.principal);
          }
        }
      }

      // Only for workspace-level admins: the directory user's own name, and how many people the key reaches.
      const directoryNames = new Map<string, string>();
      const indexes = new Map<string, DomainIndex>();
      if (directoryCounts) {
        await mapLimit(askedDomains, 2, async (key) => {
          const domain = domains.get(key) as IRagIdentityDomain;
          indexes.set(key, await domainIndexOf(db, ctx, domain));
          const ids = [...new Set(externalEntries.flatMap(([, p]) => (p.kind === 'external_user' && p.domain === key ? [p.id] : [])))];
          for (const part of chunk(ids, DIRECTORY_LOOKUP_CHUNK)) {
            for (const user of await db.findRagIdentityUsers(key, 'extId', part)) {
              const name = user.name || user.email || user.upn;
              if (name) directoryNames.set(`${key}\u0000${user.extId}`, name);
            }
          }
        });
      }

      for (const [raw, principal] of externalEntries) {
        const domain = domains.get(principal.domain);
        const canonical = normalizePrincipal(raw) ?? raw;
        let label: string | undefined;
        if (principal.kind === 'external_all') {
          label = 'All members';
        } else {
          label = (principal.kind === 'external_user' ? directoryNames.get(`${principal.domain}\u0000${principal.id}`) : undefined)
            ?? storedLabels.get(canonical);
        }
        const index = indexes.get(principal.domain);
        out[raw] = {
          kind: principal.kind,
          ...(label ? { label } : {}),
          ...(domain?.label ? { detail: domain.label } : {}),
          exists: !!domain,
          people: directoryCounts ? (index ? index.holders().get(canonical)?.length ?? 0 : 0) : null,
        };
      }
    }

    return out;
  });
}

// ── R4 / R5: pickers ────────────────────────────────────────────────────

/** Active workspace people matching `q`, optionally only those who can open `projectId` (members, owners and admins). */
async function pickPeople(db: Db, tenantId: string, q: string | undefined, limit: number, projectId?: string): Promise<IUser[]> {
  const base = { tenantId, status: 'active' as const, external: false, ...(q ? { q } : {}), limit };
  if (!projectId) return (await db.iamListUsers(base)).items;
  // Who can open a project: its members (directly, by the legacy list or through a group), and owners and admins, who
  // reach every project (`canAccessProject`). Two bounded queries, merged in the order the listing itself uses.
  const [members, implicit] = await Promise.all([
    db.iamListUsers({ ...base, projectId }),
    db.iamListUsers({ ...base, roles: ['owner', 'admin'] }),
  ]);
  const merged = new Map<string, IUser>();
  for (const user of [...members.items, ...implicit.items]) merged.set(String(user._id), user);
  return [...merged.values()]
    .sort((a, b) => byText(a.name ?? '', b.name ?? '') || byText(String(a._id), String(b._id)))
    .slice(0, limit);
}

async function pickGroups(db: Db, tenantId: string, q: string | undefined, limit: number): Promise<Array<{ group: IGroup; people: number }>> {
  const page = await db.iamListGroups({ tenantId, ...(q ? { q } : {}), limit });
  const ids = page.items.map((g) => String(g._id));
  const counts = ids.length > 0 ? await db.iamCountGroupMembers(ids) : {};
  return page.items.map((group) => ({ group, people: counts[String(group._id)] ?? 0 }));
}

/**
 * People (who can open the knowledge base's project), groups or API tokens to add to a permission list. The
 * principal is the key to store. Tokens are listed by label and visible prefix only.
 */
export async function searchRagAccessPrincipals(
  ctx: RagAccessViewContext,
  ragModuleKey: string,
  input: { type: 'user' | 'group' | 'token'; q?: string; limit?: number },
): Promise<RagAccessPrincipalOption[]> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, ragModuleKey);
    const limit = clampLimit(input.limit, PICKER_LIMIT_DEFAULT, PICKER_LIMIT_MAX);
    const q = cleanSearch(input.q);
    if (input.type === 'user') {
      const users = await pickPeople(db, ctx.tenantId, q, limit, ragModule.projectId);
      return users.map((user): RagAccessPrincipalOption => {
        const label = personLabel(user);
        return {
          principal: userPrincipal(String(user._id)),
          kind: 'user',
          label,
          ...(user.email && user.email !== label ? { detail: user.email } : {}),
        };
      });
    }
    if (input.type === 'group') {
      return (await pickGroups(db, ctx.tenantId, q, limit)).map(({ group, people }): RagAccessPrincipalOption => ({
        principal: groupPrincipal(String(group._id)),
        kind: 'group',
        label: group.name,
        detail: peopleDetail(people),
      }));
    }
    const page = await db.iamListTokens({
      tenantId: ctx.tenantId,
      ...(q ? { q } : {}),
      ...(ragModule.projectId ? { projectId: ragModule.projectId } : {}),
      status: 'active',
      limit,
    });
    return page.items.map((token): RagAccessPrincipalOption => ({
      principal: tokenPrincipal(String(token._id)),
      kind: 'token',
      label: token.label || token.tokenPrefix || String(token._id),
      ...(token.tokenPrefix ? { detail: token.tokenPrefix } : {}),
    }));
  });
}

/** Workspace people or groups to link to a directory's users or groups (no project filter: directories are workspace-wide). */
export async function searchRagConsolePeople(
  ctx: Pick<RagAccessViewContext, 'tenantDbName' | 'tenantId'>,
  input: { type: 'user' | 'group'; q?: string; limit?: number },
): Promise<RagConsolePersonOption[]> {
  return inTenant(ctx, async (db) => {
    const limit = clampLimit(input.limit, PICKER_LIMIT_DEFAULT, PICKER_LIMIT_MAX);
    const q = cleanSearch(input.q);
    if (input.type === 'user') {
      const users = await pickPeople(db, ctx.tenantId, q, limit);
      return users.map((user): RagConsolePersonOption => {
        const label = personLabel(user);
        return { id: String(user._id), kind: 'user', label, ...(user.email && user.email !== label ? { detail: user.email } : {}) };
      });
    }
    return (await pickGroups(db, ctx.tenantId, q, limit)).map(({ group, people }): RagConsolePersonOption => ({
      id: String(group._id),
      kind: 'group',
      label: group.name,
      detail: peopleDetail(people),
    }));
  });
}

// ── R6: the people of a directory ───────────────────────────────────────

function matchOrder(index: DomainIndex) {
  return (a: DirectoryMatch, b: DirectoryMatch): number => {
    if (a.via !== b.via) return a.via === 'rule' ? -1 : 1;
    if (a.via === 'rule' && a.ruleIndex !== b.ruleIndex) return (a.ruleIndex ?? 0) - (b.ruleIndex ?? 0);
    const who = (m: DirectoryMatch) => (index.display.get(m.userId)?.name ?? index.display.get(m.userId)?.email ?? '').toLowerCase();
    return byText(who(a), who(b)) || byText(a.userId, b.userId);
  };
}

function consoleMatchesOf(index: DomainIndex, extId: string): RagIdentityConsoleMatch[] {
  const matches = index.preview.byDirectoryUser.get(extId) ?? [];
  return [...matches]
    .sort(matchOrder(index))
    .slice(0, MAX_CONSOLE_MATCHES_PER_USER)
    .map((match): RagIdentityConsoleMatch => {
      const who = index.display.get(match.userId);
      return {
        userId: match.userId,
        ...(who?.name ? { name: who.name } : {}),
        ...(who?.email ? { email: who.email } : {}),
        via: match.via,
        ...(match.via === 'rule' && match.ruleIndex !== undefined ? { rule: match.ruleIndex } : {}),
        ...(match.via === 'link' && match.linkId ? { linkId: match.linkId } : {}),
      };
    });
}

function hasStoredRules(domain: Pick<IRagIdentityDomain, 'userMatch'>): boolean {
  return Array.isArray(domain.userMatch) && domain.userMatch.some(isUserMatchRule);
}

/**
 * The users of an identity directory, one page, with the console people each one is tied to (by a matching rule or a
 * manual link), and the totals of the whole directory. `filter` keeps the matched or the unmatched users.
 */
export async function listRagIdentityPeople(
  ctx: RagAccessViewContext,
  domainKey: string,
  options: { search?: string; filter?: 'all' | 'matched' | 'unmatched'; limit?: number; offset?: number } = {},
): Promise<RagIdentityPeoplePage> {
  return inTenant(ctx, async (db) => {
    const domain = await requireDomain(db, domainKey);
    const index = await domainIndexOf(db, ctx, domain);
    const limit = clampLimit(options.limit, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX);
    const offset = clampOffset(options.offset);
    const search = cleanSearch(options.search);
    const filter = options.filter ?? 'all';

    const matched = [...index.preview.matchedExtIds];
    const named = matched.slice(0, MAX_FILTER_IDS);
    const page = await db.listRagIdentityUsers(domain.key, {
      ...(search ? { search } : {}),
      limit,
      offset,
      ...(filter === 'matched' ? { extIds: named } : {}),
      ...(filter === 'unmatched' ? { excludeExtIds: named } : {}),
    });
    const directoryUsers = filter === 'all' && !search
      ? page.total
      : (await db.listRagIdentityUsers(domain.key, { limit: 0 })).total;
    const groups = await index.groups(db);

    const truncated = index.truncated || matched.length > MAX_FILTER_IDS;
    const summary: RagIdentityMatchSummary = {
      directoryUsers,
      matchedUsers: index.preview.matchedExtIds.size,
      consolePeople: index.preview.considered,
      matchedPeople: index.preview.matchedPeople,
      groups: groups.size,
      rules: index.preview.rules,
      defaults: !hasStoredRules(domain),
      matchGroupsByExternalId: index.matchGroupsByExternalId,
      ...(truncated ? { truncated: true as const } : {}),
    };
    const users = page.users.map((user): RagIdentityDirectoryUserView => ({
      extId: user.extId,
      ...(user.name ? { name: user.name } : {}),
      ...(user.email ? { email: user.email } : {}),
      ...(user.upn ? { upn: user.upn } : {}),
      type: user.type === 'guest' ? 'guest' : 'member',
      groups: Array.isArray(user.groups) ? user.groups.length : 0,
      console: consoleMatchesOf(index, user.extId),
    }));
    return { users, total: page.total, summary };
  });
}

// ── R7: what unsaved rules would match ──────────────────────────────────

function unmatchedUserOf(user: IRagIdentityUser): RagIdentityUnmatchedUser {
  return {
    extId: user.extId,
    ...(user.name ? { name: user.name } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(user.upn ? { upn: user.upn } : {}),
    type: user.type === 'guest' ? 'guest' : 'member',
  };
}

/**
 * How many directory users and console people a list of rules would match, before it is saved: the numbers behind
 * the rules editor. `userMatch` is checked like a saved list (400 `domain_invalid`); an empty list previews the
 * default rules. `matchGroupsByExternalId` only changes group keys, never which people match, so it does not change
 * the answer; it is checked and otherwise ignored.
 */
export async function previewRagIdentityMatch(
  ctx: RagAccessViewContext,
  domainKey: string,
  input: { userMatch: unknown; matchGroupsByExternalId?: boolean },
): Promise<RagIdentityMatchPreview> {
  const cleaned = cleanUserMatchRules(input.userMatch);
  if (input.matchGroupsByExternalId !== undefined && typeof input.matchGroupsByExternalId !== 'boolean') {
    throw new RagAccessError('domain_invalid', 'matchGroupsByExternalId must be a boolean');
  }
  const rules = cleaned.length > 0 ? cleaned : [...DEFAULT_USER_MATCH];
  return inTenant(ctx, async (db) => {
    const domain = await requireDomain(db, domainKey);
    const index = await domainIndexOf(db, ctx, domain, rules);
    const matched = [...index.preview.matchedExtIds].slice(0, MAX_FILTER_IDS);
    const [total, unmatched] = await Promise.all([
      db.listRagIdentityUsers(domain.key, { limit: 0 }),
      db.listRagIdentityUsers(domain.key, { excludeExtIds: matched, limit: UNMATCHED_SAMPLE }),
    ]);
    const truncated = index.truncated || index.preview.matchedExtIds.size > MAX_FILTER_IDS;
    return {
      rules: index.preview.rules,
      directoryUsers: total.total,
      matchedUsers: index.preview.matchedExtIds.size,
      consolePeople: index.preview.considered,
      matchedPeople: index.preview.matchedPeople,
      decidedByRule: index.preview.decidedByRule,
      unmatchedUsers: unmatched.users.map(unmatchedUserOf),
      ...(truncated ? { truncated: true as const } : {}),
    };
  });
}

// ── R8: the groups of a directory ───────────────────────────────────────

/**
 * The groups of an identity directory (those its users belong to, and those a permission names), each with its
 * user count and the console groups that stand for it. Searched over name and id, ordered by name, one page.
 */
export async function listRagIdentityGroups(
  ctx: RagAccessViewContext,
  domainKey: string,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ groups: RagIdentityGroupView[]; total: number }> {
  return inTenant(ctx, async (db) => {
    const domain = await requireDomain(db, domainKey);
    const index = await domainIndexOf(db, ctx, domain);
    const limit = clampLimit(options.limit, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX);
    const offset = clampOffset(options.offset);
    const search = cleanSearch(options.search)?.toLowerCase();

    const [directoryGroups, consoleGroups] = await Promise.all([index.groups(db), db.listGroups(ctx.tenantId)]);
    const rows = [...directoryGroups]
      .map(([id, group]) => ({ id, name: group.name, users: group.users }))
      .filter((row) => !search || row.id.toLowerCase().includes(search) || (row.name ?? '').toLowerCase().includes(search))
      .sort((a, b) => byText((a.name || a.id).toLowerCase(), (b.name || b.id).toLowerCase()) || byText(a.id, b.id));
    const pageRows = rows.slice(offset, offset + limit);

    // Console groups that stand for a directory group: the same external id (when the directory allows it) or a link.
    const consoleGroupById = new Map(consoleGroups.map((g) => [String(g._id), g] as const));
    const byExternalId = new Map<string, IGroup[]>();
    if (index.matchGroupsByExternalId) {
      for (const group of consoleGroups) {
        const externalId = typeof group.externalId === 'string' ? group.externalId.trim() : '';
        if (!externalId) continue;
        const list = byExternalId.get(externalId);
        if (list) list.push(group); else byExternalId.set(externalId, [group]);
      }
    }
    const linksByGroup = new Map<string, IRagIdentityLink[]>();
    for (const link of index.links) {
      if (link.externalKind !== 'group' || link.consoleKind !== 'group') continue;
      const list = linksByGroup.get(link.externalId);
      if (list) list.push(link); else linksByGroup.set(link.externalId, [link]);
    }

    const groups = pageRows.map((row): RagIdentityGroupView => {
      const standsFor: RagIdentityGroupView['console'] = [];
      const seen = new Set<string>();
      for (const group of byExternalId.get(row.id) ?? []) {
        const id = String(group._id);
        seen.add(id);
        standsFor.push({ id, name: group.name, via: 'external_id' });
      }
      for (const link of linksByGroup.get(row.id) ?? []) {
        const group = consoleGroupById.get(link.consoleId);
        if (!group || seen.has(link.consoleId)) continue;
        seen.add(link.consoleId);
        standsFor.push({ id: link.consoleId, name: group.name, via: 'link', ...(link._id !== undefined ? { linkId: String(link._id) } : {}) });
      }
      standsFor.sort((a, b) => byText(a.name.toLowerCase(), b.name.toLowerCase()) || byText(a.id, b.id));
      return { id: row.id, ...(row.name ? { name: row.name } : {}), users: row.users, console: standsFor };
    });
    return { groups, total: rows.length };
  });
}

// ── R9: the manual links of a directory ─────────────────────────────────

/** The manual links of a directory with the names of both ends, newest first. A name is left out when its end is gone. */
export async function listRagIdentityLinkViews(ctx: RagAccessViewContext, domainKey: string): Promise<RagIdentityLinkView[]> {
  return inTenant(ctx, async (db) => {
    const domain = await requireDomain(db, domainKey);
    const links = (await db.listRagIdentityLinks({ domain: domain.key }))
      .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || byText(String(b._id ?? ''), String(a._id ?? '')))
      .slice(0, MAX_LINK_VIEWS);

    const consoleUserIds = [...new Set(links.filter((l) => l.consoleKind === 'user').map((l) => l.consoleId))];
    const consoleGroupIds = [...new Set(links.filter((l) => l.consoleKind === 'group').map((l) => l.consoleId))];
    const externalUserIds = [...new Set(links.filter((l) => l.externalKind === 'user').map((l) => l.externalId))];
    const namesGroups = links.some((l) => l.externalKind === 'group');

    const [users, groups, directoryUsers, labels] = await Promise.all([
      fetchUsers(db, ctx.tenantId, consoleUserIds),
      fetchGroupsByIds(db, ctx.tenantId, consoleGroupIds),
      (async (): Promise<IRagIdentityUser[]> => {
        const found: IRagIdentityUser[] = [];
        for (const part of chunk(externalUserIds, DIRECTORY_LOOKUP_CHUNK)) found.push(...await db.findRagIdentityUsers(domain.key, 'extId', part));
        return found;
      })(),
      namesGroups ? db.listRagAclPrincipalLabels(`x:${domain.key}:g:`) : Promise.resolve([] as Array<{ principal: string; label: string }>),
    ]);
    const memberCounts: Record<string, number> = {};
    for (const part of chunk(groups.map((g) => String(g._id)), 500)) Object.assign(memberCounts, await db.iamCountGroupMembers(part));

    const userById = new Map(users.map((u) => [String(u._id), u] as const));
    const groupById = new Map(groups.map((g) => [String(g._id), g] as const));
    const directoryById = new Map(directoryUsers.map((u) => [u.extId, u] as const));
    const groupLabelPrefix = `x:${domain.key}:g:`;
    const groupLabels = new Map(labels.map((l) => [l.principal.slice(groupLabelPrefix.length), l.label] as const));

    return links.map((link): RagIdentityLinkView => {
      let externalName: string | undefined;
      if (link.externalKind === 'user') {
        const directoryUser = directoryById.get(link.externalId);
        externalName = directoryUser ? directoryUser.name || directoryUser.email || directoryUser.upn : undefined;
      } else {
        externalName = groupLabels.get(link.externalId);
      }
      let consoleName: string | undefined;
      let consoleDetail: string | undefined;
      if (link.consoleKind === 'user') {
        const user = userById.get(link.consoleId);
        if (user) {
          consoleName = personLabel(user) || undefined;
          consoleDetail = user.email && user.email !== consoleName ? user.email : undefined;
        }
      } else {
        const group = groupById.get(link.consoleId);
        if (group) {
          consoleName = group.name;
          consoleDetail = peopleDetail(memberCounts[link.consoleId] ?? 0);
        }
      }
      const createdAt = isoOf(link.createdAt);
      return {
        _id: String(link._id ?? ''),
        externalKind: link.externalKind,
        externalId: link.externalId,
        ...(externalName ? { externalName } : {}),
        consoleKind: link.consoleKind,
        consoleId: link.consoleId,
        ...(consoleName ? { consoleName } : {}),
        ...(consoleDetail ? { consoleDetail } : {}),
        ...(createdAt ? { createdAt } : {}),
      };
    });
  });
}
