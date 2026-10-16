'use client';

import { useMemo, useState } from 'react';
import { Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import type { UserDirectory } from '../useUserDirectory';
import { pluralKey } from '../plural';

interface Props {
  opened: boolean;
  onClose: () => void;
  directory: UserDirectory;
  count: number;
  loading?: boolean;
  /** `'me'`, a user id, or `null` to clear the assignee. */
  onConfirm: (assignedTo: string | null) => void;
}

/** Choose who the selected incidents are assigned to: yourself, anyone the viewer may list, or nobody. */
export default function AssignDialog({ opened, onClose, directory, count, loading, onConfirm }: Props) {
  const t = useTranslations('incidents');
  const [value, setValue] = useState<string | null>('me');
  const options = useMemo(() => {
    const items = [
      { value: 'me', label: t('ux.assign.me') },
      { value: '__none__', label: t('ux.assign.nobody') },
    ];
    for (const [id, name] of Object.entries(directory.names)) {
      if (id !== directory.meId) items.push({ value: id, label: name });
    }
    return items;
  }, [directory, t]);

  return (
    <Modal opened={opened} onClose={onClose} title={t(pluralKey('ux.assign.title', count), { count })} centered size="sm">
      <Stack gap="sm">
        <Select label={t('ux.assign.label')} data={options} value={value} onChange={setValue} searchable allowDeselect={false} comboboxProps={{ withinPortal: true }} />
        {Object.keys(directory.names).length === 0 ? (
          <Text size="xs" c="dimmed">
            {t('ux.assign.onlyYou')}
          </Text>
        ) : null}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" size="sm" onClick={onClose}>
            {t('ux.cancel')}
          </Button>
          <Button size="sm" loading={loading} disabled={!value} onClick={() => onConfirm(value === '__none__' ? null : value)}>
            {t('ux.assign.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
