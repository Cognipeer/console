/**
 * The built-in disk provider's listing, page by page: "Import from storage" walks a folder with it, so following
 * `nextCursor` has to give every object exactly once, in the order of the keys, whatever the names look like.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalFileProviderContract } from '@/lib/providers/contracts/localFile.contract';
import type { FileProviderRuntime } from '@/lib/providers';

let dir: string;
let runtime: FileProviderRuntime;

const TENANT = 'tenant-1';
const PROVIDER = 'disk';

function put(key: string) {
  const target = path.join(dir, TENANT, PROVIDER, ...key.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, key);
}

/** Every key a listing gives when it is followed to its end, page by page. */
async function listAll(limit: number, prefix?: string): Promise<{ keys: string[]; pages: number }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await runtime.listFiles({ limit, ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) });
    keys.push(...page.items.map((item) => item.key));
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 100) throw new Error('The listing does not end.');
  } while (cursor);
  return { keys, pages };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'local-listing-'));
  runtime = await LocalFileProviderContract.createRuntime({
    tenantId: TENANT,
    providerKey: PROVIDER,
    credentials: {},
    settings: { basePath: dir },
  } as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listFiles of the local disk provider', () => {
  it('gives every object once when its pages are followed: none is lost where one page ends', async () => {
    const all = Array.from({ length: 7 }, (_, index) => `work/f${index + 1}.txt`);
    all.forEach(put);

    const { keys, pages } = await listAll(3);

    expect(keys).toEqual(all);
    expect(pages).toBe(3);
  });

  it('ends with the last page, with no empty page after a full one', async () => {
    const all = Array.from({ length: 6 }, (_, index) => `work/f${index + 1}.txt`);
    all.forEach(put);

    const { keys, pages } = await listAll(3);

    expect(keys).toEqual(all);
    expect(pages).toBe(2);
  });

  it('answers a single page, without a cursor, for a folder that fits', async () => {
    put('work/a.txt');
    put('work/b.txt');

    const page = await runtime.listFiles({ prefix: 'work', limit: 50 });

    expect(page.items.map((item) => item.key)).toEqual(['work/a.txt', 'work/b.txt']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('pages one object at a time', async () => {
    const all = ['work/a.txt', 'work/b.txt', 'work/c.txt'];
    all.forEach(put);

    const { keys, pages } = await listAll(1, 'work');

    expect(keys).toEqual(all);
    expect(pages).toBe(3);
  });

  it('lists in the order of the keys, folders and capitals and punctuation included, and loses none', async () => {
    const all = [
      'work/B.txt',
      'work/a.txt',
      'work/a-b.txt',
      'work/a_b.txt',
      'work/docs.txt',
      'work/docs/x.txt',
      'work/docs/sub/y.txt',
      'work/docs/sub.txt',
      'work/z.txt',
      'work/Ünï/çödé.txt',
    ];
    all.forEach(put);

    for (const limit of [1, 2, 3, 4, 50]) {
      const { keys } = await listAll(limit, 'work');
      expect(keys, `limit ${limit}`).toEqual([...all].sort());
    }
  });

  it('lists only what is below the prefix', async () => {
    put('work/a.txt');
    put('work/docs/b.txt');
    put('other/c.txt');

    const { keys } = await listAll(2, 'work');

    expect(keys).toEqual(['work/a.txt', 'work/docs/b.txt']);
  });

  it('lists nothing for a folder that does not exist', async () => {
    expect(await runtime.listFiles({ prefix: 'nowhere', limit: 10 })).toEqual({ items: [] });
  });
});
