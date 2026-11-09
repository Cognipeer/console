'use client';

/**
 * The access list of a saved resource, on its detail page: what it is now, and an editor that saves the whole list
 * at once (a draft, so picking five people is one save and one audit entry, not five).
 */

import { useState } from 'react';
import { Badge, Button, Group, Paper, Text } from '@mantine/core';
import { IconLock, IconUsers } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import {
  AccessListFields,
  accessValueOf,
  useAccessSummary,
  type AccessListValue,
} from './AccessListFields';

interface AccessListPanelProps {
  /** The stored list, as the API sent it. */
  access: unknown;
  resource: 'mcp' | 'skill';
  /** Saves the list; a rejection keeps the editor open with the draft. */
  onSave: (next: AccessListValue) => Promise<void>;
  /** Read-only: the list is shown, not edited. */
  readOnly?: boolean;
}

export function AccessListPanel({ access, resource, onSave, readOnly }: AccessListPanelProps) {
  const t = useTranslations('resourceAccess');
  const current = accessValueOf(access);
  const [draft, setDraft] = useState<AccessListValue | null>(null);
  const [saving, setSaving] = useState(false);
  const summary = useAccessSummary(current);
  const restricted = current.mode === 'selected';

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await onSave(draft);
      setDraft(null);
    } catch {
      /* the caller reported it; the draft stays */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper withBorder p="md" radius="md" data-testid="access-list-panel">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{t('title')}</Text>
          <Group gap="xs" mt="xs">
            <Badge
              size="sm"
              variant="light"
              color={restricted ? 'orange' : 'teal'}
              leftSection={restricted ? <IconLock size={11} /> : <IconUsers size={11} />}
            >
              {restricted ? t('badgeRestricted') : t('everyone')}
            </Badge>
            {restricted ? <Text size="xs" c="dimmed">{summary}</Text> : null}
          </Group>
        </div>
        {!readOnly && !draft ? (
          <Button size="compact-xs" variant="default" onClick={() => setDraft(current)}>
            {t('edit')}
          </Button>
        ) : null}
      </Group>
      {draft ? (
        <>
          <div style={{ marginTop: 12 }}>
            <AccessListFields value={draft} onChange={setDraft} resource={resource} disabled={saving} />
          </div>
          <Group justify="flex-end" gap="xs" mt="sm">
            <Button size="xs" variant="default" onClick={() => setDraft(null)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button size="xs" onClick={() => void save()} loading={saving}>
              {t('save')}
            </Button>
          </Group>
        </>
      ) : null}
    </Paper>
  );
}
