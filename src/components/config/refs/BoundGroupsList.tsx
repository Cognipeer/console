'use client';

/** The config groups bound as a whole: chips with item count, a preview of the variable names they give, remove. */

import { ActionIcon, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconLock, IconTrash } from '@tabler/icons-react';
import type { IConfigGroupRef } from '@/lib/config/configRefShared';
import { groupVariablePreview } from './refRows';
import type { ConfigCatalog } from './useConfigCatalog';

const PREVIEW_LIMIT = 8;

export default function BoundGroupsList({
  catalog, value, onChange,
}: {
  catalog: ConfigCatalog;
  value: IConfigGroupRef[] | undefined;
  onChange: (next: IConfigGroupRef[]) => void;
}) {
  const refs = value ?? [];
  if (refs.length === 0) return <Text size="xs" c="dimmed">No config group bound.</Text>;
  return (
    <Stack gap={6}>
      {refs.map((ref) => {
        const group = catalog.groupsById.get(ref.groupId);
        const missing = catalog.status === 'ready' && !group;
        const preview = group ? groupVariablePreview(group) : [];
        return (
          <Paper key={ref.groupId} withBorder p="xs" radius="sm" style={missing ? { borderColor: 'var(--mantine-color-red-6)' } : undefined}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={2} style={{ minWidth: 0 }}>
                {missing ? (
                  <Text size="xs" c="red.7">
                    <Text span ff="monospace" inherit>{ref.key}</Text>: this config group was deleted or is in another project — remove it
                  </Text>
                ) : (
                  <>
                    <Text size="sm" fw={500}>
                      {group?.name ?? ref.key}{' '}
                      <Text span size="xs" c="dimmed">{group ? `${group.items.length} item${group.items.length === 1 ? '' : 's'}` : ''}</Text>
                    </Text>
                    {group ? (
                      <Group gap={6}>
                        {preview.slice(0, PREVIEW_LIMIT).map((variable) => (
                          <Text key={variable.name} size="xs" ff="monospace" c="dimmed">
                            {variable.name}
                            {variable.isSecret ? <IconLock size={9} style={{ marginLeft: 2 }} aria-label="secret" /> : null}
                          </Text>
                        ))}
                        {preview.length > PREVIEW_LIMIT ? <Text size="xs" c="dimmed">+{preview.length - PREVIEW_LIMIT} more</Text> : null}
                      </Group>
                    ) : null}
                  </>
                )}
              </Stack>
              <Tooltip label="Remove" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Remove group ${ref.key}`}
                  onClick={() => onChange(refs.filter((r) => r.groupId !== ref.groupId))}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}
