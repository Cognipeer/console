/**
 * Two listings the folder view of the Document Store and the client API's
 * session list depend on — the contract both database providers must keep
 * (SQLite and MongoDB via mongodb-memory-server):
 *
 *  - a bucket as folders (`listFileEntries`), derived from the file keys, and the
 *    flat listing with a key prefix / purpose filter (`listFileRecords`);
 *  - a project's conversations newest first with a keyset cursor, without their
 *    transcripts (`listAgentConversationPage`).
 *
 * The two providers are written independently; the same assertions run on both,
 * and on MongoDB every query is also checked to be served by an index.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { IFileRecord } from '@/lib/database/provider.interface';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { keyPrefixUpperBound, normalizeFolderPrefix, walkFileEntries, type FileKeyProbe } from '@/lib/database/fileEntryWalk';
import { describeForEachProvider } from './db-parity.helper';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

describeForEachProvider('Bucket folders and the session list', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';
  const providerKey = 'disk';
  const bucketKey = 'docs';

  beforeEach(async () => {
    const slug = `fold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  // ── Files as folders ──────────────────────────────────────────────────

  const put = (key: string, overrides: Partial<Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>> = {}) => getDb().createFileRecord({
    tenantId, projectId, providerKey, bucketKey, key, name: key.split('/').pop()!, size: 1, contentType: 'text/plain',
    markdownStatus: 'skipped', createdBy: 'u1', ...overrides,
  });

  const seedTree = async () => {
    for (const key of [
      'readme.txt',
      'zeta.txt',
      'agent-sessions/bot-a/s1/a-1.txt',
      'agent-sessions/bot-a/s1/b-1.txt',
      'agent-sessions/bot-a/s2/c-1.txt',
      'agent-sessions/bot-b/s9/d-1.txt',
      'agent-sessions/notes.txt',
      'invoices/2024/jan.pdf',
      'invoices/2025/feb.pdf',
    ]) await put(key, key.startsWith('agent-sessions/') && key.split('/').length > 3
      ? { purpose: 'conversation', conversationId: key.split('/')[2], agentKey: key.split('/')[1] }
      : {});
    // Another bucket / provider / project is never part of this listing.
    await put('elsewhere/x.txt', { bucketKey: 'other' });
    await put('elsewhere/y.txt', { providerKey: 'other-disk' });
    await put('elsewhere/z.txt', { projectId: 'proj-2' });
  };

  const entries = (prefix: string, extra: { limit?: number; cursor?: string; purpose?: 'conversation' | 'other' } = {}) => getDb().listFileEntries({
    providerKey, bucketKey, projectId, prefix, ...extra,
  });
  const keys = (records: IFileRecord[]) => records.map((record) => record.key);

  it('lists the root: its files and its top-level folders, in key order', async () => {
    await seedTree();
    const root = await entries('');
    expect(root.folders).toEqual(['agent-sessions/', 'invoices/']);
    expect(keys(root.items)).toEqual(['readme.txt', 'zeta.txt']);
    expect(root.nextCursor).toBeUndefined();
  });

  it('lists a folder: the files directly in it and its sub-folders, nothing deeper', async () => {
    await seedTree();
    const sessions = await entries('agent-sessions/');
    expect(sessions.folders).toEqual(['agent-sessions/bot-a/', 'agent-sessions/bot-b/']);
    expect(keys(sessions.items)).toEqual(['agent-sessions/notes.txt']);

    const botA = await entries('agent-sessions/bot-a/');
    expect(botA.folders).toEqual(['agent-sessions/bot-a/s1/', 'agent-sessions/bot-a/s2/']);
    expect(botA.items).toEqual([]);

    const leaf = await entries('agent-sessions/bot-a/s1/');
    expect(leaf.folders).toEqual([]);
    expect(keys(leaf.items)).toEqual(['agent-sessions/bot-a/s1/a-1.txt', 'agent-sessions/bot-a/s1/b-1.txt']);
    expect(await entries('nope/')).toEqual({ folders: [], items: [] });
  });

  it('keeps the other buckets, providers and projects out', async () => {
    await seedTree();
    const everything = [...(await entries('')).items, ...(await entries('')).folders];
    expect(JSON.stringify(everything)).not.toContain('elsewhere');
  });

  it('pages through a folder with a cursor: every entry once, folders and files interleaved in key order', async () => {
    await seedTree();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await entries('', { limit: 2, cursor });
      seen.push(...[...page.folders, ...keys(page.items)]);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    // agent-sessions/, invoices/, readme.txt, zeta.txt — each exactly once, in key order.
    expect(seen).toEqual(['agent-sessions/', 'invoices/', 'readme.txt', 'zeta.txt']);
    expect(pages).toBe(2);

    // A page that ends on a folder resumes after the whole folder, not inside it.
    const first = await entries('', { limit: 1 });
    expect(first.folders).toEqual(['agent-sessions/']);
    expect(first.nextCursor).toBe('agent-sessions/');
    const second = await entries('', { limit: 1, cursor: first.nextCursor });
    expect(second.folders).toEqual(['invoices/']);
  });

  it('visits a folder with thousands of keys in a handful of probes, not one per key', async () => {
    // The walk jumps over a folder's keys once it has seen the first: count the probes it makes.
    const probes: number[] = [];
    const all: Array<Pick<IFileRecord, 'key'> & Partial<IFileRecord>> = [];
    for (let s = 0; s < 3; s += 1) for (let f = 0; f < 400; f += 1) all.push({ key: `deep/s${s}/f${String(f).padStart(3, '0')}.txt` });
    all.push({ key: 'top.txt' });
    all.sort((a, b) => (a.key < b.key ? -1 : 1));
    const probe: FileKeyProbe = async (range, limit) => {
      probes.push(limit);
      return all
        .filter((record) => (range.gte === undefined || record.key >= range.gte) && (range.gt === undefined || record.key > range.gt) && (range.lt === undefined || record.key < range.lt))
        .slice(0, limit) as IFileRecord[];
    };
    const page = await walkFileEntries(probe, { prefix: 'deep/', limit: 50 });
    expect(page.folders).toEqual(['deep/s0/', 'deep/s1/', 'deep/s2/']);
    expect(page.items).toEqual([]);
    expect(probes.length).toBeLessThanOrEqual(4); // one per folder, plus the one that finds the end
  });

  it('filters the folder view to session files or the others', async () => {
    await seedTree();
    const sessionFiles = await entries('agent-sessions/bot-a/s1/', { purpose: 'conversation' });
    expect(keys(sessionFiles.items)).toEqual(['agent-sessions/bot-a/s1/a-1.txt', 'agent-sessions/bot-a/s1/b-1.txt']);
    expect(keys((await entries('agent-sessions/bot-a/s1/', { purpose: 'other' })).items)).toEqual([]);

    const rootOther = await entries('', { purpose: 'other' });
    // The sessions folder holds only session files and one plain note: it is still there for "other" (the note).
    expect(rootOther.folders).toEqual(['agent-sessions/', 'invoices/']);
    expect(keys(rootOther.items)).toEqual(['readme.txt', 'zeta.txt']);
    const rootSessions = await entries('', { purpose: 'conversation' });
    expect(rootSessions.folders).toEqual(['agent-sessions/']);
    expect(rootSessions.items).toEqual([]);
  });

  it('the flat listing takes a key prefix (exact, case-sensitive, any depth) and a purpose', async () => {
    const db = getDb();
    await seedTree();
    await put('Agent-Sessions/upper.txt');
    const flat = (extra: Record<string, unknown>) => db.listFileRecords({ providerKey, bucketKey, projectId, ...extra });

    expect((await flat({})).items).toHaveLength(10);
    expect(keys((await flat({ prefix: 'agent-sessions/bot-a/' })).items).sort()).toEqual([
      'agent-sessions/bot-a/s1/a-1.txt', 'agent-sessions/bot-a/s1/b-1.txt', 'agent-sessions/bot-a/s2/c-1.txt',
    ]);
    expect(keys((await flat({ prefix: 'agent-sessions/' })).items)).not.toContain('Agent-Sessions/upper.txt');
    expect((await flat({ purpose: 'conversation' })).items).toHaveLength(4);
    expect((await flat({ purpose: 'other' })).items).toHaveLength(6);
    expect(keys((await flat({ prefix: 'agent-sessions/', purpose: 'other' })).items)).toEqual(['agent-sessions/notes.txt']);
    // Search composes with the prefix.
    expect(keys((await flat({ prefix: 'invoices/', search: 'feb' })).items)).toEqual(['invoices/2025/feb.pdf']);
  });

  it('prefix helpers: the upper bound of a key range, and folder paths', () => {
    expect(keyPrefixUpperBound('a/b/')).toBe('a/b0');
    expect(keyPrefixUpperBound('')).toBeUndefined();
    expect(keyPrefixUpperBound('a￿')).toBe('b');
    expect(normalizeFolderPrefix(undefined)).toBe('');
    expect(normalizeFolderPrefix('/a/b')).toBe('a/b/');
    expect(normalizeFolderPrefix('a/b/')).toBe('a/b/');
  });

  // ── The session list ──────────────────────────────────────────────────

  const conversation = async (agentKey: string, overrides: Record<string, unknown> = {}) => {
    const created = await getDb().createAgentConversation({
      tenantId, projectId, agentKey, title: `${agentKey} chat`, messages: [], createdBy: 'u1', metadata: { source: 'api' }, ...overrides,
    } as never);
    await tick();
    return created;
  };
  const message = (role: 'user' | 'assistant', content: string) => ({ role, content, timestamp: new Date() });
  const ids = (rows: Array<{ _id?: unknown }>) => rows.map((row) => String(row._id));

  it('lists a project’s sessions newest first, without their transcripts but with how many messages they hold', async () => {
    const db = getDb();
    const a = await conversation('bot-a', { messages: [message('user', 'hi'), message('assistant', 'hello')] });
    const b = await conversation('bot-b');
    const c = await conversation('bot-a', { runtimeStatus: 'requires_action', budget: { maxCostUsd: 2, onReach: 'pause' }, spentUsd: 0.5, lastEventSeq: 7 });
    await db.createAgentConversation({ tenantId, projectId: 'proj-2', agentKey: 'bot-a', title: 'elsewhere', messages: [], createdBy: 'u1' });

    const rows = await db.listAgentConversationPage({ projectId, limit: 10 });
    expect(ids(rows)).toEqual(ids([c, b, a]));
    expect(rows.every((row) => !('messages' in row))).toBe(true);
    expect(rows.map((row) => row.messageCount)).toEqual([0, 0, 2]);
    expect(rows[0]).toMatchObject({
      agentKey: 'bot-a', runtimeStatus: 'requires_action', budget: { maxCostUsd: 2, onReach: 'pause' }, spentUsd: 0.5, lastEventSeq: 7,
      metadata: { source: 'api' }, createdBy: 'u1',
    });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('filters by agent and by status — "idle" includes a session that never ran', async () => {
    const db = getDb();
    const a = await conversation('bot-a');
    await conversation('bot-b', { runtimeStatus: 'running' });
    const c = await conversation('bot-a', { runtimeStatus: 'idle' });
    const d = await conversation('bot-a', { runtimeStatus: 'budget_paused' });

    expect(ids(await db.listAgentConversationPage({ projectId, agentKey: 'bot-a', limit: 10 }))).toEqual(ids([d, c, a]));
    expect(ids(await db.listAgentConversationPage({ projectId, runtimeStatus: 'idle', limit: 10 }))).toEqual(ids([c, a]));
    expect(ids(await db.listAgentConversationPage({ projectId, runtimeStatus: 'budget_paused', limit: 10 }))).toEqual(ids([d]));
    expect(ids(await db.listAgentConversationPage({ projectId, agentKey: 'bot-b', runtimeStatus: 'idle', limit: 10 }))).toEqual([]);
  });

  it('pages with a keyset: no row twice or missed, even when new sessions arrive meanwhile', async () => {
    const db = getDb();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) created.push(String((await conversation('bot-a'))._id));
    const expected = [...created].reverse();

    const first = await db.listAgentConversationPage({ projectId, limit: 2 });
    expect(ids(first)).toEqual(expected.slice(0, 2));
    const cursor = (row: { _id?: unknown; createdAt?: Date }) => ({ createdAt: row.createdAt!, id: String(row._id) });
    // A session created after the first page was read does not shift the next one.
    await conversation('bot-a');
    const second = await db.listAgentConversationPage({ projectId, limit: 2, after: cursor(first[1]) });
    expect(ids(second)).toEqual(expected.slice(2, 4));
    const third = await db.listAgentConversationPage({ projectId, limit: 2, after: cursor(second[1]) });
    expect(ids(third)).toEqual(expected.slice(4));
  });

  it('a malformed cursor id reads as "before that time", never an error', async () => {
    const db = getDb();
    await conversation('bot-a');
    const rows = await db.listAgentConversationPage({ projectId, limit: 5, after: { createdAt: new Date(Date.now() + 60_000), id: 'not-an-object-id' } });
    expect(rows).toHaveLength(1);
  });

  // ── Indexes ───────────────────────────────────────────────────────────

  it('every new query is served by an index (SQLite: SEARCH ... USING INDEX, never SCAN)', async () => {
    const db = getDb();
    if (!(db instanceof SQLiteProvider)) return;
    const sqlite = (db as unknown as { getTenantDb(): import('better-sqlite3').Database }).getTenantDb();
    const plan = (sql: string, params: Record<string, unknown>) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>)
      .map((row) => row.detail).join(' | ');
    const queries: Array<[string, string, Record<string, unknown>, string]> = [
      ['a folder: the next key in a range',
        'SELECT * FROM files WHERE providerKey = @p AND bucketKey = @b AND projectId = @pr AND key >= @gte AND key < @lt ORDER BY key ASC LIMIT 5',
        { p: providerKey, b: bucketKey, pr: projectId, gte: 'a/', lt: 'a0' }, 'idx_files_bucket_key'],
      ['sessions of a project',
        'SELECT id FROM agent_conversations WHERE projectId = @pr ORDER BY createdAt DESC, id DESC LIMIT 5',
        { pr: projectId }, 'idx_aconv_project_created'],
      ['sessions of an agent',
        'SELECT id FROM agent_conversations WHERE projectId = @pr AND agentKey = @a ORDER BY createdAt DESC, id DESC LIMIT 5',
        { pr: projectId, a: 'bot-a' }, 'idx_aconv_project_agent_created'],
      ['sessions in a status',
        'SELECT id FROM agent_conversations WHERE projectId = @pr AND runtimeStatus = @s ORDER BY createdAt DESC, id DESC LIMIT 5',
        { pr: projectId, s: 'requires_action' }, 'idx_aconv_project_status_created'],
    ];
    for (const [label, sql, params, index] of queries) {
      const detail = plan(sql, params);
      expect(detail, `${label} should use ${index}`).toContain(index);
      expect(detail, `${label} should not scan the table`).not.toMatch(/\bSCAN (files|agent_conversations)\b(?! USING)/);
    }
  });

  // MongoDB:

  it('every new query is served by an index (MongoDB: IXSCAN, never COLLSCAN)', async () => {
    const db = getDb();
    if (!(db instanceof MongoDBProvider)) return;
    const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb();

    await seedTree();
    await conversation('bot-a');
    // The collections were created after the tenant was bound: the write path ensured their indexes.

    const planOf = async (collection: string, filter: Record<string, unknown>, sort?: Record<string, 1 | -1>) => {
      let cursor = tenantDb.collection(collection).find(filter);
      if (sort) cursor = cursor.sort(sort);
      return JSON.stringify(await cursor.explain('queryPlanner'));
    };
    const oid = new (await import('mongodb')).ObjectId();
    const now = new Date();
    const queries: Array<[string, string, Record<string, unknown>, Record<string, 1 | -1>?]> = [
      ['a folder: the next key in a range', 'files', { providerKey, bucketKey, projectId, key: { $gte: 'agent-sessions/', $lt: 'agent-sessions0' } }, { key: 1 }],
      ['a folder: the next key after one', 'files', { providerKey, bucketKey, projectId, key: { $gt: 'agent-sessions/notes.txt', $lt: 'agent-sessions0' }, purpose: { $ne: 'conversation' } }, { key: 1 }],
      ['the flat listing under a prefix', 'files', { providerKey, bucketKey, projectId, $and: [{ key: { $gte: 'a/', $lt: 'a0' } }] }, { _id: 1 }],
      ['sessions of a project', 'agent_conversations', { projectId }, { createdAt: -1, _id: -1 }],
      ['sessions of a project after a cursor', 'agent_conversations', { projectId, $or: [{ createdAt: { $lt: now } }, { createdAt: now, _id: { $lt: oid } }] }, { createdAt: -1, _id: -1 }],
      ['sessions of an agent', 'agent_conversations', { projectId, agentKey: 'bot-a' }, { createdAt: -1, _id: -1 }],
      ['sessions in a status', 'agent_conversations', { projectId, runtimeStatus: 'requires_action' }, { createdAt: -1, _id: -1 }],
    ];
    for (const [label, collection, filter, sort] of queries) {
      const plan = await planOf(collection, filter, sort);
      expect(plan, `${label} should use an index`).toContain('IXSCAN');
      expect(plan, `${label} should not scan the collection`).not.toContain('COLLSCAN');
    }
  });
});

describe('the folder walk, against a fake index', () => {
  const records = (keys: string[]) => keys.sort().map((key) => ({ key }) as IFileRecord);
  const probeOver = (all: IFileRecord[]): FileKeyProbe => async (range, limit) => all
    .filter((record) => (range.gte === undefined || record.key >= range.gte) && (range.gt === undefined || record.key > range.gt) && (range.lt === undefined || record.key < range.lt))
    .slice(0, limit);

  it('a prefix that is not a folder boundary still groups by the next slash', async () => {
    const page = await walkFileEntries(probeOver(records(['agent-a/x', 'agent-b/y', 'agents.txt', 'other/z'])), { prefix: 'agent', limit: 10 });
    expect(page.folders).toEqual(['agent-a/', 'agent-b/']);
    expect(page.items.map((item) => item.key)).toEqual(['agents.txt']);
  });

  it('a cursor that does not belong to this folder is ignored', async () => {
    const page = await walkFileEntries(probeOver(records(['a/1', 'a/2'])), { prefix: 'a/', limit: 10, cursor: 'zzz/not-here' });
    expect(page.items.map((item) => item.key)).toEqual(['a/1', 'a/2']);
  });
});
