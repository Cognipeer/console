import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';

vi.mock('@/lib/services/config/configService', () => ({
  openConfigItemValue: (item: { value: string }) => {
    if (item.value === 'bad-cipher') throw new Error('cannot decrypt');
    return item.value;
  },
}));
const runWithTenantScope = vi.hoisted(() => vi.fn());
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(), runWithTenantScope }));

import { envNameFromConfigKey, MAX_CONFIG_GROUP_REFS, MAX_CONFIG_VALUE_REFS } from '@/lib/config/configRefShared';
import {
  addsConfigTargets,
  blockingConfigRefProblems,
  configRefTargets,
  configVarValues,
  describeConfigRefProblems,
  loadProjectConfigIndex,
  normalizeConfigGroupRefs,
  normalizeConfigValueRefs,
  rawConfigRefTargets,
  resolveConfigRefs,
} from '@/lib/services/config/configRefs';

interface Item { _id: string; key: string; value: string; isSecret: boolean; groupId: string; projectId?: string; version: number }
interface Group { _id: string; key: string; projectId?: string }
let items: Item[];
let groups: Group[];
let audit: Array<Record<string, unknown>>;

const item = (id: string, key: string, value: string, isSecret = false, over: Partial<Item> = {}): Item =>
  ({ _id: id, key, value, isSecret, groupId: 'g1', projectId: 'p1', version: 4, ...over });

const db = () => ({
  listConfigGroups: async (f: { projectId?: string }) => groups.filter((g) => g.projectId === f.projectId),
  listConfigItems: async (f: { projectId?: string; groupId?: string }) =>
    items.filter((i) => (!f.projectId || i.projectId === f.projectId) && (!f.groupId || i.groupId === f.groupId)),
  findConfigItemById: async (id: string) => items.find((i) => i._id === id) ?? null,
  findConfigGroupById: async (id: string) => groups.find((g) => g._id === id) ?? null,
  createConfigAuditLog: async (entry: Record<string, unknown>) => { audit.push(entry); return entry; },
}) as unknown as DatabaseProvider;

beforeEach(() => {
  groups = [{ _id: 'g1', key: 'shared', projectId: 'p1' }, { _id: 'g2', key: 'second', projectId: 'p1' }, { _id: 'gx', key: 'foreign', projectId: 'p2' }];
  items = [
    item('i1', 'region', 'eu'),
    item('i2', 'api-key', 'sk-123456', true),
    item('i3', 'dup', 'one', false, { groupId: 'g1' }),
    item('i4', 'dup', 'two', false, { groupId: 'g2' }),
    item('ix', 'foreign-item', 'zzz', false, { groupId: 'gx', projectId: 'p2' }),
  ];
  audit = [];
});

const normalizeValues = async (input: unknown, allowSecret = true) =>
  normalizeConfigValueRefs(db(), await loadProjectConfigIndex(db(), 'p1'), input, 'f', { allowSecret });
const normalizeGroups = async (input: unknown) =>
  normalizeConfigGroupRefs(db(), await loadProjectConfigIndex(db(), 'p1'), input, 'g');

describe('envNameFromConfigKey', () => {
  it.each([
    ['cfg-openai-api-key', 'OPENAI_API_KEY'],
    ['db.password', 'DB_PASSWORD'],
    ['2fa-seed', '_2FA_SEED'],
    ['---', null],
  ])('%s -> %s', (key, name) => expect(envNameFromConfigKey(key)).toBe(name));
});

describe('normalizeConfigValueRefs', () => {
  it('keeps undefined, clears on null, and refuses a non-object', async () => {
    expect((await normalizeValues(undefined)).refs).toBeUndefined();
    expect((await normalizeValues(null)).refs).toEqual({});
    expect((await normalizeValues([])).issues[0].field).toBe('f');
  });

  it('stores ids for a reference sent by id, by configKey or by key', async () => {
    const { refs, issues } = await normalizeValues({
      A: { configId: 'i1' }, B: { configKey: 'api-key' }, C: { key: 'region' },
    });
    expect(issues).toEqual([]);
    expect(refs).toEqual({
      A: { configId: 'i1', key: 'region', groupId: 'g1' },
      B: { configId: 'i2', key: 'api-key', groupId: 'g1' },
      C: { configId: 'i1', key: 'region', groupId: 'g1' },
    });
  });

  it('refuses an ambiguous key, an unknown key and an item of another project, with the field path', async () => {
    const { refs, issues } = await normalizeValues({
      AMBIG: { configKey: 'dup' }, NONE: { configKey: 'nope' }, FOREIGN: { configId: 'ix' }, MISSING: { configId: 'zz' }, EMPTY: {},
    });
    expect(refs).toEqual({});
    expect(issues.map((i) => i.field).sort()).toEqual(['f.AMBIG', 'f.EMPTY', 'f.FOREIGN', 'f.MISSING', 'f.NONE']);
    expect(issues.find((i) => i.field === 'f.AMBIG')!.message).toMatch(/configId/);
    // Another project's item is reported like an unknown one: the message never says it exists elsewhere.
    expect(issues.find((i) => i.field === 'f.FOREIGN')!.message).toMatch(/was not found in this project/);
    expect(issues.find((i) => i.field === 'f.FOREIGN')!.message).not.toMatch(/another project/);
  });

  it('accepts an ambiguous key by id', async () => {
    expect((await normalizeValues({ A: { configId: 'i4' } })).refs).toEqual({ A: { configId: 'i4', key: 'dup', groupId: 'g2' } });
  });

  it('refuses a secret item when secrets are not allowed, and an invalid variable name', async () => {
    const { refs, issues } = await normalizeValues({ KEY: { configId: 'i2' }, '1bad': { configId: 'i1' } }, false);
    expect(refs).toEqual({});
    expect(issues.map((i) => i.field).sort()).toEqual(['f.1bad', 'f.KEY']);
    expect(issues.find((i) => i.field === 'f.KEY')!.message).toMatch(/secret/);
  });

  it('limits the number of variables', async () => {
    const many = Object.fromEntries(Array.from({ length: MAX_CONFIG_VALUE_REFS + 1 }, (_, n) => [`V${n}`, { configId: 'i1' }]));
    expect((await normalizeValues(many)).issues).toEqual([{ field: 'f', message: expect.stringContaining(String(MAX_CONFIG_VALUE_REFS)) }]);
  });
});

describe('normalizeConfigGroupRefs', () => {
  it('stores id and key, by id, groupKey or key, without duplicates', async () => {
    const { refs, issues } = await normalizeGroups([{ groupId: 'g1' }, { groupKey: 'shared' }, { key: 'second' }]);
    expect(issues).toEqual([]);
    expect(refs).toEqual([{ groupId: 'g1', key: 'shared' }, { groupId: 'g2', key: 'second' }]);
  });

  it('keeps undefined, clears on null, refuses a non-list, other projects, unknown keys and too many', async () => {
    expect((await normalizeGroups(undefined)).refs).toBeUndefined();
    expect((await normalizeGroups(null)).refs).toEqual([]);
    expect((await normalizeGroups({})).issues[0].field).toBe('g');
    const bad = await normalizeGroups([{ groupId: 'gx' }, { groupKey: 'nope' }, {}]);
    expect(bad.refs).toEqual([]);
    expect(bad.issues.map((i) => i.field)).toEqual(['g[0]', 'g[1]', 'g[2]']);
    const tooMany = await normalizeGroups(Array.from({ length: MAX_CONFIG_GROUP_REFS + 1 }, () => ({ groupId: 'g1' })));
    expect(tooMany.issues).toHaveLength(1);
  });
});

describe('configRefTargets / addsConfigTargets', () => {
  it('adds only for a target the previous set did not have', () => {
    const prev = configRefTargets({ refs: [{ A: { configId: 'i1', key: 'region' } }], groupRefs: [[{ groupId: 'g1', key: 'shared' }]] });
    expect([...prev].sort()).toEqual(['group-key:shared', 'group:g1', 'item-key:region', 'item:i1']);
    expect(addsConfigTargets(new Set(prev), prev)).toBe(false);
    expect(addsConfigTargets(new Set(['item:i1']), prev)).toBe(false);
    expect(addsConfigTargets(new Set(['item:i1', 'item:i2']), prev)).toBe(true);
    expect(addsConfigTargets(new Set(), prev)).toBe(false);
    expect(configRefTargets({ refs: [null, undefined], groupRefs: [undefined] }).size).toBe(0);
  });

  it('a stored ref also covers the same item or group sent by key', () => {
    const prev = configRefTargets({ refs: [{ A: { configId: 'i1', key: 'region' } }], groupRefs: [[{ groupId: 'g1', key: 'shared' }]] });
    expect(addsConfigTargets(rawConfigRefTargets({ refs: [{ X: { configKey: 'region' } }], groupRefs: [[{ groupKey: 'shared' }]] }), prev)).toBe(false);
    expect(addsConfigTargets(rawConfigRefTargets({ refs: [{ X: { configKey: 'other' } }] }), prev)).toBe(true);
  });
});

describe('rawConfigRefTargets', () => {
  it('yields ids and keys of raw (unnormalized) refs, preferring the id', () => {
    const targets = rawConfigRefTargets({
      refs: [{ A: { configId: 'i1', configKey: 'ignored' }, B: { configKey: 'api-key' }, C: { key: 'region' } }],
      groupRefs: [[{ groupId: 'g1', groupKey: 'ignored' }, { groupKey: 'second' }, { key: 'third' }]],
    });
    expect([...targets].sort()).toEqual(['group-key:second', 'group-key:third', 'group:g1', 'item-key:api-key', 'item-key:region', 'item:i1']);
  });

  it('ignores anything that is not a map / list of objects, and blank values', () => {
    const targets = rawConfigRefTargets({
      refs: [null, undefined, 'x', ['a'], { A: null, B: 'str', C: {}, D: { configId: '  ' } }],
      groupRefs: [null, { groupId: 'g1' }, [null, 'x', {}, { groupId: '' }]],
    });
    expect(targets.size).toBe(0);
  });
});

describe('resolveConfigRefs', () => {
  const run = (over: Record<string, unknown>) =>
    resolveConfigRefs({ tenantDbName: 't', tenantId: 't', projectId: 'p1', performedBy: 'agent:bot', db: db(), ...over } as never);

  it('binds its own tenant scope when no db is passed, and none when there is nothing to resolve', async () => {
    runWithTenantScope.mockImplementation(async (_name: string, fn: (d: DatabaseProvider) => unknown) => fn(db()));
    runWithTenantScope.mockClear();
    const { vars } = await resolveConfigRefs({
      tenantDbName: 'tdb', tenantId: 't', projectId: 'p1', performedBy: 'agent:bot',
      refs: { OK: { configId: 'i2', key: 'api-key' } },
    });
    expect(runWithTenantScope).toHaveBeenCalledTimes(1);
    expect(runWithTenantScope.mock.calls[0][0]).toBe('tdb');
    expect(vars.OK.value).toBe('sk-123456');
    expect(audit).toHaveLength(1);

    runWithTenantScope.mockClear();
    await resolveConfigRefs({ tenantDbName: 'tdb', tenantId: 't', projectId: 'p1', performedBy: 'agent:bot' });
    await resolveConfigRefs({ tenantDbName: 'tdb', tenantId: 't', projectId: null, performedBy: 'agent:bot', refs: { A: { configId: 'i1', key: 'region' } } });
    expect(runWithTenantScope).not.toHaveBeenCalled();
    // A passed db is used as is.
    await run({ refs: { A: { configId: 'i1', key: 'region' } } });
    expect(runWithTenantScope).not.toHaveBeenCalled();
  });

  it('resolves nothing without references', async () => {
    expect(await run({})).toEqual({ vars: {}, problems: [] });
  });

  it('names a bound group items after their keys, in key order', async () => {
    const { vars, problems } = await run({ groupRefs: [{ groupId: 'g1', key: 'shared' }] });
    expect(problems).toEqual([]);
    expect(Object.keys(vars)).toEqual(['API_KEY', 'DUP', 'REGION']);
    expect(configVarValues(vars, 'secret')).toEqual({ API_KEY: 'sk-123456' });
    expect(configVarValues(vars, 'plain')).toEqual({ DUP: 'one', REGION: 'eu' });
    expect(configVarValues(vars)).toHaveProperty('API_KEY');
  });

  it('lets an explicit reference and reservedNames beat a bound group', async () => {
    const { vars } = await run({
      refs: { REGION: { configId: 'i3', key: 'dup' } },
      groupRefs: [{ groupId: 'g1', key: 'shared' }],
      reservedNames: ['API_KEY'],
    });
    expect(vars.REGION.value).toBe('one');
    expect(vars.API_KEY).toBeUndefined();
    expect(audit).toEqual([]);
  });

  it('uses the first group on a name collision and reports it as a warning', async () => {
    const { vars, problems } = await run({ groupRefs: [{ groupId: 'g1', key: 'shared' }, { groupId: 'g2', key: 'second' }] });
    expect(vars.DUP.value).toBe('one');
    expect(problems).toEqual([expect.objectContaining({ reason: 'name_collision', name: 'DUP' })]);
    expect(blockingConfigRefProblems(problems)).toEqual([]);
  });

  it('reports missing, other-project, unreadable and no-project references and keeps the rest', async () => {
    items.push(item('i5', 'broken', 'bad-cipher', true));
    const { vars, problems } = await run({
      refs: {
        OK: { configId: 'i1', key: 'region' },
        GONE: { configId: 'nope', key: 'removed' },
        FOREIGN: { configId: 'ix', key: 'foreign-item' },
        BROKEN: { configId: 'i5', key: 'broken' },
      },
      groupRefs: [{ groupId: 'zz', key: 'deleted' }, { groupId: 'gx', key: 'foreign' }],
    });
    expect(Object.keys(vars)).toEqual(['OK']);
    expect(problems.map((p) => p.reason).sort()).toEqual(['missing', 'missing', 'other_project', 'other_project', 'unreadable']);
    expect(blockingConfigRefProblems(problems)).toHaveLength(5);
    expect(describeConfigRefProblems(problems)).toContain('GONE');
    expect(JSON.stringify(problems)).not.toMatch(/sk-123456|bad-cipher/);

    const none = await run({ projectId: null, refs: { A: { configId: 'i1', key: 'region' } }, groupRefs: [{ groupId: 'g1', key: 'shared' }] });
    expect(none.vars).toEqual({});
    expect(none.problems.map((p) => p.reason)).toEqual(['no_project', 'no_project']);
  });

  it('skips a group item whose key gives no variable name', async () => {
    items.push(item('i6', '---', 'x', false, { groupId: 'g2' }));
    const { problems } = await run({ groupRefs: [{ groupId: 'g2', key: 'second' }] });
    expect(problems).toEqual([expect.objectContaining({ reason: 'invalid_name' })]);
  });

  it('audits one read per secret item, however many ways reach it', async () => {
    await run({
      refs: { A: { configId: 'i2', key: 'api-key' }, B: { configId: 'i2', key: 'api-key' } },
      groupRefs: [{ groupId: 'g1', key: 'shared' }],
      reservedNames: [],
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenantId: 't', projectId: 'p1', configKey: 'api-key', action: 'read', version: 4, performedBy: 'agent:bot' });
  });
});
