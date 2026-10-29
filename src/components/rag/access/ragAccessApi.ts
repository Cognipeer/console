/**
 * The access-control API of a knowledge base as the dashboard calls it: folders
 * and moves, permissions of a node, the views of the Access tab, pickers, and
 * the identity directories (people, groups, manual links).
 *
 * Every failed call throws a `RagApiError` built from the `{ error, code, details }`
 * body, so a screen shows `error.message` and branches on `status` / `code`.
 * POST, PUT and PATCH always send a JSON body: the routes refuse an empty one.
 * Nothing here talks to React.
 */

import { ApiError } from '@/lib/api/client';
import type { IRagIdentityUserMatchRule } from '@/lib/database';
import type { RagPrincipalKind } from '@/lib/services/rag/access/principals';
import type {
  RagAccessAudienceItem,
  RagAccessNodeState,
  RagAccessPrincipalOption,
  RagAccessSummaryView,
  RagConsolePersonOption,
  RagIdentityGroupView,
  RagIdentityLinkView,
  RagIdentityMatchPreview,
  RagIdentityPeoplePage,
} from '@/lib/services/rag/access/viewTypes';

export type * from '@/lib/services/rag/access/viewTypes';
export type { IRagIdentityUserMatchRule, RagPrincipalKind };

/* ── Errors ──────────────────────────────────────────────────────────────── */

export class RagApiError extends ApiError {
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, payload?: unknown) {
    super(message, status, payload);
    this.name = 'RagApiError';
    const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    this.code = typeof body.code === 'string' ? body.code : undefined;
    this.details = body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : undefined;
  }
}

export function isRagApiError(error: unknown): error is RagApiError {
  return error instanceof RagApiError;
}

/** The message to show for a failed call. */
export function ragErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/* ── Views (as they arrive over JSON) ────────────────────────────────────── */

export interface RagFolderSourceView {
  kind: 'connector';
  connectorId: string;
  sourceId: string;
  externalId: string;
}

export interface RagFolderView {
  _id: string;
  parentId?: string;
  name: string;
  /** Ancestor names and its own, joined with "/". */
  path: string;
  aclMode: 'own' | 'inherit';
  aclManaged?: 'sync';
  /** Set when a connected source owns the folder: it changes only there. */
  source?: RagFolderSourceView;
  /** Documents directly in it that the caller can list. */
  documents?: number;
  /** Shown only because a folder below it is readable: its name, never its contents. */
  pathOnly?: true;
  createdAt?: string;
  updatedAt?: string;
}

/** `module` = the knowledge base root (its default access). */
export type RagAclNodeKey = 'module' | `folder:${string}` | `document:${string}`;
export type RagAclNodeType = 'module' | 'folder' | 'document';

export function folderNode(id: string): RagAclNodeKey {
  return `folder:${id}`;
}

export function documentNode(id: string): RagAclNodeKey {
  return `document:${id}`;
}

export interface RagAclEntryView {
  principal: string;
  kind: RagPrincipalKind;
  label?: string;
  managed?: 'sync';
}

export interface RagNodeAclView {
  node: { type: RagAclNodeType; id: string };
  mode: 'own' | 'inherit';
  managed?: 'sync';
  /** Its own list (empty while it inherits). */
  entries: RagAclEntryView[];
  /** What decides who reads it now. `missing` = a broken folder chain, readable by nobody. */
  effective: {
    node: { type: RagAclNodeType | 'missing'; id: string };
    entries: RagAclEntryView[];
    /** The root decides and has no entries: everyone who can open the knowledge base. */
    openToEveryone?: boolean;
  };
}

/** An entry to store; `label` is display only (the server keeps what it is sent). */
export interface RagAclEntryInput {
  principal: string;
  label?: string;
}

export interface RagIdentityMatchView {
  domain: string;
  via: 'rule' | 'link' | 'external_id' | 'group_external_id';
  rule?: IRagIdentityUserMatchRule;
  externalIds: string[];
}

export interface RagAccessExplanation {
  userId: string;
  active: boolean;
  enabled: boolean;
  /** Administers this knowledge base. */
  manage: boolean;
  /** The admin exception applies to them. */
  bypass: boolean;
  /** Identity details: only for workspace-level admins. */
  email?: string;
  groupIds?: string[];
  principals?: string[];
  matches?: RagIdentityMatchView[];
  document?: {
    documentId: string;
    folderId?: string;
    mode: 'own' | 'inherit';
    effectiveNode: { type: RagAclNodeType | 'missing'; id: string };
    readable: boolean;
    grantedBy: string[];
    openToEveryone?: boolean;
  };
}

export interface RagIdentityDomainView {
  key: string;
  kind: 'entra' | 'qdms' | 'generic';
  label: string;
  source?: { kind: 'connector'; connectorId: string };
  /** Stored rules; empty = the defaults. */
  userMatch: IRagIdentityUserMatchRule[];
  matchGroupsByExternalId?: boolean;
  updatedAt?: string;
}

export interface RagIdentityUserView {
  extId: string;
  domain: string;
  email?: string;
  upn?: string;
  name?: string;
  type?: 'member' | 'guest';
  groups?: string[];
}

export interface RagIdentityLinkInput {
  domain: string;
  externalKind: 'user' | 'group';
  externalId: string;
  consoleKind: 'user' | 'group';
  consoleId: string;
}

export interface RagIdentityLinkRow extends RagIdentityLinkInput {
  _id: string;
  createdAt?: string;
}

export interface RagDocumentOption {
  _id: string;
  fileName: string;
  folderId?: string;
}

/* ── Transport ───────────────────────────────────────────────────────────── */

const enc = encodeURIComponent;

function modulePath(key: string, rest = ''): string {
  return `/api/rag/modules/${enc(key)}${rest}`;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function call<T>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, cache: 'no-store', credentials: 'same-origin', signal };
  if (method !== 'GET' && method !== 'DELETE') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(url, init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const message = typeof record.error === 'string' && record.error.trim()
      ? record.error
      : typeof record.message === 'string' && record.message.trim()
        ? record.message
        : response.statusText || `Request failed (${response.status})`;
    throw new RagApiError(message, response.status, payload);
  }
  return payload as T;
}

/* ── Calls ───────────────────────────────────────────────────────────────── */

export const ragAccessApi = {
  /* Folders and moves */

  async folders(key: string, signal?: AbortSignal): Promise<RagFolderView[]> {
    const body = await call<{ folders?: RagFolderView[] }>(modulePath(key, '/folders'), 'GET', undefined, signal);
    return Array.isArray(body?.folders) ? body.folders : [];
  },

  async createFolder(key: string, input: { name: string; parentId: string | null }): Promise<RagFolderView> {
    const body = await call<{ folder: RagFolderView }>(modulePath(key, '/folders'), 'POST', input);
    return body.folder;
  },

  async updateFolder(key: string, folderId: string, input: { name?: string; parentId?: string | null }): Promise<RagFolderView> {
    const body = await call<{ folder: RagFolderView }>(modulePath(key, `/folders/${enc(folderId)}`), 'PATCH', input);
    return body.folder;
  },

  async deleteFolder(key: string, folderId: string): Promise<void> {
    await call(modulePath(key, `/folders/${enc(folderId)}`), 'DELETE');
  },

  /** At most 500 ids per call. */
  async moveDocuments(key: string, documentIds: string[], folderId: string | null): Promise<number> {
    const body = await call<{ moved?: number }>(modulePath(key, '/documents/move'), 'POST', { documentIds, folderId });
    return typeof body?.moved === 'number' ? body.moved : 0;
  },

  async searchDocuments(key: string, search: string, limit = 20, signal?: AbortSignal): Promise<RagDocumentOption[]> {
    const body = await call<{ documents?: RagDocumentOption[] }>(
      modulePath(key, `/documents${query({ search: search.trim(), limit })}`), 'GET', undefined, signal,
    );
    return Array.isArray(body?.documents)
      ? body.documents.map((doc) => ({ _id: doc._id, fileName: doc.fileName, folderId: doc.folderId }))
      : [];
  },

  /* Permissions of a node */

  async getAcl(key: string, node: RagAclNodeKey, signal?: AbortSignal): Promise<RagNodeAclView> {
    const body = await call<{ acl: RagNodeAclView }>(modulePath(key, `/acl${query({ node })}`), 'GET', undefined, signal);
    return body.acl;
  },

  async putAcl(key: string, node: RagAclNodeKey, mode: 'own' | 'inherit', entries: RagAclEntryInput[] = []): Promise<RagNodeAclView> {
    const body = await call<{ acl: RagNodeAclView }>(modulePath(key, '/acl'), 'PUT', {
      node,
      mode,
      entries: mode === 'own' ? entries : [],
    });
    return body.acl;
  },

  async explain(key: string, userId: string, documentId?: string, signal?: AbortSignal): Promise<RagAccessExplanation> {
    const body = await call<{ explanation: RagAccessExplanation }>(
      modulePath(key, `/access/explain${query({ userId, documentId })}`), 'GET', undefined, signal,
    );
    return body.explanation;
  },

  /** Switches enforcement and the admin exception (`null` removes the setting: off). Returns the module row. */
  async setAccess(key: string, access: { enabled: boolean; adminBypass?: boolean } | null): Promise<unknown> {
    const body = await call<{ module?: unknown }>(modulePath(key), 'PATCH', { access });
    return body?.module;
  },

  /* Views of the Access tab */

  async summary(key: string, signal?: AbortSignal): Promise<RagAccessSummaryView> {
    const body = await call<{ summary: RagAccessSummaryView }>(modulePath(key, '/access/summary'), 'GET', undefined, signal);
    return body.summary;
  },

  /** Permission states of listed rows, keyed `folder:<id>` / `document:<id>`. At most 500 ids of each kind. */
  async nodes(
    key: string,
    ids: { folderIds?: string[]; documentIds?: string[] },
    signal?: AbortSignal,
  ): Promise<Record<string, RagAccessNodeState>> {
    const body = await call<{ nodes?: Record<string, RagAccessNodeState> }>(
      modulePath(key, '/access/nodes'), 'POST', { folderIds: ids.folderIds ?? [], documentIds: ids.documentIds ?? [] }, signal,
    );
    return body?.nodes ?? {};
  },

  /** Who each key stands for. At most 1000 keys; invalid ones are left out. */
  async audience(key: string, principals: string[], signal?: AbortSignal): Promise<Record<string, RagAccessAudienceItem>> {
    if (principals.length === 0) return {};
    const body = await call<{ audience?: Record<string, RagAccessAudienceItem> }>(
      modulePath(key, '/access/audience'), 'POST', { principals }, signal,
    );
    return body?.audience ?? {};
  },

  /** People (who can open the knowledge base's project), groups or API tokens to add to a list. */
  async principals(
    key: string,
    type: 'user' | 'group' | 'token',
    q: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<RagAccessPrincipalOption[]> {
    const body = await call<{ items?: RagAccessPrincipalOption[] }>(
      modulePath(key, `/access/principals${query({ type, q: q.trim(), limit })}`), 'GET', undefined, signal,
    );
    return Array.isArray(body?.items) ? body.items : [];
  },

  /* Identity directories (workspace-level Knowledge Engine admins) */

  async identityDomains(signal?: AbortSignal): Promise<RagIdentityDomainView[]> {
    const body = await call<{ domains?: RagIdentityDomainView[] }>('/api/rag/identity/domains', 'GET', undefined, signal);
    return Array.isArray(body?.domains) ? body.domains : [];
  },

  async consolePeople(type: 'user' | 'group', q: string, limit = 20, signal?: AbortSignal): Promise<RagConsolePersonOption[]> {
    const body = await call<{ items?: RagConsolePersonOption[] }>(
      `/api/rag/identity/console-people${query({ type, q: q.trim(), limit })}`, 'GET', undefined, signal,
    );
    return Array.isArray(body?.items) ? body.items : [];
  },

  async directoryPeople(
    domain: string,
    options: { search?: string; filter?: 'all' | 'matched' | 'unmatched'; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<RagIdentityPeoplePage> {
    return call<RagIdentityPeoplePage>(
      `/api/rag/identity/domains/${enc(domain)}/people${query({
        search: options.search?.trim(),
        filter: options.filter && options.filter !== 'all' ? options.filter : undefined,
        limit: options.limit,
        offset: options.offset,
      })}`,
      'GET',
      undefined,
      signal,
    );
  },

  /** How many directory users unsaved rules would match. `[]` = the defaults. */
  async previewMatch(
    domain: string,
    input: { userMatch: IRagIdentityUserMatchRule[]; matchGroupsByExternalId?: boolean },
    signal?: AbortSignal,
  ): Promise<RagIdentityMatchPreview> {
    const body = await call<{ preview: RagIdentityMatchPreview }>(
      `/api/rag/identity/domains/${enc(domain)}/preview`, 'POST', input, signal,
    );
    return body.preview;
  },

  async directoryGroups(
    domain: string,
    options: { search?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ groups: RagIdentityGroupView[]; total: number }> {
    const body = await call<{ groups?: RagIdentityGroupView[]; total?: number }>(
      `/api/rag/identity/domains/${enc(domain)}/groups${query({
        search: options.search?.trim(),
        limit: options.limit,
        offset: options.offset,
      })}`,
      'GET',
      undefined,
      signal,
    );
    return { groups: Array.isArray(body?.groups) ? body.groups : [], total: typeof body?.total === 'number' ? body.total : 0 };
  },

  async directoryLinks(domain: string, signal?: AbortSignal): Promise<RagIdentityLinkView[]> {
    const body = await call<{ links?: RagIdentityLinkView[] }>(
      `/api/rag/identity/domains/${enc(domain)}/links`, 'GET', undefined, signal,
    );
    return Array.isArray(body?.links) ? body.links : [];
  },

  /** Directory users, for pickers. */
  async directoryUsers(
    domain: string,
    options: { search?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ users: RagIdentityUserView[]; total: number }> {
    const body = await call<{ users?: RagIdentityUserView[]; total?: number }>(
      `/api/rag/identity/domains/${enc(domain)}/users${query({
        search: options.search?.trim(),
        limit: options.limit,
        offset: options.offset,
      })}`,
      'GET',
      undefined,
      signal,
    );
    return { users: Array.isArray(body?.users) ? body.users : [], total: typeof body?.total === 'number' ? body.total : 0 };
  },

  async createLink(input: RagIdentityLinkInput): Promise<RagIdentityLinkRow> {
    const body = await call<{ link: RagIdentityLinkRow }>('/api/rag/identity/links', 'POST', input);
    return body.link;
  },

  async deleteLink(linkId: string): Promise<void> {
    await call(`/api/rag/identity/links/${enc(linkId)}`, 'DELETE');
  },
};

export type RagAccessApi = typeof ragAccessApi;
