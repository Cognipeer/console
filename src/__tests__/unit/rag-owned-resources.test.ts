/**
 * What the Knowledge Engine owns outside its own routes (`server/api/ragOwnedResources.ts`): the stored originals of a
 * module's documents and the vector index its vectors live in. With access control on for the module they are read
 * through the module, so a caller who does not skip the checks finds the files as if they were not there, and a query on
 * the index is refused. A module without access control, and a file of no module, are left alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: { listRagModules: vi.fn(), listVectorIndexes: vi.fn(), findRagModuleByKey: vi.fn() },
  ragAccessForRequest: vi.fn(),
  canAdministerRagAccess: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/server/api/ragAccessRequest', () => ({
  ragAccessForRequest: hoisted.ragAccessForRequest,
  canAdministerRagAccess: hoisted.canAdministerRagAccess,
}));

import { FileServiceError } from '@/lib/services/files/errors';
import {
  kbBindingRefusal,
  kbIndexRefusal,
  kbIngestRefusal,
  ragFileGuard,
  ragModuleKeysOfFile,
  withoutHiddenFiles,
} from '@/server/api/ragOwnedResources';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const request = {} as never;
const where = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' };

/** What `ragAccessForRequest` answers for a module: no scope for a module that is not there. */
type Scope = { enabled: boolean; manage: boolean; bypass: boolean };
const NO_ACCESS_CONTROL: Scope = { enabled: false, manage: false, bypass: false };
const KEPT_OUT: Scope = { enabled: true, manage: false, bypass: false };
const ADMINISTRATOR: Scope = { enabled: true, manage: true, bypass: true };
/** The module turned the admin exception off: an administrator is checked like everyone else. */
const ADMINISTRATOR_WITHOUT_EXCEPTION: Scope = { enabled: true, manage: true, bypass: false };

const scopes = new Map<string, Scope>();

const file = (key: string, ragModuleKey?: string) => ({
  id: key,
  key,
  ...(ragModuleKey ? { metadata: { ragModuleKey } } : {}),
});
const hrFile = (name = 'handbook.pdf') => file(`knowledge-engine/hr/9b1c-${name}`, 'hr');
const plainFile = (name = 'a.pdf') => file(`reports/${name}`);

beforeEach(() => {
  vi.clearAllMocks();
  scopes.clear();
  mockFn(hoisted.ragAccessForRequest).mockImplementation(async (_request: unknown, input: { ragModuleKey: string }) => ({
    module: null,
    caller: { kind: 'person', userId: 'user-1' },
    scope: scopes.get(input.ragModuleKey),
  }));
  mockFn(hoisted.db.listRagModules).mockResolvedValue([]);
  mockFn(hoisted.db.listVectorIndexes).mockResolvedValue([]);
});

describe('the module a stored file belongs to', () => {
  it('is named by the metadata ragModuleKey stamps and by the key the module keeps its objects under', () => {
    expect(ragModuleKeysOfFile(file('knowledge-engine/hr/9b1c-handbook.pdf', 'hr'))).toEqual(['hr']);
    expect(ragModuleKeysOfFile(file('knowledge-engine/hr/9b1c-handbook.pdf'))).toEqual(['hr']);
    expect(ragModuleKeysOfFile(file('docs/handbook.pdf', 'hr'))).toEqual(['hr']);
    expect(ragModuleKeysOfFile(file('knowledge-engine/hr/sub/folder/handbook.pdf'))).toEqual(['hr']);
  });

  it('counts both when they differ: the file is kept back when either names a module with access control', () => {
    expect(ragModuleKeysOfFile(file('knowledge-engine/finance/1-a.pdf', 'hr')).sort()).toEqual(['finance', 'hr']);
  });

  it('is none for a file of no module', () => {
    expect(ragModuleKeysOfFile(plainFile())).toEqual([]);
    expect(ragModuleKeysOfFile({ key: 'reports/a.pdf', metadata: { owner: 'someone' } })).toEqual([]);
    // Directly under the prefix there is no module folder; another case of the prefix is another folder.
    expect(ragModuleKeysOfFile(file('knowledge-engine/readme.md'))).toEqual([]);
    expect(ragModuleKeysOfFile(file('Knowledge-Engine/hr/a.pdf'))).toEqual([]);
    expect(ragModuleKeysOfFile(file('my-knowledge-engine/hr/a.pdf'))).toEqual([]);
  });

  it('ignores a stamp that is not a name', () => {
    for (const stamped of [undefined, null, '', '   ', 7, ['hr'], { key: 'hr' }]) {
      expect(ragModuleKeysOfFile({ key: 'docs/a.pdf', metadata: { ragModuleKey: stamped } }), JSON.stringify(stamped)).toEqual([]);
    }
    expect(ragModuleKeysOfFile({ key: 'docs/a.pdf', metadata: null })).toEqual([]);
  });
});

describe('the file guard of a request', () => {
  it('lets a file of no module through without asking anything', async () => {
    const guard = ragFileGuard(request, where);

    expect(await guard.hides(plainFile())).toBe(false);
    expect(await guard.visible([plainFile('a.pdf'), plainFile('b.pdf')])).toHaveLength(2);
    await expect(guard.assertVisible(plainFile())).resolves.toBeUndefined();
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });

  it('holds a file back from a caller who does not skip the access checks of its module', async () => {
    scopes.set('hr', KEPT_OUT);
    const guard = ragFileGuard(request, where);

    expect(await guard.hides(hrFile())).toBe(true);
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledWith(request, { ...where, ragModuleKey: 'hr' });
  });

  it('answers a hidden file with the error of a key that has no record, so nothing tells the two apart', async () => {
    scopes.set('hr', KEPT_OUT);
    const guard = ragFileGuard(request, where);

    const refusal = await guard.assertVisible(hrFile()).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(FileServiceError);
    const error = refusal as FileServiceError;
    expect(error.code).toBe('file_not_found');
    expect(error.status).toBe(404);
    expect(error.message).toBe('File record not found.');
  });

  it('shows the file to an administrator of the module', async () => {
    scopes.set('hr', ADMINISTRATOR);
    const guard = ragFileGuard(request, where);

    expect(await guard.hides(hrFile())).toBe(false);
    await expect(guard.assertVisible(hrFile())).resolves.toBeUndefined();
  });

  it('holds it back from an administrator when the module turned the admin exception off', async () => {
    scopes.set('hr', ADMINISTRATOR_WITHOUT_EXCEPTION);

    expect(await ragFileGuard(request, where).hides(hrFile())).toBe(true);
  });

  it('leaves the files of a module without access control, and of a module that is not there, alone', async () => {
    scopes.set('hr', NO_ACCESS_CONTROL);
    const guard = ragFileGuard(request, where);

    expect(await guard.hides(hrFile())).toBe(false);
    // `ragAccessForRequest` answers without a scope when the module does not exist.
    expect(await guard.hides(file('knowledge-engine/gone/1-a.pdf', 'gone'))).toBe(false);
  });

  it('holds a file back when its key names a module with access control, whatever its metadata says', async () => {
    scopes.set('hr', NO_ACCESS_CONTROL);
    scopes.set('finance', KEPT_OUT);
    const guard = ragFileGuard(request, where);

    expect(await guard.hides(file('knowledge-engine/finance/1-a.pdf', 'hr'))).toBe(true);
    expect(await guard.hides(file('knowledge-engine/finance/2-b.pdf'))).toBe(true);
  });

  it('asks about a module once per request, however many of its files there are', async () => {
    scopes.set('hr', KEPT_OUT);
    scopes.set('ops', NO_ACCESS_CONTROL);
    const guard = ragFileGuard(request, where);
    const files = [hrFile('a.pdf'), hrFile('b.pdf'), file('knowledge-engine/ops/1-c.pdf', 'ops'), hrFile('d.pdf'), file('knowledge-engine/ops/2-e.pdf', 'ops')];

    const visible = await guard.visible(files);
    await guard.hides(hrFile('f.pdf'));

    expect(visible.map((entry) => entry.key)).toEqual(['knowledge-engine/ops/1-c.pdf', 'knowledge-engine/ops/2-e.pdf']);
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledTimes(2);
    expect(mockFn(hoisted.ragAccessForRequest).mock.calls.map((call) => (call[1] as { ragModuleKey: string }).ragModuleKey).sort()).toEqual(['hr', 'ops']);
  });

  it('names the keys it holds back, and keeps the order of the files it lets through', async () => {
    scopes.set('hr', KEPT_OUT);
    const guard = ragFileGuard(request, where);
    const files = [plainFile('z.pdf'), hrFile('a.pdf'), plainFile('m.pdf'), hrFile('b.pdf')];

    expect([...(await guard.hiddenKeys(files))].sort()).toEqual(['knowledge-engine/hr/9b1c-a.pdf', 'knowledge-engine/hr/9b1c-b.pdf']);
    expect((await guard.visible(files)).map((entry) => entry.key)).toEqual(['reports/z.pdf', 'reports/m.pdf']);
  });

  it('does not decide for itself when the question cannot be answered: the failure reaches the route', async () => {
    mockFn(hoisted.ragAccessForRequest).mockRejectedValue(new Error('the engine is down'));
    const guard = ragFileGuard(request, where);

    await expect(guard.hides(hrFile())).rejects.toThrow('the engine is down');
    await expect(guard.visible([hrFile()])).rejects.toThrow('the engine is down');
  });
});

describe('a listing read that leaves hidden files out', () => {
  const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, ...extra }) as never;
  const readOf = (pages: unknown[]) => {
    const queue = [...pages];
    return vi.fn(async (_cursor: string | undefined, _size: number) => queue.shift() as never);
  };
  const keysOf = (result: { items: Array<{ key: string }> }) => result.items.map((item) => item.key);

  beforeEach(() => {
    scopes.set('hr', KEPT_OUT);
  });

  it('returns the read as it was when nothing is left out', async () => {
    const first = page([plainFile('a.pdf'), plainFile('b.pdf')], { nextCursor: 'c1' });
    const read = readOf([first]);

    const result = await withoutHiddenFiles(ragFileGuard(request, where), read)(undefined, 50);

    expect(result).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('fills the page from the following reads, asking for exactly what is missing', async () => {
    const read = readOf([
      page([plainFile('p1.pdf'), hrFile('h1.pdf'), hrFile('h2.pdf'), plainFile('p2.pdf')], { nextCursor: 'c1' }),
      page([plainFile('p3.pdf'), hrFile('h3.pdf')], { nextCursor: 'c2' }),
      page([plainFile('p4.pdf')], { nextCursor: 'c3' }),
    ]);

    const result = await withoutHiddenFiles(ragFileGuard(request, where), read)(undefined, 4);

    expect(keysOf(result)).toEqual(['reports/p1.pdf', 'reports/p2.pdf', 'reports/p3.pdf', 'reports/p4.pdf']);
    expect(result.nextCursor).toBe('c3');
    expect(read.mock.calls).toEqual([[undefined, 4], ['c1', 2], ['c2', 1]]);
  });

  it('counts a folder as an entry of the page and keeps the folders and the prefix of the listing', async () => {
    const read = readOf([
      page([hrFile('h1.pdf'), plainFile('p1.pdf')], { folders: ['archive/'], prefix: 'docs/', nextCursor: 'c1' }),
      page([plainFile('p2.pdf')], { folders: [], prefix: 'docs/' }),
    ]);

    const result = await withoutHiddenFiles(ragFileGuard(request, where), read)(undefined, 3);

    expect(keysOf(result)).toEqual(['reports/p1.pdf', 'reports/p2.pdf']);
    expect(result).toMatchObject({ folders: ['archive/'], prefix: 'docs/' });
    expect(result.nextCursor).toBeUndefined();
    expect(read.mock.calls).toEqual([[undefined, 3], ['c1', 1]]);
  });

  it('ends where the listing ends: no cursor, no more reads', async () => {
    const read = readOf([page([hrFile('h1.pdf')])]);

    const result = await withoutHiddenFiles(ragFileGuard(request, where), read)(undefined, 10);

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops at a read that returns nothing, whatever cursor it names', async () => {
    const read = readOf([
      page([hrFile('h1.pdf')], { nextCursor: 'c1' }),
      page([], { nextCursor: 'c2' }),
    ]);

    const result = await withoutHiddenFiles(ragFileGuard(request, where), read)(undefined, 10);

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('returns a short page with where to go on when a listing keeps being hidden', async () => {
    let reads = 0;
    const read = vi.fn(async () => {
      reads += 1;
      return page([hrFile(`h${reads}.pdf`)], { nextCursor: `c${reads}` });
    });

    const result = await withoutHiddenFiles(ragFileGuard(request, where), read)(undefined, 5);

    expect(read).toHaveBeenCalledTimes(20);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBe('c20');
  });

  it('shows an administrator the whole read', async () => {
    scopes.set('hr', ADMINISTRATOR);
    const first = page([plainFile('p1.pdf'), hrFile('h1.pdf')], { nextCursor: 'c1' });
    const read = readOf([first]);

    const result = await withoutHiddenFiles(ragFileGuard(request, where), read)(undefined, 50);

    expect(result).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('a direct query on a vector index', () => {
  const index = { ...where, providerKey: 'vec', indexKey: 'kb-index' };
  const ragModule = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    name: key,
    vectorProviderKey: 'vec',
    vectorIndexKey: 'kb-index',
    access: { enabled: true },
    ...over,
  });
  const modules = (...list: unknown[]) => mockFn(hoisted.db.listRagModules).mockResolvedValue(list);
  const scopeOf = (key: string, scope: Scope) => scopes.set(key, scope);

  it('goes on when no module of the project has access control: one list of modules, nothing else asked', async () => {
    modules(ragModule('open', { access: undefined }), ragModule('off', { access: { enabled: false } }));

    expect(await kbIndexRefusal(request, index)).toBeNull();
    expect(hoisted.db.listRagModules).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(hoisted.db.listVectorIndexes).not.toHaveBeenCalled();
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });

  it('is refused with kb_access_controlled when a module with access control keeps its vectors in the index', async () => {
    modules(ragModule('payroll'));
    scopeOf('payroll', KEPT_OUT);

    const refusal = await kbIndexRefusal(request, index);

    expect(refusal).toEqual({ error: expect.any(String), code: 'kb_access_controlled' });
    // The refusal does not name the knowledge base.
    expect(JSON.stringify(refusal)).not.toContain('payroll');
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledWith(request, { ...where, ragModuleKey: 'payroll' });
  });

  it('goes on for a caller who administers the module', async () => {
    modules(ragModule('hr'));
    scopeOf('hr', ADMINISTRATOR);

    expect(await kbIndexRefusal(request, index)).toBeNull();
  });

  it('is refused for an administrator whose module turned the admin exception off', async () => {
    modules(ragModule('hr'));
    scopeOf('hr', ADMINISTRATOR_WITHOUT_EXCEPTION);

    expect(await kbIndexRefusal(request, index)).toMatchObject({ code: 'kb_access_controlled' });
  });

  it('needs every module that shares the index: one the caller does not administer is enough to refuse', async () => {
    modules(ragModule('hr'), ragModule('finance'));
    scopeOf('hr', ADMINISTRATOR);
    scopeOf('finance', KEPT_OUT);

    expect(await kbIndexRefusal(request, index)).toMatchObject({ code: 'kb_access_controlled' });
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledTimes(2);

    scopeOf('finance', ADMINISTRATOR);
    expect(await kbIndexRefusal(request, index)).toBeNull();
  });

  it('ignores a module that keeps its vectors in another index of the provider, or in another provider', async () => {
    modules(
      ragModule('elsewhere', { vectorIndexKey: 'other-index' }),
      ragModule('other-provider', { vectorProviderKey: 'vec-2' }),
    );
    mockFn(hoisted.db.listVectorIndexes).mockResolvedValue([
      { key: 'kb-index', externalId: 'ext-1' },
      { key: 'other-index', externalId: 'ext-2' },
    ]);

    expect(await kbIndexRefusal(request, index)).toBeNull();
    // Only the modules of this provider make the index records worth reading.
    expect(hoisted.db.listVectorIndexes).toHaveBeenCalledTimes(1);
    expect(hoisted.db.listVectorIndexes).toHaveBeenCalledWith({ providerKey: 'vec', projectId: 'proj-1' });
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });

  it('does not read the index records when the module is on the index asked about, or on another provider', async () => {
    modules(ragModule('hr'), ragModule('other-provider', { vectorProviderKey: 'vec-2', vectorIndexKey: 'x' }));
    scopeOf('hr', ADMINISTRATOR);

    await kbIndexRefusal(request, index);

    expect(hoisted.db.listVectorIndexes).not.toHaveBeenCalled();
  });

  it('counts an index registered a second time (same provider, same external id) as the index of the module', async () => {
    modules(ragModule('hr', { vectorIndexKey: 'kb-index' }));
    scopeOf('hr', KEPT_OUT);
    mockFn(hoisted.db.listVectorIndexes).mockResolvedValue([
      { key: 'kb-index', externalId: 'ext-1' },
      { key: 'kb-index-attached', externalId: 'ext-1' },
      { key: 'unrelated', externalId: 'ext-9' },
    ]);

    expect(await kbIndexRefusal(request, { ...index, indexKey: 'kb-index-attached' })).toMatchObject({ code: 'kb_access_controlled' });
    expect(await kbIndexRefusal(request, { ...index, indexKey: 'unrelated' })).toBeNull();
  });

  it('does not take an index with no external id, or one that is not there, for any other', async () => {
    modules(ragModule('hr'));
    scopeOf('hr', KEPT_OUT);
    mockFn(hoisted.db.listVectorIndexes).mockResolvedValue([
      { key: 'kb-index', externalId: '' },
      { key: 'blank', externalId: '' },
    ]);

    expect(await kbIndexRefusal(request, { ...index, indexKey: 'blank' })).toBeNull();
    expect(await kbIndexRefusal(request, { ...index, indexKey: 'not-registered' })).toBeNull();
  });

  it('does not decide for itself when the question cannot be answered: the failure reaches the route', async () => {
    modules(ragModule('hr'));
    mockFn(hoisted.ragAccessForRequest).mockRejectedValue(new Error('the engine is down'));

    await expect(kbIndexRefusal(request, index)).rejects.toThrow('the engine is down');
  });
});

describe('documents another service sends into a knowledge base', () => {
  const guarded = { key: 'hr', projectId: 'proj-1', access: { enabled: true } };

  it('a module with access control takes them only from a caller who administers it', async () => {
    mockFn(hoisted.db.findRagModuleByKey).mockResolvedValue(guarded);
    mockFn(hoisted.canAdministerRagAccess).mockResolvedValue(false);
    expect(await kbIngestRefusal(request, where, 'hr')).toEqual({
      error: expect.stringContaining('access control'),
      code: 'kb_access_controlled',
    });
    mockFn(hoisted.canAdministerRagAccess).mockResolvedValue(true);
    expect(await kbIngestRefusal(request, where, 'hr')).toBeNull();
    expect(hoisted.db.findRagModuleByKey).toHaveBeenCalledWith('hr', 'proj-1');
    expect(hoisted.canAdministerRagAccess).toHaveBeenCalledWith(request, guarded);
  });

  it('asks nothing more of a module without access control, or of one that is not there', async () => {
    for (const found of [null, { key: 'hr', access: { enabled: false } }, { key: 'hr' }]) {
      mockFn(hoisted.db.findRagModuleByKey).mockResolvedValueOnce(found);
      expect(await kbIngestRefusal(request, where, 'hr')).toBeNull();
    }
    expect(hoisted.canAdministerRagAccess).not.toHaveBeenCalled();
  });

  it('a crawler binding asks only when it sends pages', async () => {
    mockFn(hoisted.db.findRagModuleByKey).mockResolvedValue(guarded);
    mockFn(hoisted.canAdministerRagAccess).mockResolvedValue(false);
    expect(await kbBindingRefusal(request, where, undefined)).toBeNull();
    expect(await kbBindingRefusal(request, where, null)).toBeNull();
    expect(await kbBindingRefusal(request, where, { ragModuleKey: 'hr', enabled: false })).toBeNull();
    expect(hoisted.db.findRagModuleByKey).not.toHaveBeenCalled();
    expect((await kbBindingRefusal(request, where, { ragModuleKey: 'hr', enabled: true }))?.code).toBe('kb_access_controlled');
  });
});
