/**
 * Analysis results and the agent-conversation reader behind them: the contract both database providers must keep
 * (SQLite and MongoDB via mongodb-memory-server). The two are written independently; the same assertions run on both.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import type { IAnalysisResult } from '@/lib/database/provider/types.domain';
import { describeForEachProvider } from './db-parity.helper';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeForEachProvider('Analysis results', (getDb) => {
  let tenantId: string;
  const projectId = 'proj-1';

  beforeEach(async () => {
    const slug = `ares-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    await db.switchToTenant(dbName);
    tenantId = String(tenant._id);
  });

  const result = (over: Partial<Omit<IAnalysisResult, '_id' | 'createdAt' | 'updatedAt'>> = {}) => ({
    tenantId, projectId, definitionKey: 'def', sourceKind: 'conversation' as const, sourceId: 'c1', runId: 'run-1',
    decisions: { mood: { answer: 'happy', confidence: 0.9 } }, extractedFields: { a: 1 },
    needsReview: false, minConfidence: 0.9, analyzedAt: new Date('2026-01-01T00:00:00Z'), ...over,
  });

  describe('results', () => {
    it('upserts on the unique key: one row, createdAt kept, fields and updatedAt replaced, review passed through', async () => {
      const db = getDb();
      const first = await db.upsertAnalysisResult(result());
      expect(typeof first._id).toBe('string');
      await sleep(15);
      const review = { values: { mood: 'sad' }, by: 'u1', at: '2026-01-02T00:00:00.000Z' };
      const second = await db.upsertAnalysisResult(result({ runId: 'run-2', extractedFields: { a: 2 }, needsReview: true, minConfidence: 0.2, review }));
      expect(String(second._id)).toBe(String(first._id));
      expect(second.runId).toBe('run-2');
      expect(second.extractedFields).toEqual({ a: 2 });
      expect(second.needsReview).toBe(true);
      expect(second.review).toEqual(review);
      expect(new Date(second.createdAt!).getTime()).toBe(new Date(first.createdAt!).getTime());
      expect(new Date(second.updatedAt!).getTime()).toBeGreaterThan(new Date(first.updatedAt!).getTime());
      expect(await db.countAnalysisResults({ projectId })).toBe(1);
    });

    it('replaces the whole row: optional fields the new result lacks are gone', async () => {
      const db = getDb();
      await db.upsertAnalysisResult(result({
        rationale: 'old', reviewReason: 'spot_check', judge: { score: 0.4 }, title: 'T', sourceVersion: { messageCount: 2 },
      }));
      const again = await db.upsertAnalysisResult(result({ runId: 'run-2' }));
      const found = await db.findAnalysisResultById(String(again._id));
      for (const key of ['rationale', 'reviewReason', 'judge', 'title', 'sourceVersion'] as const) {
        expect(found?.[key] ?? undefined).toBeUndefined();
      }
      expect(found?.runId).toBe('run-2');
    });

    it('finds a result by its string id, and null for an unknown or malformed id', async () => {
      const db = getDb();
      const row = await db.upsertAnalysisResult(result({ title: 'T' }));
      const found = await db.findAnalysisResultById(String(row._id));
      expect(found).toMatchObject({ definitionKey: 'def', sourceId: 'c1', title: 'T', decisions: { mood: { answer: 'happy', confidence: 0.9 } } });
      expect(typeof found!._id).toBe('string');
      expect(found!.analyzedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
      expect(await db.findAnalysisResultById('nope')).toBeNull();
      expect(await db.findAnalysisResultById('64b7f0f0f0f0f0f0f0f0f0f0')).toBeNull();
    });

    const seed = async (db: DatabaseProvider) => {
      const reviewed = { values: { mood: 'x' }, by: 'u', at: '2026-01-01T00:00:00.000Z' };
      await db.upsertAnalysisResult(result({ sourceId: 'a', analyzedAt: new Date('2026-01-01T00:00:00Z'), minConfidence: 0.9 }));
      await db.upsertAnalysisResult(result({ sourceId: 'b', analyzedAt: new Date('2026-01-02T00:00:00Z'), minConfidence: 0.3, needsReview: true }));
      await db.upsertAnalysisResult(result({ sourceId: 'c', analyzedAt: new Date('2026-01-03T00:00:00Z'), minConfidence: 0.5, review: reviewed }));
      await db.upsertAnalysisResult(result({ definitionKey: 'other', sourceId: 'd', analyzedAt: new Date('2026-01-04T00:00:00Z') }));
      await db.upsertAnalysisResult(result({
        sourceKind: 'agent_session', sourceId: 's1', agentKey: 'bot', ownerId: 'u1', analyzedAt: new Date('2026-01-05T00:00:00Z'), minConfidence: 0.1, needsReview: true,
      }));
      await db.upsertAnalysisResult(result({
        sourceKind: 'agent_session', sourceId: 's2', agentKey: 'secret', ownerId: 'u2', analyzedAt: new Date('2026-01-06T00:00:00Z'),
      }));
      await db.upsertAnalysisResult(result({ projectId: 'proj-2', sourceId: 'z' }));
    };
    const ids = (rows: IAnalysisResult[]) => rows.map((r) => r.sourceId);

    it('filters by definition, source kind, source ids, needsReview and reviewed', async () => {
      const db = getDb();
      await seed(db);
      expect(ids(await db.listAnalysisResults({ projectId }))).toEqual(['s2', 's1', 'd', 'c', 'b', 'a']);
      expect(ids(await db.listAnalysisResults({ projectId, definitionKey: 'other' }))).toEqual(['d']);
      expect(ids(await db.listAnalysisResults({ projectId, definitionKey: 'def', sourceKind: 'agent_session' }))).toEqual(['s2', 's1']);
      expect(ids(await db.listAnalysisResults({ projectId, sourceIds: ['a', 'c', 'nope'] }))).toEqual(['c', 'a']);
      expect(await db.listAnalysisResults({ projectId, sourceIds: [] })).toEqual([]);
      expect(ids(await db.listAnalysisResults({ projectId, needsReview: true }))).toEqual(['s1', 'b']);
      expect(ids(await db.listAnalysisResults({ projectId, needsReview: false, definitionKey: 'def', sourceKind: 'conversation' }))).toEqual(['c', 'a']);
      expect(ids(await db.listAnalysisResults({ projectId, reviewed: true }))).toEqual(['c']);
      expect(ids(await db.listAnalysisResults({ projectId, reviewed: false, sourceKind: 'conversation', definitionKey: 'def' }))).toEqual(['b', 'a']);
    });

    it('limits agent-session rows to a restricted viewer: their agents and their own sessions', async () => {
      const db = getDb();
      await seed(db);
      const viewer = { userId: 'u1', agentKeys: [] as string[] };
      expect(ids(await db.listAnalysisResults({ projectId, viewer }))).toEqual(['s1', 'd', 'c', 'b', 'a']);
      expect(ids(await db.listAnalysisResults({ projectId, viewer: { userId: 'u9', agentKeys: ['secret'] } }))).toEqual(['s2', 'd', 'c', 'b', 'a']);
      expect(await db.countAnalysisResults({ projectId, viewer: { userId: 'u9', agentKeys: [] } })).toBe(4);
    });

    it('sorts by recency or by lowest confidence first, and pages with limit and skip', async () => {
      const db = getDb();
      await seed(db);
      const f = { projectId, definitionKey: 'def' };
      expect(ids(await db.listAnalysisResults({ ...f, sort: 'confidence' }))).toEqual(['s1', 'b', 'c', 's2', 'a']);
      expect(ids(await db.listAnalysisResults({ ...f, sort: 'recent', limit: 2, skip: 1 }))).toEqual(['s1', 'c']);
      expect(ids(await db.listAnalysisResults({ ...f, limit: 2, skip: 4 }))).toEqual(['a']);
    });

    it('counts with the same filters', async () => {
      const db = getDb();
      await seed(db);
      expect(await db.countAnalysisResults({ projectId })).toBe(6);
      expect(await db.countAnalysisResults({ projectId, needsReview: true })).toBe(2);
      expect(await db.countAnalysisResults({ projectId, definitionKey: 'other' })).toBe(1);
      expect(await db.countAnalysisResults({ projectId, reviewed: true })).toBe(1);
    });

    it('records a review and clears needsReview; null for an unknown id', async () => {
      const db = getDb();
      const row = await db.upsertAnalysisResult(result({ needsReview: true, reviewReason: 'low_confidence', minConfidence: 0.2 }));
      const review = { values: { mood: 'sad' }, by: 'u1', at: '2026-02-01T00:00:00.000Z' };
      const updated = await db.updateAnalysisResultReview(String(row._id), review);
      expect(updated).toMatchObject({ needsReview: false, review, reviewReason: 'low_confidence' });
      expect((await db.findAnalysisResultById(String(row._id)))?.review).toEqual(review);
      expect(await db.updateAnalysisResultReview('64b7f0f0f0f0f0f0f0f0f0f0', review)).toBeNull();
      expect(await db.updateAnalysisResultReview('nope', review)).toBeNull();
    });

    it('deletes the results of one definition in one project and says how many', async () => {
      const db = getDb();
      await seed(db);
      await db.upsertAnalysisResult(result({ projectId: 'proj-2', sourceId: 'z2' }));
      expect(await db.deleteAnalysisResultsForDefinition(projectId, 'def')).toBe(5);
      expect(await db.countAnalysisResults({ projectId })).toBe(1);
      expect(await db.countAnalysisResults({ projectId: 'proj-2' })).toBe(2);
      expect(await db.deleteAnalysisResultsForDefinition(projectId, 'def')).toBe(0);
    });
  });

  describe('definitions', () => {
    it('round-trips the decision model, source and review settings, and clears the decision model', async () => {
      const db = getDb();
      const created = await db.createAnalysisDefinition({
        tenantId, projectId, key: `def-${Date.now()}`, name: 'Decisions', createdBy: 'u1', modes: {},
        fieldSet: [{ key: 'tone', type: 'score', levels: ['poor', 'ok', 'great'], reviewBelow: 0.8 }],
        decisionModelKey: 'decider',
        source: { kind: 'agent_sessions', agentKeys: ['support'], minMessages: 3, days: 14 },
        review: { threshold: 0.85, spotCheckPct: 5 },
      });
      const found = await db.findAnalysisDefinitionById(String(created._id));
      expect(found).toMatchObject({
        decisionModelKey: 'decider',
        source: { kind: 'agent_sessions', agentKeys: ['support'], minMessages: 3, days: 14 },
        review: { threshold: 0.85, spotCheckPct: 5 },
        fieldSet: [{ key: 'tone', type: 'score', levels: ['poor', 'ok', 'great'], reviewBelow: 0.8 }],
      });

      // A present-but-undefined key clears it; an absent key leaves the rest alone.
      const cleared = await db.updateAnalysisDefinition(String(created._id), { decisionModelKey: undefined });
      expect(cleared?.decisionModelKey ?? undefined).toBeUndefined();
      expect(cleared).toMatchObject({ name: 'Decisions', review: { threshold: 0.85, spotCheckPct: 5 } });
      expect(cleared?.source).toMatchObject({ kind: 'agent_sessions', agentKeys: ['support'] });
    });
  });

  describe('listAgentConversationsForAnalysis', () => {
    const make = (agentKey: string, createdBy: string, n = 2) => getDb().createAgentConversation({
      tenantId, projectId, agentKey, title: `${agentKey}-${createdBy}`, createdBy,
      messages: Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}`, timestamp: new Date('2026-03-01T00:00:00Z'),
      })),
      runtimeTurnId: 'turn-secret',
    } as never);
    const titles = (rows: Array<{ title?: string }>) => rows.map((r) => r.title);

    it('filters by agent keys (an empty list matches nothing) and ids (an empty list matches nothing)', async () => {
      const db = getDb();
      const a = await make('alpha', 'u1');
      const b = await make('beta', 'u1');
      await make('gamma', 'u1');
      const base = { projectId, limit: 50, fields: 'meta' as const };
      expect((await db.listAgentConversationsForAnalysis(base)).length).toBe(3);
      expect(titles(await db.listAgentConversationsForAnalysis({ ...base, agentKeys: ['beta', 'alpha'] })).sort()).toEqual(['alpha-u1', 'beta-u1']);
      expect(await db.listAgentConversationsForAnalysis({ ...base, agentKeys: [] })).toEqual([]);
      expect(titles(await db.listAgentConversationsForAnalysis({ ...base, ids: [String(b._id), 'junk'] }))).toEqual(['beta-u1']);
      expect(await db.listAgentConversationsForAnalysis({ ...base, ids: [] })).toEqual([]);
      const rows = await db.listAgentConversationsForAnalysis({ ...base, ids: [String(a._id)] });
      expect(typeof rows[0]._id).toBe('string');
      expect(await db.listAgentConversationsForAnalysis({ ...base, projectId: 'other' })).toEqual([]);
    });

    it('applies the updatedAt window (from inclusive, to exclusive)', async () => {
      const db = getDb();
      await make('alpha', 'u1');
      await sleep(30);
      const mid = await make('beta', 'u1');
      await sleep(30);
      await make('gamma', 'u1');
      const base = { projectId, limit: 50, fields: 'meta' as const };
      const midAt = new Date((await db.listAgentConversationsForAnalysis({ ...base, ids: [String(mid._id)] }))[0].updatedAt!);
      expect(titles(await db.listAgentConversationsForAnalysis({ ...base, updatedFrom: midAt }))).toEqual(['gamma-u1', 'beta-u1']);
      expect(titles(await db.listAgentConversationsForAnalysis({ ...base, updatedTo: midAt }))).toEqual(['alpha-u1']);
      expect(titles(await db.listAgentConversationsForAnalysis({ ...base, updatedFrom: midAt, updatedTo: new Date(midAt.getTime() + 1) }))).toEqual(['beta-u1']);
    });

    it('with ownOnly returns own sessions and every session of the viewable agents', async () => {
      const db = getDb();
      await make('alpha', 'me');
      await make('alpha', 'them');
      await make('beta', 'them');
      await make('beta', 'me');
      const base = { projectId, limit: 50, fields: 'meta' as const };
      expect(titles(await db.listAgentConversationsForAnalysis({ ...base, ownOnly: { userId: 'me' } })).sort()).toEqual(['alpha-me', 'beta-me']);
      expect(titles(await db.listAgentConversationsForAnalysis({ ...base, ownOnly: { userId: 'me', viewableAgentKeys: ['beta'] } })).sort())
        .toEqual(['alpha-me', 'beta-me', 'beta-them']);
    });

    it('pages newest-updated first with a keyset cursor', async () => {
      const db = getDb();
      for (const key of ['a', 'b', 'c', 'd', 'e']) { await make(key, 'u1'); await sleep(5); }
      const base = { projectId, fields: 'meta' as const };
      const page1 = await db.listAgentConversationsForAnalysis({ ...base, limit: 2 });
      expect(titles(page1)).toEqual(['e-u1', 'd-u1']);
      const last = page1[1];
      const page2 = await db.listAgentConversationsForAnalysis({ ...base, limit: 2, before: { updatedAt: new Date(last.updatedAt!), id: String(last._id) } });
      expect(titles(page2)).toEqual(['c-u1', 'b-u1']);
      const l2 = page2[1];
      const page3 = await db.listAgentConversationsForAnalysis({ ...base, limit: 2, before: { updatedAt: new Date(l2.updatedAt!), id: String(l2._id) } });
      expect(titles(page3)).toEqual(['a-u1']);
    });

    it("returns messages as { role, content: '', timestamp } for meta and the transcript for full, never runtimeTurnId", async () => {
      const db = getDb();
      await make('alpha', 'u1', 3);
      const base = { projectId, limit: 5 };
      const [meta] = await db.listAgentConversationsForAnalysis({ ...base, fields: 'meta' });
      expect(meta.messages).toHaveLength(3);
      expect(meta.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      for (const m of meta.messages) {
        expect(m.content).toBe('');
        expect(new Date(m.timestamp as never).toISOString()).toBe('2026-03-01T00:00:00.000Z');
      }
      expect(meta).not.toHaveProperty('runtimeTurnId');
      const [full] = await db.listAgentConversationsForAnalysis({ ...base, fields: 'full' });
      expect(full.messages.map((m) => m.content)).toEqual(['message 0', 'message 1', 'message 2']);
      expect(full).not.toHaveProperty('runtimeTurnId');
      expect(full).toMatchObject({ agentKey: 'alpha', projectId, createdBy: 'u1' });
    });
  });
});
