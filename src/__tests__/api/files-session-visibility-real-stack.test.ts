/**
 * The files an agent session holds (`purpose: 'conversation'`) keep the visibility of their session in the routes that
 * work on several files: a caller never archives a session file they may not view, and never deletes or converts one
 * they may not manage. Who may do what with a session is the session access module's question (answered here by the
 * test); what the routes do with the answer is what is checked, over the real plugin, database and disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import JSZip from 'jszip';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  refuse: vi.fn(),
  actorOf: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return { ...actual, refuseSessionLinked: hoisted.refuse, sessionActorOf: hoisted.actorOf };
});

import { getQueue } from '@/lib/core/queue';
import { SESSION_FORBIDDEN_MESSAGE } from '@/server/api/plugins/agent-session-access';
import { runBucketDeletionJob } from '@/lib/services/files/jobs/bucketDeletion';
import { createFilesStack, FILES_DB_NAME, type FilesStack } from '../helpers/filesRealStack';

let stack: FilesStack;

/** The sessions the caller may not act on: conversation id -> the refusal. */
let refusals: Record<string, { status: 403 | 503; need: 'view' | 'manage' }>;

beforeEach(async () => {
  vi.clearAllMocks();
  stack = await createFilesStack(hoisted.getDatabase);
  await stack.createBucket('work', { name: 'Work files' });
  refusals = {};
  hoisted.actorOf.mockImplementation(async () => ({ tenantDbName: FILES_DB_NAME, projectId: stack.projectId, userId: stack.userId }));
  hoisted.refuse.mockImplementation(async (_request: unknown, conversationId: string | null, need: 'view' | 'manage') => {
    if (!conversationId) return null;
    const refusal = refusals[conversationId];
    return refusal ? { ok: false, reason: refusal.status === 403 ? 'forbidden' : 'unavailable', status: refusal.status, need } : null;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stack.close();
});

const sessionFile = (key: string, conversationId: string, content = key) =>
  stack.putFile('work', key, content, { purpose: 'conversation', conversationId });

describe('batch-delete', () => {
  const batchDelete = (keys: string[]) => stack.request('POST', '/files/buckets/work/objects/batch-delete', { keys });

  it('deletes the files of a session the caller may manage and reports, without deleting, the ones they may not', async () => {
    await stack.putFile('work', 'plain.txt', 'plain');
    await sessionFile('mine.txt', 'conv-mine');
    await sessionFile('theirs.txt', 'conv-theirs');
    await sessionFile('also-theirs.txt', 'conv-theirs');
    refusals['conv-theirs'] = { status: 403, need: 'manage' };

    const res = await batchDelete(['theirs.txt', 'plain.txt', 'also-theirs.txt', 'mine.txt']);

    expect(res.statusCode).toBe(200);
    expect(stack.json(res)).toEqual({
      deleted: ['plain.txt', 'mine.txt'],
      failed: [
        { key: 'theirs.txt', error: SESSION_FORBIDDEN_MESSAGE.manage },
        { key: 'also-theirs.txt', error: SESSION_FORBIDDEN_MESSAGE.manage },
      ],
    });
    expect((await stack.records('work')).map((record) => record.key).sort()).toEqual(['also-theirs.txt', 'theirs.txt']);
    expect(existsSync(stack.objectPath('work', 'theirs.txt'))).toBe(true);
    expect(existsSync(stack.objectPath('work', 'also-theirs.txt'))).toBe(true);
    expect(existsSync(stack.objectPath('work', 'mine.txt'))).toBe(false);
  });

  it('asks about each session once, as a change, however many of its files are named', async () => {
    await sessionFile('a1.txt', 'conv-a');
    await sessionFile('a2.txt', 'conv-a');
    await sessionFile('a3.txt', 'conv-a');
    await sessionFile('b1.txt', 'conv-b');

    await batchDelete(['a1.txt', 'a2.txt', 'a3.txt', 'b1.txt']);

    expect(hoisted.refuse).toHaveBeenCalledTimes(2);
    expect(hoisted.refuse.mock.calls.map((call) => [call[1], call[2]]).sort()).toEqual([['conv-a', 'manage'], ['conv-b', 'manage']]);
    // The caller was worked out once, and handed on, not looked up again for every file.
    expect(hoisted.actorOf).toHaveBeenCalledTimes(1);
    expect(hoisted.refuse.mock.calls[0]![3]).toEqual({ actor: { tenantDbName: FILES_DB_NAME, projectId: stack.projectId, userId: stack.userId } });
  });

  it('asks nothing when no file belongs to a session', async () => {
    await stack.putFile('work', 'a.txt', 'a');
    await stack.putFile('work', 'b.txt', 'b');

    const res = await batchDelete(['a.txt', 'b.txt']);

    expect(stack.json(res).deleted).toEqual(['a.txt', 'b.txt']);
    expect(hoisted.refuse).not.toHaveBeenCalled();
    expect(hoisted.actorOf).not.toHaveBeenCalled();
  });

  it('reports a file whose session could not be checked as not deleted: no answer is never a yes', async () => {
    await sessionFile('unknown.txt', 'conv-down');
    await stack.putFile('work', 'plain.txt', 'plain');
    refusals['conv-down'] = { status: 503, need: 'manage' };

    const res = await batchDelete(['unknown.txt', 'plain.txt']);

    expect(res.statusCode).toBe(200);
    expect(stack.json(res)).toEqual({
      deleted: ['plain.txt'],
      failed: [{ key: 'unknown.txt', error: 'Authorization is temporarily unavailable.' }],
    });
    expect(await stack.record('work', 'unknown.txt')).not.toBeNull();
  });

  it('does not treat a file as a session file just because it has a purpose: it needs the session it belongs to', async () => {
    await stack.putFile('work', 'orphan.txt', 'x', { purpose: 'conversation' });

    const res = await batchDelete(['orphan.txt']);

    expect(stack.json(res).deleted).toEqual(['orphan.txt']);
    expect(hoisted.refuse).not.toHaveBeenCalled();
  });
});

describe('archive', () => {
  const archive = (keys: string[]) => stack.request('POST', '/files/buckets/work/objects/archive', { keys });

  it('includes the files of a session the caller may view', async () => {
    await stack.putFile('work', 'plain.txt', 'plain');
    await sessionFile('mine.txt', 'conv-mine', 'my session file');

    const res = await archive(['plain.txt', 'mine.txt']);

    expect(res.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(res.rawPayload);
    expect(Object.keys(zip.files)).toEqual(['plain.txt', 'mine.txt']);
    expect(await zip.file('mine.txt')!.async('string')).toBe('my session file');
    expect(hoisted.refuse.mock.calls.map((call) => [call[1], call[2]])).toEqual([['conv-mine', 'view']]);
  });

  it('is refused with the session\'s own 403 when one file is of a session the caller may not view: no ZIP, not even of the others', async () => {
    await stack.putFile('work', 'plain.txt', 'plain');
    await sessionFile('secret.txt', 'conv-theirs', 'not for you');
    refusals['conv-theirs'] = { status: 403, need: 'view' };

    const res = await archive(['plain.txt', 'secret.txt']);

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).not.toContain('not for you');
    expect(res.body).toContain(SESSION_FORBIDDEN_MESSAGE.view);
    expect(res.rawPayload.subarray(0, 2).toString()).not.toBe('PK');
  });

  it('is a 503 when the session cannot be checked', async () => {
    await sessionFile('unknown.txt', 'conv-down');
    refusals['conv-down'] = { status: 503, need: 'view' };

    const res = await archive(['unknown.txt']);

    expect(res.statusCode).toBe(503);
  });

  it('asks nothing when no file belongs to a session', async () => {
    await stack.putFile('work', 'a.txt', 'a');

    expect((await archive(['a.txt'])).statusCode).toBe(200);
    expect(hoisted.refuse).not.toHaveBeenCalled();
  });
});

/**
 * Nothing stops two records from carrying one key (rows written before an upload replaced the record of its key, or
 * two nodes uploading a new key at the same moment). They describe one object, so the one that says it is a
 * session's decides for the key, whichever the database happens to return last.
 */
describe('two records under one key, one of them a session\'s', () => {
  const record = (over: Record<string, unknown>) => stack.db.createFileRecord({
    tenantId: stack.tenantId, projectId: stack.projectId, providerKey: 'local', bucketKey: 'work', key: 'shared.txt', name: 'shared.txt',
    size: 11, contentType: 'text/plain', markdownStatus: 'skipped', createdBy: stack.userId, ...over,
  } as never);
  const plain = () => record({});
  const linked = () => record({ purpose: 'conversation', conversationId: 'conv-theirs' });

  describe.each([
    ['the session\'s record first', async () => { await linked(); await plain(); }],
    ['the plain record first', async () => { await plain(); await linked(); }],
  ])('%s', (_label, arrange) => {
    beforeEach(async () => {
      stack.putObject('work', 'shared.txt', 'their bytes');
      await arrange();
      refusals['conv-theirs'] = { status: 403, need: 'manage' };
    });

    it('batch-delete leaves the key alone, as it does for any file of a session the caller may not manage', async () => {
      const res = await stack.request('POST', '/files/buckets/work/objects/batch-delete', { keys: ['shared.txt'] });

      expect(res.statusCode).toBe(200);
      expect(stack.json(res)).toEqual({ deleted: [], failed: [{ key: 'shared.txt', error: SESSION_FORBIDDEN_MESSAGE.manage }] });
      expect(existsSync(stack.objectPath('work', 'shared.txt'))).toBe(true);
      expect(await stack.records('work')).toHaveLength(2);
    });

    it('batch-delete still deletes the other keys it names', async () => {
      await stack.putFile('work', 'plain.txt', 'plain');

      const res = await stack.request('POST', '/files/buckets/work/objects/batch-delete', { keys: ['shared.txt', 'plain.txt'] });

      expect(stack.json(res)).toEqual({ deleted: ['plain.txt'], failed: [{ key: 'shared.txt', error: SESSION_FORBIDDEN_MESSAGE.manage }] });
      expect(existsSync(stack.objectPath('work', 'shared.txt'))).toBe(true);
    });

    it('archive is refused with the session\'s own 403: no ZIP, and the bytes are not served', async () => {
      const res = await stack.request('POST', '/files/buckets/work/objects/archive', { keys: ['shared.txt'] });

      expect(res.statusCode).toBe(403);
      expect(res.body).toContain(SESSION_FORBIDDEN_MESSAGE.view);
      expect(res.body).not.toContain('their bytes');
      expect(res.rawPayload.subarray(0, 2).toString()).not.toBe('PK');
    });
  });

  it('changes nothing for a key whose records are all plain: it is deleted and archived as before', async () => {
    stack.putObject('work', 'shared.txt', 'plain bytes');
    await plain();
    await plain();

    const archived = await stack.request('POST', '/files/buckets/work/objects/archive', { keys: ['shared.txt'] });
    expect(archived.statusCode).toBe(200);
    const deleted = await stack.request('POST', '/files/buckets/work/objects/batch-delete', { keys: ['shared.txt'] });
    expect(stack.json(deleted)).toEqual({ deleted: ['shared.txt'], failed: [] });
    expect(existsSync(stack.objectPath('work', 'shared.txt'))).toBe(false);
    expect(hoisted.refuse).not.toHaveBeenCalled();
  });

  it('is decided by asking about the session once, as a change for batch-delete and as a view for an archive', async () => {
    stack.putObject('work', 'shared.txt', 'their bytes');
    await linked();
    await plain();
    await linked();
    refusals['conv-theirs'] = { status: 403, need: 'manage' };

    await stack.request('POST', '/files/buckets/work/objects/batch-delete', { keys: ['shared.txt'] });
    await stack.request('POST', '/files/buckets/work/objects/archive', { keys: ['shared.txt'] });

    expect(hoisted.refuse.mock.calls.map((call) => [call[1], call[2]])).toEqual([['conv-theirs', 'manage'], ['conv-theirs', 'view']]);
  });
});

describe('convert', () => {
  const convert = (key: string) => stack.request('POST', '/files/buckets/work/convert', { key });

  it('converts the file of a session the caller may manage', async () => {
    await sessionFile('mine.txt', 'conv-mine', 'words of mine');

    const res = await convert('mine.txt');

    expect(res.statusCode).toBe(202);
    expect(stack.json(res).record).toMatchObject({ key: 'mine.txt', markdownStatus: 'pending' });
    expect(hoisted.refuse.mock.calls.map((call) => [call[1], call[2]])).toEqual([['conv-mine', 'manage']]);
  });

  it('is refused for the file of a session the caller may not manage: the file is not touched and nothing is queued', async () => {
    await sessionFile('theirs.txt', 'conv-theirs');
    refusals['conv-theirs'] = { status: 403, need: 'manage' };
    const publish = vi.spyOn(await getQueue(), 'publish');

    const res = await convert('theirs.txt');

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(SESSION_FORBIDDEN_MESSAGE.manage);
    expect((await stack.record('work', 'theirs.txt'))?.markdownStatus).toBe('skipped');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('upload under the key of a file', () => {
  const uploadAt = (keyHint: string, content = 'new bytes') => stack.request('POST', '/files/buckets/work/objects', {
    fileName: 'x.txt', data: Buffer.from(content).toString('base64'), contentType: 'text/plain', convertToMarkdown: false, keyHint,
  });
  const stored = (key: string) => readFileSync(stack.objectPath('work', key), 'utf8');

  it('writes over the file of a session the caller may manage, after asking about that session as a change', async () => {
    await sessionFile('mine.txt', 'conv-mine', 'old bytes');

    const res = await uploadAt('mine.txt');

    expect(res.statusCode).toBe(201);
    expect(stored('mine.txt')).toBe('new bytes');
    expect(hoisted.refuse.mock.calls.map((call) => [call[1], call[2]])).toEqual([['conv-mine', 'manage']]);
  });

  it('is refused with the session\'s own 403 for the file of a session the caller may not manage: the file and its record stay as they were', async () => {
    await sessionFile('theirs.txt', 'conv-theirs', 'their bytes');
    refusals['conv-theirs'] = { status: 403, need: 'manage' };

    const res = await uploadAt('theirs.txt');

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(SESSION_FORBIDDEN_MESSAGE.manage);
    expect(stored('theirs.txt')).toBe('their bytes');
    const records = (await stack.records('work')).filter((record) => record.key === 'theirs.txt');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: 'conversation', conversationId: 'conv-theirs', size: Buffer.byteLength('their bytes') });
  });

  it('is refused whatever way the key is spelled: slashes, backslashes and a leading slash name the same file', async () => {
    await sessionFile('agent-sessions/bot/s1/theirs.txt', 'conv-theirs', 'their bytes');
    refusals['conv-theirs'] = { status: 403, need: 'manage' };

    for (const spelling of ['agent-sessions//bot/s1/theirs.txt', 'agent-sessions\\bot\\s1\\theirs.txt', '/agent-sessions/bot/s1/theirs.txt', '  agent-sessions/bot/s1//theirs.txt  ']) {
      const res = await uploadAt(spelling);
      expect(res.statusCode, spelling).toBe(403);
    }
    expect(stored('agent-sessions/bot/s1/theirs.txt')).toBe('their bytes');
    expect(await stack.records('work')).toHaveLength(1);
  });

  it('is a 503 when the session cannot be checked: no answer is never a yes', async () => {
    await sessionFile('unknown.txt', 'conv-down', 'their bytes');
    refusals['conv-down'] = { status: 503, need: 'manage' };

    const res = await uploadAt('unknown.txt');

    expect(res.statusCode).toBe(503);
    expect(stored('unknown.txt')).toBe('their bytes');
  });

  it('asks nothing for a key that holds a plain file, a key nobody uses, or a folder', async () => {
    await stack.putFile('work', 'plain.txt', 'plain');

    expect((await uploadAt('plain.txt')).statusCode).toBe(201);
    expect((await uploadAt('fresh/key.txt')).statusCode).toBe(201);
    expect((await uploadAt('some/folder/')).statusCode).toBe(201);
    expect(hoisted.refuse).not.toHaveBeenCalled();
  });

  it('asks about the session when a plain file and a session file share the key', async () => {
    await stack.putFile('work', 'shared.txt', 'plain', {});
    await stack.putFile('work', 'shared.txt', 'session', { purpose: 'conversation', conversationId: 'conv-theirs' });
    refusals['conv-theirs'] = { status: 403, need: 'manage' };

    expect((await uploadAt('shared.txt')).statusCode).toBe(403);
  });
});

describe('delete a bucket with its files', () => {
  const FORBIDDEN = 'This bucket holds files of sessions started by someone else, and you are not allowed to change them, so it cannot be deleted with its files.';
  const deleteWithFiles = () => stack.request('DELETE', '/files/buckets/work?deleteFiles=true');
  const payload = () => ({ tenantDbName: FILES_DB_NAME, tenantId: stack.tenantId, projectId: stack.projectId, bucketKey: 'work', actor: stack.userId });

  /** What the refusal must not have touched. */
  const untouched = async (expectedRecords: number) => {
    const bucket = await stack.bucket('work');
    expect(bucket).toMatchObject({ status: 'active' });
    expect(bucket?.metadata ?? {}).not.toHaveProperty('deleting');
    expect(await stack.db.countFileRecords({ projectId: stack.projectId })).toBe(expectedRecords);
  };

  it('is refused with a 403 and a sentence about the bucket when one session is not the caller\'s to change: nothing is marked, queued or deleted', async () => {
    await stack.putFile('work', 'plain.txt', 'plain');
    await sessionFile('mine.txt', 'conv-mine');
    await sessionFile('theirs.txt', 'conv-theirs');
    refusals['conv-theirs'] = { status: 403, need: 'manage' };
    const publish = vi.spyOn(await getQueue(), 'publish');

    const res = await deleteWithFiles();

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(stack.json(res).error).toBe(FORBIDDEN);
    expect(stack.json(res).error).not.toBe(SESSION_FORBIDDEN_MESSAGE.manage);
    expect(publish).not.toHaveBeenCalled();
    await untouched(3);
    for (const key of ['plain.txt', 'mine.txt', 'theirs.txt']) expect(existsSync(stack.objectPath('work', key)), key).toBe(true);
  });

  it('is a 503 when a session cannot be checked: no answer is never a yes', async () => {
    await sessionFile('unknown.txt', 'conv-down');
    refusals['conv-down'] = { status: 503, need: 'manage' };
    const publish = vi.spyOn(await getQueue(), 'publish');

    const res = await deleteWithFiles();

    expect(res.statusCode).toBe(503);
    expect(publish).not.toHaveBeenCalled();
    await untouched(1);
  });

  it('goes ahead (202) when the caller may manage every session the bucket holds, asking about each session once, as a change', async () => {
    await stack.putFile('work', 'plain.txt', 'plain');
    await sessionFile('a1.txt', 'conv-a');
    await sessionFile('a2.txt', 'conv-a');
    await sessionFile('b1.txt', 'conv-b');

    const res = await deleteWithFiles();

    expect(res.statusCode).toBe(202);
    expect(stack.json(res)).toEqual({ status: 'deleting' });
    expect(hoisted.refuse.mock.calls.map((call) => [call[1], call[2]]).sort()).toEqual([['conv-a', 'manage'], ['conv-b', 'manage']]);
    expect(hoisted.actorOf).toHaveBeenCalledTimes(1);
    expect(await stack.bucket('work')).toMatchObject({ status: 'disabled', metadata: { deleting: true } });
    // The job removes what the answers allowed.
    await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));
    expect(await stack.bucket('work')).toBeNull();
    expect(await stack.records('work')).toEqual([]);
  });

  it('asks nothing when no file belongs to a session', async () => {
    await stack.putFile('work', 'a.txt', 'a');
    await stack.putFile('work', 'orphan.txt', 'x', { purpose: 'conversation' });

    const res = await deleteWithFiles();

    expect(res.statusCode).toBe(202);
    expect(hoisted.refuse).not.toHaveBeenCalled();
    expect(hoisted.actorOf).not.toHaveBeenCalled();
  });

  it('does not ask for a delete without the files: the bucket goes, every file stays, and no session is asked about', async () => {
    await sessionFile('theirs.txt', 'conv-theirs');
    refusals['conv-theirs'] = { status: 403, need: 'manage' };

    const res = await stack.request('DELETE', '/files/buckets/work?force=true');

    expect(res.statusCode).toBe(200);
    expect(hoisted.refuse).not.toHaveBeenCalled();
    expect(existsSync(stack.objectPath('work', 'theirs.txt'))).toBe(true);
  });

  it('looks at every page of the bucket: a session behind the first page is found', async () => {
    // More session files than one page of the check reads (200), each of its own session.
    const total = 230;
    for (let index = 0; index < total; index += 1) {
      await stack.db.createFileRecord({
        tenantId: stack.tenantId, projectId: stack.projectId, providerKey: 'local', bucketKey: 'work',
        key: `s/f${String(index).padStart(3, '0')}.txt`, name: `f${index}.txt`, size: 1, contentType: 'text/plain',
        markdownStatus: 'skipped', createdBy: stack.userId, purpose: 'conversation', conversationId: `conv-${index}`,
      } as never);
    }
    // The sessions behind the first page, whichever order the listing has.
    const first = await stack.db.listFileRecords({ providerKey: 'local', bucketKey: 'work', projectId: stack.projectId, purpose: 'conversation', limit: 200 });
    expect(first.nextCursor).toBeTruthy();
    const behind = await stack.db.listFileRecords({ providerKey: 'local', bucketKey: 'work', projectId: stack.projectId, purpose: 'conversation', limit: 200, cursor: first.nextCursor });
    expect(behind.items.length).toBeGreaterThan(0);
    refusals[behind.items[behind.items.length - 1]!.conversationId!] = { status: 403, need: 'manage' };

    const res = await deleteWithFiles();

    expect(res.statusCode).toBe(403);
    expect(stack.json(res).error).toBe(FORBIDDEN);
    await untouched(total);
    // Every session of both pages was asked about once.
    expect(new Set(hoisted.refuse.mock.calls.map((call) => call[1])).size).toBe(total);
    expect(hoisted.refuse).toHaveBeenCalledTimes(total);
  });

  it('is a 404 for a bucket that does not exist, before any session is asked about', async () => {
    const res = await stack.request('DELETE', '/files/buckets/nobody?deleteFiles=true');

    expect(res.statusCode).toBe(404);
    expect(hoisted.refuse).not.toHaveBeenCalled();
  });
});
