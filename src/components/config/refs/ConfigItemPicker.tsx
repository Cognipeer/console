'use client';

/**
 * Picks one config item of the project, grouped by config group, searchable. Shows key, name, secret badge,
 * group and version. Handles the catalog states (loading / forbidden / error) and a stored reference whose
 * item is gone. Never shows values.
 */

import { Anchor, Badge, Group, Loader, Select, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconExternalLink, IconLock } from '@tabler/icons-react';
import type { IConfigValueRef } from '@/lib/config/configRefShared';
import { refFromItem } from './refRows';
import type { ConfigCatalog, ConfigCatalogItem } from './useConfigCatalog';

export const CONFIG_FORBIDDEN_HINT = 'You need read access to Config in this project';
export const CONFIG_MISSING_HINT = 'This config item was deleted or is in another project — pick another or switch to Value';

export function CreateConfigItemLink() {
  return (
    <Anchor
      href="/dashboard/config"
      target="_blank"
      rel="noreferrer"
      size="xs"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
    >
      Create a config item <IconExternalLink size={10} />
    </Anchor>
  );
}

export function SecretBadge() {
  return (
    <Badge size="xs" variant="light" color="orange" leftSection={<IconLock size={9} />}>secret</Badge>
  );
}

/** One line describing an item: key, secret badge, group · version. */
export function ConfigItemSummary({ item, groupName }: { item: ConfigCatalogItem; groupName?: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" ff="monospace" truncate>{item.key}</Text>
      {item.isSecret ? <SecretBadge /> : null}
      <Text size="xs" c="dimmed" truncate>{groupName ? `${groupName} · ` : ''}v{item.version}</Text>
    </Group>
  );
}

export interface ConfigItemPickerProps {
  catalog: ConfigCatalog;
  value: IConfigValueRef | undefined;
  onChange: (ref: IConfigValueRef) => void;
  /** Items that cannot be picked here are shown disabled with this reason. */
  disableSecret?: boolean;
  disableSecretReason?: string;
  label?: string;
  size?: 'xs' | 'sm' | 'md';
}

export default function ConfigItemPicker({
  catalog, value, onChange, disableSecret = false, disableSecretReason = 'Secret items go under Secrets', label, size,
}: ConfigItemPickerProps) {
  const { status } = catalog;
  const selected = value?.configId ? catalog.itemsById.get(value.configId) : undefined;
  const missing = status === 'ready' && Boolean(value?.configId) && !selected;

  if (status === 'forbidden') return <Text size="xs" c="dimmed">{CONFIG_FORBIDDEN_HINT}</Text>;
  if (status === 'error') {
    return (
      <Text size="xs" c="red.7">
        Could not load Config.{' '}
        <Anchor component="button" type="button" size="xs" onClick={catalog.reload}>Retry</Anchor>
      </Text>
    );
  }

  const data = catalog.groups
    .filter((group) => group.items.length > 0)
    .map((group) => ({
      group: group.name,
      items: group.items.map((item) => ({
        value: item.id,
        label: `${item.name} (${item.key})`,
        disabled: disableSecret && item.isSecret,
      })),
    }));

  return (
    <Stack gap={4}>
      <Select
        size={size}
        label={label}
        placeholder={status === 'loading' ? 'Loading Config…' : 'Pick a config item'}
        aria-label={label ?? 'Config item'}
        data={data}
        value={selected?.id ?? null}
        onChange={(id) => {
          const item = id ? catalog.itemsById.get(id) : undefined;
          if (item) onChange(refFromItem(item));
        }}
        searchable
        disabled={status === 'loading'}
        rightSection={status === 'loading' ? <Loader size={12} /> : undefined}
        nothingFoundMessage="No config items"
        error={missing ? CONFIG_MISSING_HINT : undefined}
        renderOption={({ option }) => {
          const item = catalog.itemsById.get(option.value);
          if (!item) return option.label;
          return (
            <Stack gap={0}>
              <Group gap={6} wrap="nowrap">
                <Text size="sm" truncate>{item.name}</Text>
                {item.isSecret ? <SecretBadge /> : null}
              </Group>
              <Text size="xs" c="dimmed" truncate>
                {item.key} · {catalog.groupsById.get(item.groupId)?.name ?? ''} · v{item.version}
                {disableSecret && item.isSecret ? ` — ${disableSecretReason}` : ''}
              </Text>
            </Stack>
          );
        }}
      />
      {selected ? (
        <Group gap={6} wrap="nowrap">
          <ConfigItemSummary item={selected} groupName={catalog.groupsById.get(selected.groupId)?.name} />
          <Anchor href={`/dashboard/config/${selected.groupId}`} target="_blank" rel="noreferrer" size="xs" aria-label="Open in Config">
            <IconExternalLink size={11} />
          </Anchor>
        </Group>
      ) : missing ? (
        <Group gap={4} wrap="nowrap">
          <IconAlertTriangle size={12} color="var(--mantine-color-red-6)" />
          <Text size="xs" c="red.7" ff="monospace">{value?.key}</Text>
        </Group>
      ) : null}
      {selected ? null : <CreateConfigItemLink />}
    </Stack>
  );
}
