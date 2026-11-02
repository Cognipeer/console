/**
 * Fake data and a fetch mock for the Documents tab library tests: a small knowledge base "kb" with folders (one
 * a connector owns), documents in them, the permission states of the rows and the routes the page reads.
 * Fake names only.
 */

import type { RagAccessNodeState, RagFolderView } from '@/components/rag/access/ragAccessApi';
import { installApiMock, jsonResponse, type ApiMock, type RecordedCall } from './iamCenterUi';

export interface FixtureDoc {
  _id: string;
  ragModuleKey: string;
  fileName: string;
  status: string;
  fileKey?: string;
  chunkCount?: number;
  folderId?: string;
  aclMode?: 'own';
  aclManaged?: 'sync';
  createdAt?: string;
  lastIndexedAt?: string;
  extraction?: Record<string, unknown>;
}

export function folder(over: Partial<RagFolderView> & { _id: string; name: string }): RagFolderView {
  return {
    path: over.name,
    aclMode: 'inherit',
    documents: 0,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...over,
  };
}

export function doc(over: Partial<FixtureDoc> & { _id: string; fileName: string }): FixtureDoc {
  return {
    ragModuleKey: 'kb',
    status: 'indexed',
    chunkCount: 4,
    createdAt: '2026-10-02T10:00:00.000Z',
    lastIndexedAt: '2026-10-02T10:05:00.000Z',
    ...over,
  };
}

export const POLICIES = folder({ _id: 'f-policies', name: 'Policies', path: 'Policies', aclMode: 'own', documents: 2 });
export const LEAVE = folder({ _id: 'f-leave', name: 'Leave', parentId: 'f-policies', path: 'Policies/Leave', documents: 1 });
export const ONBOARDING = folder({ _id: 'f-onboarding', name: 'Onboarding', path: 'Onboarding', documents: 9 });
export const ARCHIVE = folder({ _id: 'f-archive', name: 'Archive', path: 'Archive', documents: 0 });
export const SITE = folder({
  _id: 'f-site',
  name: 'HR Site',
  path: 'HR Site',
  aclMode: 'own',
  aclManaged: 'sync',
  documents: 23,
  source: { kind: 'connector', connectorId: 'conn-1', sourceId: 'src-1', externalId: 'site-ext' },
});
export const ALL_FOLDERS: RagFolderView[] = [POLICIES, LEAVE, ONBOARDING, ARCHIVE, SITE];

export const HANDBOOK = doc({ _id: 'd-handbook', fileName: 'employee-handbook-2026.pdf', chunkCount: 64 });
export const SALARY = doc({ _id: 'd-salary', fileName: 'salary-bands-2026.xlsx', aclMode: 'own', chunkCount: 5, fileKey: 'files/salary.xlsx' });
export const HOLIDAY = doc({ _id: 'd-holiday', fileName: 'holiday-calendar-2026.xlsx', aclMode: 'own', chunkCount: 3 });
export const SITE_DOC = doc({ _id: 'd-site', fileName: 'site-handbook.docx', folderId: 'f-site', aclMode: 'own', aclManaged: 'sync', chunkCount: 12 });
export const LEAVE_DOC = doc({ _id: 'd-leave', fileName: 'parental-leave.docx', folderId: 'f-leave' });

/** What `POST /access/nodes` answers for the rows above. */
export const NODE_STATES: Record<string, RagAccessNodeState> = {
  'folder:f-policies': { mode: 'own', entries: 3 },
  'folder:f-onboarding': { mode: 'inherit', entries: 0 },
  'folder:f-archive': { mode: 'inherit', entries: 0 },
  'folder:f-site': { mode: 'own', managed: 'sync', entries: 5 },
  'document:d-handbook': { mode: 'inherit', entries: 0 },
  'document:d-salary': { mode: 'own', entries: 1 },
  'document:d-holiday': { mode: 'own', entries: 0 },
  'document:d-site': { mode: 'own', managed: 'sync', entries: 0 },
};

export function moduleView(over: Record<string, unknown> = {}) {
  return {
    _id: 'm1',
    key: 'kb',
    name: 'HR Policies',
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vp',
    vectorIndexKey: 'idx',
    chunkConfig: { strategy: 'recursive_character', chunkSize: 1000, chunkOverlap: 100 },
    status: 'active',
    totalDocuments: 4,
    totalChunks: 90,
    ...over,
  };
}

export interface KbApiOptions {
  /** The caller's level in `/api/auth/session`; undefined = the route is not mocked (the level stays unknown). */
  level?: 'read' | 'write' | 'admin';
  module?: Record<string, unknown>;
  /** The folder list; `null` = the route answers 404 (a server without folders). */
  folders?: RagFolderView[] | null;
  /** Documents by listing place: `root`, a folder id, or `search`. */
  documents?: Record<string, FixtureDoc[]>;
  nodes?: Record<string, RagAccessNodeState>;
}

/** Installs the routes the page and the library read, plus accepting answers for every change they make. */
export function installKbApi(options: KbApiOptions = {}): ApiMock {
  const folders = options.folders === undefined ? ALL_FOLDERS : options.folders;
  const documents = options.documents ?? { root: [HANDBOOK, SALARY, HOLIDAY], 'f-site': [SITE_DOC], 'f-policies': [], 'f-leave': [LEAVE_DOC], search: [SALARY, LEAVE_DOC] };
  const nodes = options.nodes ?? NODE_STATES;

  const listing = (call: RecordedCall) => {
    const place = call.query.search ? 'search' : (call.query.folderId ?? 'root');
    const rows = documents[place] ?? [];
    return { documents: rows, total: rows.length, limit: Number(call.query.limit ?? 25), offset: Number(call.query.offset ?? 0) };
  };

  return installApiMock([
    ...(options.level ? ([['GET', '/api/auth/session', () => ({ effectivePermissions: { rag: options.level } })]] as Array<[string, string, () => unknown]>) : []),
    ['GET', '/api/rag/modules/kb', () => ({ module: moduleView(options.module) })],
    ['GET', '/api/rag/modules/kb/documents', listing],
    ['GET', '/api/rag/modules/kb/folders', () => (folders === null ? jsonResponse({ error: 'not found' }, 404) : { folders })],
    ['POST', '/api/rag/modules/kb/access/nodes', () => ({ nodes })],
    ['GET', /^\/api\/rag\/modules\/kb\/(usage|score-distribution|queries)/, () => ({ logs: [], buckets: [], queries: [] })],
    ['POST', '/api/rag/modules/kb/folders', (call) => jsonResponse({ folder: folder({ _id: 'f-new', name: String((call.body as { name?: string }).name) }) }, 201)],
    ['PATCH', /^\/api\/rag\/modules\/kb\/folders\/[^/]+$/, (call) => ({ folder: folder({ _id: call.path.split('/').pop()!, name: String((call.body as { name?: string }).name ?? 'moved') }) })],
    ['DELETE', /^\/api\/rag\/modules\/kb\/folders\/[^/]+$/, () => ({ success: true })],
    ['POST', '/api/rag/modules/kb/documents/move', (call) => ({ moved: (call.body as { documentIds: string[] }).documentIds.length })],
    ['POST', '/api/rag/modules/kb/documents', () => jsonResponse({ document: HANDBOOK }, 201)],
  ]);
}
