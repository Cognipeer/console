/**
 * Pure row <-> config mapping for the env / secret editors that can take a value from Config.
 * A row is either a typed value or a reference to one config item; the stored shapes are the
 * `env`/`secrets` maps and the `envRefs`/`secretRefs` maps (`IConfigValueRef`).
 */

import { CONFIG_ENV_NAME_RE } from '@/lib/config/configRefShared';
import type { IConfigGroupRef, IConfigValueRef } from '@/lib/config/configRefShared';
import type { ConfigCatalogGroup, ConfigCatalogItem } from './useConfigCatalog';

export type RowSource = 'value' | 'config';

export interface EditorRow {
  id: number;
  key: string;
  source: RowSource;
  /** Typed value (source `value`). */
  value: string;
  /** Reference (source `config`). */
  ref?: IConfigValueRef;
  /** The typed value this row had before it was switched to Config; kept until an item is picked. */
  prevValue?: string;
  /** Loaded from the stored config (not added in this edit): its value is kept even when empty. */
  stored?: boolean;
}

let rowSeq = 0;
export const nextRowId = (): number => ++rowSeq;

export function rowsFromMaps(
  values: Record<string, string> | undefined,
  refs: Record<string, IConfigValueRef> | undefined,
): EditorRow[] {
  const rows: EditorRow[] = Object.entries(values ?? {}).map(([key, value]) => ({ id: nextRowId(), key, source: 'value', value, stored: true }));
  for (const [key, ref] of Object.entries(refs ?? {})) {
    if (ref?.configId) rows.push({ id: nextRowId(), key, source: 'config', value: '', ref, stored: true });
  }
  return rows;
}

export interface RowMaps {
  values: Record<string, string> | undefined;
  refs: Record<string, IConfigValueRef> | undefined;
}

/**
 * Rows without a name are dropped. A config row without a chosen item keeps what it had stored (a typed or
 * masked value) until an item is picked; a brand-new row is simply not saved.
 */
export function rowsToMaps(rows: EditorRow[]): RowMaps {
  const values: Record<string, string> = {};
  const refs: Record<string, IConfigValueRef> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.source === 'config') {
      if (row.ref?.configId) refs[key] = row.ref;
      else if (row.prevValue !== undefined && (row.stored || row.prevValue !== '')) values[key] = row.prevValue;
    } else {
      values[key] = row.value;
    }
  }
  return {
    values: Object.keys(values).length > 0 ? values : undefined,
    refs: Object.keys(refs).length > 0 ? refs : undefined,
  };
}

/** Stable comparison key, used to re-seed the rows when the stored value changes from outside. */
export const serializeMaps = (maps: RowMaps): string => JSON.stringify([maps.values ?? {}, maps.refs ?? {}]);

export function refFromItem(item: ConfigCatalogItem): IConfigValueRef {
  return { configId: item.id, key: item.key, groupId: item.groupId };
}

/** Switching a row's source: the typed value is remembered while on Config and restored when switching back. */
export function switchRowSource(row: EditorRow, source: RowSource): EditorRow {
  if (row.source === source) return row;
  if (source === 'config') return { ...row, source, value: '', ref: undefined, prevValue: row.value };
  return { ...row, source, value: row.prevValue ?? '', ref: undefined, prevValue: undefined };
}

export type NameProblem = 'empty' | 'invalid' | 'duplicate';

/** A variable name that cannot be used, or null. `taken` are the other names in the same block (and its sibling). */
export function nameProblem(name: string, taken: ReadonlySet<string>): NameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (!CONFIG_ENV_NAME_RE.test(trimmed)) return 'invalid';
  if (taken.has(trimmed)) return 'duplicate';
  return null;
}

export const nameProblemText = (problem: NameProblem): string =>
  problem === 'duplicate' ? 'Name already used' : problem === 'invalid' ? 'Letters, digits and _ only' : 'Name required';

/** Names in use by the rows of an editor (typed or Config), optionally ignoring one row. */
export const usedNames = (rows: EditorRow[], exceptId?: number): Set<string> =>
  new Set(rows.filter((row) => row.id !== exceptId && row.key.trim()).map((row) => row.key.trim()));

/** The rows to add for a set of picked items, with the (possibly edited) variable names. Invalid or duplicate names are skipped. */
export function rowsForPickedItems(
  picks: Array<{ item: ConfigCatalogItem; name: string }>,
  existing: ReadonlySet<string>,
): EditorRow[] {
  const taken = new Set(existing);
  const rows: EditorRow[] = [];
  for (const { item, name } of picks) {
    const key = name.trim();
    if (nameProblem(key, taken)) continue;
    taken.add(key);
    rows.push({ id: nextRowId(), key, source: 'config', value: '', ref: refFromItem(item) });
  }
  return rows;
}

/** The variables a bound group gives, in item order; items whose key gives no usable name are left out. */
export function groupVariablePreview(group: ConfigCatalogGroup): Array<{ name: string; isSecret: boolean }> {
  return group.items.flatMap((item) => (item.envName ? [{ name: item.envName, isSecret: item.isSecret }] : []));
}

export const groupRefFor = (group: ConfigCatalogGroup): IConfigGroupRef => ({ groupId: group.id, key: group.key });

/** Adds groups not yet bound. */
export function addGroupRefs(current: IConfigGroupRef[] | undefined, groups: ConfigCatalogGroup[]): IConfigGroupRef[] {
  const next = [...(current ?? [])];
  for (const group of groups) {
    if (!next.some((ref) => ref.groupId === group.id)) next.push(groupRefFor(group));
  }
  return next;
}
