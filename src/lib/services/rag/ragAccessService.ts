/**
 * Managing Knowledge Engine access control: folders, permissions, identity
 * directories, and the calls integrations use to mirror a source system's
 * folders and permissions (SharePoint, QDMS, ...).
 *
 * Nothing here re-embeds or touches vectors: permissions are database rows
 * that queries read (access/scope.ts). Every write that changes the folder
 * tree or the root's permissions bumps the module's `aclRevision` AFTER the
 * write, so every replica reloads its cached tree on the next query.
 *
 * Authorization is the route's job (the gate plus the handler checks that
 * need `rag.admin`); the functions here take the caller's access scope where
 * what they show or allow depends on it.
 */

import { createLogger } from '@/lib/core/logger';
import {
  runWithTenantScope,
  type DatabaseProvider,
  type IRagAclEntry,
  type IRagDocument,
  type IRagFolder,
  type IRagIdentityDomain,
  type IRagIdentityLink,
  type IRagIdentityUser,
  type IRagIdentityUserMatchRule,
  type IRagModule,
  type RagAclManagedBy,
  type RagAclNodeType,
  type RagIdentityDomainKind,
} from '@/lib/database';
import { fetchGroupsByIds } from '@/lib/iam/groupGrants';
import { canAccessProject } from '@/lib/services/projects/projectAccess';
import {
  MAX_ACL_ENTRIES_PER_NODE,
  cleanAclLabel,
  effectiveAclNodeOf,
  invalidateRagAccessTree,
  invalidateRagIdentityCache,
  isUserMatchRule,
  isValidIdentityDomainKey,
  normalizeEmail,
  normalizePrincipal,
  parsePrincipal,
  principalDomain,
  resolvePersonPrincipals,
  resolveRagAccess,
  type PersonIdentityMatch,
  type RagAccessScope,
  type RagPrincipalKind,
} from './access';

const logger = createLogger('rag:access');

export const MAX_FOLDER_DEPTH = 64;
export const MAX_FOLDER_NAME_LENGTH = 200;
export const MAX_DOCUMENTS_PER_MOVE = 500;
const MAX_DIRECTORY_GROUPS_PER_USER = 2_000;
const MAX_DIRECTORY_ATTRS = 16;
const MAX_DIRECTORY_VALUE_LENGTH = 512;
const DIRECTORY_UPSERT_BATCH = 500;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// ── errors ─────────────────────────────────────────────────────────────

export type RagAccessErrorCode =
  | 'module_not_found'
  | 'folder_not_found'
  | 'document_not_found'
  | 'folder_exists'
  | 'folder_not_empty'
  | 'folder_cycle'
  | 'folder_too_deep'
  | 'folder_name_invalid'
  | 'folder_managed_by_source'
  | 'document_managed_by_source'
  | 'acl_managed_by_source'
  | 'node_invalid'
  | 'principal_invalid'
  | 'principal_unknown'
  | 'too_many_entries'
  | 'too_many_documents'
  | 'domain_invalid'
  | 'domain_not_found'
  | 'domain_managed_by_source'
  | 'domain_in_use'
  | 'link_invalid'
  | 'link_not_found'
  | 'user_not_found'
  | 'access_denied';

const STATUS_BY_CODE: Record<RagAccessErrorCode, number> = {
  module_not_found: 404,
  folder_not_found: 404,
  document_not_found: 404,
  domain_not_found: 404,
  link_not_found: 404,
  user_not_found: 404,
  folder_exists: 409,
  folder_not_empty: 409,
  folder_cycle: 409,
  folder_managed_by_source: 409,
  document_managed_by_source: 409,
  acl_managed_by_source: 409,
  domain_managed_by_source: 409,
  domain_in_use: 409,
  folder_too_deep: 400,
  folder_name_invalid: 400,
  node_invalid: 400,
  principal_invalid: 400,
  principal_unknown: 400,
  too_many_entries: 400,
  too_many_documents: 400,
  domain_invalid: 400,
  link_invalid: 400,
  access_denied: 403,
};

/** A refusal the routes answer with `statusCode` and `{ error, code }`. */
export class RagAccessError extends Error {
  readonly statusCode: number;
  constructor(readonly code: RagAccessErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'RagAccessError';
    this.statusCode = STATUS_BY_CODE[code];
  }
}

// ── shared helpers ─────────────────────────────────────────────────────

export interface RagAccessContext {
  tenantDbName: string;
  tenantId: string;
  /** The project the request runs in (the module is looked up in it). */
  projectId?: string;
  /** Who writes: a user id, or `system:connector:<id>` for an integration. */
  actor: string;
}

type Db = DatabaseProvider;

function inTenant<T>(ctx: Pick<RagAccessContext, 'tenantDbName'>, fn: (db: Db) => Promise<T>): Promise<T> {
  return runWithTenantScope(ctx.tenantDbName, fn);
}

async function requireModule(db: Db, ctx: RagAccessContext, ragModuleKey: string): Promise<IRagModule> {
  const ragModule = await db.findRagModuleByKey(ragModuleKey, ctx.projectId);
  if (!ragModule) throw new RagAccessError('module_not_found', `Knowledge Engine module "${ragModuleKey}" not found`);
  return ragModule;
}

function sameProject(a: string | undefined | null, b: string | undefined | null): boolean {
  return (a ?? '') === (b ?? '');
}

/**
 * A record by id. An id the store cannot parse (a MongoDB ObjectId needs 24 hex characters) names nothing: the
 * lookup finds nothing, as it does on SQLite, instead of failing the request.
 */
async function findById<T>(find: () => Promise<T | null>): Promise<T | null> {
  try {
    return await find();
  } catch (error) {
    if (error instanceof Error && error.name === 'BSONError') return null;
    throw error;
  }
}

async function requireFolder(db: Db, ragModule: IRagModule, folderId: string): Promise<IRagFolder> {
  const folder = typeof folderId === 'string' && folderId ? await findById(() => db.findRagFolderById(folderId)) : null;
  if (!folder || folder.ragModuleKey !== ragModule.key || !sameProject(folder.projectId, ragModule.projectId)) {
    throw new RagAccessError('folder_not_found', 'Folder not found');
  }
  return folder;
}

/** Module keys are unique per project only, so a document of the module is also a document of its project (rows from before documents carried a project are accepted, as the document routes do). */
function inModuleProject(doc: Pick<IRagDocument, 'projectId'>, ragModule: Pick<IRagModule, 'projectId'>): boolean {
  return !doc.projectId || sameProject(String(doc.projectId), ragModule.projectId);
}

async function requireDocument(db: Db, ragModule: IRagModule, documentId: string): Promise<IRagDocument> {
  const doc = typeof documentId === 'string' && documentId ? await findById(() => db.findRagDocumentById(documentId)) : null;
  if (!doc || doc.ragModuleKey !== ragModule.key || !inModuleProject(doc, ragModule)) {
    throw new RagAccessError('document_not_found', 'Document not found');
  }
  return doc;
}

// Folder and permission writes of one module run one at a time in this process:
// two overlapping edits could otherwise create the same folder twice, or leave
// the entries of both writes on a node.
const structureWriteTails = new Map<string, Promise<void>>();

async function serializeStructureWrite<T>(
  ctx: Pick<RagAccessContext, 'tenantDbName'>,
  ragModule: Pick<IRagModule, 'key' | 'projectId'>,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${ctx.tenantDbName}\u0000${ragModule.projectId ?? ''}\u0000${ragModule.key}`;
  const before = structureWriteTails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = before.then(() => held);
  structureWriteTails.set(key, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (structureWriteTails.get(key) === tail) structureWriteTails.delete(key);
  }
}

/** Bump after the write it covers; never fails the write (the cached tree also expires on its own). */
async function treeChanged(db: Db, ctx: Pick<RagAccessContext, 'tenantDbName'>, ragModule: Pick<IRagModule, 'key' | 'projectId'>): Promise<void> {
  invalidateRagAccessTree(ctx.tenantDbName, ragModule.key);
  try {
    await db.bumpRagModuleAclRevision(ragModule.key, ragModule.projectId);
  } catch (error) {
    logger.warn('Could not record a folder or permission change on the module', {
      ragModuleKey: ragModule.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function validateFolderName(name: unknown): string {
  if (typeof name !== 'string') throw new RagAccessError('folder_name_invalid', 'Folder name is required');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_FOLDER_NAME_LENGTH || CONTROL_RE.test(trimmed) || trimmed.includes('/')
    || trimmed === '.' || trimmed === '..') {
    throw new RagAccessError(
      'folder_name_invalid',
      `Folder name must be 1-${MAX_FOLDER_NAME_LENGTH} characters, without "/" or control characters`,
    );
  }
  return trimmed;
}

interface TreeNode {
  folder: IRagFolder;
  id: string;
  parentId?: string;
}

function treeOf(folders: IRagFolder[]): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>();
  for (const folder of folders) {
    if (!folder._id) continue;
    const id = String(folder._id);
    map.set(id, { folder, id, ...(folder.parentId ? { parentId: String(folder.parentId) } : {}) });
  }
  return map;
}

/** Ancestors of `id`, top level first; null when the chain is broken (missing parent, loop). */
function ancestorsOf(tree: Map<string, TreeNode>, id: string | undefined): string[] | null {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = id ? tree.get(id)?.parentId : undefined;
  if (id && !tree.has(id)) return null;
  while (current !== undefined) {
    if (seen.has(current)) return null;
    seen.add(current);
    const node = tree.get(current);
    if (!node) return null;
    chain.push(current);
    current = node.parentId;
  }
  return chain.reverse();
}

function pathOf(tree: Map<string, TreeNode>, id: string): string {
  const ancestors = ancestorsOf(tree, id) ?? [];
  return [...ancestors, id].map((a) => tree.get(a)?.folder.name ?? '?').join('/');
}

function descendantsOf(tree: Map<string, TreeNode>, id: string): string[] {
  const children = new Map<string, string[]>();
  for (const node of tree.values()) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const out: string[] = [];
  const stack = [...(children.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

function siblingNameTaken(tree: Map<string, TreeNode>, parentId: string | undefined, name: string, exceptId?: string): boolean {
  const lower = name.toLowerCase();
  for (const node of tree.values()) {
    if (node.id === exceptId) continue;
    if ((node.parentId ?? '') !== (parentId ?? '')) continue;
    if (node.folder.name.toLowerCase() === lower) return true;
  }
  return false;
}

// ── access scopes for management views ──────────────────────────────────

/** Whether a management view shows this folder to the caller. */
function folderVisible(scope: RagAccessScope | undefined, folderId: string): boolean {
  if (!scope || !scope.enabled || scope.manage) return true;
  return scope.canSeeFolder(folderId);
}

const FOLDERS_ADMIN_ONLY = 'Changing the folders of a knowledge base with access control needs Knowledge Engine admin';
const MOVE_ADMIN_ONLY = 'Moving documents of a knowledge base with access control needs Knowledge Engine admin';

/**
 * Whether the caller may change what a knowledge base with access control is made of: its folders, and the folder an
 * existing document sits in (both decide who reads what). Managers may; so may internal callers (no scope) and, for an
 * API token, which never holds `scope.manage`, a caller the route found allowed Knowledge Engine admin (`admin`).
 * A module without access control has no such limit.
 */
function mayChangeStructure(ragModule: Pick<IRagModule, 'access'>, scope: RagAccessScope | undefined, admin?: boolean): boolean {
  if (ragModule.access?.enabled !== true && scope?.enabled !== true) return true;
  return !scope || scope.manage || admin === true;
}

// ── folders ────────────────────────────────────────────────────────────

export interface RagFolderView {
  _id: string;
  parentId?: string;
  name: string;
  path: string;
  aclMode: 'own' | 'inherit';
  aclManaged?: RagAclManagedBy;
  source?: IRagFolder['source'];
  createdAt?: Date;
  updatedAt?: Date;
}

function folderView(tree: Map<string, TreeNode>, folder: IRagFolder): RagFolderView {
  const id = String(folder._id);
  return {
    _id: id,
    ...(folder.parentId ? { parentId: String(folder.parentId) } : {}),
    name: folder.name,
    path: pathOf(tree, id),
    aclMode: folder.aclMode === 'own' ? 'own' : 'inherit',
    ...(folder.aclManaged ? { aclManaged: folder.aclManaged } : {}),
    ...(folder.source ? { source: folder.source } : {}),
    ...(folder.createdAt ? { createdAt: folder.createdAt } : {}),
    ...(folder.updatedAt ? { updatedAt: folder.updatedAt } : {}),
  };
}

/** The module's folders the caller may see (all of them without access control, or for managers). */
export async function listRagModuleFolders(
  ctx: RagAccessContext,
  ragModuleKey: string,
  scope?: RagAccessScope,
): Promise<RagFolderView[]> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, ragModuleKey);
    const folders = await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId });
    const tree = treeOf(folders);
    return folders
      .filter((f) => f._id && folderVisible(scope, String(f._id)))
      .map((f) => folderView(tree, f))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
}

export async function createRagModuleFolder(
  ctx: RagAccessContext,
  input: { ragModuleKey: string; name: string; parentId?: string | null; scope?: RagAccessScope },
): Promise<RagFolderView> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    // A new folder is a new place to put permissions, and a name that ingests by path may start to resolve to: managers only.
    if (!mayChangeStructure(ragModule, input.scope)) throw new RagAccessError('access_denied', FOLDERS_ADMIN_ONLY);
    const name = validateFolderName(input.name);
    return serializeStructureWrite(ctx, ragModule, async () => {
      const folders = await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId });
      const tree = treeOf(folders);
      const parentId = input.parentId ? String(input.parentId) : undefined;
      let ancestorIds: string[] = [];
      if (parentId) {
        if (!tree.has(parentId)) throw new RagAccessError('folder_not_found', 'Parent folder not found');
        const above = ancestorsOf(tree, parentId);
        if (!above) throw new RagAccessError('folder_not_found', 'Parent folder not found');
        ancestorIds = [...above, parentId];
      }
      if (ancestorIds.length + 1 > MAX_FOLDER_DEPTH) {
        throw new RagAccessError('folder_too_deep', `Folders nest at most ${MAX_FOLDER_DEPTH} levels`);
      }
      if (siblingNameTaken(tree, parentId, name)) {
        throw new RagAccessError('folder_exists', 'A folder with this name already exists here');
      }
      const created = await db.createRagFolder({
        tenantId: ctx.tenantId,
        ...(ragModule.projectId ? { projectId: ragModule.projectId } : {}),
        ragModuleKey: ragModule.key,
        ...(parentId ? { parentId } : {}),
        name,
        ...(ancestorIds.length > 0 ? { ancestorIds } : {}),
        createdBy: ctx.actor,
      });
      await treeChanged(db, ctx, ragModule);
      tree.set(String(created._id), { folder: created, id: String(created._id), ...(parentId ? { parentId } : {}) });
      return folderView(tree, created);
    });
  });
}

/** Re-parent `folderId` (and recompute its subtree's ancestors). The caller checked managed/permission rules. */
async function moveFolderInTree(
  db: Db,
  ctx: RagAccessContext,
  tree: Map<string, TreeNode>,
  folderId: string,
  newParentId: string | undefined,
): Promise<void> {
  if (newParentId === folderId) throw new RagAccessError('folder_cycle', 'A folder cannot be moved into itself');
  const below = descendantsOf(tree, folderId);
  if (newParentId && below.includes(newParentId)) {
    throw new RagAccessError('folder_cycle', 'A folder cannot be moved into one of its own folders');
  }
  let parentAncestors: string[] = [];
  if (newParentId) {
    const above = ancestorsOf(tree, newParentId);
    if (!above) throw new RagAccessError('folder_not_found', 'Parent folder not found');
    parentAncestors = [...above, newParentId];
  }
  // Depth of the deepest folder below, relative to the moved one.
  let deepest = 0;
  for (const id of below) {
    const above = ancestorsOf(tree, id) ?? [];
    const index = above.indexOf(folderId);
    if (index >= 0) deepest = Math.max(deepest, above.length - index);
  }
  if (parentAncestors.length + 1 + deepest > MAX_FOLDER_DEPTH) {
    throw new RagAccessError('folder_too_deep', `Folders nest at most ${MAX_FOLDER_DEPTH} levels`);
  }

  const node = tree.get(folderId)!;
  await db.updateRagFolder(folderId, {
    parentId: newParentId,
    ancestorIds: parentAncestors.length > 0 ? parentAncestors : undefined,
    updatedBy: ctx.actor,
  });
  tree.set(folderId, { ...node, ...(newParentId ? { parentId: newParentId } : { parentId: undefined }) });
  for (const id of below) {
    const above = ancestorsOf(tree, id);
    if (!above) continue;
    await db.updateRagFolder(id, { ancestorIds: above.length > 0 ? above : undefined });
  }
}

export async function updateRagModuleFolder(
  ctx: RagAccessContext,
  input: {
    ragModuleKey: string;
    folderId: string;
    name?: string;
    /** `null` moves the folder to the top level. */
    parentId?: string | null;
    scope?: RagAccessScope;
    /** An integration updating the folders it owns. */
    asSource?: boolean;
  },
): Promise<RagFolderView> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    // A rename changes the path ingests resolve, a move changes what the folder inherits: managers only.
    if (!mayChangeStructure(ragModule, input.scope)) throw new RagAccessError('access_denied', FOLDERS_ADMIN_ONLY);
    return serializeStructureWrite(ctx, ragModule, () => updateFolderLocked(db, ctx, ragModule, input));
  });
}

async function updateFolderLocked(
  db: Db,
  ctx: RagAccessContext,
  ragModule: IRagModule,
  input: Parameters<typeof updateRagModuleFolder>[1],
): Promise<RagFolderView> {
  const folder = await requireFolder(db, ragModule, input.folderId);
  const folderId = String(folder._id);
  if (folder.source && !input.asSource) {
    throw new RagAccessError('folder_managed_by_source', 'This folder mirrors a connected source and changes only there');
  }
  const folders = await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId });
  const tree = treeOf(folders);
  let changed = false;

  const targetParent = input.parentId ? String(input.parentId) : undefined;
  const wantsMove = input.parentId !== undefined && targetParent !== (folder.parentId ? String(folder.parentId) : undefined);
  const name = input.name !== undefined ? validateFolderName(input.name) : undefined;
  const renames = name !== undefined && name !== folder.name;

  // Everything is checked before the first write: a refused request changes nothing.
  if (renames || wantsMove) {
    const parentAfter = wantsMove ? targetParent : (folder.parentId ? String(folder.parentId) : undefined);
    if (siblingNameTaken(tree, parentAfter, name ?? folder.name, folderId)) {
      throw new RagAccessError('folder_exists', 'A folder with this name already exists here');
    }
  }
  if (wantsMove && targetParent && !tree.has(targetParent)) throw new RagAccessError('folder_not_found', 'Parent folder not found');

  // A move checks loops and depth before it writes, so it goes first.
  if (wantsMove) {
    await moveFolderInTree(db, ctx, tree, folderId, targetParent);
    changed = true;
  }
  if (renames) {
    await db.updateRagFolder(folderId, { name, updatedBy: ctx.actor });
    changed = true;
  }

  if (changed) await treeChanged(db, ctx, ragModule);
  const fresh = await db.findRagFolderById(folderId);
  return folderView(treeOf(await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId })), fresh ?? folder);
}

/** How many documents of a folder are counted, at most, for a module without a project. */
const FOLDER_DOCUMENT_SCAN_MAX = 1_000;

/**
 * The documents of `folderId`: the module's project and the rows written
 * before documents carried one; for a module without a project, any project
 * (counted up to FOLDER_DOCUMENT_SCAN_MAX: enough to refuse and report).
 */
async function countFolderDocuments(db: Db, ragModule: IRagModule, folderId: string): Promise<number> {
  if (ragModule.projectId) return db.countRagDocuments(ragModule.key, ragModule.projectId, { folderId, withUnscoped: true });
  return (await db.listRagDocumentIds(ragModule.key, { folderId, limit: FOLDER_DOCUMENT_SCAN_MAX })).length;
}

export async function deleteRagModuleFolder(
  ctx: RagAccessContext,
  input: { ragModuleKey: string; folderId: string; scope?: RagAccessScope; asSource?: boolean },
): Promise<void> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    // A deleted folder's name can be created again with weaker permissions: managers only.
    if (!mayChangeStructure(ragModule, input.scope)) throw new RagAccessError('access_denied', FOLDERS_ADMIN_ONLY);
    await serializeStructureWrite(ctx, ragModule, async () => {
      const folder = await requireFolder(db, ragModule, input.folderId);
      const folderId = String(folder._id);
      if (folder.source && !input.asSource) {
        throw new RagAccessError('folder_managed_by_source', 'This folder mirrors a connected source and changes only there');
      }
      const [children, documents] = await Promise.all([
        db.listRagFolders(ragModule.key, { projectId: ragModule.projectId, parentId: folderId }),
        countFolderDocuments(db, ragModule, folderId),
      ]);
      if (children.length > 0 || documents > 0) {
        // With access control on, only callers who manage the module get here, so the counts reveal nothing hidden.
        throw new RagAccessError('folder_not_empty', 'Only an empty folder can be deleted', {
          folders: children.length,
          documents,
        });
      }
      await db.deleteRagFolder(folderId);
      await db.replaceRagAclEntries(ragModule.key, { type: 'folder', id: folderId }, [], ragModule.projectId);
      await treeChanged(db, ctx, ragModule);
    });
  });
}

/** Put documents into a folder (`null`: the top level). With access control on, only managers move. */
export async function moveRagDocuments(
  ctx: RagAccessContext,
  input: {
    ragModuleKey: string;
    documentIds: string[];
    folderId: string | null;
    scope?: RagAccessScope;
    asSource?: boolean;
  },
): Promise<{ moved: number }> {
  const ids = [...new Set((Array.isArray(input.documentIds) ? input.documentIds : []).filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return { moved: 0 };
  if (ids.length > MAX_DOCUMENTS_PER_MOVE) {
    throw new RagAccessError('too_many_documents', `At most ${MAX_DOCUMENTS_PER_MOVE} documents per move`);
  }
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    if (!mayChangeStructure(ragModule, input.scope)) throw new RagAccessError('access_denied', MOVE_ADMIN_ONLY);
    return serializeStructureWrite(ctx, ragModule, async () => {
      let folderId: string | undefined;
      if (input.folderId) folderId = String((await requireFolder(db, ragModule, input.folderId))._id);
      const docs = await db.findRagDocumentsByIds(ids);
      const found = new Map(docs
        .filter((d) => d.ragModuleKey === ragModule.key && inModuleProject(d, ragModule))
        .map((d) => [String(d._id), d]));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) throw new RagAccessError('document_not_found', 'Document not found', { documentIds: missing });
      if (!input.asSource) {
        const managed = [...found.values()].filter((d) => d.aclManaged === 'sync').map((d) => String(d._id));
        if (managed.length > 0) {
          throw new RagAccessError('document_managed_by_source', 'These documents mirror a connected source and move only there', { documentIds: managed });
        }
      }
      let moved = 0;
      for (const doc of found.values()) {
        if ((doc.folderId ?? undefined) === folderId) continue;
        await db.updateRagDocument(String(doc._id), { folderId });
        moved += 1;
      }
      return { moved };
    });
  });
}

// ── permissions ────────────────────────────────────────────────────────

export type RagAclNodeRef = { type: RagAclNodeType; id: string };

/** `module`, `folder:<id>` or `document:<id>`. */
export function parseRagAclNode(raw: unknown, ragModuleKey: string): RagAclNodeRef {
  if (raw === 'module' || raw === undefined || raw === null || raw === '') return { type: 'module', id: ragModuleKey };
  if (typeof raw === 'object' && raw) {
    const node = raw as { type?: unknown; id?: unknown };
    if (node.type === 'module') return { type: 'module', id: ragModuleKey };
    if ((node.type === 'folder' || node.type === 'document') && typeof node.id === 'string' && node.id) {
      return { type: node.type, id: node.id };
    }
    throw new RagAccessError('node_invalid', 'node must be "module", "folder:<id>" or "document:<id>"');
  }
  if (typeof raw === 'string') {
    const sep = raw.indexOf(':');
    const type = sep > 0 ? raw.slice(0, sep) : '';
    const id = sep > 0 ? raw.slice(sep + 1) : '';
    if ((type === 'folder' || type === 'document') && id) return { type, id };
  }
  throw new RagAccessError('node_invalid', 'node must be "module", "folder:<id>" or "document:<id>"');
}

export interface RagAclEntryView {
  principal: string;
  kind: RagPrincipalKind;
  label?: string;
  managed?: RagAclManagedBy;
}

export interface RagNodeAclView {
  node: RagAclNodeRef;
  /** The root always has its own; folders and documents inherit unless they break it. */
  mode: 'own' | 'inherit';
  managed?: RagAclManagedBy;
  entries: RagAclEntryView[];
  /** The permissions that apply: the node's own, or those of the nearest node that has its own. */
  effective: {
    node: { type: RagAclNodeType | 'missing'; id: string };
    entries: RagAclEntryView[];
    /** The module root without entries: open to everyone who can read the knowledge base. */
    openToEveryone?: boolean;
  };
}

function entryView(entry: IRagAclEntry): RagAclEntryView {
  const parsed = parsePrincipal(entry.principal);
  return {
    principal: entry.principal,
    kind: parsed?.kind ?? 'everyone',
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.managed ? { managed: entry.managed } : {}),
  };
}

interface ResolvedNode {
  ref: RagAclNodeRef;
  mode: 'own' | 'inherit';
  managed?: RagAclManagedBy;
  /** Folder the node inherits from (folder: its parent; document: its folder). */
  inheritFrom?: string;
}

async function resolveNode(db: Db, ragModule: IRagModule, node: RagAclNodeRef): Promise<ResolvedNode> {
  if (node.type === 'module') {
    if (node.id !== ragModule.key) throw new RagAccessError('node_invalid', 'The module node is the module itself');
    return { ref: node, mode: 'own' };
  }
  if (node.type === 'folder') {
    const folder = await requireFolder(db, ragModule, node.id);
    return {
      ref: { type: 'folder', id: String(folder._id) },
      mode: folder.aclMode === 'own' ? 'own' : 'inherit',
      ...(folder.aclManaged ? { managed: folder.aclManaged } : {}),
      ...(folder.parentId ? { inheritFrom: String(folder.parentId) } : {}),
    };
  }
  const doc = await requireDocument(db, ragModule, node.id);
  return {
    ref: { type: 'document', id: String(doc._id) },
    mode: doc.aclMode === 'own' ? 'own' : 'inherit',
    ...(doc.aclManaged ? { managed: doc.aclManaged } : {}),
    ...(doc.folderId ? { inheritFrom: String(doc.folderId) } : {}),
  };
}

export async function getRagNodeAcl(
  ctx: RagAccessContext,
  input: { ragModuleKey: string; node: RagAclNodeRef },
): Promise<RagNodeAclView> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    const resolved = await resolveNode(db, ragModule, input.node);
    const own = await db.listRagAclEntries(ragModule.key, {
      projectId: ragModule.projectId,
      nodeType: resolved.ref.type,
      nodeId: resolved.ref.id,
    });

    let effectiveNode: { type: RagAclNodeType | 'missing'; id: string } = resolved.ref;
    let effectiveEntries = own;
    if (resolved.mode === 'inherit') {
      const folders = await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId });
      const map = new Map(folders.filter((f) => f._id).map((f) => [String(f._id), {
        ...(f.parentId ? { parentId: String(f.parentId) } : {}),
        own: f.aclMode === 'own',
      }]));
      effectiveNode = effectiveAclNodeOf(map, ragModule.key, resolved.inheritFrom);
      effectiveEntries = effectiveNode.type === 'missing'
        ? []
        : await db.listRagAclEntries(ragModule.key, {
          projectId: ragModule.projectId,
          nodeType: effectiveNode.type,
          nodeId: effectiveNode.id,
        });
    }
    return {
      node: resolved.ref,
      mode: resolved.mode,
      ...(resolved.managed ? { managed: resolved.managed } : {}),
      entries: resolved.mode === 'own' ? own.map(entryView) : [],
      effective: {
        node: effectiveNode,
        entries: effectiveEntries.map(entryView),
        ...(effectiveNode.type === 'module' && effectiveEntries.length === 0 ? { openToEveryone: true } : {}),
      },
    };
  });
}

export interface RagAclEntryInput {
  principal: string;
  label?: string;
}

/** Canonical, de-duplicated entries; throws on the first invalid one. */
export function normalizeAclEntries(entries: unknown): Array<{ principal: string; label?: string }> {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new RagAccessError('principal_invalid', 'entries must be an array');
  if (entries.length > MAX_ACL_ENTRIES_PER_NODE) {
    throw new RagAccessError('too_many_entries', `At most ${MAX_ACL_ENTRIES_PER_NODE} entries per folder or document`);
  }
  const byPrincipal = new Map<string, { principal: string; label?: string }>();
  entries.forEach((raw, index) => {
    const value = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw as { principal?: unknown }).principal : undefined);
    const principal = normalizePrincipal(value);
    if (!principal) {
      throw new RagAccessError('principal_invalid', `entries[${index}] is not a valid principal`, { index });
    }
    const label = raw && typeof raw === 'object' ? cleanAclLabel((raw as { label?: unknown }).label) : undefined;
    if (!byPrincipal.has(principal)) byPrincipal.set(principal, { principal, ...(label ? { label } : {}) });
  });
  return [...byPrincipal.values()];
}

/** Every console user, group, token and identity domain the entries name must exist. */
async function assertPrincipalsExist(
  db: Db,
  ctx: RagAccessContext,
  entries: Array<{ principal: string }>,
  options: { externalOnly?: boolean },
): Promise<void> {
  const users = new Set<string>();
  const groups = new Set<string>();
  const tokens = new Set<string>();
  const domains = new Set<string>();
  for (const entry of entries) {
    const parsed = parsePrincipal(entry.principal);
    if (!parsed) continue;
    if (parsed.kind === 'user') users.add(parsed.id);
    else if (parsed.kind === 'group') groups.add(parsed.id);
    else if (parsed.kind === 'token') tokens.add(parsed.id);
    const domain = principalDomain(parsed);
    if (domain) domains.add(domain);
  }
  const unknown: string[] = [];
  if (domains.size > 0) {
    const known = new Set((await db.listRagIdentityDomains()).map((d) => d.key));
    for (const d of domains) if (!known.has(d)) unknown.push(`x:${d}`);
  }
  if (!options.externalOnly) {
    const userRows = await Promise.all([...users].map(async (id) => [id, await findById(() => db.findUserById(id))] as const));
    for (const [id, row] of userRows) if (!row || (row.tenantId && String(row.tenantId) !== ctx.tenantId)) unknown.push(`user:${id}`);
    if (groups.size > 0) {
      const found = new Set((await fetchGroupsByIds(db, ctx.tenantId, [...groups])).map((g) => String(g._id)));
      for (const id of groups) if (!found.has(id)) unknown.push(`group:${id}`);
    }
    const tokenRows = await Promise.all([...tokens].map(async (id) => [id, await findById(() => db.findApiTokenById(id, ctx.tenantId))] as const));
    for (const [id, row] of tokenRows) if (!row) unknown.push(`token:${id}`);
  }
  if (unknown.length > 0) {
    throw new RagAccessError('principal_unknown', 'Some entries name users, groups, tokens or directories that do not exist', {
      principals: unknown.slice(0, 50),
    });
  }
}

export interface SetRagNodeAclInput {
  ragModuleKey: string;
  node: RagAclNodeRef;
  mode: 'own' | 'inherit';
  entries?: unknown;
  /** Written by an integration: the node becomes (or stays) owned by the source. */
  managed?: RagAclManagedBy;
}

function writeNodeAcl(db: Db, ctx: RagAccessContext, ragModule: IRagModule, input: SetRagNodeAclInput): Promise<RagAclNodeRef> {
  return serializeStructureWrite(ctx, ragModule, () => writeNodeAclLocked(db, ctx, ragModule, input));
}

async function writeNodeAclLocked(db: Db, ctx: RagAccessContext, ragModule: IRagModule, input: SetRagNodeAclInput): Promise<RagAclNodeRef> {
  const resolved = await resolveNode(db, ragModule, input.node);
  if (resolved.managed === 'sync' && input.managed !== 'sync') {
    throw new RagAccessError('acl_managed_by_source', 'These permissions mirror a connected source and change only there');
  }
  if (input.mode !== 'own' && input.mode !== 'inherit') throw new RagAccessError('node_invalid', 'mode must be "own" or "inherit"');
  if (resolved.ref.type === 'module' && input.mode !== 'own') {
    throw new RagAccessError('node_invalid', 'The module root has no parent to inherit from');
  }
  const entries = input.mode === 'own' ? normalizeAclEntries(input.entries) : [];
  await assertPrincipalsExist(db, ctx, entries, { externalOnly: input.managed === 'sync' });

  const rows = entries.map((e) => ({
    tenantId: ctx.tenantId,
    ...(ragModule.projectId ? { projectId: ragModule.projectId } : {}),
    principal: e.principal,
    ...(e.label ? { label: e.label } : {}),
    ...(input.managed ? { managed: input.managed } : {}),
    createdBy: ctx.actor,
  }));

  if (resolved.ref.type === 'module') {
    await db.replaceRagAclEntries(ragModule.key, resolved.ref, rows, ragModule.projectId);
    await treeChanged(db, ctx, ragModule);
    return resolved.ref;
  }

  // Order keeps every intermediate state closed: an own ACL is switched on
  // before its entries exist (nobody reads), switched off before they go.
  const markOwn = { aclMode: 'own' as const, aclManaged: input.managed };
  const markInherit = { aclMode: undefined, aclManaged: input.managed };
  if (resolved.ref.type === 'folder') {
    if (input.mode === 'own') {
      await db.updateRagFolder(resolved.ref.id, { ...markOwn, updatedBy: ctx.actor });
      await db.replaceRagAclEntries(ragModule.key, resolved.ref, rows, ragModule.projectId);
    } else {
      await db.updateRagFolder(resolved.ref.id, { ...markInherit, updatedBy: ctx.actor });
      await db.replaceRagAclEntries(ragModule.key, resolved.ref, [], ragModule.projectId);
    }
    await treeChanged(db, ctx, ragModule);
    return resolved.ref;
  }

  if (input.mode === 'own') {
    await db.updateRagDocument(resolved.ref.id, markOwn);
    await db.replaceRagAclEntries(ragModule.key, resolved.ref, rows, ragModule.projectId);
  } else {
    await db.updateRagDocument(resolved.ref.id, markInherit);
    await db.replaceRagAclEntries(ragModule.key, resolved.ref, [], ragModule.projectId);
  }
  return resolved.ref;
}

/** Set one node's permissions from the console (a person with Knowledge Engine admin). */
export async function setRagNodeAclFromConsole(ctx: RagAccessContext, input: Omit<SetRagNodeAclInput, 'managed'>): Promise<RagNodeAclView> {
  const ref = await inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    return writeNodeAcl(db, ctx, ragModule, { ...input });
  });
  return getRagNodeAcl(ctx, { ragModuleKey: input.ragModuleKey, node: ref });
}

// ── explain ────────────────────────────────────────────────────────────

export interface RagAccessExplanation {
  userId: string;
  active: boolean;
  enabled: boolean;
  manage: boolean;
  bypass: boolean;
  /** The person's identity (e-mail, groups, every key, the directory matches): only with `identity`, for workspace-level admins. */
  email?: string;
  groupIds?: string[];
  principals?: string[];
  matches?: PersonIdentityMatch[];
  document?: {
    documentId: string;
    folderId?: string;
    mode: 'own' | 'inherit';
    effectiveNode: { type: RagAclNodeType | 'missing'; id: string };
    readable: boolean;
    /** The person's keys that the entries of the deciding node name. */
    grantedBy: string[];
    /** The deciding node is the module root and it has no entries: open to everyone who reaches the knowledge base. */
    openToEveryone?: boolean;
  };
}

/**
 * Why a console user can (not) read a document: the decision and the keys of the person that the deciding node names.
 * With `identity` (the caller administers the Knowledge Engine of the whole workspace, not just of this project) also who
 * the person is: their e-mail, groups, every key and how the directories matched them.
 */
export async function explainRagAccess(
  ctx: RagAccessContext,
  input: { ragModuleKey: string; userId: string; documentId?: string; identity?: boolean },
): Promise<RagAccessExplanation> {
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    const user = await findById(() => db.findUserById(input.userId));
    if (!user || (user.tenantId && String(user.tenantId) !== ctx.tenantId)) throw new RagAccessError('user_not_found', 'User not found');
    // An admin of the project asks only about people who work in it. They write the entries themselves, so the decision
    // on an entry of a guessed e-mail or directory id would otherwise tell them who anyone of the workspace is.
    if (!input.identity) {
      const projectId = ragModule.projectId || ctx.projectId;
      const reaches = Boolean(projectId) && await canAccessProject(db, {
        userId: String(user._id),
        userRole: user.role,
        projectId: String(projectId),
        legacyProjectIds: user.projectIds,
      });
      if (!reaches) throw new RagAccessError('user_not_found', 'User not found');
    }
    const person = await resolvePersonPrincipals(ctx.tenantDbName, ctx.tenantId, input.userId, { fresh: true });
    // The decision is made with the very keys listed, not with the cached set of the last 15 seconds.
    const keys = new Set(person.principals);
    const scope = await resolveRagAccess({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      module: ragModule,
      caller: { kind: 'person', userId: input.userId },
      principals: keys,
    });
    let document: RagAccessExplanation['document'];
    if (input.documentId) {
      const doc = await requireDocument(db, ragModule, input.documentId);
      const folders = await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId });
      const map = new Map(folders.filter((f) => f._id).map((f) => [String(f._id), {
        ...(f.parentId ? { parentId: String(f.parentId) } : {}),
        own: f.aclMode === 'own',
      }]));
      const own = doc.aclMode === 'own';
      const effectiveNode: NonNullable<RagAccessExplanation['document']>['effectiveNode'] = own
        ? { type: 'document', id: String(doc._id) }
        : effectiveAclNodeOf(map, ragModule.key, doc.folderId ?? undefined);
      const entries = effectiveNode.type === 'missing'
        ? []
        : await db.listRagAclEntries(ragModule.key, { projectId: ragModule.projectId, nodeType: effectiveNode.type, nodeId: effectiveNode.id });
      document = {
        documentId: String(doc._id),
        ...(doc.folderId ? { folderId: String(doc.folderId) } : {}),
        mode: own ? 'own' : 'inherit',
        effectiveNode,
        readable: !scope.enforced || scope.canReadDocument(doc),
        grantedBy: entries.map((e) => e.principal).filter((principal) => keys.has(principal)),
        ...(effectiveNode.type === 'module' && entries.length === 0 ? { openToEveryone: true } : {}),
      };
    }
    return {
      userId: person.userId,
      active: person.active,
      enabled: scope.enabled,
      manage: scope.manage,
      bypass: scope.bypass,
      ...(input.identity
        ? {
          ...(person.email ? { email: person.email } : {}),
          groupIds: person.groupIds,
          principals: person.principals,
          matches: person.matches,
        }
        : {}),
      ...(document ? { document } : {}),
    };
  });
}

// ── identity directories ────────────────────────────────────────────────

/** The rules as sent, each one checked; not sent (undefined) is not the same as an empty list, which stands for the default rules. */
function cleanRules(raw: unknown): IRagIdentityUserMatchRule[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new RagAccessError('domain_invalid', 'userMatch must be an array');
  if (raw.length > 8) throw new RagAccessError('domain_invalid', 'userMatch takes at most 8 rules');
  return raw.map((rule): IRagIdentityUserMatchRule => {
    if (!isUserMatchRule(rule)) {
      throw new RagAccessError('domain_invalid', 'userMatch rules compare console "email" or "externalId" with "email", "upn", "id" or "attr:<name>"');
    }
    if (rule.external.startsWith('attr:') && !/^attr:[A-Za-z0-9_.-]{1,64}$/.test(rule.external)) {
      throw new RagAccessError('domain_invalid', 'Attribute names are 1-64 letters, digits, ".", "_" or "-"');
    }
    return { console: rule.console, external: rule.external };
  });
}

function cleanDomainLabel(label: unknown, fallback: string): string {
  const clean = cleanAclLabel(label);
  return clean ?? fallback;
}

export async function listRagIdentityDomains(ctx: Pick<RagAccessContext, 'tenantDbName'>): Promise<IRagIdentityDomain[]> {
  return inTenant(ctx, (db) => db.listRagIdentityDomains());
}

export interface PutRagIdentityDomainInput {
  key: string;
  label?: string;
  kind?: RagIdentityDomainKind;
  userMatch?: unknown;
  matchGroupsByExternalId?: boolean;
}

async function upsertDomain(
  db: Db,
  ctx: RagAccessContext,
  input: PutRagIdentityDomainInput,
  source: IRagIdentityDomain['source'] | undefined,
): Promise<IRagIdentityDomain> {
  if (!isValidIdentityDomainKey(input.key)) {
    throw new RagAccessError('domain_invalid', 'Directory keys are 1-64 lower-case letters, digits, ".", "_" or "-", starting with a letter or digit');
  }
  const existing = await db.findRagIdentityDomain(input.key);
  if (existing?.source && !source) {
    throw new RagAccessError('domain_managed_by_source', 'This directory is maintained by a connector and changes only there');
  }
  if (existing?.source && source && existing.source.connectorId !== source.connectorId) {
    throw new RagAccessError('domain_managed_by_source', 'This directory is maintained by another connector');
  }
  const rules = cleanRules(input.userMatch);
  const domain = await db.upsertRagIdentityDomain({
    tenantId: ctx.tenantId,
    key: input.key,
    kind: input.kind ?? existing?.kind ?? 'generic',
    label: cleanDomainLabel(input.label, existing?.label ?? input.key),
    ...(source ? { source } : existing?.source ? { source: existing.source } : {}),
    userMatch: rules ?? existing?.userMatch ?? [],
    ...(typeof input.matchGroupsByExternalId === 'boolean'
      ? { matchGroupsByExternalId: input.matchGroupsByExternalId }
      : existing && typeof existing.matchGroupsByExternalId === 'boolean'
        ? { matchGroupsByExternalId: existing.matchGroupsByExternalId }
        : {}),
    ...(existing?.createdBy ? { createdBy: existing.createdBy } : { createdBy: ctx.actor }),
    updatedBy: ctx.actor,
  });
  invalidateRagIdentityCache(ctx.tenantDbName);
  return domain;
}

/** A directory made by hand (`generic`), or the matching rules of one. Connector-maintained ones are refused. */
export async function putRagIdentityDomain(ctx: RagAccessContext, input: PutRagIdentityDomainInput): Promise<IRagIdentityDomain> {
  return inTenant(ctx, (db) => upsertDomain(db, ctx, { ...input, kind: input.kind ?? 'generic' }, undefined));
}

export async function deleteRagIdentityDomainByKey(ctx: RagAccessContext, key: string): Promise<void> {
  return inTenant(ctx, async (db) => {
    const existing = await db.findRagIdentityDomain(key);
    if (!existing) throw new RagAccessError('domain_not_found', 'Directory not found');
    if (existing.source) {
      throw new RagAccessError('domain_managed_by_source', 'This directory is maintained by a connector and is removed with it');
    }

    // The permissions that name the directory go with it; left behind, they would come back to whoever matches a
    // directory made later under the same key. A module root without entries is open to everyone, so a root that names
    // nothing but this directory keeps it until the knowledge base has other permissions.
    const prefix = `x:${key}:`;
    const onlyThisDirectory: string[] = [];
    for (const ragModule of await db.listRagModules()) {
      const rootEntries = (await db.listRagAclEntries(ragModule.key, {
        projectId: ragModule.projectId,
        nodeType: 'module',
        nodeId: ragModule.key,
      })).filter((entry) => sameProject(entry.projectId, ragModule.projectId));
      if (rootEntries.length > 0 && rootEntries.every((entry) => entry.principal.startsWith(prefix)) && !onlyThisDirectory.includes(ragModule.key)) {
        onlyThisDirectory.push(ragModule.key);
      }
    }
    if (onlyThisDirectory.length > 0) {
      throw new RagAccessError(
        'domain_in_use',
        'The permissions of a knowledge base name only this directory; give the knowledge base other permissions first',
        { modules: onlyThisDirectory },
      );
    }

    // Entries first: if the directory's own removal fails, deleting it again still cleans up.
    await db.deleteRagAclEntriesByPrincipalPrefix(prefix);
    await db.deleteRagIdentityDomain(key);
    invalidateRagIdentityCache(ctx.tenantDbName);
  });
}

export async function listRagIdentityDirectoryUsers(
  ctx: Pick<RagAccessContext, 'tenantDbName'>,
  key: string,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ users: IRagIdentityUser[]; total: number }> {
  return inTenant(ctx, async (db) => {
    const domain = await db.findRagIdentityDomain(key);
    if (!domain) throw new RagAccessError('domain_not_found', 'Directory not found');
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const search = typeof options.search === 'string' ? options.search.trim().slice(0, 200) : undefined;
    return db.listRagIdentityUsers(key, { ...(search ? { search } : {}), limit, offset });
  });
}

export async function listRagIdentityLinksFor(
  ctx: Pick<RagAccessContext, 'tenantDbName'>,
  filters: { domain?: string; consoleKind?: 'user' | 'group'; consoleId?: string } = {},
): Promise<IRagIdentityLink[]> {
  return inTenant(ctx, (db) => db.listRagIdentityLinks({
    ...(filters.domain ? { domain: filters.domain } : {}),
    ...(filters.consoleKind ? { consoleKind: filters.consoleKind } : {}),
    ...(filters.consoleId ? { consoleIds: [filters.consoleId] } : {}),
  }));
}

export async function createRagIdentityLinkFor(
  ctx: RagAccessContext,
  input: { domain: string; externalKind: 'user' | 'group'; externalId: string; consoleKind: 'user' | 'group'; consoleId: string },
): Promise<IRagIdentityLink> {
  if (input.externalKind !== 'user' && input.externalKind !== 'group') throw new RagAccessError('link_invalid', 'externalKind must be "user" or "group"');
  if (input.consoleKind !== 'user' && input.consoleKind !== 'group') throw new RagAccessError('link_invalid', 'consoleKind must be "user" or "group"');
  if (input.consoleKind === 'group' && input.externalKind === 'user') {
    throw new RagAccessError('link_invalid', 'A console group can be linked to an external group only');
  }
  const externalId = typeof input.externalId === 'string' ? input.externalId.trim() : '';
  if (!externalId || externalId.length > MAX_DIRECTORY_VALUE_LENGTH || CONTROL_RE.test(externalId)) {
    throw new RagAccessError('link_invalid', 'externalId is required');
  }
  return inTenant(ctx, async (db) => {
    const domain = await db.findRagIdentityDomain(input.domain);
    if (!domain) throw new RagAccessError('domain_not_found', 'Directory not found');
    if (input.consoleKind === 'user') {
      const user = typeof input.consoleId === 'string' && input.consoleId ? await findById(() => db.findUserById(input.consoleId)) : null;
      if (!user || (user.tenantId && String(user.tenantId) !== ctx.tenantId)) throw new RagAccessError('link_invalid', 'Console user not found');
    } else {
      const [group] = await fetchGroupsByIds(db, ctx.tenantId, [input.consoleId]);
      if (!group) throw new RagAccessError('link_invalid', 'Console group not found');
    }
    const existing = (await db.listRagIdentityLinks({ domain: domain.key, consoleKind: input.consoleKind, consoleIds: [input.consoleId] }))
      .find((l) => l.externalKind === input.externalKind && l.externalId === externalId);
    if (existing) return existing;
    const link = await db.createRagIdentityLink({
      tenantId: ctx.tenantId,
      domain: domain.key,
      externalKind: input.externalKind,
      externalId,
      consoleKind: input.consoleKind,
      consoleId: input.consoleId,
      createdBy: ctx.actor,
    });
    invalidateRagIdentityCache(ctx.tenantDbName);
    return link;
  });
}

export async function deleteRagIdentityLinkById(ctx: RagAccessContext, id: string): Promise<void> {
  return inTenant(ctx, async (db) => {
    const removed = await db.deleteRagIdentityLink(id);
    if (!removed) throw new RagAccessError('link_not_found', 'Link not found');
    invalidateRagIdentityCache(ctx.tenantDbName);
  });
}

// ── integration API (connector sync) ────────────────────────────────────

export interface RagSourceRef {
  connectorId: string;
  sourceId: string;
}

/** A source folder's name as a console folder name: never refused, only made readable. */
function sourceFolderName(raw: unknown, externalId: string): string {
  const flat = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\//g, '-').trim().slice(0, MAX_FOLDER_NAME_LENGTH).trim();
  if (flat && flat !== '.' && flat !== '..') return flat;
  return `folder-${externalId.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 24) || 'unnamed'}`;
}

/**
 * Make sure the folders of a source path exist, top level first, and return
 * the last one's id. Folders are matched by the source's own ids, so a rename
 * or a move in the source renames or moves the folder here.
 */
export async function ensureRagFolderPath(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  input: {
    ragModuleKey: string;
    source: RagSourceRef;
    segments: Array<{ externalId: string; name: string }>;
    actor: string;
  },
): Promise<string | undefined> {
  const ctx: RagAccessContext = { tenantDbName, tenantId, projectId, actor: input.actor };
  if (!Array.isArray(input.segments) || input.segments.length === 0) return undefined;
  if (input.segments.length > MAX_FOLDER_DEPTH) {
    throw new RagAccessError('folder_too_deep', `Folders nest at most ${MAX_FOLDER_DEPTH} levels`);
  }
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    return serializeStructureWrite(ctx, ragModule, () => ensureSourcePathLocked(db, ctx, ragModule, input));
  });
}

async function ensureSourcePathLocked(
  db: Db,
  ctx: RagAccessContext,
  ragModule: IRagModule,
  input: Parameters<typeof ensureRagFolderPath>[3],
): Promise<string | undefined> {
  const folders = await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId });
  const tree = treeOf(folders);
  const bySourceId = new Map<string, TreeNode>();
  for (const node of tree.values()) {
    const s = node.folder.source;
    if (s && s.sourceId === input.source.sourceId) bySourceId.set(s.externalId, node);
  }
  let parentId: string | undefined;
  let changed = false;
  for (const segment of input.segments) {
    const externalId = typeof segment.externalId === 'string' ? segment.externalId.trim() : '';
    if (!externalId) throw new RagAccessError('folder_name_invalid', 'Every path segment needs the source id of the folder');
    const name = sourceFolderName(segment.name, externalId);
    const existing = bySourceId.get(externalId);
    if (existing) {
      const id = existing.id;
      if (existing.folder.name !== name) {
        await db.updateRagFolder(id, { name, updatedBy: ctx.actor });
        tree.set(id, { ...existing, folder: { ...existing.folder, name } });
        changed = true;
      }
      if ((existing.parentId ?? undefined) !== parentId) {
        await moveFolderInTree(db, ctx, tree, id, parentId);
        changed = true;
      }
      parentId = id;
      continue;
    }
    const ancestors = parentId ? [...(ancestorsOf(tree, parentId) ?? []), parentId] : [];
    const created = await db.createRagFolder({
      tenantId: ctx.tenantId,
      ...(ragModule.projectId ? { projectId: ragModule.projectId } : {}),
      ragModuleKey: ragModule.key,
      ...(parentId ? { parentId } : {}),
      name,
      ...(ancestors.length > 0 ? { ancestorIds: ancestors } : {}),
      source: { kind: 'connector', connectorId: input.source.connectorId, sourceId: input.source.sourceId, externalId },
      createdBy: ctx.actor,
    });
    const id = String(created._id);
    const node: TreeNode = { folder: created, id, ...(parentId ? { parentId } : {}) };
    tree.set(id, node);
    bySourceId.set(externalId, node);
    parentId = id;
    changed = true;
  }
  if (changed) await treeChanged(db, ctx, ragModule);
  return parentId;
}

/** Set one node's permissions as an integration (the node becomes owned by the source). */
export async function setRagNodeAcl(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  input: SetRagNodeAclInput & { actor: string },
): Promise<void> {
  const ctx: RagAccessContext = { tenantDbName, tenantId, projectId, actor: input.actor };
  await inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    await writeNodeAcl(db, ctx, ragModule, { ...input, managed: input.managed ?? 'sync' });
  });
}

/** A directory maintained by a connector (created on its first sync). */
export async function upsertRagIdentityDomainFromSource(
  tenantDbName: string,
  tenantId: string,
  input: PutRagIdentityDomainInput & { connectorId: string; actor: string },
): Promise<IRagIdentityDomain> {
  const ctx: RagAccessContext = { tenantDbName, tenantId, actor: input.actor };
  return inTenant(ctx, (db) => upsertDomain(db, ctx, input, { kind: 'connector', connectorId: input.connectorId }));
}

function cleanDirectoryValue(value: unknown, lower: boolean): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_DIRECTORY_VALUE_LENGTH || CONTROL_RE.test(trimmed)) return undefined;
  return lower ? trimmed.toLowerCase() : trimmed;
}

/** One directory user as stored: lower-cased e-mail / UPN / attributes, bounded groups and attributes. */
export function normalizeDirectoryUser(
  raw: Partial<IRagIdentityUser> & { extId: string },
  tenantId: string,
  runId: string,
): Omit<IRagIdentityUser, '_id' | 'domain'> | null {
  const extId = cleanDirectoryValue(raw.extId, false);
  if (!extId) return null;
  const email = raw.email ? normalizeEmail(raw.email) ?? undefined : undefined;
  const upn = cleanDirectoryValue(raw.upn, true);
  const name = cleanAclLabel(raw.name);
  const groups = Array.isArray(raw.groups)
    ? [...new Set(raw.groups.map((g) => cleanDirectoryValue(g, false)).filter((g): g is string => Boolean(g)))].slice(0, MAX_DIRECTORY_GROUPS_PER_USER)
    : undefined;
  let attrs: Record<string, string> | undefined;
  if (raw.attrs && typeof raw.attrs === 'object') {
    attrs = {};
    for (const [key, value] of Object.entries(raw.attrs).slice(0, MAX_DIRECTORY_ATTRS)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
      const clean = cleanDirectoryValue(value, true);
      if (clean) attrs[key] = clean;
    }
    if (Object.keys(attrs).length === 0) attrs = undefined;
  }
  return {
    tenantId,
    extId,
    ...(email ? { email } : {}),
    ...(upn ? { upn } : {}),
    ...(name ? { name } : {}),
    ...(raw.type === 'guest' ? { type: 'guest' as const } : { type: 'member' as const }),
    ...(groups && groups.length > 0 ? { groups } : {}),
    ...(attrs ? { attrs } : {}),
    syncRunId: runId,
    syncedAt: new Date(),
  };
}

/**
 * Store a directory snapshot pushed by an integration. Users are upserted by
 * their directory id; with `prune` the users this run did not report are
 * removed (only pass it after a COMPLETE listing).
 */
export async function syncRagIdentityUsers(
  tenantDbName: string,
  tenantId: string,
  input: { domain: string; users: Array<Partial<IRagIdentityUser> & { extId: string }>; runId: string; prune?: boolean },
): Promise<{ upserted: number; skipped: number; pruned: number }> {
  const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
  if (!runId) throw new RagAccessError('domain_invalid', 'runId is required');
  return runWithTenantScope(tenantDbName, async (db) => {
    const domain = await db.findRagIdentityDomain(input.domain);
    if (!domain) throw new RagAccessError('domain_not_found', 'Directory not found');
    const clean: Array<Omit<IRagIdentityUser, '_id' | 'domain'>> = [];
    let skipped = 0;
    for (const raw of Array.isArray(input.users) ? input.users : []) {
      const user = normalizeDirectoryUser(raw, tenantId, runId);
      if (user) clean.push(user); else skipped += 1;
    }
    let upserted = 0;
    for (let i = 0; i < clean.length; i += DIRECTORY_UPSERT_BATCH) {
      upserted += await db.upsertRagIdentityUsers(domain.key, clean.slice(i, i + DIRECTORY_UPSERT_BATCH));
    }
    const pruned = input.prune === true ? await db.pruneRagIdentityUsers(domain.key, runId) : 0;
    invalidateRagIdentityCache(tenantDbName);
    return { upserted, skipped, pruned };
  });
}

// ── documents: placement on ingest, teardown ────────────────────────────

/** Check a folder of `ragModule` exists (ingest with `folderId`). */
export async function assertRagFolderInModule(db: Db, ragModule: IRagModule, folderId: string): Promise<string> {
  return String((await requireFolder(db, ragModule, folderId))._id);
}

/**
 * A folder is not an existing folder to a caller who cannot read it: the answer for a path that names a missing folder
 * and for one that names a folder the caller cannot read is this one error.
 */
function folderNotFound(): RagAccessError {
  return new RagAccessError('folder_not_found', 'Folder not found');
}

/** The readable folder a path names, for a caller who may not create folders. Nothing is written. */
async function readableFolderByPath(db: Db, ragModule: IRagModule, names: string[], scope: RagAccessScope | undefined): Promise<string> {
  const tree = treeOf(await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId }));
  let folderId: string | undefined;
  for (const name of names) {
    const lower = name.toLowerCase();
    const next = [...tree.values()].find((n) => (n.parentId ?? '') === (folderId ?? '') && n.folder.name.toLowerCase() === lower);
    if (!next) throw folderNotFound();
    folderId = next.id;
  }
  if (!folderId || !scope?.canReadFolder(folderId)) throw folderNotFound();
  return folderId;
}

/**
 * The folder a `/`-separated path names. Callers who manage the module (or whose module has no access control) get the
 * folders it lacks created (manual folders only); anyone else only finds a folder they can read.
 */
export async function ensureRagFolderByPath(
  ctx: RagAccessContext,
  input: { ragModuleKey: string; path: string; scope?: RagAccessScope; admin?: boolean },
): Promise<string | undefined> {
  const segments = String(input.path ?? '').split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return undefined;
  if (segments.length > MAX_FOLDER_DEPTH) throw new RagAccessError('folder_too_deep', `Folders nest at most ${MAX_FOLDER_DEPTH} levels`);
  const names = segments.map(validateFolderName);
  return inTenant(ctx, async (db) => {
    const ragModule = await requireModule(db, ctx, input.ragModuleKey);
    if (!mayChangeStructure(ragModule, input.scope, input.admin)) return readableFolderByPath(db, ragModule, names, input.scope);
    return serializeStructureWrite(ctx, ragModule, async () => {
      const folders = await db.listRagFolders(ragModule.key, { projectId: ragModule.projectId });
      const tree = treeOf(folders);
      let parentId: string | undefined;
      let changed = false;
      for (const name of names) {
        const lower = name.toLowerCase();
        const existing = [...tree.values()].find((n) => (n.parentId ?? '') === (parentId ?? '') && n.folder.name.toLowerCase() === lower);
        if (existing) {
          parentId = existing.id;
          continue;
        }
        const ancestors = parentId ? [...(ancestorsOf(tree, parentId) ?? []), parentId] : [];
        const created = await db.createRagFolder({
          tenantId: ctx.tenantId,
          ...(ragModule.projectId ? { projectId: ragModule.projectId } : {}),
          ragModuleKey: ragModule.key,
          ...(parentId ? { parentId } : {}),
          name,
          ...(ancestors.length > 0 ? { ancestorIds: ancestors } : {}),
          createdBy: ctx.actor,
        });
        const id = String(created._id);
        tree.set(id, { folder: created, id, ...(parentId ? { parentId } : {}) });
        parentId = id;
        changed = true;
      }
      if (changed) await treeChanged(db, ctx, ragModule);
      return parentId;
    });
  });
}

/** Placement and permissions an ingest asks for, as the caller sent them. */
export interface RagDocumentPlacementInput {
  /** A folder of the module; `null` = the top level. */
  folderId?: string | null;
  /** A `/`-separated folder path, created as needed (ignored when `folderId` is given). */
  folderPath?: string;
  acl?: unknown;
  /** An integration's sync owns the document's folder and permissions. */
  aclManaged?: RagAclManagedBy;
  /**
   * The caller's access scope. With access control on, a caller who is not a manager places new documents only in
   * folders they can read, creates no folder and moves no existing document. No scope: an internal caller.
   */
  scope?: RagAccessScope;
  /**
   * The route found the caller allowed Knowledge Engine admin. An API token never holds `scope.manage`, so this is how
   * one that passed the admin check counts as a manager for folders.
   */
  admin?: boolean;
}

/** Validated placement, ready to write once the document row exists. */
export interface PreparedRagPlacement {
  /** undefined = leave as is; null = top level. */
  folderId?: string | null;
  acl?: { mode: 'own' | 'inherit'; entries: Array<{ principal: string; label?: string }> };
  aclManaged?: RagAclManagedBy;
  /**
   * The caller's authority, recorded when the placement was prepared: whether they may change the folder of a document
   * that already exists (a manager, an internal caller, an admin token, anyone in a module without access control).
   * Absent means no, so a placement made any other way moves nothing.
   */
  mayMove?: boolean;
}

/** Whether an ingest asked for any placement at all. */
export function hasRagPlacement(input: RagDocumentPlacementInput | undefined): boolean {
  return Boolean(input) && (input!.folderId !== undefined || Boolean(input!.folderPath) || input!.acl !== undefined || input!.aclManaged !== undefined);
}

/**
 * Check an ingest's placement BEFORE anything is stored: the folder exists in
 * the module (a manager's path is created; anyone else's must name a folder
 * they can read), the entries are valid and name existing users, groups,
 * tokens and directories.
 */
export async function prepareRagDocumentPlacement(
  db: Db,
  ctx: RagAccessContext,
  ragModule: IRagModule,
  input: RagDocumentPlacementInput,
  scope?: RagAccessScope,
): Promise<PreparedRagPlacement> {
  const caller = scope ?? input.scope;
  const manages = mayChangeStructure(ragModule, caller, input.admin);
  const prepared: PreparedRagPlacement = { mayMove: manages };
  // The entries first: a path's missing folders are created on the way, and a refused request leaves none behind.
  if (input.acl !== undefined && input.acl !== null) {
    if (typeof input.acl !== 'object') throw new RagAccessError('node_invalid', 'acl must be an object');
    const mode = (input.acl as { mode?: unknown }).mode;
    if (mode !== 'own' && mode !== 'inherit') throw new RagAccessError('node_invalid', 'acl.mode must be "own" or "inherit"');
    const entries = mode === 'own' ? normalizeAclEntries((input.acl as { entries?: unknown }).entries) : [];
    await assertPrincipalsExist(db, ctx, entries, { externalOnly: input.aclManaged === 'sync' });
    prepared.acl = { mode, entries };
  }
  if (input.folderId !== undefined) {
    prepared.folderId = input.folderId ? await assertRagFolderInModule(db, ragModule, input.folderId) : null;
    // A folder the caller cannot read is a folder that does not exist: a new document would join its readers' corpus.
    if (prepared.folderId && !manages && !caller?.canReadFolder(prepared.folderId)) throw folderNotFound();
  } else if (input.folderPath) {
    prepared.folderId = (await ensureRagFolderByPath(ctx, {
      ragModuleKey: ragModule.key,
      path: input.folderPath,
      scope: caller,
      admin: input.admin,
    })) ?? null;
  }
  if (input.aclManaged) prepared.aclManaged = input.aclManaged;
  return prepared;
}

/** The fields a NEW document row starts with (an own ACL starts closed: nobody reads until its entries exist). */
export function ragPlacementRowFields(prepared: PreparedRagPlacement): Pick<IRagDocument, 'folderId' | 'aclMode' | 'aclManaged'> {
  return {
    ...(prepared.folderId ? { folderId: prepared.folderId } : {}),
    ...(prepared.acl?.mode === 'own' ? { aclMode: 'own' as const } : {}),
    ...(prepared.aclManaged ? { aclManaged: prepared.aclManaged } : {}),
  };
}

/**
 * Write a prepared placement to a document row: right after the row is created
 * (only the entries are left), or on an existing row (an unchanged re-upload,
 * a re-ingest) — where a row owned by a source refuses changes from anyone else.
 */
export function commitRagDocumentPlacement(
  db: Db,
  ctx: RagAccessContext,
  ragModule: IRagModule,
  doc: IRagDocument,
  prepared: PreparedRagPlacement,
): Promise<void> {
  return serializeStructureWrite(ctx, ragModule, () => commitPlacementLocked(db, ctx, ragModule, doc, prepared));
}

async function commitPlacementLocked(
  db: Db,
  ctx: RagAccessContext,
  ragModule: IRagModule,
  doc: IRagDocument,
  prepared: PreparedRagPlacement,
): Promise<void> {
  const id = String(doc._id);
  const changesPlacement = prepared.folderId !== undefined || prepared.acl !== undefined;
  if (doc.aclManaged === 'sync' && prepared.aclManaged !== 'sync' && changesPlacement) {
    throw new RagAccessError('document_managed_by_source', 'This document mirrors a connected source; its folder and permissions change only there');
  }
  if (prepared.folderId !== undefined) {
    const folderId = prepared.folderId ?? undefined;
    // The folder may have been deleted since the placement was checked (a delete takes this lock too).
    if (folderId) await requireFolder(db, ragModule, folderId);
    // A new row is created in its folder, so only an existing row can differ: that is a move, and moves are for managers.
    if ((doc.folderId ? String(doc.folderId) : undefined) !== folderId) {
      if (ragModule.access?.enabled === true && prepared.mayMove !== true) throw new RagAccessError('access_denied', MOVE_ADMIN_ONLY);
      await db.updateRagDocument(id, { folderId });
    }
  }
  if (prepared.acl) {
    const rows = prepared.acl.entries.map((e) => ({
      tenantId: ctx.tenantId,
      ...(ragModule.projectId ? { projectId: ragModule.projectId } : {}),
      principal: e.principal,
      ...(e.label ? { label: e.label } : {}),
      ...(prepared.aclManaged ? { managed: prepared.aclManaged } : {}),
      createdBy: ctx.actor,
    }));
    if (prepared.acl.mode === 'own') {
      if (doc.aclMode !== 'own' || doc.aclManaged !== prepared.aclManaged) {
        await db.updateRagDocument(id, { aclMode: 'own', aclManaged: prepared.aclManaged });
      }
      await db.replaceRagAclEntries(ragModule.key, { type: 'document', id }, rows, ragModule.projectId);
    } else {
      if (doc.aclMode === 'own' || doc.aclManaged !== prepared.aclManaged) {
        await db.updateRagDocument(id, { aclMode: undefined, aclManaged: prepared.aclManaged });
      }
      await db.replaceRagAclEntries(ragModule.key, { type: 'document', id }, [], ragModule.projectId);
    }
  } else if (prepared.aclManaged && doc.aclManaged !== prepared.aclManaged) {
    await db.updateRagDocument(id, { aclManaged: prepared.aclManaged });
  }
}

/** Remove a document's permission entries (document delete). Best effort: entries of a missing document match nothing. */
export async function deleteRagDocumentAcl(db: Db, ragModule: Pick<IRagModule, 'key' | 'projectId'>, documentId: string): Promise<void> {
  try {
    await db.replaceRagAclEntries(ragModule.key, { type: 'document', id: documentId }, [], ragModule.projectId);
  } catch (error) {
    logger.warn('Could not remove the permissions of a deleted document', {
      ragModuleKey: ragModule.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Remove a module's folders and permission entries (module teardown). */
export async function deleteRagModuleAccessData(
  db: Db,
  tenantDbName: string,
  ragModule: Pick<IRagModule, 'key' | 'projectId'>,
): Promise<void> {
  await db.deleteRagAclEntriesByModuleKey(ragModule.key, ragModule.projectId);
  await db.deleteRagFoldersByModuleKey(ragModule.key, ragModule.projectId);
  invalidateRagAccessTree(tenantDbName, ragModule.key);
}

