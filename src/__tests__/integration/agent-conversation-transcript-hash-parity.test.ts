/**
 * The lookup behind "a chat-completions client that resends its transcript continues its session": a
 * session is found by the digest of the transcript its last turn left, scoped to project, agent and the
 * person who started it. The contract both database providers must keep (SQLite and MongoDB via
 * mongodb-memory-server), served by an index so a Cosmos-backed deployment never scans.
 */

import { beforeEach, expect, it } from 'vitest';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { TENANT_DB_INDEXES } from '@/lib/database/mongodb/indexManifest';
import { describeForEachProvider } from './db-parity.helper';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

describeForEachProvider('Sessions found by their transcript digest', (getDb) => {
  let tenantId: string;
  const projectId = 'proj-1';

  beforeEach(async () => {
    const slug = `th-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const conversation = async (agentKey: string, createdBy: string, overrides: Record<string, unknown> = {}) => {
    const created = await getDb().createAgentConversation({
      tenantId, projectId, agentKey, messages: [], createdBy, metadata: { source: 'api' }, ...overrides,
    } as never);
    await tick();
    return created;
  };

  const ids = (found: Array<{ _id?: unknown }>) => found.map((entry) => String(entry._id));

  it('finds the session by project, agent, owner and digest; nothing for another one of those', async () => {
    const db = getDb();
    const mine = await conversation('bot-a', 'ann');
    await db.updateAgentConversationRuntime(String(mine._id), { transcriptHash: 'h1' });
    const filter = { projectId, agentKey: 'bot-a', createdBy: 'ann', transcriptHash: 'h1' };

    expect(ids(await db.findAgentConversationsByTranscriptHash(filter, 2))).toEqual([String(mine._id)]);
    expect((await db.findAgentConversationsByTranscriptHash(filter, 2))[0]?.transcriptHash).toBe('h1');
    expect(await db.findAgentConversationsByTranscriptHash({ ...filter, transcriptHash: 'h2' }, 2)).toEqual([]);
    expect(await db.findAgentConversationsByTranscriptHash({ ...filter, createdBy: 'bob' }, 2)).toEqual([]);
    expect(await db.findAgentConversationsByTranscriptHash({ ...filter, agentKey: 'bot-b' }, 2)).toEqual([]);
    expect(await db.findAgentConversationsByTranscriptHash({ ...filter, projectId: 'proj-2' }, 2)).toEqual([]);
  });

  it('a newer digest replaces the older one on the same session', async () => {
    const db = getDb();
    const session = await conversation('bot-a', 'ann');
    const filter = { projectId, agentKey: 'bot-a', createdBy: 'ann' };
    await db.updateAgentConversationRuntime(String(session._id), { transcriptHash: 'h1' });
    await db.updateAgentConversationRuntime(String(session._id), { transcriptHash: 'h2' });
    expect(await db.findAgentConversationsByTranscriptHash({ ...filter, transcriptHash: 'h1' }, 2)).toEqual([]);
    expect(ids(await db.findAgentConversationsByTranscriptHash({ ...filter, transcriptHash: 'h2' }, 2))).toEqual([String(session._id)]);
  });

  it('answers every session of the owner that carries the digest, most recently updated first, up to the limit', async () => {
    const db = getDb();
    const older = await conversation('bot-a', 'ann');
    const newer = await conversation('bot-a', 'ann');
    const third = await conversation('bot-a', 'ann');
    await db.updateAgentConversationRuntime(String(third._id), { transcriptHash: 'same' });
    await db.updateAgentConversationRuntime(String(newer._id), { transcriptHash: 'same' });
    await db.updateAgentConversationRuntime(String(older._id), { transcriptHash: 'same' });
    await db.updateAgentConversation(String(newer._id), { title: 'touched later' });
    const filter = { projectId, agentKey: 'bot-a', createdBy: 'ann', transcriptHash: 'same' };
    expect(ids(await db.findAgentConversationsByTranscriptHash(filter, 2))).toEqual([String(newer._id), String(third._id)]);
    expect(await db.findAgentConversationsByTranscriptHash(filter, 5)).toHaveLength(3);
  });

  it('is served by an index', async () => {
    const db = getDb();
    const session = await conversation('bot-a', 'ann');
    await db.updateAgentConversationRuntime(String(session._id), { transcriptHash: 'h1' });
    if (db instanceof SQLiteProvider) {
      const sqlite = (db as unknown as { getTenantDb(): import('better-sqlite3').Database }).getTenantDb();
      const plan = (sqlite.prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM agent_conversations WHERE projectId = @p AND agentKey = @a AND createdBy = @u AND transcriptHash = @h ORDER BY updatedAt DESC LIMIT 2',
      ).all({ p: projectId, a: 'bot-a', u: 'ann', h: 'h1' }) as Array<{ detail: string }>).map((row) => row.detail).join(' | ');
      expect(plan).toContain('idx_aconv_transcript');
    }
    if (db instanceof MongoDBProvider) {
      const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb();
      const plan = JSON.stringify(
        await tenantDb.collection('agent_conversations')
          .find({ projectId, agentKey: 'bot-a', createdBy: 'ann', transcriptHash: 'h1' })
          .sort({ updatedAt: -1 })
          .explain('queryPlanner'),
      );
      expect(plan).toContain('idx_transcript_hash');
      expect(plan).not.toContain('COLLSCAN');
      // The manifest names the index the write path creates, and it is not a partial one (Cosmos rejects those).
      const entry = TENANT_DB_INDEXES.agent_conversations.find((index) => index.options?.name === 'idx_transcript_hash');
      expect(entry?.key).toEqual({ projectId: 1, agentKey: 1, createdBy: 1, transcriptHash: 1, updatedAt: -1 });
      expect(entry?.options).not.toHaveProperty('partialFilterExpression');
    }
  });
});
