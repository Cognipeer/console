/**
 * What one caller may read in one knowledge base.
 *
 * Nodes are the module root, folders (a tree) and documents. A node inherits
 * its parent's permissions unless it has its own (`aclMode: 'own'`), which
 * then REPLACE the parent's. A document's effective permissions are those of
 * the nearest node with its own, walking document -> folder -> ... -> root.
 *
 *  - The root with no entries at all is open to everyone, so switching access
 *    control on hides nothing until someone restricts something.
 *  - A node with its own permissions and no entries is readable by nobody.
 *  - A document in a folder that does not exist (a folder loop counts too) is
 *    readable by nobody: a broken tree never opens anything.
 *
 * Two different admin notions (decision of 2026-10-28):
 *  - `manage`: the caller administers the knowledge base (the engine allows
 *    them `rag.admin` in the module's project). Managers see every document in
 *    MANAGEMENT views so they can set permissions.
 *  - `bypass`: managers also read every document in RETRIEVAL (search,
 *    answers, agent tools, content reads) unless the module turns it off with
 *    `access.adminBypass: false`.
 *
 * The folder tree is cached per process and reused while the module row
 * carries the same `aclRevision` (every tree or root-permission write bumps
 * it), so a change is seen by every replica on its next query. Which nodes
 * the caller holds a grant on is read fresh on every scope.
 */

import { createLogger } from '@/lib/core/logger';
import {
  runWithTenantScope,
  type DatabaseProvider,
  type IRagModule,
  type RagAclNodeType,
  type RagDocumentAccessFilter,
} from '@/lib/database';
import { quietServiceAllows } from '@/lib/iam/requestAuthz';
import type { KbCaller } from './caller';
import { resolveCallerPrincipals } from './identity';

const logger = createLogger('rag:access:scope');

const TREE_MAX_AGE_MS = 5 * 60_000;
const TREE_CACHE_MAX = 500;
/** Principals per grant lookup. */
const PRINCIPAL_BATCH = 500;

export type RagAccessModule = Pick<IRagModule, 'key' | 'projectId' | 'access' | 'aclRevision'>;

export interface RagAccessDocument {
  _id?: unknown;
  ragModuleKey: string;
  folderId?: string | null;
  aclMode?: string | null;
}

export interface RagAccessScope {
  readonly moduleKey: string;
  readonly projectId?: string;
  /** Access control is switched on for the module. */
  readonly enabled: boolean;
  /** The caller administers the module: management views show them everything. */
  readonly manage: boolean;
  /** Retrieval skips the checks for this caller (a manager with the admin exception on, or an internal job). */
  readonly bypass: boolean;
  /** Retrieval must check: `enabled && !bypass`. */
  readonly enforced: boolean;
  readonly caller: KbCaller;
  readonly principals: ReadonlySet<string>;
  /** Retrieval decision for one document of this module. */
  canReadDocument(doc: RagAccessDocument): boolean;
  /** Documents that inherit from this folder are readable. */
  canReadFolder(folderId: string): boolean;
  /** The folder, or a folder below it, is readable: it may be shown in a folder tree. */
  canSeeFolder(folderId: string): boolean;
  /** The documents retrieval may return, as a database filter; undefined = no restriction. */
  documentFilter(): RagDocumentAccessFilter | undefined;
  /** The documents a management view lists: everything for managers, else as retrieval. */
  managementFilter(): RagDocumentAccessFilter | undefined;
  /** Counts for logs and diagnostics (no ids). */
  readonly stats: { principals: number; grantedNodes: number; folders: number; readableFolders: number };
}

// ── folder tree ─────────────────────────────────────────────────────────

interface FolderNode {
  parentId?: string;
  own: boolean;
}

interface ModuleTree {
  revision: number;
  loadedAt: number;
  folders: Map<string, FolderNode>;
  rootHasEntries: boolean;
}

type ScopeDb = Pick<DatabaseProvider, 'listRagFolders' | 'hasRagAclEntries' | 'listRagAclNodesForPrincipals' | 'findUserById'>;

const treeCache = new Map<string, ModuleTree>();
/** Per tenant + module: bumped by every in-process invalidation, so a load that started before it is not cached. */
const treeGenerations = new Map<string, number>();

function treeKey(tenantDbName: string, module: RagAccessModule): string {
  return `${tenantDbName}\u0000${module.projectId ?? ''}\u0000${module.key}`;
}

function generationKey(tenantDbName: string, moduleKey: string): string {
  return `${tenantDbName}\u0000${moduleKey}`;
}

/** Forget a module's cached tree in this process (other replicas follow `aclRevision`). */
export function invalidateRagAccessTree(tenantDbName: string, moduleKey: string): void {
  const generation = generationKey(tenantDbName, moduleKey);
  treeGenerations.set(generation, (treeGenerations.get(generation) ?? 0) + 1);
  const prefix = `${tenantDbName}\u0000`;
  const suffix = `\u0000${moduleKey}`;
  for (const key of [...treeCache.keys()]) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) treeCache.delete(key);
  }
}

async function loadTree(db: ScopeDb, module: RagAccessModule): Promise<Omit<ModuleTree, 'revision' | 'loadedAt'>> {
  const [folders, rootHasEntries] = await Promise.all([
    db.listRagFolders(module.key, { projectId: module.projectId }),
    db.hasRagAclEntries(module.key, 'module', module.key, module.projectId),
  ]);
  const map = new Map<string, FolderNode>();
  for (const folder of folders) {
    if (!folder?._id) continue;
    map.set(String(folder._id), {
      ...(folder.parentId ? { parentId: String(folder.parentId) } : {}),
      own: folder.aclMode === 'own',
    });
  }
  return { folders: map, rootHasEntries };
}

async function getTree(tenantDbName: string, db: ScopeDb, module: RagAccessModule): Promise<ModuleTree> {
  const key = treeKey(tenantDbName, module);
  const revision = typeof module.aclRevision === 'number' ? module.aclRevision : 0;
  const hit = treeCache.get(key);
  if (hit && hit.revision === revision && Date.now() - hit.loadedAt < TREE_MAX_AGE_MS) {
    treeCache.delete(key);
    treeCache.set(key, hit);
    return hit;
  }
  const genKey = generationKey(tenantDbName, module.key);
  const generation = treeGenerations.get(genKey) ?? 0;
  const loaded = await loadTree(db, module);
  const tree: ModuleTree = { ...loaded, revision, loadedAt: Date.now() };
  if ((treeGenerations.get(genKey) ?? 0) === generation) {
    treeCache.delete(key);
    treeCache.set(key, tree);
    while (treeCache.size > TREE_CACHE_MAX) {
      const oldest = treeCache.keys().next().value;
      if (oldest === undefined) break;
      treeCache.delete(oldest);
    }
  }
  return tree;
}

/**
 * Folders whose inheriting documents are readable: the folder's nearest
 * own-permission ancestor-or-self is granted, or none has its own and the root
 * is readable. A missing parent or a loop makes the whole chain unreadable.
 */
export function computeReadableFolders(
  folders: ReadonlyMap<string, FolderNode>,
  grantedFolders: ReadonlySet<string>,
  rootReadable: boolean,
): Set<string> {
  const memo = new Map<string, boolean>();
  for (const start of folders.keys()) {
    if (memo.has(start)) continue;
    const chain: string[] = [];
    const seen = new Set<string>();
    let verdict = false;
    let current: string | undefined = start;
    while (current !== undefined) {
      const known = memo.get(current);
      if (known !== undefined) { verdict = known; break; }
      if (seen.has(current)) { verdict = false; break; }
      seen.add(current);
      const node = folders.get(current);
      if (!node) { verdict = false; break; }
      chain.push(current);
      if (node.own) { verdict = grantedFolders.has(current); break; }
      if (!node.parentId) { verdict = rootReadable; break; }
      current = node.parentId;
    }
    for (const id of chain) memo.set(id, verdict);
  }
  const readable = new Set<string>();
  for (const [id, ok] of memo) if (ok) readable.add(id);
  return readable;
}

/** The readable folders plus every ancestor of one (what a folder tree may show). */
function computeVisibleFolders(folders: ReadonlyMap<string, FolderNode>, readable: ReadonlySet<string>): Set<string> {
  const visible = new Set<string>();
  for (const id of readable) {
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (current !== undefined && !visible.has(current) && !seen.has(current)) {
      seen.add(current);
      const node = folders.get(current);
      if (!node) break;
      visible.add(current);
      current = node.parentId;
    }
  }
  return visible;
}

/**
 * The node whose permissions apply to a folder (`folderId`) or to the top
 * level (`folderId` absent): the nearest own-permission folder, else the
 * module root; `missing` for a broken chain.
 */
export function effectiveAclNodeOf(
  folders: ReadonlyMap<string, FolderNode>,
  moduleKey: string,
  folderId: string | undefined,
): { type: RagAclNodeType | 'missing'; id: string } {
  let current = folderId;
  const seen = new Set<string>();
  while (current !== undefined) {
    if (seen.has(current)) return { type: 'missing', id: current };
    seen.add(current);
    const node = folders.get(current);
    if (!node) return { type: 'missing', id: current };
    if (node.own) return { type: 'folder', id: current };
    current = node.parentId;
  }
  return { type: 'module', id: moduleKey };
}

// ── scopes ─────────────────────────────────────────────────────────────

const NO_STATS = Object.freeze({ principals: 0, grantedNodes: 0, folders: 0, readableFolders: 0 });

function openScope(
  module: RagAccessModule,
  caller: KbCaller,
  flags: { enabled: boolean; manage: boolean; bypass: boolean },
): RagAccessScope {
  return {
    moduleKey: module.key,
    ...(module.projectId ? { projectId: module.projectId } : {}),
    enabled: flags.enabled,
    manage: flags.manage,
    bypass: flags.bypass,
    enforced: false,
    caller,
    principals: new Set<string>(),
    canReadDocument: (doc) => doc.ragModuleKey === module.key,
    canReadFolder: () => true,
    canSeeFolder: () => true,
    documentFilter: () => undefined,
    managementFilter: () => undefined,
    stats: NO_STATS,
  };
}

export interface ResolveRagAccessInput {
  tenantDbName: string;
  tenantId: string;
  module: RagAccessModule;
  caller: KbCaller;
  /**
   * Whether the caller administers the module, when the handler already asked
   * the engine (`serviceActionAllowedForRequest(request, 'rag', 'admin', { projectId })`).
   * Omitted: asked here for a person acting for themselves; never for tokens,
   * delegated calls or anonymous callers.
   */
  manage?: boolean;
  /**
   * The caller's principal keys, when the caller already holds them (the explain view
   * prints the very set it decides with). Omitted: resolved here, through the cache.
   */
  principals?: ReadonlySet<string>;
}

async function personManages(db: ScopeDb, input: ResolveRagAccessInput): Promise<boolean> {
  const { caller } = input;
  if (caller.kind !== 'person' || caller.delegated || caller.tokenId) return false;
  try {
    const user = await db.findUserById(caller.userId);
    if (!user || user.status === 'disabled') return false;
    return await quietServiceAllows({
      subject: 'session',
      tenantDbName: input.tenantDbName,
      tenantId: input.tenantId,
      userId: caller.userId,
      user,
      projectId: input.module.projectId ?? null,
      projectFromPath: Boolean(input.module.projectId),
    }, 'rag', 'admin');
  } catch (error) {
    // No decision is no exception: the caller is checked like everyone else.
    logger.warn('Could not decide whether the caller administers the knowledge base', {
      ragModuleKey: input.module.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function grantedNodes(
  db: ScopeDb,
  module: RagAccessModule,
  principals: ReadonlySet<string>,
): Promise<Array<{ nodeType: RagAclNodeType; nodeId: string }>> {
  const list = [...principals];
  if (list.length <= PRINCIPAL_BATCH) {
    return db.listRagAclNodesForPrincipals(module.key, list, module.projectId);
  }
  const batches: string[][] = [];
  for (let i = 0; i < list.length; i += PRINCIPAL_BATCH) batches.push(list.slice(i, i + PRINCIPAL_BATCH));
  const results = await Promise.all(batches.map((batch) => db.listRagAclNodesForPrincipals(module.key, batch, module.projectId)));
  return results.flat();
}

/**
 * The access scope of `caller` in `module`. Cheap for modules without access
 * control (no database read) and for managers with the admin exception.
 */
export async function resolveRagAccess(input: ResolveRagAccessInput): Promise<RagAccessScope> {
  const { module, caller } = input;
  const enabled = module.access?.enabled === true;
  if (!enabled) return openScope(module, caller, { enabled: false, manage: input.manage === true, bypass: false });
  if (caller.kind === 'system') return openScope(module, caller, { enabled: true, manage: true, bypass: true });

  return runWithTenantScope(input.tenantDbName, async (db) => {
    const manage = input.manage ?? await personManages(db, input);
    if (manage && module.access?.adminBypass !== false) {
      return openScope(module, caller, { enabled: true, manage: true, bypass: true });
    }

    const [{ principals }, tree] = await Promise.all([
      input.principals
        ? Promise.resolve({ principals: input.principals })
        : resolveCallerPrincipals(input.tenantDbName, input.tenantId, caller),
      getTree(input.tenantDbName, db, module),
    ]);
    const nodes = await grantedNodes(db, module, principals);

    const grantedDocs = new Set<string>();
    const grantedFolders = new Set<string>();
    let rootGranted = false;
    for (const node of nodes) {
      if (node.nodeType === 'document') grantedDocs.add(String(node.nodeId));
      else if (node.nodeType === 'folder') grantedFolders.add(String(node.nodeId));
      else if (node.nodeType === 'module' && node.nodeId === module.key) rootGranted = true;
    }
    const rootReadable = !tree.rootHasEntries || rootGranted;
    const readableFolders = computeReadableFolders(tree.folders, grantedFolders, rootReadable);
    let visibleFolders: Set<string> | undefined;

    const filter = (): RagDocumentAccessFilter => ({
      ownAllowedIds: [...grantedDocs],
      inheritFolderIds: [...readableFolders],
      includeTopLevel: rootReadable,
    });

    const scope: RagAccessScope = {
      moduleKey: module.key,
      ...(module.projectId ? { projectId: module.projectId } : {}),
      enabled: true,
      manage,
      bypass: false,
      enforced: true,
      caller,
      principals,
      canReadDocument(doc) {
        if (!doc || doc.ragModuleKey !== module.key) return false;
        if (doc.aclMode === 'own') {
          const id = doc._id !== undefined && doc._id !== null ? String(doc._id) : '';
          return id !== '' && grantedDocs.has(id);
        }
        if (doc.folderId) return readableFolders.has(String(doc.folderId));
        return rootReadable;
      },
      canReadFolder: (folderId) => readableFolders.has(String(folderId)),
      canSeeFolder(folderId) {
        visibleFolders ??= computeVisibleFolders(tree.folders, readableFolders);
        return visibleFolders.has(String(folderId));
      },
      documentFilter: filter,
      managementFilter: () => (manage ? undefined : filter()),
      stats: {
        principals: principals.size,
        grantedNodes: nodes.length,
        folders: tree.folders.size,
        readableFolders: readableFolders.size,
      },
    };
    return scope;
  });
}
