/**
 * The query behind the dashboard's cross-agent Sessions list, `listProjectAgentConversations`: the contract both
 * database providers must keep (SQLite and MongoDB via mongodb-memory-server).
 *
 *  - a project's conversations, most recently updated first (`updatedAt`, then id), each message cut down to a tally;
 *  - narrowed by runtime status (an empty list matches nothing, 'idle' also matches one that never ran) and by id;
 *  - the same `ownOnly` restriction as `listAgentConversationPage`, applied before the page is cut;
 *  - keyset paging on (updatedAt, id), also when the narrowing filters are combined;
 *  - served by an index, so a Cosmos-backed deployment never scans.
 */

import { beforeEach, expect, it } from 'vitest';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { TENANT_DB_INDEXES } from '@/lib/database/mongodb/indexManifest';
import { describeForEachProvider } from './db-parity.helper';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

describeForEachProvider('Project sessions by last activity', (getDb) => {
  let tenantId: string;
  const projectId = 'proj-1';

  beforeEach(async () => {
    const slug = `pls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const conversation = async (agentKey: string, createdBy: string, overrides: Record<string, unknown> = {}) => {
    const created = await getDb().createAgentConversation({
      tenantId, projectId, agentKey, title: `${createdBy} on ${agentKey}`, messages: [{ role: 'user', content: 'hi' }], createdBy, metadata: { source: 'api' }, ...overrides,
    } as never);
    await tick();
    return created;
  };
  const setStatus = (row: { _id?: unknown }, runtimeStatus: 'idle' | 'running' | 'requires_action' | 'budget_paused') =>
    getDb().updateAgentConversationRuntime(String(row._id), { runtimeStatus });
  const ids = (rows: Array<{ _id?: unknown }>) => rows.map((row) => String(row._id));

  it('lists a project\'s sessions across agents, most recently updated first, one tally per message', async () => {
    const db = getDb();
    const a = await conversation('bot-a', 'ann');
    const b = await conversation('bot-b', 'bob');
    const c = await conversation('bot-a', 'ann');
    await db.createAgentConversation({ tenantId, projectId: 'proj-2', agentKey: 'bot-a', messages: [], createdBy: 'ann' } as never);

    const rows = await db.listProjectAgentConversations({ projectId, limit: 10 });
    expect(ids(rows)).toEqual(ids([c, b, a]));
    expect(rows[0].messages).toHaveLength(1);
    expect(rows[0].agentKey).toBe('bot-a');

    // writing to the oldest session moves it to the top: the order is by activity, not creation
    await db.updateAgentConversation(String(a._id), { title: 'renamed' });
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10 }))).toEqual(ids([a, c, b]));
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 2 }))).toEqual(ids([a, c]));
    expect(await db.listProjectAgentConversations({ projectId: 'proj-none', limit: 10 })).toEqual([]);
  });

  it('a row carries a tally per message - what a summary counts - and never the transcript', async () => {
    const db = getDb();
    const created = await conversation('bot-a', 'ann', {
      messages: [
        { role: 'user', content: 'secret question', attachments: [{ fileId: 'f1', name: 'a.txt', mimeType: 'text/plain', size: 3 }] },
        {
          role: 'assistant',
          content: 'secret answer',
          reasoning: 'secret thoughts',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.25 },
          latencyMs: 1200,
          stopReason: 'limit',
          outputError: 'schema failed',
          steps: [
            { name: 'search', args: { q: 'secret' }, output: { hits: 1 }, status: 'success' },
            { name: 'fetch', args: { url: 'x' }, output: 'oops', status: 'error', error: 'timeout' },
          ],
        },
        { role: 'assistant', content: 'plain' },
      ],
    });

    const [row] = await db.listProjectAgentConversations({ projectId, limit: 5, ids: [String(created._id)] });
    expect(row.messages).toHaveLength(3);
    expect(row.messages[0].role).toBe('user');
    const turn = row.messages[1];
    expect(turn).toMatchObject({
      role: 'assistant',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.25 },
      latencyMs: 1200,
      stopReason: 'limit',
      outputError: 'schema failed',
    });
    expect(turn.steps).toEqual([{ status: 'success' }, { status: 'error', error: 'timeout' }]);
    // a message without steps still has a (empty) tally list
    expect(row.messages[2].steps ?? []).toEqual([]);
    const shipped = JSON.stringify(row);
    for (const secret of ['secret question', 'secret answer', 'secret thoughts', 'a.txt', '"search"', '"hits"', '"args"', '"output"', '"attachments"', '"reasoning"', '"content"']) {
      expect(shipped).not.toContain(secret);
    }
    // the stored conversation is untouched
    const stored = await db.findAgentConversationById(String(created._id));
    expect(stored?.messages[1].content).toBe('secret answer');
  });

  it('keyset paging: `before` is the last row of the previous page', async () => {
    const db = getDb();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) created.push(String((await conversation('bot-a', 'ann'))._id));
    const expected = [...created].reverse();

    const first = await db.listProjectAgentConversations({ projectId, limit: 2 });
    expect(ids(first)).toEqual(expected.slice(0, 2));
    const keyset = (row: { _id?: unknown; updatedAt?: Date }) => ({ updatedAt: row.updatedAt!, id: String(row._id) });
    const second = await db.listProjectAgentConversations({ projectId, limit: 2, before: keyset(first[1]) });
    expect(ids(second)).toEqual(expected.slice(2, 4));
    const third = await db.listProjectAgentConversations({ projectId, limit: 2, before: keyset(second[1]) });
    expect(ids(third)).toEqual(expected.slice(4));
    expect(await db.listProjectAgentConversations({ projectId, limit: 2, before: keyset(third[0]) })).toEqual([]);
  });

  it('runtimeStatuses: any of the listed states; "idle" also matches a session that never ran', async () => {
    const db = getDb();
    const fresh = await conversation('bot-a', 'ann');
    const running = await conversation('bot-a', 'ann');
    const waiting = await conversation('bot-b', 'ann');
    const paused = await conversation('bot-b', 'ann');
    const idle = await conversation('bot-a', 'ann');
    await setStatus(running, 'running');
    await setStatus(waiting, 'requires_action');
    await setStatus(paused, 'budget_paused');
    await setStatus(idle, 'idle');

    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, runtimeStatuses: ['running', 'requires_action', 'budget_paused'] })))
      .toEqual(ids([paused, waiting, running]));
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, runtimeStatuses: ['running'] }))).toEqual(ids([running]));
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, runtimeStatuses: ['idle'] }))).toEqual(ids([idle, fresh]));
    expect(await db.listProjectAgentConversations({ projectId, limit: 10, runtimeStatuses: [] })).toEqual([]);
  });

  it('ids: only those sessions; ids that name nothing (or are no ids) match nothing; an empty list matches nothing', async () => {
    const db = getDb();
    const a = await conversation('bot-a', 'ann');
    await conversation('bot-a', 'ann');
    const c = await conversation('bot-b', 'bob');
    const other = await db.createAgentConversation({ tenantId, projectId: 'proj-2', agentKey: 'bot-a', messages: [], createdBy: 'ann' } as never);

    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ids: [String(a._id), String(c._id)] }))).toEqual(ids([c, a]));
    // an id of another project is not found through this one
    expect(await db.listProjectAgentConversations({ projectId, limit: 10, ids: [String(other._id)] })).toEqual([]);
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ids: [String(a._id), 'not an id', 'ffffffffffffffffffffffff'] }))).toEqual(ids([a]));
    expect(await db.listProjectAgentConversations({ projectId, limit: 10, ids: ['not an id'] })).toEqual([]);
    expect(await db.listProjectAgentConversations({ projectId, limit: 10, ids: [] })).toEqual([]);
  });

  it('ids and runtimeStatuses together both apply', async () => {
    const db = getDb();
    const running = await conversation('bot-a', 'ann');
    const idle = await conversation('bot-a', 'ann');
    await setStatus(running, 'running');
    const both = [String(running._id), String(idle._id)];
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ids: both, runtimeStatuses: ['running'] }))).toEqual(ids([running]));
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ids: [String(idle._id)], runtimeStatuses: ['running'] }))).toEqual([]);
  });

  it('ownOnly: the caller\'s own sessions plus every session of the agents they may view, cut before the page', async () => {
    const db = getDb();
    const aOwn = await conversation('bot-a', 'ann');
    await conversation('bot-a', 'bob');
    const bOthers = await conversation('bot-b', 'bob');
    const bOwn = await conversation('bot-b', 'ann');
    const ghostOwn = await conversation('bot-gone', 'ann');
    await conversation('bot-gone', 'bob');

    // no allow list (or an empty one): only their own, anywhere
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ownOnly: { userId: 'ann' } }))).toEqual(ids([ghostOwn, bOwn, aOwn]));
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ownOnly: { userId: 'ann', viewableAgentKeys: [] } }))).toEqual(ids([ghostOwn, bOwn, aOwn]));
    // bot-b may be viewed whole; bot-a and the deleted agent are cut to their own
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ownOnly: { userId: 'ann', viewableAgentKeys: ['bot-b'] } })))
      .toEqual(ids([ghostOwn, bOwn, bOthers, aOwn]));

    // the restriction combines with the other filters and with paging
    await setStatus(bOthers, 'running');
    await setStatus(aOwn, 'running');
    const ownOnly = { userId: 'ann', viewableAgentKeys: ['bot-b'] };
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ownOnly, runtimeStatuses: ['running'] }))).toEqual(ids([bOthers, aOwn]));
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ownOnly, ids: [String(bOthers._id), String(aOwn._id)] }))).toEqual(ids([bOthers, aOwn]));
    const first = await db.listProjectAgentConversations({ projectId, limit: 2, ownOnly });
    expect(ids(first)).toEqual(ids([ghostOwn, bOwn]));
    const second = await db.listProjectAgentConversations({ projectId, limit: 2, ownOnly, before: { updatedAt: first[1].updatedAt!, id: String(first[1]._id) } });
    expect(ids(second)).toEqual(ids([bOthers, aOwn]));
    // runtimeStatuses and a restricted viewer together never reveal the hidden rows
    expect(ids(await db.listProjectAgentConversations({ projectId, limit: 10, ownOnly: { userId: 'ann' }, runtimeStatuses: ['running'] }))).toEqual(ids([aOwn]));
  });

  it('the query is served by an index', async () => {
    const db = getDb();
    await conversation('bot-a', 'ann');
    if (db instanceof SQLiteProvider) {
      const sqlite = (db as unknown as { getTenantDb(): import('better-sqlite3').Database }).getTenantDb();
      const plan = (sqlite.prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM agent_conversations WHERE projectId = @p ORDER BY updatedAt DESC, id DESC LIMIT 5',
      ).all({ p: projectId }) as Array<{ detail: string }>).map((row) => row.detail).join(' | ');
      expect(plan).toContain('idx_aconv_project_updated');
      expect(plan).not.toContain('TEMP B-TREE');
    }
    if (db instanceof MongoDBProvider) {
      const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb();
      const plan = JSON.stringify(
        await tenantDb.collection('agent_conversations').find({ projectId }).sort({ updatedAt: -1, _id: -1 }).explain('queryPlanner'),
      );
      expect(plan).toContain('IXSCAN');
      expect(plan).not.toContain('COLLSCAN');
      // the manifest (boot) and the write path name the same index
      expect(TENANT_DB_INDEXES.agent_conversations.map((index) => JSON.stringify(index.key))).toContain(JSON.stringify({ projectId: 1, updatedAt: -1, _id: -1 }));
      expect(TENANT_DB_INDEXES.agent_conversations.map((index) => index.options?.name)).toContain('idx_project_updatedAt');
    }
  });
});
