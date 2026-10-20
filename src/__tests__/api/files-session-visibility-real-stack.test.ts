/**
 * The files an agent session holds (`purpose: 'conversation'`) keep the visibility of their session in the routes that
 * work on several files: a caller never archives a session file they may not view, and never deletes or converts one
 * they may not manage. Who may do what with a session is the session access module's question (answered here by the
 * test); what the routes do with the answer is what is checked, over the real plugin, database and disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
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
