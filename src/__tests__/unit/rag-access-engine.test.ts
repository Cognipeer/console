/**
 * The pure parts of Knowledge Engine access control: principal keys, who a
 * caller is, the folder-inheritance rules, how a search is planned from the
 * readable / total document counts, and the per-match checks of a search.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IRagChunk, IRagDocument, RagDocumentAccessFilter } from '@/lib/database';
import type { VectorQueryMatch } from '@/lib/providers';
import { VectorFilterError } from '@/lib/providers/domains/vectorFilter';
import {
  anonymousKbCaller,
  describeKbCaller,
  kbCallerFromApiToken,
  kbCallerFromIdentity,
  kbCallerFromRuntime,
  kbCallerFromSession,
} from '@/lib/services/rag/access/caller';
import {
  cleanAclLabel,
  isValidIdentityDomainKey,
  MAX_PRINCIPAL_LENGTH,
  normalizePrincipal,
  parsePrincipal,
} from '@/lib/services/rag/access/principals';
import { computeReadableFolders, effectiveAclNodeOf, type RagAccessScope } from '@/lib/services/rag/access/scope';
import {
  aclIdListMax,
  aclPostFetchMax,
  aclVectorFilter,
  aclWidening,
  isAclFilterRefusal,
  isAclPushdownBroken,
  isRawFilterConflict,
  markAclPushdownBroken,
  planRagAclQuery,
  ragDocumentProjectScope,
} from '@/lib/services/rag/access/vectorPlan';
import { runRagAclSearch, vectorDocumentId, type RagAclSearchInput } from '@/lib/services/rag/ragAclSearch';

afterEach(() => {
  vi.useRealTimers();
});

describe('principal keys', () => {
  it('accepts exactly the documented shapes and canonicalises e-mail', () => {
    expect(normalizePrincipal('everyone')).toBe('everyone');
    expect(normalizePrincipal('user:u1')).toBe('user:u1');
    expect(normalizePrincipal('group:g1')).toBe('group:g1');
    expect(normalizePrincipal('token:t1')).toBe('token:t1');
    expect(normalizePrincipal('email:Ada.Lovelace@Example.COM')).toBe('email:ada.lovelace@example.com');
    expect(normalizePrincipal('x:contoso:u:00000000-aaaa')).toBe('x:contoso:u:00000000-aaaa');
    expect(normalizePrincipal('x:contoso:g:finance:emea')).toBe('x:contoso:g:finance:emea');
    expect(normalizePrincipal('x:contoso:all')).toBe('x:contoso:all');
  });

  it('refuses anything else', () => {
    for (const bad of [
      '', 'Everyone', 'user:', 'user: u1', 'role:admin', 'email:not-an-address', 'x:Contoso:u:1', 'x:contoso:z:1',
      'x::u:1', 'x:contoso', 'x:contoso:u:', 42, null, undefined, { principal: 'user:u1' },
      `user:${'a'.repeat(MAX_PRINCIPAL_LENGTH)}`,
    ]) {
      expect(normalizePrincipal(bad), String(bad)).toBeNull();
    }
  });

  it('parses external keys with the domain they belong to', () => {
    expect(parsePrincipal('x:contoso:g:fin')).toEqual({ kind: 'external_group', domain: 'contoso', id: 'fin' });
    expect(parsePrincipal('x:contoso:all')).toEqual({ kind: 'external_all', domain: 'contoso' });
  });

  it('validates directory keys and trims labels', () => {
    expect(isValidIdentityDomainKey('sharepoint-contoso')).toBe(true);
    expect(isValidIdentityDomainKey('Contoso')).toBe(false);
    expect(isValidIdentityDomainKey('a:b')).toBe(false);
    expect(cleanAclLabel('  Finance\nteam  ')).toBe('Finance team');
    expect(cleanAclLabel('   ')).toBeUndefined();
    expect(cleanAclLabel('x'.repeat(500))).toHaveLength(200);
  });
});

describe('who a caller is', () => {
  it('a dashboard session is the person; a synthetic or missing id is nobody', () => {
    expect(kbCallerFromSession({ userId: 'u1' })).toEqual({ kind: 'person', userId: 'u1' });
    expect(kbCallerFromSession({ userId: 'system' })).toEqual({ kind: 'anonymous', reason: 'unknown' });
    expect(kbCallerFromSession(null)).toEqual({ kind: 'anonymous', reason: 'unknown' });
  });

  it('a token call is the token, a delegated call the person it acts for', () => {
    expect(kbCallerFromApiToken({ tokenRecord: { _id: 't1', userId: 'owner' }, user: { _id: 'owner' } } as never))
      .toEqual({ kind: 'token', tokenId: 't1', ownerUserId: 'owner' });
    expect(kbCallerFromApiToken({
      tokenRecord: { _id: 't1', userId: 'owner' },
      user: { _id: 'person-1' },
      delegation: { state: 'active' },
    } as never)).toEqual({ kind: 'person', userId: 'person-1', tokenId: 't1', delegated: true });
    // Never falls back to the token's owner when a delegation is not active.
    expect(kbCallerFromApiToken({
      tokenRecord: { _id: 't1', userId: 'owner' },
      user: { _id: 'owner' },
      delegation: { state: 'refused' },
    } as never)).toEqual({ kind: 'anonymous', reason: 'unknown' });
  });

  it('a run a trigger started has no person, whoever owns the trigger', () => {
    expect(kbCallerFromRuntime({ userId: 'owner', source: 'trigger' } as never)).toEqual({ kind: 'anonymous', reason: 'trigger' });
    expect(kbCallerFromRuntime({ userId: 'u1' } as never)).toEqual({ kind: 'person', userId: 'u1' });
    expect(kbCallerFromRuntime({ userId: 'u1', tokenId: 't1' } as never)).toEqual({ kind: 'token', tokenId: 't1', ownerUserId: 'u1' });
    expect(kbCallerFromRuntime({ userId: 'u1', tokenId: 't1', via: { kind: 'delegated' } } as never))
      .toEqual({ kind: 'person', userId: 'u1', tokenId: 't1', delegated: true });
    expect(kbCallerFromRuntime(undefined)).toEqual({ kind: 'anonymous', reason: 'unknown' });
  });

  it('an MCP call follows the same rules', () => {
    expect(kbCallerFromIdentity({ userId: 'u1' } as never)).toEqual({ kind: 'person', userId: 'u1' });
    expect(kbCallerFromIdentity({ userId: 'u1', tokenId: 't1' } as never)).toEqual({ kind: 'token', tokenId: 't1', ownerUserId: 'u1' });
    expect(kbCallerFromIdentity({ userId: 'u1', source: 'trigger' } as never)).toEqual({ kind: 'anonymous', reason: 'trigger' });
    expect(kbCallerFromIdentity(null)).toEqual({ kind: 'anonymous', reason: 'unknown' });
  });

  it('describes callers without ids', () => {
    expect(describeKbCaller({ kind: 'person', userId: 'secret-id', delegated: true })).toBe('person(delegated)');
    expect(describeKbCaller(anonymousKbCaller('public'))).toBe('anonymous(public)');
  });
});

describe('folder inheritance', () => {
  // root ─ a (own) ─ a1 ─ a11
  //      └ b ─ b1 (own)
  //      └ orphan (parent missing), loop1 <-> loop2
  const folders = new Map([
    ['a', { own: true }],
    ['a1', { parentId: 'a', own: false }],
    ['a11', { parentId: 'a1', own: false }],
    ['b', { own: false }],
    ['b1', { parentId: 'b', own: true }],
    ['orphan', { parentId: 'gone', own: false }],
    ['loop1', { parentId: 'loop2', own: false }],
    ['loop2', { parentId: 'loop1', own: false }],
  ]);

  it('a folder inherits from its nearest folder with own permissions, else from the root', () => {
    expect([...computeReadableFolders(folders, new Set(['a']), false)].sort()).toEqual(['a', 'a1', 'a11']);
    expect([...computeReadableFolders(folders, new Set(), true)].sort()).toEqual(['b']);
    expect([...computeReadableFolders(folders, new Set(['b1']), true)].sort()).toEqual(['b', 'b1']);
  });

  it('a broken chain (missing parent, loop) is never readable', () => {
    const readable = computeReadableFolders(folders, new Set(['a', 'b1']), true);
    expect(readable.has('orphan')).toBe(false);
    expect(readable.has('loop1')).toBe(false);
    expect(readable.has('loop2')).toBe(false);
  });

  it('names the node whose permissions apply', () => {
    expect(effectiveAclNodeOf(folders, 'kb', 'a11')).toEqual({ type: 'folder', id: 'a' });
    expect(effectiveAclNodeOf(folders, 'kb', 'b')).toEqual({ type: 'module', id: 'kb' });
    expect(effectiveAclNodeOf(folders, 'kb', undefined)).toEqual({ type: 'module', id: 'kb' });
    expect(effectiveAclNodeOf(folders, 'kb', 'orphan').type).toBe('missing');
    expect(effectiveAclNodeOf(folders, 'kb', 'loop1').type).toBe('missing');
  });
});

// ── search planning ────────────────────────────────────────────────────

const FILTER: RagDocumentAccessFilter = { ownAllowedIds: [], inheritFolderIds: ['f1'], includeTopLevel: false };

function planDb(input: { allowed: number; total: number; allowedIds?: string[]; deniedIds?: string[] }) {
  return {
    countRagDocuments: vi.fn(async (_key: string, _projectId?: string, filters?: { access?: RagDocumentAccessFilter }) => (
      filters?.access ? input.allowed : input.total
    )),
    listRagDocumentIds: vi.fn(async (_key: string, options: { projectId?: string; access?: RagDocumentAccessFilter; limit?: number }) => {
      const ids = options.access?.negate ? input.deniedIds ?? [] : input.allowedIds ?? [];
      return ids.slice(0, options.limit);
    }),
  };
}

const plan = (db: ReturnType<typeof planDb>, extra: Partial<Parameters<typeof planRagAclQuery>[1]> = {}) => planRagAclQuery(db as never, {
  moduleKey: 'kb',
  projectScope: { projectId: 'p1' },
  filter: FILTER,
  operators: ['$in', '$nin', '$eq'],
  ...extra,
});

describe('planning a search with access control', () => {
  it('nothing readable: no search at all', async () => {
    expect(await plan(planDb({ allowed: 0, total: 50 }))).toEqual({ mode: 'none', allowed: 0, total: 50 });
  });

  it('everything readable: an unfiltered search', async () => {
    expect((await plan(planDb({ allowed: 50, total: 50 }))).mode).toBe('all');
  });

  it('few readable: the readable ids are pushed to the store', async () => {
    const db = planDb({ allowed: 2, total: 5000, allowedIds: ['d1', 'd2'] });
    const result = await plan(db);
    expect(result).toEqual({ mode: 'in', allowed: 2, total: 5000, ids: ['d1', 'd2'] });
    expect(aclVectorFilter(result)).toEqual({ _documentId: { $in: ['d1', 'd2'] } });
    // One selection: the module's project plus the rows from before documents carried one.
    expect(db.countRagDocuments).toHaveBeenCalledWith('kb', 'p1', { withUnscoped: true, access: FILTER });
    expect(db.countRagDocuments).toHaveBeenCalledWith('kb', 'p1', { withUnscoped: true });
    expect(db.listRagDocumentIds).toHaveBeenCalledWith('kb', { projectId: 'p1', withUnscoped: true, access: FILTER, limit: 1001 });
  });

  it('few unreadable: the unreadable ids are pushed instead', async () => {
    const result = await plan(planDb({ allowed: 4998, total: 5000, deniedIds: ['d9', 'd10'] }));
    expect(result).toEqual({ mode: 'nin', allowed: 4998, total: 5000, ids: ['d9', 'd10'] });
    expect(aclVectorFilter(result)).toEqual({ _documentId: { $nin: ['d9', 'd10'] } });
  });

  it('neither list is short, the store cannot filter ids, or it refused a list recently: post-filtering', async () => {
    expect(await plan(planDb({ allowed: 3000, total: 6000 }))).toEqual({ mode: 'post', allowed: 3000, total: 6000, widen: 4 });
    expect((await plan(planDb({ allowed: 2, total: 5000, allowedIds: ['d1', 'd2'] }), { operators: ['$eq'] })).mode).toBe('post');
    expect((await plan(planDb({ allowed: 2, total: 5000, allowedIds: ['d1', 'd2'] }), { pushdownBroken: true })).mode).toBe('post');
  });

  it('a store with a short filter limit takes shorter lists', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `d${i}`);
    expect((await plan(planDb({ allowed: 300, total: 5000, allowedIds: ids }))).mode).toBe('in');
    expect((await plan(planDb({ allowed: 300, total: 5000, allowedIds: ids }), { driver: 'azure-ai-search' })).mode).toBe('post');
    expect(aclIdListMax('azure-ai-search')).toBe(200);
    expect(aclIdListMax(undefined)).toBe(1000);
  });

  it('a list that grew past the cap between the count and the read falls through', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `d${i}`);
    expect((await plan(planDb({ allowed: 10, total: 5000, allowedIds: ids }))).mode).toBe('post');
  });

  it('a module without a project cannot be counted in one scope: always post-filtered', async () => {
    const db = planDb({ allowed: 1, total: 1 });
    expect(await plan(db, { projectScope: ragDocumentProjectScope({}) })).toEqual({ mode: 'post', allowed: 0, total: 0, widen: 4 });
    expect(db.countRagDocuments).not.toHaveBeenCalled();
    expect(ragDocumentProjectScope({ projectId: 'p1' })).toEqual({ projectId: 'p1' });
  });

  it('widening follows the unreadable share, within 2..20', () => {
    expect(aclWidening(100, 90)).toBe(4);
    expect(aclWidening(100, 1)).toBe(20);
    expect(aclWidening(100, 0)).toBe(20);
    expect(aclWidening(100, 100)).toBe(2);
    expect(aclPostFetchMax('mongodb', true)).toBe(500);
    expect(aclPostFetchMax('mongodb', false)).toBe(1000);
    expect(aclPostFetchMax('pinecone', true)).toBe(1000);
    // S3 Vectors answers at most 100 results in one QueryVectors response, and the client cannot ask for a next page.
    expect(aclPostFetchMax('aws-s3-vectors', false)).toBe(100);
    expect(aclPostFetchMax('system-default', false)).toBe(100);
    expect(aclPostFetchMax('system-default', true)).toBe(100);
  });

  it('remembers for ten minutes that a store refused a pushed-down list', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T10:00:00Z'));
    expect(isAclPushdownBroken('tenant_a', 'atlas')).toBe(false);
    markAclPushdownBroken('tenant_a', 'atlas');
    expect(isAclPushdownBroken('tenant_a', 'atlas')).toBe(true);
    expect(isAclPushdownBroken('tenant_b', 'atlas')).toBe(false);
    vi.setSystemTime(new Date('2026-10-28T10:10:01Z'));
    expect(isAclPushdownBroken('tenant_a', 'atlas')).toBe(false);
  });
});

// ── the search itself ───────────────────────────────────────────────────

function match(id: string, documentId?: string): VectorQueryMatch {
  return { id, score: 0.9, metadata: documentId ? { _documentId: documentId } : {} } as VectorQueryMatch;
}

function doc(id: string, extra: Partial<IRagDocument> = {}): IRagDocument {
  return { _id: id, tenantId: 't', projectId: 'p1', ragModuleKey: 'kb', fileName: `${id}.md`, status: 'indexed', createdBy: 'u', ...extra };
}

function chunk(vectorId: string, documentId: string, extra: Partial<IRagChunk> = {}): IRagChunk {
  return { vectorId, documentId, ragModuleKey: 'kb', content: `text of ${vectorId}`, chunkIndex: 0, tenantId: 't', ...extra } as IRagChunk;
}

/** What Atlas answers when its index does not declare the `_documentId` path as a filter. */
function atlasPathError(): Error {
  return Object.assign(
    new Error("PlanExecutor error during aggregation :: caused by :: Path 'metadata._documentId' needs to be indexed as filter"),
    { name: 'MongoServerError' },
  );
}

function scopeReading(readable: string[], filter: RagDocumentAccessFilter | undefined = FILTER): RagAccessScope {
  const set = new Set(readable);
  return {
    moduleKey: 'kb',
    projectId: 'p1',
    enabled: true,
    manage: false,
    bypass: false,
    enforced: true,
    caller: { kind: 'person', userId: 'u1' },
    principals: new Set(['everyone', 'user:u1']),
    canReadDocument: (d) => d.ragModuleKey === 'kb' && set.has(String(d._id)),
    canReadFolder: () => false,
    canSeeFolder: () => false,
    documentFilter: () => filter,
    managementFilter: () => filter,
    stats: { principals: 2, grantedNodes: 0, folders: 0, readableFolders: 0 },
  };
}

function searchInput(overrides: Partial<RagAclSearchInput> & {
  docs?: IRagDocument[];
  chunks?: IRagChunk[];
  counts?: { allowed: number; total: number; allowedIds?: string[]; deniedIds?: string[] };
}): RagAclSearchInput {
  const counts = planDb(overrides.counts ?? { allowed: 5, total: 10 });
  const docs = overrides.docs ?? [];
  const chunks = overrides.chunks ?? [];
  return {
    db: {
      ...counts,
      findRagDocumentsByIds: vi.fn(async (ids: string[]) => docs.filter((d) => ids.includes(String(d._id)))),
      findRagChunksByVectorIds: vi.fn(async (ids: string[]) => chunks.filter((c) => ids.includes(c.vectorId))),
    } as never,
    scope: scopeReading(['d1', 'd2']),
    moduleKey: 'kb',
    moduleProjectId: 'p1',
    operators: ['$in', '$nin'],
    pushdownBroken: false,
    fetchTopK: 4,
    topK: 4,
    hybrid: false,
    search: vi.fn(async () => ({ matches: [] })),
    ...overrides,
  };
}

describe('the search of a knowledge base with access control', () => {
  it('reads the document id from the vector metadata, else from the vector id', () => {
    expect(vectorDocumentId(match('kb:d1:0', 'd7'), 'kb')).toBe('d7');
    expect(vectorDocumentId(match('kb:d1:12'), 'kb')).toBe('d1');
    expect(vectorDocumentId(match('kb:with:colon:3'), 'kb')).toBe('with:colon');
    expect(vectorDocumentId(match('other:d1:0'), 'kb')).toBeUndefined();
    expect(vectorDocumentId(match('kb:d1:x'), 'kb')).toBeUndefined();
  });

  it('nothing readable: an empty result without asking the store', async () => {
    const input = searchInput({ counts: { allowed: 0, total: 10 } });
    const result = await runRagAclSearch(input);
    expect(result.matches).toEqual([]);
    expect(result.stats).toMatchObject({ mode: 'none', total: 10 });
    expect(input.search).not.toHaveBeenCalled();
  });

  it('pushes a short readable list to the store', async () => {
    const input = searchInput({
      counts: { allowed: 2, total: 10, allowedIds: ['d1', 'd2'] },
      docs: [doc('d1'), doc('d2')],
      chunks: [chunk('kb:d1:0', 'd1'), chunk('kb:d2:0', 'd2')],
      search: vi.fn(async () => ({ matches: [match('kb:d1:0', 'd1'), match('kb:d2:0', 'd2')] })),
    });
    const result = await runRagAclSearch(input);
    expect(input.search).toHaveBeenCalledWith(4, { _documentId: { $in: ['d1', 'd2'] } });
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:0', 'kb:d2:0']);
    expect(result.chunks.get('kb:d1:0')?.content).toBe('text of kb:d1:0');
    expect(result.stats).toMatchObject({ mode: 'in', dropped: 0, retried: false });
  });

  it('drops every candidate the database does not confirm', async () => {
    const input = searchInput({
      counts: { allowed: 5000, total: 9000 },
      docs: [
        doc('d1'),
        doc('d2'),
        doc('d3'), // not readable
        doc('d4', { ragModuleKey: 'other' }),
        doc('d5', { projectId: 'p2' }),
      ],
      chunks: [
        chunk('kb:d1:0', 'd1'),
        chunk('kb:d2:0', 'd3'), // metadata says d2, the stored chunk belongs to d3
        chunk('kb:d3:0', 'd3'),
      ],
      scope: scopeReading(['d1', 'd2', 'd4', 'd5']),
      search: vi.fn(async () => ({
        matches: [
          match('kb:d1:0', 'd1'),
          match('kb:d2:0', 'd2'),
          match('kb:d3:0', 'd3'),
          match('kb:d4:0', 'd4'),
          match('kb:d5:0', 'd5'),
          match('no-document-id'),
          match('kb:d1:9', 'd1'), // no stored chunk
        ],
      })),
    });
    const result = await runRagAclSearch(input);
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:0']);
    expect([...result.chunks.keys()]).toEqual(['kb:d1:0']);
    expect(result.stats.mode).toBe('post');
    // Only readable candidates' text is read.
    expect(vi.mocked(input.db.findRagChunksByVectorIds).mock.calls[0][0]).toEqual(['kb:d1:0', 'kb:d2:0', 'kb:d1:9']);
  });

  it('a refused pushed-down list falls back to post-filtering and is reported', async () => {
    const refused = vi.fn();
    const search = vi.fn(async (_n: number, aclFilter?: Record<string, unknown>) => {
      if (aclFilter) throw atlasPathError();
      return { matches: [match('kb:d1:0', 'd1')] };
    });
    const input = searchInput({
      counts: { allowed: 2, total: 10, allowedIds: ['d1', 'd2'] },
      docs: [doc('d1')],
      chunks: [chunk('kb:d1:0', 'd1')],
      search,
      onPushdownRefused: refused,
    });
    const result = await runRagAclSearch(input);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(result.stats).toMatchObject({ mode: 'post', fellBack: true });
    expect(search).toHaveBeenLastCalledWith(4 * aclWidening(10, 2));
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:0']);
  });

  it('an aborted search is not mistaken for a refused list', async () => {
    const controller = new AbortController();
    controller.abort();
    const refused = vi.fn();
    const input = searchInput({
      counts: { allowed: 2, total: 10, allowedIds: ['d1', 'd2'] },
      search: vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }),
      onPushdownRefused: refused,
      signal: controller.signal,
    });
    await expect(runRagAclSearch(input)).rejects.toThrow('aborted');
    expect(refused).not.toHaveBeenCalled();
  });

  it('post-filtering retries once, wider, when too few survive and the store had more', async () => {
    const search = vi.fn(async (n: number) => ({
      matches: Array.from({ length: n }, (_, i) => match(`kb:d${i < n - 1 ? 3 : 1}:${i}`, i < n - 1 ? 'd3' : 'd1')),
    }));
    const input = searchInput({
      counts: { allowed: 3000, total: 6000 },
      docs: [doc('d1'), doc('d3')],
      chunks: [chunk('kb:d1:15', 'd1'), chunk('kb:d1:63', 'd1')],
      search,
    });
    const result = await runRagAclSearch(input);
    expect(search.mock.calls.map((c) => c[0])).toEqual([16, 64]);
    expect(result.stats).toMatchObject({ mode: 'post', retried: true });
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:63']);
  });

  it('never hands on more candidates than an unfiltered search would', async () => {
    const ids = ['d1', 'd2'];
    const matches = Array.from({ length: 10 }, (_, i) => match(`kb:${ids[i % 2]}:${i}`, ids[i % 2]));
    const input = searchInput({
      counts: { allowed: 10, total: 10 },
      docs: [doc('d1'), doc('d2')],
      chunks: matches.map((m) => chunk(m.id, String(m.metadata?._documentId))),
      search: vi.fn(async () => ({ matches })),
      fetchTopK: 3,
      topK: 3,
    });
    const result = await runRagAclSearch(input);
    expect(result.stats.mode).toBe('all');
    expect(result.matches).toHaveLength(3);
    expect(result.chunks.size).toBe(3);
  });
});

// ── which failures blame the pushed-down list ───────────────────────────

describe('which search errors say the filter was refused', () => {
  it('a refused filter is recognised however the store reports it', () => {
    // the filter layer and the drivers
    expect(isAclFilterRefusal(new VectorFilterError('The "chroma" vector provider does not support $nin.'))).toBe(true);
    // an HTTP store rejecting the request
    expect(isAclFilterRefusal(Object.assign(new Error('ValidationException: bad filter'), { $metadata: { httpStatusCode: 400 } }))).toBe(true);
    expect(isAclFilterRefusal(Object.assign(new Error('unprocessable'), { statusCode: 422 }))).toBe(true);
    expect(isAclFilterRefusal(Object.assign(new Error('too large'), { status: 413 }))).toBe(true);
    // Atlas: a path its index does not declare
    expect(isAclFilterRefusal(atlasPathError())).toBe(true);
    expect(isAclFilterRefusal(Object.assign(new Error("Path 'x' needs to be indexed as token"), { name: 'MongoServerError' }))).toBe(true);
    // elasticsearch-cloud keeps the status only in the message of the error it rethrows
    expect(isAclFilterRefusal(new Error('Elasticsearch error (HTTP 400): failed to create query: The number of terms [600] used in the Terms Query request has exceeded the allowed maximum of [500].'))).toBe(true);
    expect(isAclFilterRefusal(new Error('Elasticsearch HTTP 413: {"error":"too large"}'))).toBe(true);
  });

  it('a store that is unwell, a cancelled call and plain faults are not a refused filter', () => {
    const notRefusals: unknown[] = [
      Object.assign(new Error('Request to "vector-query:atlas" timed out after 30000ms'), { name: 'RequestTimeoutError' }),
      Object.assign(new Error('Circuit breaker is open for "vector-query:atlas" — request rejected'), { name: 'CircuitOpenError' }),
      Object.assign(new Error('slow down'), { status: 429 }),
      Object.assign(new Error('unavailable'), { statusCode: 503 }),
      Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } }),
      Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
      new Error('Elasticsearch error (HTTP 503): no shard available'),
      new Error('Elasticsearch error (HTTP unknown): circuit_breaking_exception'),
      new Error('Upstream said: Elasticsearch error (HTTP 400): not from the store client'),
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      // a server error of Atlas that has nothing to do with an undeclared path
      Object.assign(new Error('Authentication failed.'), { name: 'MongoServerError' }),
      // the same words from a class that is not Atlas's
      new Error('Path x needs to be indexed'),
      new Error('Query vector has 3 values but index "kb" expects 4.'),
      'a string', 42, null, undefined,
    ];
    for (const error of notRefusals) expect(isAclFilterRefusal(error), String(error)).toBe(false);
  });

  it('a `$raw` filter that cannot be combined is the module\'s own doing, not the store\'s', () => {
    expect(isRawFilterConflict(new VectorFilterError('"$raw" is only allowed at the top level of a filter.'))).toBe(true);
    expect(isRawFilterConflict(new VectorFilterError('"$raw" cannot be combined with other filter keys — it replaces the whole filter.'))).toBe(true);
    expect(isRawFilterConflict(new VectorFilterError('The "chroma" vector provider does not support $nin.'))).toBe(false);
    expect(isRawFilterConflict(Object.assign(new Error('"$raw" is only allowed at the top level'), { statusCode: 400 }))).toBe(false);
  });
});

describe('a pushed-down list and the store\'s answer to it', () => {
  const pushdownInput = (search: RagAclSearchInput['search'], extra: Partial<RagAclSearchInput> = {}) => searchInput({
    counts: { allowed: 2, total: 10, allowedIds: ['d1', 'd2'] },
    docs: [doc('d1'), doc('d2')],
    chunks: [chunk('kb:d1:0', 'd1'), chunk('kb:d2:0', 'd2')],
    search,
    ...extra,
  });

  it('a refusal by the filter layer falls back to post-filtering, and is reported once the search without the list worked', async () => {
    const refused = vi.fn();
    const error = new VectorFilterError('Milvus collection "kb" was created before filterable metadata, so metadata filters cannot be pushed down.');
    const search = vi.fn(async (_n: number, aclFilter?: Record<string, unknown>) => {
      if (aclFilter) throw error;
      return { matches: [match('kb:d1:0', 'd1')] };
    });
    const result = await runRagAclSearch(pushdownInput(search, { onPushdownRefused: refused }));
    expect(search).toHaveBeenCalledTimes(2);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledWith(error);
    expect(result.stats).toMatchObject({ mode: 'post', fellBack: true });
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:0']);
  });

  it('a request an HTTP store rejected as invalid counts as a refusal', async () => {
    const refused = vi.fn();
    const search = vi.fn(async (_n: number, aclFilter?: Record<string, unknown>) => {
      if (aclFilter) throw Object.assign(new Error('ValidationException'), { $metadata: { httpStatusCode: 400 } });
      return { matches: [match('kb:d2:0', 'd2')] };
    });
    const result = await runRagAclSearch(pushdownInput(search, { onPushdownRefused: refused }));
    expect(refused).toHaveBeenCalledTimes(1);
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d2:0']);
  });

  it('a store that is unwell fails the query: no second search, nothing marked', async () => {
    const failures: unknown[] = [
      Object.assign(new Error('Request timed out'), { name: 'RequestTimeoutError' }),
      Object.assign(new Error('Circuit breaker is open'), { name: 'CircuitOpenError' }),
      Object.assign(new Error('rate limited'), { status: 429 }),
      Object.assign(new Error('bad gateway'), { statusCode: 502 }),
      new Error('socket hang up'),
    ];
    for (const failure of failures) {
      const refused = vi.fn();
      const search = vi.fn(async () => { throw failure; });
      await expect(runRagAclSearch(pushdownInput(search, { onPushdownRefused: refused }))).rejects.toBe(failure);
      expect(search, String(failure)).toHaveBeenCalledTimes(1);
      expect(refused, String(failure)).not.toHaveBeenCalled();
    }
  });

  it('a filter that fails with the list and without it is the caller\'s own: its error is reported, the store is not blamed', async () => {
    const refused = vi.fn();
    const error = new VectorFilterError('The "chroma" vector provider does not support $exists. Supported operators: $eq, $in.');
    const search = vi.fn(async () => { throw error; });
    await expect(runRagAclSearch(pushdownInput(search, { onPushdownRefused: refused }))).rejects.toBe(error);
    expect(search).toHaveBeenCalledTimes(2);
    expect(refused).not.toHaveBeenCalled();
  });

  it('a module `$raw` filter cannot be combined with a list: the search goes on without it, the store is not blamed', async () => {
    const refused = vi.fn();
    const search = vi.fn(async (_n: number, aclFilter?: Record<string, unknown>) => {
      if (aclFilter) throw new VectorFilterError('"$raw" is only allowed at the top level of a filter.');
      return { matches: [match('kb:d1:0', 'd1')] };
    });
    const result = await runRagAclSearch(pushdownInput(search, { onPushdownRefused: refused }));
    expect(result.stats).toMatchObject({ mode: 'post', fellBack: true });
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:0']);
    expect(refused).not.toHaveBeenCalled();
  });

  it('a cancelled call during the search without the list is still a cancelled call', async () => {
    const refused = vi.fn();
    const controller = new AbortController();
    const search = vi.fn(async (_n: number, aclFilter?: Record<string, unknown>) => {
      if (aclFilter) throw atlasPathError();
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(runRagAclSearch(pushdownInput(search, { onPushdownRefused: refused, signal: controller.signal }))).rejects.toThrow('aborted');
    expect(refused).not.toHaveBeenCalled();
  });
});

describe('a list the store applied itself, in memory, over a short window', () => {
  const IN_MEMORY = { filterPushdown: 'in-memory', filterCandidates: 20, filterDropped: 19 };
  const listInput = (search: RagAclSearchInput['search'], extra: Parameters<typeof searchInput>[0] = {}) => searchInput({
    counts: { allowed: 2, total: 10, allowedIds: ['d1', 'd2'] },
    docs: [doc('d1'), doc('d2')],
    chunks: [chunk('kb:d1:0', 'd1'), chunk('kb:d2:0', 'd2'), chunk('kb:d2:1', 'd2')],
    search,
    ...extra,
  });

  it('too few survivors: searched again as post-filtering, with the window the plan sizes', async () => {
    const refused = vi.fn();
    const search = vi.fn(async (_n: number, aclFilter?: Record<string, unknown>) => (aclFilter
      ? { matches: [match('kb:d1:0', 'd1')], usage: IN_MEMORY }
      : { matches: [match('kb:d1:0', 'd1'), match('kb:d2:0', 'd2'), match('kb:d2:1', 'd2')] }));
    const result = await runRagAclSearch(listInput(search, { onPushdownRefused: refused }));
    expect(search.mock.calls).toEqual([
      [4, { _documentId: { $in: ['d1', 'd2'] } }],
      [4 * aclWidening(10, 2)],
    ]);
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:0', 'kb:d2:0', 'kb:d2:1']);
    expect(result.stats).toMatchObject({ mode: 'post', fellBack: true });
    // The store refused nothing: it is not marked.
    expect(refused).not.toHaveBeenCalled();
  });

  it('enough survivors: they are the nearest readable ones, no second search', async () => {
    const search = vi.fn(async () => ({
      matches: [match('kb:d1:0', 'd1'), match('kb:d2:0', 'd2'), match('kb:d2:1', 'd2'), match('kb:d1:1', 'd1')],
      usage: IN_MEMORY,
    }));
    const result = await runRagAclSearch(listInput(search, {
      chunks: [chunk('kb:d1:0', 'd1'), chunk('kb:d2:0', 'd2'), chunk('kb:d2:1', 'd2'), chunk('kb:d1:1', 'd1')],
    }));
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.stats).toMatchObject({ mode: 'in', dropped: 0 });
    expect(result.stats.fellBack).toBeUndefined();
    expect(result.matches).toHaveLength(4);
  });

  it('a store that applied the list itself (no in-memory note) is believed even when few survive', async () => {
    const search = vi.fn(async () => ({ matches: [match('kb:d1:0', 'd1')] }));
    const result = await runRagAclSearch(listInput(search));
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.stats).toMatchObject({ mode: 'in' });
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:0']);
  });

  it('the second search is itself retried wider when it too returns few and the store had more', async () => {
    const search = vi.fn(async (n: number, aclFilter?: Record<string, unknown>) => {
      if (aclFilter) return { matches: [match('kb:d1:0', 'd1')], usage: IN_MEMORY };
      // a full page of unreadable candidates, then the readable ones on the wider try
      return n < 100
        ? { matches: Array.from({ length: n }, (_, i) => match(`kb:d9:${i}`, 'd9')) }
        : { matches: [match('kb:d1:0', 'd1'), match('kb:d2:0', 'd2')] };
    });
    const result = await runRagAclSearch(listInput(search, { fetchTopK: 5, topK: 5 }));
    expect(search.mock.calls.map((c) => c[0])).toEqual([5, 5 * aclWidening(10, 2), 5 * aclWidening(10, 2) * 4]);
    expect(result.stats).toMatchObject({ mode: 'post', fellBack: true, retried: true });
    expect(result.matches.map((m) => m.id)).toEqual(['kb:d1:0', 'kb:d2:0']);
  });
});

describe('no search asks for more candidates than the store takes', () => {
  /** A page of `n` candidates none of which the reader may read, so every search comes up short. */
  const unreadablePage = (n: number) => ({ matches: Array.from({ length: n }, (_, i) => match(`kb:x${i}:0`, `x${i}`)) });
  const asked = (search: { mock: { calls: unknown[][] } }) => search.mock.calls.map((call) => call[0]);

  it('a widened first search and its retry are cut to the ceiling of a store that states one', async () => {
    // Atlas: a plain search takes 1000, a hybrid one 500 (aclPostFetchMax).
    const search = vi.fn(async (n: number) => unreadablePage(n));
    const result = await runRagAclSearch(searchInput({
      counts: { allowed: 100, total: 10000 },
      operators: [],
      driver: 'mongodb',
      hybrid: true,
      fetchTopK: 20,
      topK: 5,
      search,
    }));
    // widening 20 x 20 = 400, then 4 x 400 cut to 500
    expect(asked(search)).toEqual([400, 500]);
    expect(result.stats).toMatchObject({ mode: 'post', retried: true });
  });

  it('a widened search above the ceiling is cut, and then there is nothing wider to retry', async () => {
    const search = vi.fn(async (n: number) => unreadablePage(n));
    await runRagAclSearch(searchInput({
      counts: { allowed: 100, total: 10000 },
      operators: [],
      driver: 'mongodb',
      hybrid: true,
      fetchTopK: 60,
      topK: 5,
      search,
    }));
    expect(asked(search)).toEqual([500]);
  });

  it('a store with no stated ceiling takes the default of 1000', async () => {
    const search = vi.fn(async (n: number) => unreadablePage(n));
    await runRagAclSearch(searchInput({
      counts: { allowed: 100, total: 10000 },
      operators: [],
      driver: 'pinecone',
      fetchTopK: 100,
      topK: 5,
      search,
    }));
    expect(asked(search)).toEqual([1000]);
  });

  it('the search that follows a refused list is cut as well', async () => {
    const search = vi.fn(async (n: number, aclFilter?: Record<string, unknown>) => {
      if (aclFilter) throw atlasPathError();
      return unreadablePage(n);
    });
    await runRagAclSearch(searchInput({
      counts: { allowed: 2, total: 10000, allowedIds: ['d1', 'd2'] },
      driver: 'mongodb',
      hybrid: true,
      fetchTopK: 40,
      topK: 5,
      search,
    }));
    // 40, then 40 x 20 cut to 500
    expect(asked(search)).toEqual([40, 500]);
  });

  it('the search that follows a thin in-memory list is cut as well', async () => {
    const search = vi.fn(async (n: number, aclFilter?: Record<string, unknown>) => (aclFilter
      ? { matches: [], usage: { filterPushdown: 'in-memory' } }
      : unreadablePage(n)));
    await runRagAclSearch(searchInput({
      counts: { allowed: 2, total: 10000, allowedIds: ['d1', 'd2'] },
      driver: 'mongodb',
      hybrid: true,
      fetchTopK: 40,
      topK: 5,
      search,
    }));
    expect(asked(search)).toEqual([40, 500]);
  });
});
