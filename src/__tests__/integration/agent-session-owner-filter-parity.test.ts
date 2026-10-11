/**
 * The queries behind "a caller who may not view other people's sessions sees only their own": the
 * contract both database providers must keep (SQLite and MongoDB via mongodb-memory-server).
 *
 *  - `listAgentConversations(agentKey, { createdBy })` - one agent's sessions started by one person;
 *  - `listAgentConversationPage({ ownOnly })` - a project's sessions where, for the restricted agents (or
 *    every agent), only the caller's own are visible, cut BEFORE the page so a busy teammate cannot push the
 *    caller's rows off it, and still keyset-paged;
 *  - `listAgentRuns({ userId })` - the background runs the caller queued.
 *
 * Every one of them is checked to be served by an index, so a Cosmos-backed deployment never scans.
 */

import { beforeEach, expect, it } from 'vitest';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { TENANT_DB_INDEXES } from '@/lib/database/mongodb/indexManifest';
import { describeForEachProvider } from './db-parity.helper';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

describeForEachProvider('Sessions listed for their owner only', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';

  beforeEach(async () => {
    const slug = `own-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const conversation = async (agentKey: string, createdBy: string, overrides: Record<string, unknown> = {}) => {
    const created = await getDb().createAgentConversation({
      tenantId, projectId, agentKey, title: `${createdBy} on ${agentKey}`, messages: [], createdBy, metadata: { source: 'api' }, ...overrides,
    } as never);
    await tick();
    return created;
  };
  const ids = (rows: Array<{ _id?: unknown }>) => rows.map((row) => String(row._id));

  it('lists one agent\'s sessions started by one person, newest activity first', async () => {
    const db = getDb();
    const a = await conversation('bot-a', 'ann');
    await conversation('bot-a', 'bob');
    const c = await conversation('bot-a', 'ann');
    await conversation('bot-b', 'ann');
    await db.createAgentConversation({ tenantId, projectId: 'proj-2', agentKey: 'bot-a', messages: [], createdBy: 'ann' } as never);

    expect(ids(await db.listAgentConversations('bot-a', { projectId, createdBy: 'ann' }))).toEqual(ids([c, a]));
    expect(ids(await db.listAgentConversations('bot-a', { projectId, createdBy: 'nobody' }))).toEqual([]);
    // without the filter: everybody's, as before
    expect(await db.listAgentConversations('bot-a', { projectId })).toHaveLength(3);
    // the limit applies after the filter: a teammate's newer sessions do not push these off
    for (let i = 0; i < 5; i += 1) await conversation('bot-a', 'bob');
    expect(ids(await db.listAgentConversations('bot-a', { projectId, createdBy: 'ann', limit: 2 }))).toEqual(ids([c, a]));
  });

  it('a project page: every agent\'s sessions are the caller\'s own when no agent is named as exempt', async () => {
    const db = getDb();
    const own = await conversation('bot-a', 'ann');
    await conversation('bot-a', 'bob');
    const ownB = await conversation('bot-b', 'ann');
    await conversation('bot-b', 'bob');
    expect(ids(await db.listAgentConversationPage({ projectId, limit: 10, ownOnly: { userId: 'ann' } }))).toEqual(ids([ownB, own]));
    expect(await db.listAgentConversationPage({ projectId, limit: 10 })).toHaveLength(4);
  });

  it('a project page: only the RESTRICTED agents are cut to the caller\'s own; the others stay whole', async () => {
    const db = getDb();
    const aOwn = await conversation('bot-a', 'ann');
    await conversation('bot-a', 'bob');
    const bOthers = await conversation('bot-b', 'bob');
    const bOwn = await conversation('bot-b', 'ann');
    const cOthers = await conversation('bot-c', 'bob');

    const page = await db.listAgentConversationPage({ projectId, limit: 10, ownOnly: { userId: 'ann', agentKeys: ['bot-a'] } });
    expect(ids(page)).toEqual(ids([cOthers, bOwn, bOthers, aOwn]));
    // two restricted agents
    expect(ids(await db.listAgentConversationPage({ projectId, limit: 10, ownOnly: { userId: 'ann', agentKeys: ['bot-a', 'bot-b'] } })))
      .toEqual(ids([cOthers, bOwn, aOwn]));
    // an empty list restricts nobody
    expect(await db.listAgentConversationPage({ projectId, limit: 10, ownOnly: { userId: 'ann', agentKeys: [] } })).toHaveLength(5);
    // naming the agent in the page filter works together with the restriction
    expect(ids(await db.listAgentConversationPage({ projectId, agentKey: 'bot-a', limit: 10, ownOnly: { userId: 'ann', agentKeys: ['bot-a'] } }))).toEqual(ids([aOwn]));
  });

  it('the restriction is applied before the page is cut, and keyset paging still works through it', async () => {
    const db = getDb();
    const mine: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      mine.push(String((await conversation('bot-a', 'ann'))._id));
      await conversation('bot-a', 'bob');
      await conversation('bot-a', 'bob');
    }
    const expected = [...mine].reverse();
    const ownOnly = { userId: 'ann', agentKeys: ['bot-a'] };
    const first = await db.listAgentConversationPage({ projectId, limit: 2, ownOnly });
    expect(ids(first)).toEqual(expected.slice(0, 2));
    const cursor = (row: { _id?: unknown; createdAt?: Date }) => ({ createdAt: row.createdAt!, id: String(row._id) });
    const second = await db.listAgentConversationPage({ projectId, limit: 2, ownOnly, after: cursor(first[1]) });
    expect(ids(second)).toEqual(expected.slice(2, 4));
    expect(await db.listAgentConversationPage({ projectId, limit: 2, ownOnly, after: cursor(second[1]) })).toEqual([]);
  });

  it('background runs: the ones one person queued', async () => {
    const db = getDb();
    const run = (userId: string, conversationId: string) => db.createAgentRun({
      mode: 'background', tenantId, tenantDbName: dbName, projectId, agentKey: 'bot-a', conversationId, userMessage: 'hi', status: 'queued', userId,
    } as never);
    const r1 = await run('ann', 'c1');
    await run('bob', 'c2');
    const r3 = await run('ann', 'c3');
    const listed = await db.listAgentRuns({ tenantId, projectId, agentKey: 'bot-a', userId: 'ann' });
    expect(listed.map((r) => String(r._id)).sort()).toEqual([String(r1._id), String(r3._id)].sort());
    expect(await db.listAgentRuns({ tenantId, projectId, agentKey: 'bot-a' })).toHaveLength(3);
    expect(await db.listAgentRuns({ tenantId, projectId, agentKey: 'bot-a', userId: 'nobody' })).toEqual([]);
  });

  it('every new query is served by an index', async () => {
    const db = getDb();
    await conversation('bot-a', 'ann');
    if (db instanceof SQLiteProvider) {
      const sqlite = (db as unknown as { getTenantDb(): import('better-sqlite3').Database }).getTenantDb();
      const plan = (sql: string, params: Record<string, unknown>) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>)
        .map((row) => row.detail).join(' | ');
      const mine = plan(
        'SELECT * FROM agent_conversations WHERE agentKey = @a AND projectId = @p AND createdBy = @u ORDER BY updatedAt DESC LIMIT 5',
        { a: 'bot-a', p: projectId, u: 'ann' },
      );
      expect(mine).toContain('idx_aconv_agent_creator');
      const runs = plan(
        'SELECT * FROM agent_runs WHERE tenantId = @t AND projectId = @p AND agentKey = @a AND userId = @u ORDER BY createdAt DESC LIMIT 5',
        { t: tenantId, p: projectId, a: 'bot-a', u: 'ann' },
      );
      expect(runs).toContain('idx_agent_runs_project_agent_user');
    }
    if (db instanceof MongoDBProvider) {
      const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb();
      const plan = async (collection: string, filter: Record<string, unknown>, sort: Record<string, 1 | -1>) => JSON.stringify(
        await tenantDb.collection(collection).find(filter).sort(sort).explain('queryPlanner'),
      );
      const mine = await plan('agent_conversations', { agentKey: 'bot-a', projectId, createdBy: 'ann' }, { updatedAt: -1 });
      expect(mine).toContain('IXSCAN');
      expect(mine).not.toContain('COLLSCAN');
      // the project page with a restriction: the project's index serves it, the restriction filters the entries it reads
      const page = await plan(
        'agent_conversations',
        { projectId, $and: [{ $or: [{ createdBy: 'ann' }, { agentKey: { $nin: ['bot-a'] } }] }] },
        { createdAt: -1, _id: -1 },
      );
      expect(page).toContain('IXSCAN');
      expect(page).not.toContain('COLLSCAN');
      // the manifest names the index the matching query needs
      expect(TENANT_DB_INDEXES.agent_conversations.map((index) => JSON.stringify(index.key))).toContain(JSON.stringify({ agentKey: 1, createdBy: 1, updatedAt: -1 }));
      expect(TENANT_DB_INDEXES.agent_runs.map((index) => JSON.stringify(index.key))).toContain(JSON.stringify({ tenantId: 1, projectId: 1, agentKey: 1, userId: 1, createdAt: -1 }));
    }
  });
});
