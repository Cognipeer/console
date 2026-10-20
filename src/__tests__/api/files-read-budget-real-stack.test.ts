/**
 * Every read of a stored object into memory shares one budget per process (`storedObjectReads`), through the REAL
 * plugin over a real SQLite database and the real local-disk driver: a download, the files of an archive and the
 * conversion of a file to Markdown all wait while other reads hold the budget, and go on as soon as it is free.
 * The budget itself is pinned in read-budget.test.ts; this proves the three paths use it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import JSZip from 'jszip';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

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

import { runMarkdownConversionJob } from '@/lib/services/files/jobs/markdownConversion';
import { READ_BUDGET_BYTES, storedObjectReads } from '@/lib/services/files/readBudget';
import { createFilesStack, FILES_DB_NAME, type FilesStack } from '../helpers/filesRealStack';

let stack: FilesStack;

beforeEach(async () => {
  vi.clearAllMocks();
  stack = await createFilesStack(hoisted.getDatabase);
  await stack.createBucket('work', { name: 'Work files' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stack.close();
});

/** Takes the whole budget, as the read of a very large object would, until `release()` is called. */
function holdBudget() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = storedObjectReads.run(READ_BUDGET_BYTES, () => held);
  return { release: () => { release(); return reading; } };
}

/** Waits until a read has reached the budget and is queued behind the one that holds it. */
const queued = () => vi.waitFor(() => {
  expect(storedObjectReads.snapshot().waiting).toBe(1);
}, { timeout: 5_000, interval: 5 });

/** Starts something and tells whether it has finished yet. */
function watch<T>(work: Promise<T>) {
  const state = { done: false };
  const result = work.then((value) => {
    state.done = true;
    return value;
  });
  return { state, result };
}

describe('a download', () => {
  it('waits while other reads hold the budget, and is served as soon as it is free', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');
    const hold = holdBudget();

    const download = watch(stack.request('GET', '/files/buckets/work/objects/a.txt?download=original'));
    await queued();
    expect(download.state.done).toBe(false);

    await hold.release();
    const res = await download.result;
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('alpha');
    expect(storedObjectReads.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });

  it('counts the size the record gives, for the original and for the Markdown copy alike', async () => {
    const run = vi.spyOn(storedObjectReads, 'run');
    await stack.putFile('work', 'doc.pdf', '%PDF-1.4', { contentType: 'application/pdf', markdownStatus: 'succeeded', markdownKey: 'doc.md', markdownSize: 7 });
    stack.putObject('work', 'doc.md', '# copy!');

    expect((await stack.request('GET', '/files/buckets/work/objects/doc.pdf?download=original')).statusCode).toBe(200);
    expect((await stack.request('GET', '/files/buckets/work/objects/doc.pdf?download=markdown')).statusCode).toBe(200);

    expect(run.mock.calls.map(([size]) => size)).toEqual([8, 7]);
  });

  it('releases its share when the read fails, and the next read is not held back', async () => {
    await stack.putFile('work', 'gone.txt', 'alpha');
    await stack.putFile('work', 'there.txt', 'beta');
    rmSync(stack.objectPath('work', 'gone.txt'));

    const failed = await stack.request('GET', '/files/buckets/work/objects/gone.txt?download=original');
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(storedObjectReads.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });

    const next = await stack.request('GET', '/files/buckets/work/objects/there.txt?download=original');
    expect(next.statusCode).toBe(200);
    expect(next.body).toBe('beta');
  });
});

describe('an archive', () => {
  it('reads each file within the budget: the ZIP is written once the budget is free', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');
    await stack.putFile('work', 'b.txt', 'beta');
    const hold = holdBudget();

    const archive = watch(stack.request('POST', '/files/buckets/work/objects/archive', { keys: ['a.txt', 'b.txt'] }));
    await queued();
    expect(archive.state.done).toBe(false);

    await hold.release();
    const res = await archive.result;
    expect(res.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(res.rawPayload);
    expect(Object.keys(zip.files).sort()).toEqual(['a.txt', 'b.txt']);
    expect(await zip.file('b.txt')!.async('string')).toBe('beta');
    expect(storedObjectReads.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });
});

describe('the conversion of a file to Markdown', () => {
  it('reads the original within the budget, and converts once it is free', async () => {
    await stack.putFile('work', 'notes.txt', 'Quarterly notes: revenue grew.', { contentType: 'text/plain', markdownStatus: 'pending' });
    const hold = holdBudget();

    const job = watch(stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob({
      tenantDbName: FILES_DB_NAME, tenantId: stack.tenantId, projectId: stack.projectId, bucketKey: 'work', key: 'notes.txt', actor: stack.userId,
    })));
    await queued();
    expect(job.state.done).toBe(false);
    expect(await stack.record('work', 'notes.txt')).toMatchObject({ markdownStatus: 'pending' });

    await hold.release();
    await job.result;
    expect(await stack.record('work', 'notes.txt')).toMatchObject({ markdownStatus: 'succeeded' });
    expect(storedObjectReads.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });
});
