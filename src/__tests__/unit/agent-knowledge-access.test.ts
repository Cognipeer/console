/**
 * Agent knowledge tools and document-level access control (agentService.ts).
 *
 *   - the tools read for the caller of the run (a person, a token, a trigger,
 *     nobody) and hand it to the query, together with the caller's scope;
 *   - the scope is resolved lazily, once per knowledge base per build, and only
 *     for a knowledge base that has access control switched on;
 *   - a document the caller may not read is answered exactly like a missing one;
 *   - a knowledge base without access control behaves as it did before.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRag: vi.fn(),
  getRagDocument: vi.fn(),
  getRagDocumentFullText: vi.fn(),
  getRagDocumentTextLines: vi.fn(),
  resolveModule: vi.fn(),
  resolveRagAccess: vi.fn(),
  noteRestrictedDocuments: vi.fn(),
}));

vi.mock('@/lib/services/rag/ragService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  queryRag: mocks.queryRag,
  getRagDocument: mocks.getRagDocument,
  getRagDocumentFullText: mocks.getRagDocumentFullText,
  getRagDocumentTextLines: mocks.getRagDocumentTextLines,
}));
vi.mock('@/lib/services/agents/bindingResolution', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveAgentKnowledgeModule: mocks.resolveModule,
}));
vi.mock('@/lib/services/rag/access', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveRagAccess: mocks.resolveRagAccess,
  // Whether a document handed on is open to everyone (it marks the run when not): exposure tests cover it.
  noteRestrictedDocuments: mocks.noteRestrictedDocuments,
}));
// A sub-agent build asks whether the agents service is on and which services are off.
vi.mock('@/lib/services/availability/serviceAvailability', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assertServiceEnabled: async () => undefined,
  getDisabledServices: async () => new Map(),
}));

import { createTool } from '@cognipeer/agent-sdk';
import { z } from 'zod';
import { anonymousKbCaller, type RagAccessScope } from '@/lib/services/rag/access';
import {
  buildAgentKnowledgeTools,
  buildAgentSubagents,
  knowledgeCallerOf,
} from '@/lib/services/agents/agentService';

const guard = { protect: (_s: unknown, fn: unknown) => fn } as never;
const run = (tool: unknown, args: unknown) => {
  const t = tool as { invoke?: (a: unknown) => Promise<unknown>; func?: (a: unknown) => Promise<unknown> };
  return (t.invoke ?? t.func)!(args);
};

const NOT_FOUND = 'Document not found in this knowledge base.';
const NOT_FOUND_BOUND = 'Document not found in the bound knowledge bases.';

/** Tools in build order: search, read_document, read_document_lines. */
const [SEARCH, READ, READ_LINES] = [0, 1, 2];

/** A scope that lets the caller read only the documents listed in `readable`. */
function scopeFor(readable: string[], over: Record<string, unknown> = {}): RagAccessScope {
  const allowed = new Set(readable);
  return {
    moduleKey: 'kb-acl',
    enabled: true,
    manage: false,
    bypass: false,
    enforced: true,
    principals: new Set<string>(),
    canReadDocument: vi.fn((doc: { _id?: unknown }) => allowed.has(String(doc._id))),
    canReadFolder: () => false,
    canSeeFolder: () => false,
    documentFilter: () => undefined,
    managementFilter: () => undefined,
    stats: { principals: 0, grantedNodes: 0, folders: 0, readableFolders: 0 },
    ...over,
  } as unknown as RagAccessScope;
}

const ACL_MODULE = { key: 'kb-acl', projectId: 'p1', status: 'active', access: { enabled: true }, aclRevision: 3 };
const PLAIN_MODULE = { key: 'kb-plain', projectId: 'p1', status: 'active' };
const OFF_MODULE = { key: 'kb-off', projectId: 'p1', status: 'active', access: { enabled: false } };
const MODULES: Record<string, Record<string, unknown>> = {
  'kb-acl': ACL_MODULE,
  'kb-acl-2': { ...ACL_MODULE, key: 'kb-acl-2' },
  'kb-plain': PLAIN_MODULE,
  'kb-off': OFF_MODULE,
};

const doc = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, ragModuleKey: 'kb-acl', projectId: 'p1', fileName: `${id}.md`, ...over,
});

/** The options object `queryRag` was last called with (its fifth argument). */
const lastQueryOptions = () => mocks.queryRag.mock.calls.at(-1)?.[4] as Record<string, unknown>;

const PERSON_CONTEXT = { userId: 'user-1', source: 'playground' as const };
const TRIGGER_CONTEXT = { userId: 'system:trigger:t1', source: 'trigger' as const, trigger: { id: 't1', type: 'schedule' } };

const person = (userId: string) => ({ kind: 'person', userId });

beforeEach(() => {
  mocks.queryRag.mockReset().mockResolvedValue({ matches: [] });
  mocks.noteRestrictedDocuments.mockReset().mockResolvedValue(null);
  mocks.getRagDocument.mockReset();
  mocks.getRagDocumentFullText.mockReset().mockResolvedValue({ fileName: 'f.md', text: 'body', truncated: false, totalChars: 4, totalLines: 1 });
  mocks.getRagDocumentTextLines.mockReset().mockResolvedValue({
    fileName: 'f.md', lines: 'line', startLine: 1, endLine: 1, totalLines: 1, hasMore: false,
  });
  mocks.resolveModule.mockReset().mockImplementation(async (_db: string, key: string) => MODULES[key] ?? null);
  mocks.resolveRagAccess.mockReset().mockImplementation(async () => scopeFor([]));
});

describe('who a run reads for', () => {
  it('is the person of a dashboard or API-user run', () => {
    expect(knowledgeCallerOf({ runtimeContext: PERSON_CONTEXT })).toEqual(person('user-1'));
  });

  it('is nobody for a trigger run, whoever owns the trigger', () => {
    expect(knowledgeCallerOf({ runtimeContext: TRIGGER_CONTEXT })).toEqual({ kind: 'anonymous', reason: 'trigger' });
    expect(knowledgeCallerOf({ runtimeContext: { ...TRIGGER_CONTEXT, userId: 'user-owner' } })).toEqual({ kind: 'anonymous', reason: 'trigger' });
  });

  it('is the token alone for an API token that carries no person', () => {
    expect(knowledgeCallerOf({ runtimeContext: { userId: 'owner-1', tokenId: 'tok-1', source: 'api' } }))
      .toEqual({ kind: 'token', tokenId: 'tok-1', ownerUserId: 'owner-1' });
  });

  it('is the person a trusted issuer vouched for on a delegated call', () => {
    expect(knowledgeCallerOf({
      runtimeContext: { userId: 'user-2', tokenId: 'tok-1', source: 'api', via: { kind: 'delegated', issuer: 'idp' } as never },
    })).toEqual({ kind: 'person', userId: 'user-2', tokenId: 'tok-1', delegated: true });
  });

  it('is an unknown caller without a runtime context or with a synthetic actor', () => {
    expect(knowledgeCallerOf({})).toEqual({ kind: 'anonymous', reason: 'unknown' });
    expect(knowledgeCallerOf({ runtimeContext: { userId: 'a2a-public', source: 'a2a' } })).toEqual({ kind: 'anonymous', reason: 'synthetic' });
  });

  it('is the person a continued pause is for, never whoever answered it', () => {
    const answeredBy = { userId: 'approver', source: 'playground' as const };
    expect(knowledgeCallerOf({ identity: { userId: 'asker', source: 'playground' }, runtimeContext: answeredBy })).toEqual(person('asker'));
    // A pause stored without a person does not fall back to the approver either.
    expect(knowledgeCallerOf({ identity: {}, runtimeContext: answeredBy })).toEqual({ kind: 'anonymous', reason: 'unknown' });
    expect(knowledgeCallerOf({ identity: { userId: 'owner', source: 'trigger' }, runtimeContext: answeredBy }))
      .toEqual({ kind: 'anonymous', reason: 'trigger' });
  });
});

describe('knowledge search for a knowledge base with access control', () => {
  it('hands the person and the resolved scope to the query (legacy single tool set)', async () => {
    const scope = scopeFor(['d1']);
    mocks.resolveRagAccess.mockResolvedValue(scope);
    const caller = knowledgeCallerOf({ runtimeContext: PERSON_CONTEXT });
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'kb-acl' }, guard, { caller });

    await run(built.tools[SEARCH], { query: 'q' });

    expect(mocks.resolveRagAccess).toHaveBeenCalledTimes(1);
    expect(mocks.resolveRagAccess).toHaveBeenCalledWith({ tenantDbName: 'db', tenantId: 't', module: ACL_MODULE, caller });
    expect(lastQueryOptions()).toMatchObject({ caller: person('user-1') });
    expect(lastQueryOptions().access).toBe(scope);
    // The request itself is what it always was.
    expect(mocks.queryRag.mock.calls[0][3]).toMatchObject({ ragModuleKey: 'kb-acl', query: 'q', topK: 5 });
  });

  it('hands a trigger run to the query as nobody', async () => {
    const caller = knowledgeCallerOf({ runtimeContext: TRIGGER_CONTEXT });
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'kb-acl' }, guard, { caller });

    await run(built.tools[SEARCH], { query: 'q' });

    expect(mocks.resolveRagAccess.mock.calls[0][0].caller).toEqual({ kind: 'anonymous', reason: 'trigger' });
    expect(lastQueryOptions().caller).toEqual({ kind: 'anonymous', reason: 'trigger' });
  });

  it('treats a build without a caller as an unknown caller', async () => {
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'kb-acl' }, guard);

    await run(built.tools[SEARCH], { query: 'q' });

    expect(mocks.resolveRagAccess.mock.calls[0][0].caller).toEqual(anonymousKbCaller('unknown'));
    expect(lastQueryOptions().caller).toEqual(anonymousKbCaller('unknown'));
  });

  it('does the same in separate mode and keeps the tool names', async () => {
    const caller = knowledgeCallerOf({ runtimeContext: PERSON_CONTEXT });
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', {
      knowledgeToolMode: 'separate',
      knowledgeBindings: [{ key: 'kb-acl', description: 'ACL' }, { key: 'kb-plain' }],
    }, guard, { caller });
    expect(built.toolDefinitions.map((d) => d.name)).toEqual([
      'knowledge_search_kb_acl', 'knowledge_read_document_kb_acl', 'knowledge_read_document_lines_kb_acl',
      'knowledge_search_kb_plain', 'knowledge_read_document_kb_plain', 'knowledge_read_document_lines_kb_plain',
    ]);

    await run(built.tools[SEARCH], { query: 'q' });
    await run(built.tools[3 + SEARCH], { query: 'q' });

    expect(mocks.queryRag.mock.calls[0][4]).toMatchObject({ caller: person('user-1'), access: expect.anything() });
    expect(mocks.queryRag.mock.calls[1][4]).toMatchObject({ caller: person('user-1') });
    expect(mocks.queryRag.mock.calls[1][4]).not.toHaveProperty('access');
    expect(mocks.resolveRagAccess).toHaveBeenCalledTimes(1);
  });

  it('searches every bound knowledge base for the same caller in combined mode', async () => {
    const scopes: Record<string, RagAccessScope> = { 'kb-acl': scopeFor(['d1']), 'kb-acl-2': scopeFor([]) };
    mocks.resolveRagAccess.mockImplementation(async ({ module }: { module: { key: string } }) => scopes[module.key]);
    const caller = knowledgeCallerOf({ runtimeContext: PERSON_CONTEXT });
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', {
      knowledgeBindings: [{ key: 'kb-acl' }, { key: 'kb-acl-2' }, { key: 'kb-plain' }],
    }, guard, { caller });

    await run(built.tools[SEARCH], { query: 'q' });

    const optionsOf = (key: string) => mocks.queryRag.mock.calls.find((c) => c[3].ragModuleKey === key)![4];
    expect(optionsOf('kb-acl')).toMatchObject({ caller: person('user-1') });
    expect(optionsOf('kb-acl').access).toBe(scopes['kb-acl']);
    expect(optionsOf('kb-acl-2').access).toBe(scopes['kb-acl-2']);
    expect(optionsOf('kb-plain')).toMatchObject({ caller: person('user-1') });
    expect(optionsOf('kb-plain')).not.toHaveProperty('access');
    expect(mocks.resolveRagAccess.mock.calls.map((c) => c[0].module.key).sort()).toEqual(['kb-acl', 'kb-acl-2']);
  });

  it('resolves the scope on first use, once per knowledge base for the whole build', async () => {
    mocks.getRagDocument.mockResolvedValue(doc('d1'));
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'kb-acl' }, guard, {
      caller: knowledgeCallerOf({ runtimeContext: PERSON_CONTEXT }),
    });
    expect(mocks.resolveRagAccess).not.toHaveBeenCalled();

    await run(built.tools[SEARCH], { query: 'a' });
    await run(built.tools[SEARCH], { query: 'b' });
    await run(built.tools[READ], { documentId: 'd1' });
    await run(built.tools[READ_LINES], { documentId: 'd1' });
    // Searches racing each other share the one lookup too.
    await Promise.all([run(built.tools[SEARCH], { query: 'c' }), run(built.tools[SEARCH], { query: 'd' })]);

    expect(mocks.resolveRagAccess).toHaveBeenCalledTimes(1);
    expect(mocks.queryRag).toHaveBeenCalledTimes(4);
  });

  it('asks again after a lookup that failed, and keeps the failure out of the answer', async () => {
    mocks.resolveRagAccess.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(scopeFor([]));
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'kb-acl' }, guard, {
      caller: knowledgeCallerOf({ runtimeContext: PERSON_CONTEXT }),
    });

    await expect(run(built.tools[SEARCH], { query: 'q' })).rejects.toThrow('db down');
    expect(mocks.queryRag).not.toHaveBeenCalled();

    await run(built.tools[SEARCH], { query: 'q' });
    expect(mocks.resolveRagAccess).toHaveBeenCalledTimes(2);
    expect(mocks.queryRag).toHaveBeenCalledTimes(1);
  });
});

describe('reading a document of a knowledge base with access control', () => {
  const personCaller = knowledgeCallerOf({ runtimeContext: PERSON_CONTEXT });

  describe.each([
    ['read_document', READ, () => mocks.getRagDocumentFullText],
    ['read_document_lines', READ_LINES, () => mocks.getRagDocumentTextLines],
  ] as const)('%s (single set)', (_name, index, reader) => {
    const open = async (readable: string[], over: Record<string, unknown> = {}) => {
      const scope = scopeFor(readable, over);
      mocks.resolveRagAccess.mockResolvedValue(scope);
      const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'kb-acl' }, guard, { caller: personCaller });
      return { tool: built.tools[index], scope };
    };

    it('reads a document the caller may read', async () => {
      mocks.getRagDocument.mockResolvedValue(doc('d1'));
      const { tool } = await open(['d1']);
      expect(String(await run(tool, { documentId: 'd1' }))).toContain('# f.md');
      expect(reader()).toHaveBeenCalledTimes(1);
      // The document handed on is checked for marks before its text goes back to the model.
      expect(mocks.noteRestrictedDocuments).toHaveBeenCalledWith(expect.objectContaining({ documents: [expect.objectContaining({ _id: 'd1' })] }));
    });

    it('answers a document the caller may not read exactly like a missing one', async () => {
      const { tool } = await open(['someone-elses']);
      mocks.getRagDocument.mockResolvedValue(null);
      const missing = await run(tool, { documentId: 'd1' });
      mocks.getRagDocument.mockResolvedValue(doc('d1'));
      const hidden = await run(tool, { documentId: 'd1' });

      expect(missing).toBe(NOT_FOUND);
      expect(hidden).toBe(missing);
      expect(reader()).not.toHaveBeenCalled();
    });

    it('hands the document to the scope as the database holds it', async () => {
      const stored = doc('d1', { folderId: 'f1', aclMode: 'own' });
      mocks.getRagDocument.mockResolvedValue(stored);
      const { tool, scope } = await open(['d1']);
      await run(tool, { documentId: 'd1' });
      expect(scope.canReadDocument).toHaveBeenCalledWith(stored);
    });

    it('does not consult the scope for a document of another module or project', async () => {
      const { tool, scope } = await open(['d1']);
      mocks.getRagDocument.mockResolvedValue(doc('d1', { ragModuleKey: 'other' }));
      expect(await run(tool, { documentId: 'd1' })).toBe(NOT_FOUND);
      mocks.getRagDocument.mockResolvedValue(doc('d1', { projectId: 'p2' }));
      expect(await run(tool, { documentId: 'd1' })).toBe(NOT_FOUND);
      expect(scope.canReadDocument).not.toHaveBeenCalled();
    });

    it('reads any document of the module for a caller the scope does not enforce on', async () => {
      mocks.getRagDocument.mockResolvedValue(doc('d1'));
      const { tool, scope } = await open([], { enforced: false, bypass: true, manage: true });
      expect(String(await run(tool, { documentId: 'd1' }))).toContain('# f.md');
      expect(scope.canReadDocument).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['read_document', READ, () => mocks.getRagDocumentFullText],
    ['read_document_lines', READ_LINES, () => mocks.getRagDocumentTextLines],
  ] as const)('%s (combined set)', (_name, index, reader) => {
    const buildCombined = async () => {
      const scopes: Record<string, RagAccessScope> = { 'kb-acl': scopeFor(['d1']), 'kb-acl-2': scopeFor([]) };
      mocks.resolveRagAccess.mockImplementation(async ({ module }: { module: { key: string } }) => scopes[module.key]);
      return buildAgentKnowledgeTools('db', 't', 'p1', {
        knowledgeBindings: [{ key: 'kb-acl' }, { key: 'kb-acl-2' }, { key: 'kb-plain' }],
      }, guard, { caller: personCaller });
    };

    it('reads a document the caller may read', async () => {
      const built = await buildCombined();
      mocks.getRagDocument.mockResolvedValue(doc('d1'));
      expect(String(await run(built.tools[index], { documentId: 'd1' }))).toContain('# f.md');
      expect(reader()).toHaveBeenCalledTimes(1);
    });

    it('answers a document the caller may not read exactly like a missing one', async () => {
      const built = await buildCombined();
      mocks.getRagDocument.mockResolvedValue(null);
      const missing = await run(built.tools[index], { documentId: 'd2' });
      mocks.getRagDocument.mockResolvedValue(doc('d2', { ragModuleKey: 'kb-acl-2' }));
      const hidden = await run(built.tools[index], { documentId: 'd2' });
      mocks.getRagDocument.mockResolvedValue(doc('d3'));
      const hiddenInTheFirst = await run(built.tools[index], { documentId: 'd3', kb: 'kb-acl' });

      expect(missing).toBe(NOT_FOUND_BOUND);
      expect(hidden).toBe(missing);
      expect(hiddenInTheFirst).toBe(missing);
      expect(reader()).not.toHaveBeenCalled();
    });

    it('checks only the scope of the knowledge base the document belongs to', async () => {
      const built = await buildCombined();
      mocks.getRagDocument.mockResolvedValue(doc('p1doc', { ragModuleKey: 'kb-plain' }));
      expect(String(await run(built.tools[index], { documentId: 'p1doc' }))).toContain('# f.md');
      expect(mocks.resolveRagAccess).not.toHaveBeenCalled();
    });
  });
});

describe('a knowledge base without access control', () => {
  it.each([
    ['no access setting', 'kb-plain'],
    ['access switched off', 'kb-off'],
  ])('(%s) resolves no scope for search or reads', async (_label, key) => {
    mocks.getRagDocument.mockResolvedValue(doc('d1', { ragModuleKey: key }));
    const caller = knowledgeCallerOf({ runtimeContext: PERSON_CONTEXT });

    for (const source of [
      { knowledgeEngineKey: key },
      { knowledgeToolMode: 'separate' as const, knowledgeBindings: [{ key }, { key: 'kb-plain' }] },
      { knowledgeBindings: [{ key, description: 'combined' }, { key: 'kb-plain' }] },
    ]) {
      mocks.queryRag.mockClear();
      const built = await buildAgentKnowledgeTools('db', 't', 'p1', source, guard, { caller });
      await run(built.tools[SEARCH], { query: 'q' });
      expect(String(await run(built.tools[READ], { documentId: 'd1' }))).toContain('# f.md');
      expect(String(await run(built.tools[READ_LINES], { documentId: 'd1' }))).toContain('(lines 1-1 of 1)');

      expect(mocks.queryRag).toHaveBeenCalled();
      for (const call of mocks.queryRag.mock.calls) {
        expect(call[4]).not.toHaveProperty('access');
        expect(call[4]).toMatchObject({ caller: person('user-1') });
      }
    }
    expect(mocks.resolveRagAccess).not.toHaveBeenCalled();
  });

  it('keeps the tool names, definitions and output of a build without a caller', async () => {
    mocks.queryRag.mockResolvedValue({ matches: [{ content: 'passage', documentId: 'd1', fileName: 'a.md', score: 0.9 }] });
    const built = await buildAgentKnowledgeTools('db', 't', 'p1', { knowledgeEngineKey: 'kb-plain' }, guard);
    expect(built.toolDefinitions.map((d) => d.name)).toEqual([
      'knowledge_search', 'knowledge_read_document', 'knowledge_read_document_lines',
    ]);
    expect(await run(built.tools[SEARCH], { query: 'q' })).toBe('[documentId: d1, file: a.md]\npassage');
    expect(mocks.resolveRagAccess).not.toHaveBeenCalled();
  });
});

describe('sub-agents', () => {
  function subagentInput(over: Record<string, unknown> = {}) {
    return {
      tenantDbName: 'db',
      tenantId: 't',
      projectId: 'p1',
      subagents: [{ kind: 'inline', name: 'helper', header: 'Helps', knowledgeEngineKey: 'kb-acl' }],
      createToolFn: createTool,
      zod: z,
      guard,
      prompt: { parent: {} },
      ...over,
    } as never;
  }

  async function searchAsChild(over: Record<string, unknown>) {
    const built = await buildAgentSubagents(subagentInput(over));
    const tools = (built.subagents[0] as unknown as { tools: unknown[] }).tools;
    await run(tools[SEARCH], { query: 'q' });
    return tools;
  }

  it('read for the person of the parent run (from its runtime context)', async () => {
    await searchAsChild({ runtimeContext: PERSON_CONTEXT });

    expect(mocks.resolveRagAccess.mock.calls[0][0].caller).toEqual(person('user-1'));
    expect(lastQueryOptions()).toMatchObject({ caller: person('user-1') });
    expect(lastQueryOptions().access).toBeDefined();
  });

  it('read as nobody when the parent run is a trigger run', async () => {
    await searchAsChild({ runtimeContext: TRIGGER_CONTEXT });

    expect(lastQueryOptions().caller).toEqual({ kind: 'anonymous', reason: 'trigger' });
  });

  it('read as an unknown caller without a runtime context', async () => {
    await searchAsChild({});

    expect(lastQueryOptions().caller).toEqual({ kind: 'anonymous', reason: 'unknown' });
  });

  it('read for the caller the parent run resolved, ahead of its runtime context', async () => {
    await searchAsChild({
      runtimeContext: { userId: 'approver', source: 'playground' },
      kbCaller: person('asker'),
    });

    expect(lastQueryOptions().caller).toEqual(person('asker'));
  });

  it('answer an unreadable document like a missing one and resolve nothing for a plain knowledge base', async () => {
    mocks.resolveRagAccess.mockResolvedValue(scopeFor(['d1']));
    mocks.getRagDocument.mockResolvedValue(doc('d2'));
    const tools = await searchAsChild({ runtimeContext: PERSON_CONTEXT });
    expect(await run(tools[READ], { documentId: 'd2' })).toBe(NOT_FOUND);

    mocks.resolveRagAccess.mockClear();
    const plain = await buildAgentSubagents(subagentInput({
      runtimeContext: PERSON_CONTEXT,
      subagents: [{ kind: 'inline', name: 'plain', header: 'Plain', knowledgeEngineKey: 'kb-plain' }],
    }));
    await run((plain.subagents[0] as unknown as { tools: unknown[] }).tools[SEARCH], { query: 'q' });
    expect(mocks.resolveRagAccess).not.toHaveBeenCalled();
  });
});
