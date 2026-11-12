'use client';

/**
 * The active project's Config groups and items, for the pickers that let a setting take its value from Config
 * (agent sandbox env and secrets, sandbox template and instance env). Values are never needed here: secret
 * values come back masked from the API and the pickers only show keys, names and whether an item is secret.
 *
 * `status` is `forbidden` when the caller may not read Config (the API answers 403): the pickers then say so
 * instead of offering an empty list.
 */

import { useCallback, useMemo } from 'react';
import { envNameFromConfigKey } from '@/lib/config/configRefShared';
import { isForbidden, useConfigCatalogData, type RawConfigGroup, type RawConfigItem } from '@/lib/api/queries/config';

export interface ConfigCatalogItem {
  id: string;
  key: string;
  name: string;
  description?: string;
  groupId: string;
  isSecret: boolean;
  valueType: string;
  version: number;
  /** The variable name a bound group gives this item (null: the key gives no usable name). */
  envName: string | null;
}

export interface ConfigCatalogGroup {
  id: string;
  key: string;
  name: string;
  description?: string;
  items: ConfigCatalogItem[];
}

export type ConfigCatalogStatus = 'loading' | 'ready' | 'forbidden' | 'error';

export interface ConfigCatalog {
  status: ConfigCatalogStatus;
  groups: ConfigCatalogGroup[];
  itemsById: Map<string, ConfigCatalogItem>;
  groupsById: Map<string, ConfigCatalogGroup>;
  reload: () => void;
}

function buildGroups(rawGroups: RawConfigGroup[], rawItems: RawConfigItem[]): ConfigCatalogGroup[] {
  const byGroup = new Map<string, ConfigCatalogItem[]>();
  for (const raw of rawItems) {
    const item: ConfigCatalogItem = {
      id: String(raw._id ?? raw.id ?? ''),
      key: raw.key,
      name: raw.name,
      description: raw.description,
      groupId: String(raw.groupId),
      isSecret: Boolean(raw.isSecret),
      valueType: raw.valueType ?? 'string',
      version: raw.version ?? 1,
      envName: envNameFromConfigKey(raw.key),
    };
    const list = byGroup.get(item.groupId) ?? [];
    list.push(item);
    byGroup.set(item.groupId, list);
  }
  return rawGroups
    .map((raw) => {
      const id = String(raw._id ?? raw.id ?? '');
      return {
        id,
        key: raw.key,
        name: raw.name,
        description: raw.description,
        items: (byGroup.get(id) ?? []).sort((a, b) => a.key.localeCompare(b.key)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function useConfigCatalog(enabled = true): ConfigCatalog {
  const query = useConfigCatalogData(enabled);
  const { refetch } = query;

  const groups = useMemo(
    () => (query.data ? buildGroups(query.data.groups, query.data.items) : []),
    [query.data],
  );
  const status: ConfigCatalogStatus = query.isError
    ? isForbidden(query.error)
      ? 'forbidden'
      : 'error'
    : query.isPending
      ? 'loading'
      : 'ready';

  const itemsById = useMemo(() => {
    const map = new Map<string, ConfigCatalogItem>();
    for (const group of groups) for (const item of group.items) map.set(item.id, item);
    return map;
  }, [groups]);
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);

  return { status, groups, itemsById, groupsById, reload };
}
