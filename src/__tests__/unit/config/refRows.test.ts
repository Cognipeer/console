import { describe, expect, it } from 'vitest';
import {
  addGroupRefs, groupVariablePreview, nameProblem, rowsForPickedItems, rowsFromMaps, rowsToMaps, switchRowSource,
} from '@/components/config/refs/refRows';
import type { ConfigCatalogGroup, ConfigCatalogItem } from '@/components/config/refs/useConfigCatalog';

const item = (over: Partial<ConfigCatalogItem> = {}): ConfigCatalogItem => ({
  id: 'i1', key: 'cfg-openai-key', name: 'OpenAI', groupId: 'g1', isSecret: false, valueType: 'string', version: 1, envName: 'OPENAI_KEY', ...over,
});

describe('refRows', () => {
  it('round-trips values and refs', () => {
    const ref = { configId: 'i1', key: 'k', groupId: 'g1' };
    const rows = rowsFromMaps({ A: '1' }, { B: ref });
    expect(rows.map((r) => r.source)).toEqual(['value', 'config']);
    expect(rowsToMaps(rows)).toEqual({ values: { A: '1' }, refs: { B: ref } });
  });

  it('drops unnamed rows and config rows without an item', () => {
    const rows = rowsFromMaps({ A: '1' }, undefined);
    rows.push({ id: 99, key: 'X', source: 'config', value: '' }, { id: 100, key: ' ', source: 'value', value: 'v' });
    expect(rowsToMaps(rows)).toEqual({ values: { A: '1' }, refs: undefined });
  });

  it('switching to Config keeps the stored value until an item is picked', () => {
    const [secret] = rowsFromMaps({ A: '••••••' }, undefined);
    const cfg = switchRowSource(secret, 'config');
    expect(cfg).toMatchObject({ source: 'config', value: '', prevValue: '••••••' });
    expect(rowsToMaps([cfg]).values).toEqual({ A: '••••••' });
    const picked = { ...cfg, ref: { configId: 'i1', key: 'k', groupId: 'g1' } };
    expect(rowsToMaps([picked])).toEqual({ values: undefined, refs: { A: picked.ref } });
    expect(switchRowSource(cfg, 'value').value).toBe('••••••');
  });

  it('a brand-new row switched to Config without an item is not saved', () => {
    const cfg = switchRowSource({ id: 5, key: 'NEW', source: 'value', value: '' }, 'config');
    expect(rowsToMaps([cfg])).toEqual({ values: undefined, refs: undefined });
  });

  it('flags empty, invalid and duplicate names', () => {
    const taken = new Set(['A']);
    expect(nameProblem('', taken)).toBe('empty');
    expect(nameProblem('1x', taken)).toBe('invalid');
    expect(nameProblem('A', taken)).toBe('duplicate');
    expect(nameProblem('B', taken)).toBeNull();
  });

  it('picked items skip bad and duplicate names', () => {
    const rows = rowsForPickedItems(
      [{ item: item(), name: 'A' }, { item: item({ id: 'i2' }), name: 'A' }, { item: item({ id: 'i3' }), name: 'bad name' }],
      new Set(['Z']),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ref?.configId).toBe('i1');
  });

  it('previews group variables and adds groups once', () => {
    const group: ConfigCatalogGroup = { id: 'g1', key: 'prod', name: 'Prod', items: [item(), item({ id: 'i2', envName: null }), item({ id: 'i3', envName: 'S', isSecret: true })] };
    expect(groupVariablePreview(group)).toEqual([{ name: 'OPENAI_KEY', isSecret: false }, { name: 'S', isSecret: true }]);
    const once = addGroupRefs(undefined, [group]);
    expect(addGroupRefs(once, [group])).toEqual([{ groupId: 'g1', key: 'prod' }]);
  });
});
