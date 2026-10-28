/**
 * Knowledge Base MCP provider — access control.
 *
 * A module with access control answers with what the caller of the tool call
 * may read: the caller is derived from the identity the call carries (none =
 * a public endpoint = anonymous), a document the caller may not read is
 * reported exactly like an unknown id, and the response is marked so the
 * request log keeps a summary of it. A module without access control is
 * served as it always was.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// TRAP: factories must be synchronous (an async vi.mock factory silently fails to intercept).
const h = vi.hoisted(() => ({
  getRagDocument: vi.fn(),
  getRagDocumentFullText: vi.fn(),
  getRagDocumentTextLines: vi.fn(),
  listRagModules: vi.fn(),
  getRagModule: vi.fn(),
  queryRag: vi.fn(),
  resolveRagAccess: vi.fn(),
}));

vi.mock('@/lib/services/rag/ragService', () => ({
  getRagDocument: h.getRagDocument,
  getRagDocumentFullText: h.getRagDocumentFullText,
  getRagDocumentTextLines: h.getRagDocumentTextLines,
  listRagModules: h.listRagModules,
  getRagModule: h.getRagModule,
  queryRag: h.queryRag,
}));
// The scope itself is the access engine's own business (tested there); here it is a stand-in.
vi.mock('@/lib/services/rag/access/scope', () => ({ resolveRagAccess: h.resolveRagAccess }));

import { McpToolInputError } from '@/lib/services/mcp/errors';
import { knowledgeBaseProvider } from '@/lib/services/mcp/internal/knowledgeBaseProvider';
import { responseLogSummaryOf } from '@/lib/services/mcp/responseLog';
import type { ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';

const MODULE_KEY = 'docs';
const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'project-a' };
const GUARDED_MODULE = { key: MODULE_KEY, projectId: 'project-a', access: { enabled: true } };
const PLAIN_MODULE = { key: MODULE_KEY, projectId: 'project-a' };

const PASSAGE = 'CONFIDENTIAL PASSAGE';
const SEARCH_RESULT = { query: 'q', matches: [{ documentId: 'doc-1', content: PASSAGE }, { documentId: 'doc-2', content: PASSAGE }] };
const FULL_TEXT = { documentId: 'doc-1', fileName: 'secret.md', text: PASSAGE, totalChars: 20, totalLines: 1, truncated: false };
const LINES = { documentId: 'doc-1', fileName: 'secret.md', totalLines: 40, startLine: 1, endLine: 20, hasMore: true, lines: `1\t${PASSAGE}` };

/** What a scope decides, for the documents it is asked about. */
function scopeReading(readable: string[], overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    enforced: true,
    canReadDocument: (doc: { _id?: unknown }) => readable.includes(String(doc._id)),
    ...overrides,
  };
}

function doc(id: string) {
  return { _id: id, tenantId: 'tenant-1', ragModuleKey: MODULE_KEY, projectId: 'project-a', fileName: 'a.md' };
}

const run = (tool: string, args: Record<string, unknown>, identity?: ConsoleIdentityCaller, ctx = CTX) =>
  knowledgeBaseProvider.execute({ ...ctx, ...(identity ? { identity } : {}) }, MODULE_KEY, {}, tool, args);

beforeEach(() => {
  vi.resetAllMocks();
  h.getRagModule.mockResolvedValue(GUARDED_MODULE);
  h.resolveRagAccess.mockResolvedValue(scopeReading(['doc-1']));
  h.queryRag.mockResolvedValue(SEARCH_RESULT);
  h.getRagDocument.mockImplementation(async (_db: string, id: string) => (id.startsWith('doc-') ? doc(id) : null));
  h.getRagDocumentFullText.mockResolvedValue(FULL_TEXT);
  h.getRagDocumentTextLines.mockResolvedValue(LINES);
});

describe('who a call reads as', () => {
  const cases: Array<[string, ConsoleIdentityCaller | undefined, unknown]> = [
    ['a person in the playground', { userId: 'u1', source: 'playground' }, { kind: 'person', userId: 'u1' }],
    ['a person in a console session', { userId: 'u1', source: 'console' }, { kind: 'person', userId: 'u1' }],
    [
      'a call a trusted issuer made for a person',
      { userId: 'u1', tokenId: 'tok1', delegated: true, source: 'mcp' },
      { kind: 'person', userId: 'u1', tokenId: 'tok1', delegated: true },
    ],
    [
      'an API token (its owner is not the reader)',
      { userId: 'owner-1', tokenId: 'tok1', source: 'mcp' },
      { kind: 'token', tokenId: 'tok1', ownerUserId: 'owner-1' },
    ],
    ['a token with no user', { tokenId: 'tok1', source: 'mcp' }, { kind: 'token', tokenId: 'tok1' }],
    ['a trigger run (not its owner)', { userId: 'owner-1', source: 'trigger' }, { kind: 'anonymous', reason: 'trigger' }],
    ['a synthetic actor', { userId: 'agent:support-bot' }, { kind: 'anonymous', reason: 'synthetic' }],
    ['a call that carries no identity (a public endpoint)', undefined, { kind: 'anonymous', reason: 'unknown' }],
  ];

  it.each(cases)('search reads as %s', async (_name, identity, caller) => {
    await run('search', { query: 'q' }, identity);

    expect(h.resolveRagAccess).toHaveBeenCalledTimes(1);
    expect(h.resolveRagAccess).toHaveBeenCalledWith({
      tenantDbName: 'tenant_db',
      tenantId: 'tenant-1',
      module: GUARDED_MODULE,
      caller,
    });
    // The scope is resolved once and handed on, together with the caller.
    const options = h.queryRag.mock.calls[0][4];
    expect(options.caller).toEqual(caller);
    expect(options.access).toBe(await h.resolveRagAccess.mock.results[0].value);
  });

  it.each(cases)('read_document reads as %s', async (_name, identity, caller) => {
    await run('read_document', { documentId: 'doc-1' }, identity);
    // The caller's scope; then, for the document handed on, whether it is open to everyone (the call is marked if not).
    expect(h.resolveRagAccess).toHaveBeenCalledTimes(2);
    expect(h.resolveRagAccess.mock.calls[0][0].caller).toEqual(caller);
    expect(h.resolveRagAccess.mock.calls[1][0]).toMatchObject({ caller: { kind: 'anonymous', reason: 'public' }, manage: false });
  });

  it.each(cases)('read_document_lines reads as %s', async (_name, identity, caller) => {
    await run('read_document_lines', { documentId: 'doc-1' }, identity);
    // The caller's scope; then, for the document handed on, whether it is open to everyone (the call is marked if not).
    expect(h.resolveRagAccess).toHaveBeenCalledTimes(2);
    expect(h.resolveRagAccess.mock.calls[0][0].caller).toEqual(caller);
    expect(h.resolveRagAccess.mock.calls[1][0]).toMatchObject({ caller: { kind: 'anonymous', reason: 'public' }, manage: false });
  });

  it('looks the module up where the server is published', async () => {
    await run('search', { query: 'q' }, { userId: 'u1' });
    expect(h.getRagModule).toHaveBeenCalledWith('tenant_db', MODULE_KEY, 'project-a');
  });
});

describe.each(['read_document', 'read_document_lines'] as const)('%s in a module with access control', (tool) => {
  const reader = tool === 'read_document' ? h.getRagDocumentFullText : h.getRagDocumentTextLines;
  const identity: ConsoleIdentityCaller = { userId: 'u1', source: 'playground' };

  it('reads a document the caller may read', async () => {
    await expect(run(tool, { documentId: 'doc-1' }, identity)).resolves.toBeDefined();
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('answers a document the caller may not read exactly like an unknown id', async () => {
    // doc-2 exists, the scope does not let this caller read it.
    const unreadable = await run(tool, { documentId: 'doc-2' }, identity).catch((e: Error) => e);
    // The same id when there is no such document.
    h.getRagDocument.mockResolvedValueOnce(null);
    const missing = await run(tool, { documentId: 'doc-2' }, identity).catch((e: Error) => e);

    expect(unreadable).toBeInstanceOf(McpToolInputError);
    expect(missing).toBeInstanceOf(McpToolInputError);
    expect((unreadable as Error).message).toBe((missing as Error).message);
    expect((unreadable as Error).message).toBe('Document "doc-2" not found in this knowledge base');
    expect(reader).not.toHaveBeenCalled();
  });

  it('asks the scope about the document it loaded (folder and permissions mode included)', async () => {
    const canReadDocument = vi.fn(() => true);
    h.resolveRagAccess.mockResolvedValue(scopeReading([], { canReadDocument }));
    const stored = { ...doc('doc-1'), folderId: 'folder-1', aclMode: 'own' };
    h.getRagDocument.mockResolvedValue(stored);

    await run(tool, { documentId: 'doc-1' }, identity);

    expect(canReadDocument).toHaveBeenCalledWith(stored);
  });

  it('reads everything for a caller the permissions do not apply to (a manager with the admin exception)', async () => {
    h.resolveRagAccess.mockResolvedValue(scopeReading([], { enforced: false }));
    await expect(run(tool, { documentId: 'doc-2' }, identity)).resolves.toBeDefined();
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('still refuses a document of another module or project before anything else', async () => {
    h.getRagDocument.mockResolvedValueOnce({ ...doc('doc-1'), ragModuleKey: 'other' });
    await expect(run(tool, { documentId: 'doc-1' }, identity)).rejects.toThrow(/not found/);
    h.getRagDocument.mockResolvedValueOnce({ ...doc('doc-1'), projectId: 'project-b' });
    await expect(run(tool, { documentId: 'doc-1' }, identity)).rejects.toThrow(/not found/);
    expect(reader).not.toHaveBeenCalled();
  });

  it('does not look the scope up for a call that is missing its document id', async () => {
    await expect(run(tool, {}, identity)).rejects.toThrow('"documentId" is required');
    expect(h.getRagModule).not.toHaveBeenCalled();
  });
});

describe('search in a module with access control', () => {
  it('answers with what the query returned', async () => {
    const result = await run('search', { query: ' q ', filter: { lang: 'en' } }, { userId: 'u1' });

    expect(result).toEqual(SEARCH_RESULT);
    expect(h.queryRag).toHaveBeenCalledWith(
      'tenant_db',
      'tenant-1',
      'project-a',
      expect.objectContaining({ ragModuleKey: MODULE_KEY, query: 'q', filter: { lang: 'en' } }),
      expect.objectContaining({ caller: { kind: 'person', userId: 'u1' } }),
    );
  });

  it('does not resolve a scope for a call with no query', async () => {
    await expect(run('search', { query: '  ' }, { userId: 'u1' })).rejects.toThrow('"query" is required');
    expect(h.getRagModule).not.toHaveBeenCalled();
    expect(h.resolveRagAccess).not.toHaveBeenCalled();
  });
});

describe('what the request log keeps', () => {
  it('summarises a search by its match count', async () => {
    const result = await run('search', { query: 'q' }, { userId: 'u1' });
    expect(responseLogSummaryOf(result)).toEqual({ omitted: true, reason: 'access_controlled', matches: 2 });
  });

  it('summarises a document read by its sizes', async () => {
    const result = await run('read_document', { documentId: 'doc-1' }, { userId: 'u1' });
    expect(responseLogSummaryOf(result)).toEqual({
      omitted: true, reason: 'access_controlled', totalChars: 20, totalLines: 1, truncated: false,
    });
  });

  it('summarises a line read by its range', async () => {
    const result = await run('read_document_lines', { documentId: 'doc-1' }, { userId: 'u1' });
    expect(responseLogSummaryOf(result)).toEqual({
      omitted: true, reason: 'access_controlled', totalLines: 40, startLine: 1, endLine: 20, hasMore: true,
    });
  });

  it('keeps no content, name or id in a summary', async () => {
    const summaries = [
      responseLogSummaryOf(await run('search', { query: 'q' }, { userId: 'u1' })),
      responseLogSummaryOf(await run('read_document', { documentId: 'doc-1' }, { userId: 'u1' })),
      responseLogSummaryOf(await run('read_document_lines', { documentId: 'doc-1' }, { userId: 'u1' })),
    ];
    for (const summary of summaries) {
      expect(JSON.stringify(summary)).not.toMatch(/CONFIDENTIAL|secret\.md|doc-1/);
    }
  });

  it('leaves the response itself untouched', async () => {
    const result = await run('search', { query: 'q' }, { userId: 'u1' });
    expect(result).toEqual(SEARCH_RESULT);
    expect(Object.keys(result as object)).toEqual(['query', 'matches']);
  });

  it('summarises for a caller the permissions do not apply to as well: the module decides, not the caller', async () => {
    h.resolveRagAccess.mockResolvedValue(scopeReading([], { enforced: false }));
    const result = await run('search', { query: 'q' }, { userId: 'admin-1' });
    expect(responseLogSummaryOf(result)).toMatchObject({ omitted: true });
  });
});

describe('a module without access control', () => {
  it.each([
    ['no access setting', PLAIN_MODULE],
    ['access control switched off', { ...PLAIN_MODULE, access: { enabled: false } }],
  ])('is served as before: %s', async (_name, ragModule) => {
    h.getRagModule.mockResolvedValue(ragModule);
    const identity: ConsoleIdentityCaller = { userId: 'u1', source: 'playground' };

    const search = await run('search', { query: 'q' }, identity);
    const full = await run('read_document', { documentId: 'doc-2' }, identity);
    const lines = await run('read_document_lines', { documentId: 'doc-2' }, identity);

    expect(h.resolveRagAccess).not.toHaveBeenCalled();
    // The query is made exactly as it always was: no caller, no scope.
    expect(Object.keys(h.queryRag.mock.calls[0][4])).toEqual(['signal']);
    // Every document of the module is read, and every response is logged in full.
    expect(search).toEqual(SEARCH_RESULT);
    expect(full).toEqual(FULL_TEXT);
    expect(lines).toEqual(LINES);
    for (const result of [search, full, lines]) expect(responseLogSummaryOf(result)).toBeUndefined();
  });

  it('reports a module that does not exist as it always did', async () => {
    h.getRagModule.mockResolvedValue(null);
    h.queryRag.mockRejectedValue(new Error('Knowledge Engine module "docs" not found'));

    await expect(run('search', { query: 'q' }, { userId: 'u1' })).rejects.toThrow('module "docs" not found');
    expect(h.resolveRagAccess).not.toHaveBeenCalled();
    expect(Object.keys(h.queryRag.mock.calls[0][4])).toEqual(['signal']);
    await expect(run('read_document', { documentId: 'doc-1' }, { userId: 'u1' })).resolves.toEqual(FULL_TEXT);
  });
});
