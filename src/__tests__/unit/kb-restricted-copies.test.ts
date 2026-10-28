/**
 * The marks a piece of work carries when it handed on passages of knowledge base documents not open to everyone
 * (rag/access/exposure.ts), and what depends on them:
 *
 *   - the exposure: marks noted, stored once through the record's writer, passed to the work around it, retried
 *     after a failed store, seeded from what the record already holds;
 *   - `restrictedTagOf`: a document of a module with access control that somebody holding only `everyone` cannot
 *     read marks the work with the module's tag; a module without access control never does;
 *   - `kbReader: 'anonymous'` (a shared channel): the run reads as no one in particular, a paused turn keeps it;
 *   - memory: work that is marked keeps what it learnt in the session;
 *   - the request helpers: a stored copy's content for the person it was made for and for an administrator of every
 *     knowledge base it names; a token never administers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveRagAccess: vi.fn(),
  serviceActionAllowed: vi.fn(),
  findRagModuleByKey: vi.fn(),
  addMemory: vi.fn(),
  listMemoryItems: vi.fn(),
  getMemoryStore: vi.fn(),
  updateMemoryItem: vi.fn(),
}));

// TRAP: factories must be synchronous (an async vi.mock factory silently fails to intercept).
vi.mock('@/lib/services/rag/access/scope', () => ({ resolveRagAccess: h.resolveRagAccess }));
vi.mock('@/server/api/fastify-utils', () => ({ serviceActionAllowedForRequest: h.serviceActionAllowed }));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn({ findRagModuleByKey: h.findRagModuleByKey }),
}));
vi.mock('@/lib/services/memory/memoryService', () => ({
  addMemory: h.addMemory,
  listMemoryItems: h.listMemoryItems,
  getMemoryStore: h.getMemoryStore,
  searchMemories: vi.fn(),
  updateMemoryItem: h.updateMemoryItem,
}));

import type { FastifyRequest } from 'fastify';
import { createTool } from '@cognipeer/agent-sdk';
import { z } from 'zod';
import {
  KnowledgeExposure,
  currentRestrictedKnowledgeTags,
  noteRestrictedKnowledge,
  parseRestrictedKnowledgeTag,
  restrictedKnowledgeTag,
  restrictedKnowledgeTagsOf,
  runWithKnowledgeExposure,
  withKnowledgeExposure,
} from '@/lib/services/rag/access/exposure';
import { noteRestrictedDocuments, restrictedTagOf } from '@/lib/services/rag/access/restricted';
import { kbCallerFromIdentity, kbCallerFromRuntime } from '@/lib/services/rag/access/caller';
import { consoleIdentityCallerOf, consoleIdentityPersonOf } from '@/lib/iam/consoleIdentity';
import { createConsoleMemoryStore, memoryWriteWithheld } from '@/lib/services/agents/agentMemoryAdapter';
import { buildMemoryTools } from '@/lib/services/agents/agentMemoryTools';
import {
  restrictedKnowledgeReaderFor,
  withoutRestrictedAttempts,
  withoutRestrictedMcpLogContent,
  withoutRestrictedRunItems,
} from '@/server/api/restrictedKnowledgeRequest';

const TAG = 'p1:handbook';
const OTHER_TAG = 'p2:wiki';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the marks', () => {
  it('name a module by its project and key, and read back', () => {
    expect(restrictedKnowledgeTag({ key: 'handbook', projectId: 'p1' })).toBe(TAG);
    expect(restrictedKnowledgeTag({ key: 'handbook' })).toBe(':handbook');
    expect(parseRestrictedKnowledgeTag(TAG)).toEqual({ key: 'handbook', projectId: 'p1' });
    expect(parseRestrictedKnowledgeTag(':handbook')).toEqual({ key: 'handbook' });
    expect(parseRestrictedKnowledgeTag('no-colon')).toBeNull();
    expect(parseRestrictedKnowledgeTag(42)).toBeNull();
  });

  it('are read from stored data defensively: strings only, once each', () => {
    expect(restrictedKnowledgeTagsOf([TAG, TAG, OTHER_TAG, 7, null, ''])).toEqual(expect.arrayContaining([TAG, OTHER_TAG]));
    expect(restrictedKnowledgeTagsOf([TAG, TAG])).toHaveLength(1);
    expect(restrictedKnowledgeTagsOf(undefined)).toEqual([]);
    expect(restrictedKnowledgeTagsOf('p1:handbook')).toEqual([]);
  });
});

describe('an exposure', () => {
  it('is unmarked until a passage is noted, then stores the mark once', async () => {
    const onRestricted = vi.fn(async () => undefined);
    const exposure = new KnowledgeExposure({ parent: null, onRestricted });
    expect(exposure.restricted).toBe(false);
    await runWithKnowledgeExposure(exposure, async () => {
      await noteRestrictedKnowledge([TAG]);
      await noteRestrictedKnowledge([TAG]);
      expect(currentRestrictedKnowledgeTags()).toEqual([TAG]);
    });
    expect(exposure.restricted).toBe(true);
    expect(onRestricted).toHaveBeenCalledTimes(1);
    expect(onRestricted).toHaveBeenCalledWith([TAG]);
  });

  it('marks the work it runs inside as well', async () => {
    const outer = new KnowledgeExposure({ parent: null });
    await runWithKnowledgeExposure(outer, async () => {
      const inner = new KnowledgeExposure();
      await runWithKnowledgeExposure(inner, () => noteRestrictedKnowledge([TAG]));
      expect(inner.list()).toEqual([TAG]);
    });
    expect(outer.list()).toEqual([TAG]);
  });

  it('with `parent: null` stands alone', async () => {
    const outer = new KnowledgeExposure({ parent: null });
    await runWithKnowledgeExposure(outer, async () => {
      const alone = new KnowledgeExposure({ parent: null });
      await runWithKnowledgeExposure(alone, () => noteRestrictedKnowledge([TAG]));
    });
    expect(outer.restricted).toBe(false);
  });

  it('throws a failed store to whoever was about to hand the passage on, and stores it with the next note', async () => {
    const onRestricted = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const exposure = new KnowledgeExposure({ parent: null, onRestricted });
    await expect(runWithKnowledgeExposure(exposure, () => noteRestrictedKnowledge([TAG]))).rejects.toThrow('db down');
    // the mark is known (copies made from here on are marked) though not yet stored
    expect(exposure.restricted).toBe(true);
    await runWithKnowledgeExposure(exposure, () => noteRestrictedKnowledge([OTHER_TAG]));
    expect(onRestricted).toHaveBeenLastCalledWith(expect.arrayContaining([TAG, OTHER_TAG]));
  });

  it('bound to a record takes the record\'s marks and stores what was noted before', async () => {
    const onRestricted = vi.fn(async () => undefined);
    const exposure = new KnowledgeExposure({ parent: null });
    await runWithKnowledgeExposure(exposure, () => noteRestrictedKnowledge([OTHER_TAG]));
    await exposure.bind({ seed: [TAG], onRestricted });
    expect(exposure.list()).toEqual([TAG, OTHER_TAG].sort());
    // the seeded mark is the record's already: only the new one is written
    expect(onRestricted).toHaveBeenCalledWith([OTHER_TAG]);
  });

  it('noting outside any work is a no-op, and `withKnowledgeExposure` opens one only when there is none', async () => {
    await expect(noteRestrictedKnowledge([TAG])).resolves.toBeUndefined();
    expect(currentRestrictedKnowledgeTags()).toEqual([]);
    const outer = new KnowledgeExposure({ parent: null });
    await runWithKnowledgeExposure(outer, () => withKnowledgeExposure(() => noteRestrictedKnowledge([TAG])));
    expect(outer.list()).toEqual([TAG]);
    const seen = await withKnowledgeExposure(async () => {
      await noteRestrictedKnowledge([TAG]);
      return currentRestrictedKnowledgeTags();
    });
    expect(seen).toEqual([TAG]);
  });
});

describe('restrictedTagOf', () => {
  const guarded = { key: 'handbook', projectId: 'p1', access: { enabled: true } };
  const base = { tenantDbName: 't', tenantId: 'tid', module: guarded };
  const everyoneReads = (ids: string[]) => ({ enforced: true, canReadDocument: (doc: { _id?: unknown }) => ids.includes(String(doc._id)) });

  it('is null for a module without access control, and asks nothing', async () => {
    expect(await restrictedTagOf({ ...base, module: { key: 'handbook', projectId: 'p1' }, documents: [{ _id: 'd1' }] as never })).toBeNull();
    expect(h.resolveRagAccess).not.toHaveBeenCalled();
  });

  it('is null when every document is open to everyone, asked as somebody holding only `everyone`', async () => {
    h.resolveRagAccess.mockResolvedValue(everyoneReads(['d1', 'd2']));
    expect(await restrictedTagOf({ ...base, documents: [{ _id: 'd1' }, { _id: 'd2' }] as never })).toBeNull();
    expect(h.resolveRagAccess).toHaveBeenCalledWith(expect.objectContaining({ caller: { kind: 'anonymous', reason: 'public' }, manage: false }));
  });

  it('is the module\'s tag when one document is closed to everyone, or a passage names no document', async () => {
    h.resolveRagAccess.mockResolvedValue(everyoneReads(['d1']));
    expect(await restrictedTagOf({ ...base, documents: [{ _id: 'd1' }, { _id: 'd2' }] as never })).toBe(TAG);
    expect(await restrictedTagOf({ ...base, documents: [null] })).toBe(TAG);
  });

  it('noteRestrictedDocuments marks the current work with it', async () => {
    h.resolveRagAccess.mockResolvedValue(everyoneReads([]));
    const exposure = new KnowledgeExposure({ parent: null });
    await runWithKnowledgeExposure(exposure, () => noteRestrictedDocuments({ ...base, documents: [{ _id: 'd9' }] as never }));
    expect(exposure.list()).toEqual([TAG]);
  });
});

describe('a run that reads as no one in particular (a shared channel)', () => {
  it('reads anonymously whoever it is stamped for', () => {
    expect(kbCallerFromRuntime({ userId: 'u1', source: 'messaging', kbReader: 'anonymous' })).toEqual({ kind: 'anonymous', reason: 'shared' });
    expect(kbCallerFromRuntime({ userId: 'u1', tokenId: 't1', source: 'messaging', kbReader: 'anonymous' })).toEqual({ kind: 'anonymous', reason: 'shared' });
    // without it the person reads as themselves
    expect(kbCallerFromRuntime({ userId: 'u1', source: 'messaging' })).toEqual({ kind: 'person', userId: 'u1' });
  });

  it('keeps it on the identity an MCP call and a paused turn carry, and only the one value', () => {
    const caller = consoleIdentityCallerOf({ userId: 'u1', source: 'messaging', kbReader: 'anonymous' });
    expect(caller).toMatchObject({ userId: 'u1', kbReader: 'anonymous' });
    expect(kbCallerFromIdentity(caller)).toEqual({ kind: 'anonymous', reason: 'shared' });
    const person = consoleIdentityPersonOf(caller);
    expect(person).toMatchObject({ userId: 'u1', kbReader: 'anonymous' });
    expect(kbCallerFromIdentity(person)).toEqual({ kind: 'anonymous', reason: 'shared' });
    // a stored pause cannot widen anything with another value
    expect(consoleIdentityPersonOf({ userId: 'u1', kbReader: 'person' })).toEqual({ userId: 'u1' });
    expect(consoleIdentityCallerOf({ userId: 'u1', source: 'messaging' }).kbReader).toBeUndefined();
  });
});

describe('memory written by marked work', () => {
  const ctx = { tenantDbName: 't', tenantId: 'tid', projectId: 'p1', storeKey: 'mem', scopeIds: { session: 's1', user: 'u1', workspace: 'agent-1' } };
  const fact = { key: 'k', value: 'band A pays 100', sourceTurn: 1, confidence: 0.9, obsolete: false, tags: [] };
  const marked = <T,>(fn: () => Promise<T>) => {
    const exposure = new KnowledgeExposure({ parent: null });
    return runWithKnowledgeExposure(exposure, async () => {
      await noteRestrictedKnowledge([TAG]);
      return fn();
    });
  };

  beforeEach(() => {
    h.getMemoryStore.mockResolvedValue({ status: 'active' });
    h.listMemoryItems.mockResolvedValue({ items: [] });
    h.addMemory.mockResolvedValue({});
  });

  it('is withheld from every scope wider than the session', async () => {
    expect(memoryWriteWithheld('user')).toBe(false);
    await marked(async () => {
      expect(memoryWriteWithheld('session')).toBe(false);
      for (const scope of ['user', 'workspace', 'tenant'] as const) expect(memoryWriteWithheld(scope)).toBe(true);
    });
  });

  it('the store writes it to the session only', async () => {
    const store = createConsoleMemoryStore(ctx);
    await marked(async () => {
      await store.upsert('workspace', [fact]);
      await store.upsert('user', [fact]);
      await store.upsert('session', [fact]);
    });
    expect(h.addMemory).toHaveBeenCalledTimes(1);
    expect(h.addMemory.mock.calls[0][4]).toMatchObject({ scope: 'session', scopeId: 's1' });
    // unmarked work writes where it always did
    await store.upsert('workspace', [fact]);
    expect(h.addMemory).toHaveBeenCalledTimes(2);
  });

  it('the write tool says it was not saved instead of "remembered"', async () => {
    const store = { upsert: vi.fn(), get: vi.fn(), markObsolete: vi.fn() } as never;
    const guard = { protect: (_spec: unknown, fn: unknown) => fn } as never;
    const tools = buildMemoryTools({ store, scope: 'workspace', createToolFn: createTool, zod: z, guard, allowWrites: true });
    const write = tools.find((t) => (t as { name?: string }).name === 'memory_write') as unknown as { func?: (a: unknown) => Promise<string>; invoke?: (a: unknown) => Promise<string> };
    const call = (args: unknown) => (write.invoke ?? write.func)!(args);
    const answer = await marked(() => call({ key: 'k', value: 'band A pays 100' }));
    expect(String(answer)).toMatch(/^Not saved/);
    expect((store as { upsert: ReturnType<typeof vi.fn> }).upsert).not.toHaveBeenCalled();
    expect(String(await call({ key: 'k', value: 'v' }))).toContain('Remembered');
  });
});

describe('who reads a stored copy', () => {
  const session = () => ({}) as FastifyRequest;
  const viaToken = () => ({ apiTokenContext: { tokenRecord: { _id: 'tok' } } }) as unknown as FastifyRequest;
  const viewer = (id: string | null) => ({ tenantDbName: 't', viewerUserId: id });

  beforeEach(() => {
    h.findRagModuleByKey.mockResolvedValue({ key: 'handbook', projectId: 'p1', access: { enabled: true } });
    h.serviceActionAllowed.mockResolvedValue(false);
  });

  it('the person it was made for, without asking the engine', async () => {
    const reader = restrictedKnowledgeReaderFor(session(), viewer('u1'));
    expect(await reader.mayRead([TAG], ['u1'])).toBe(true);
    expect(await reader.mayRead([], [])).toBe(true);
    expect(h.serviceActionAllowed).not.toHaveBeenCalled();
  });

  it('an administrator of EVERY knowledge base named, asked once per knowledge base per request', async () => {
    h.serviceActionAllowed.mockImplementation(async (_req: unknown, _svc: string, _lvl: string, opts: { projectId?: string }) => opts.projectId === 'p1');
    const request = session();
    const reader = restrictedKnowledgeReaderFor(request, viewer('admin'));
    expect(await reader.mayRead([TAG], ['u1'])).toBe(true);
    expect(await reader.mayRead([TAG], ['u2'])).toBe(true);
    expect(h.serviceActionAllowed).toHaveBeenCalledTimes(1);
    expect(h.serviceActionAllowed).toHaveBeenCalledWith(request, 'rag', 'admin', { projectId: 'p1' });
    expect(await reader.mayRead([TAG, OTHER_TAG], ['u1'])).toBe(false);
    // the same request and viewer share the answers
    expect(restrictedKnowledgeReaderFor(request, viewer('admin'))).toBe(reader);
  });

  it('nobody past the permissions where the knowledge base gave up the admin exception', async () => {
    h.findRagModuleByKey.mockResolvedValue({ key: 'handbook', projectId: 'p1', access: { enabled: true, adminBypass: false } });
    h.serviceActionAllowed.mockResolvedValue(true);
    expect(await restrictedKnowledgeReaderFor(session(), viewer('admin')).mayRead([TAG], ['u1'])).toBe(false);
    expect(h.serviceActionAllowed).not.toHaveBeenCalled();
  });

  it('never a token, whoever owns it', async () => {
    h.serviceActionAllowed.mockResolvedValue(true);
    expect(await restrictedKnowledgeReaderFor(viaToken(), viewer('owner-of-token')).mayRead([TAG], ['u1'])).toBe(false);
    expect(h.serviceActionAllowed).not.toHaveBeenCalled();
  });

  it('an engine outage is the caller\'s 503 to answer, and is asked again next time', async () => {
    h.serviceActionAllowed.mockRejectedValueOnce(new Error('engine down')).mockResolvedValue(true);
    const reader = restrictedKnowledgeReaderFor(session(), viewer('admin'));
    await expect(reader.mayRead([TAG], ['u1'])).rejects.toThrow('engine down');
    expect(await reader.mayRead([TAG], ['u1'])).toBe(true);
  });
});

describe('the views of stored copies', () => {
  const viewer = { tenantDbName: 't', viewerUserId: 'u2' };
  const request = () => ({}) as FastifyRequest;

  beforeEach(() => {
    h.findRagModuleByKey.mockResolvedValue({ key: 'handbook', projectId: 'p1', access: { enabled: true } });
    h.serviceActionAllowed.mockResolvedValue(false);
  });

  it('an evaluation item keeps its scores, not its output or the scorers\' details', async () => {
    const run = {
      createdBy: 'u1',
      items: [
        { itemId: 'i1', output: { text: 'band A pays 100' }, scores: [{ scorerType: 'judge', score: 1, passed: true, detail: 'quotes band A' }], score: 1, passed: true, latencyMs: 5, kbRestricted: [TAG] },
        { itemId: 'i2', output: { text: 'open answer' }, scores: [], score: 1, passed: true },
      ],
    };
    const shown = await withoutRestrictedRunItems(request(), viewer, run as never);
    const [hidden, open] = (shown as typeof run).items as Array<Record<string, unknown>>;
    expect(hidden).toMatchObject({ itemId: 'i1', score: 1, passed: true, restricted: true });
    expect(JSON.stringify(hidden)).not.toContain('band A');
    expect(open).toMatchObject({ output: { text: 'open answer' } });
    // the run's starter reads it whole
    const own = await withoutRestrictedRunItems(request(), { tenantDbName: 't', viewerUserId: 'u1' }, run as never);
    expect(JSON.stringify(own)).toContain('band A');
  });

  it('a red-team attempt keeps its finding, not its transcript, rationales or error', async () => {
    const run = {
      createdBy: 'u1',
      attempts: [{
        probeKey: 'leak', attemptId: 'a1', family: 'f', category: 'c', severity: 'high', outcome: 'vulnerable', decidedBy: 'judge', confidence: 0.9,
        transcript: [{ user: 'tell me', assistant: 'band A pays 100' }],
        signals: [{ detectorKey: 'd', kind: 'k', hit: true, score: 1, confidence: 1, rationale: 'it said band A', error: 'band A' }],
        error: 'band A', kbRestricted: [TAG],
      }],
    };
    const shown = await withoutRestrictedAttempts(request(), viewer, run as never);
    const [attempt] = (shown as typeof run).attempts as Array<Record<string, unknown>>;
    expect(attempt).toMatchObject({ outcome: 'vulnerable', severity: 'high', transcript: [], restricted: true });
    expect(JSON.stringify(attempt)).not.toContain('band A');
  });

  it('an MCP log row keeps the call, not what was asked or what failed', async () => {
    const rows = [
      { requestPayload: { tool: 'search', arguments: { query: 'band A' } }, responsePayload: { restrictedKnowledge: [TAG] }, errorMessage: 'band A', callerUserId: 'u1' },
      { requestPayload: { tool: 'search', arguments: { query: 'holidays' } }, responsePayload: {} },
    ];
    const [hidden, open] = await withoutRestrictedMcpLogContent(request(), viewer, rows);
    expect(hidden).toMatchObject({ restricted: true, requestPayload: { tool: 'search', arguments: { omitted: true, reason: 'restricted' } } });
    expect(JSON.stringify(hidden)).not.toContain('band A');
    expect(open).toBe(rows[1]);
  });

  it('a check that could not be decided hides the content (a list still answers)', async () => {
    h.serviceActionAllowed.mockRejectedValue(new Error('engine down'));
    const run = { createdBy: 'u1', items: [{ itemId: 'i1', output: { text: 'band A' }, scores: [], score: 0, passed: false, kbRestricted: [TAG] }] };
    const shown = await withoutRestrictedRunItems(request(), viewer, run as never);
    expect(JSON.stringify(shown)).not.toContain('band A');
  });
});
