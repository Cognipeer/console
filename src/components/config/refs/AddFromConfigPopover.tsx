'use client';

/**
 * "+ Add from Config": an inline popover with two tabs. Items: tick config items, each gets a variable name
 * (suggested from the key, editable). Groups: bind a whole group, every item of it becomes a variable.
 */

import { useState } from 'react';
import { Button, Checkbox, Group, Popover, ScrollArea, Stack, Tabs, Text, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { IConfigGroupRef } from '@/lib/config/configRefShared';
import { CONFIG_FORBIDDEN_HINT, CreateConfigItemLink, SecretBadge } from './ConfigItemPicker';
import { groupVariablePreview, nameProblem, nameProblemText } from './refRows';
import type { ConfigCatalog, ConfigCatalogGroup, ConfigCatalogItem } from './useConfigCatalog';

export interface AddFromConfigPopoverProps {
  catalog: ConfigCatalog;
  /** Names already used in the block, to flag duplicates. */
  takenNames: ReadonlySet<string>;
  /** Items of this kind cannot be added here (secret items in the env block). */
  disableSecret?: boolean;
  disableSecretReason?: string;
  /** Groups already bound (shown ticked and disabled). Omit the Groups tab with `onAddGroups` unset. */
  boundGroups?: IConfigGroupRef[];
  onAddItems: (picks: Array<{ item: ConfigCatalogItem; name: string }>) => void;
  onAddGroups?: (groups: ConfigCatalogGroup[]) => void;
  /** Only the Groups tab (the "Config groups" block). */
  groupsOnly?: boolean;
}

export default function AddFromConfigPopover({
  catalog, takenNames, disableSecret = false, disableSecretReason = 'Secret items go under Secrets', boundGroups, onAddItems, onAddGroups, groupsOnly = false,
}: AddFromConfigPopoverProps) {
  const [opened, setOpened] = useState(false);
  const [tab, setTab] = useState<string>(groupsOnly ? 'groups' : 'items');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({}); // item id -> variable name
  const [groupIds, setGroupIds] = useState<string[]>([]);

  const reset = () => { setPicked({}); setGroupIds([]); setQuery(''); };
  const close = () => { setOpened(false); reset(); };

  const q = query.trim().toLowerCase();
  const groups = catalog.groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !q || `${item.name} ${item.key} ${group.name}`.toLowerCase().includes(q)),
    }))
    .filter((group) => group.items.length > 0);
  // The Groups tab lists groups by name/key only, empty ones included (items added later become variables).
  const bindableGroups = catalog.groups.filter((group) => !q || `${group.name} ${group.key}`.toLowerCase().includes(q));

  const problemFor = (id: string) => {
    const name = picked[id].trim();
    const others = new Set([...takenNames, ...Object.entries(picked).filter(([other]) => other !== id).map(([, n]) => n.trim())]);
    return nameProblem(name, others);
  };
  const pickedIds = Object.keys(picked);
  const itemsValid = pickedIds.every((id) => !problemFor(id));
  const total = pickedIds.length + (onAddGroups ? groupIds.length : 0);
  const boundIds = new Set((boundGroups ?? []).map((ref) => ref.groupId));
  const canConfirm = total > 0 && itemsValid;

  const confirm = () => {
    if (pickedIds.length > 0) {
      onAddItems(pickedIds.flatMap((id) => {
        const item = catalog.itemsById.get(id);
        return item ? [{ item, name: picked[id].trim() }] : [];
      }));
    }
    if (onAddGroups && groupIds.length > 0) {
      onAddGroups(groupIds.flatMap((id) => {
        const group = catalog.groupsById.get(id);
        return group ? [group] : [];
      }));
    }
    close();
  };

  const disabledHint = catalog.status === 'forbidden' ? CONFIG_FORBIDDEN_HINT : undefined;

  return (
    <Popover opened={opened} onChange={(next) => { setOpened(next); if (!next) reset(); }} width={420} position="bottom-start" shadow="md" trapFocus withinPortal>
      <Popover.Target>
        <Button
          size="compact-xs"
          variant="light"
          color="teal"
          leftSection={<IconPlus size={12} />}
          disabled={catalog.status === 'forbidden' || catalog.status === 'loading'}
          title={disabledHint}
          onClick={() => setOpened((o) => !o)}
        >
          {groupsOnly ? 'Bind a config group' : 'Add from Config'}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        {catalog.status === 'error' ? (
          <Text size="xs" c="red.7">Could not load Config.</Text>
        ) : (
          <Tabs value={tab} onChange={(next) => setTab(next ?? 'items')}>
            <Tabs.List>
              {groupsOnly ? null : <Tabs.Tab value="items">Items</Tabs.Tab>}
              {onAddGroups && !groupsOnly ? <Tabs.Tab value="groups">Groups</Tabs.Tab> : null}
            </Tabs.List>
            <Stack gap="xs" mt="sm">
              <TextInput size="xs" placeholder="Search" aria-label="Search config" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
              <Tabs.Panel value="items">
                <ScrollArea.Autosize mah={280}>
                  <Stack gap="xs">
                    {groups.length === 0 ? <Text size="xs" c="dimmed">No config items.</Text> : null}
                    {groups.map((group) => (
                      <Stack key={group.id} gap={4}>
                        <Text size="xs" fw={600} c="dimmed" tt="uppercase">{group.name}</Text>
                        {group.items.map((item) => {
                          const blocked = disableSecret && item.isSecret;
                          const checked = item.id in picked;
                          const problem = checked ? problemFor(item.id) : null;
                          return (
                            <Stack key={item.id} gap={2}>
                              <Checkbox
                                size="xs"
                                disabled={blocked}
                                checked={checked}
                                onChange={(e) => {
                                  const on = e.currentTarget.checked;
                                  setPicked((cur) => {
                                    const next = { ...cur };
                                    if (on) next[item.id] = item.envName ?? '';
                                    else delete next[item.id];
                                    return next;
                                  });
                                }}
                                label={
                                  <Group gap={6} wrap="nowrap">
                                    <Text size="xs" ff="monospace">{item.key}</Text>
                                    <Text size="xs" c="dimmed">{item.name} · v{item.version}</Text>
                                    {item.isSecret ? <SecretBadge /> : null}
                                  </Group>
                                }
                                description={blocked ? disableSecretReason : undefined}
                              />
                              {checked ? (
                                <TextInput
                                  size="xs"
                                  ml={24}
                                  ff="monospace"
                                  aria-label={`Variable name for ${item.key}`}
                                  value={picked[item.id]}
                                  onChange={(e) => { const name = e.currentTarget.value; setPicked((cur) => ({ ...cur, [item.id]: name })); }}
                                  error={problem ? nameProblemText(problem) : undefined}
                                />
                              ) : null}
                            </Stack>
                          );
                        })}
                      </Stack>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </Tabs.Panel>
              <Tabs.Panel value="groups">
                <Text size="xs" c="dimmed" mb="xs">Bind whole group: every item, now and later, becomes a variable.</Text>
                <ScrollArea.Autosize mah={280}>
                  <Stack gap="xs">
                    {bindableGroups.length === 0 ? <Text size="xs" c="dimmed">No config groups.</Text> : null}
                    {bindableGroups.map((group) => {
                      const full = group;
                      const bound = boundIds.has(group.id);
                      return (
                        <Checkbox
                          key={group.id}
                          size="xs"
                          disabled={bound}
                          checked={bound || groupIds.includes(group.id)}
                          onChange={(e) => {
                            const on = e.currentTarget.checked;
                            setGroupIds((cur) => (on ? [...cur, group.id] : cur.filter((id) => id !== group.id)));
                          }}
                          label={`${full.name} (${full.items.length})`}
                          description={bound ? 'Already bound' : groupVariablePreview(full).slice(0, 4).map((v) => v.name).join(', ') || (full.items.length === 0 ? 'empty' : undefined)}
                        />
                      );
                    })}
                  </Stack>
                </ScrollArea.Autosize>
              </Tabs.Panel>
              <Group justify="space-between">
                <CreateConfigItemLink />
                <Group gap="xs">
                  <Button size="compact-xs" variant="default" onClick={close}>Cancel</Button>
                  <Button size="compact-xs" disabled={!canConfirm} onClick={confirm}>{total > 0 ? `Add (${total})` : 'Add'}</Button>
                </Group>
              </Group>
            </Stack>
          </Tabs>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
