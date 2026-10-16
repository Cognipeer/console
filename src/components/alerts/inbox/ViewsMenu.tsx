'use client';

import { useState } from 'react';
import { Button, Group, Menu, Modal, TextInput, ActionIcon } from '@mantine/core';
import { IconBookmark, IconChevronDown, IconTrash } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { BUILTIN_VIEWS, MAX_SAVED_VIEWS, type InboxView } from './inboxModel';

interface Props {
  activeId: string | null;
  saved: InboxView[];
  onApply: (view: InboxView) => void;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
  /** Saving needs a browser store; without one the entry is hidden. */
  canSave: boolean;
}

/** Built-in views, the user's saved views and "save the current filters as a view". A view is just the inbox URL query. */
export default function ViewsMenu({ activeId, saved, onApply, onSave, onDelete, canSave }: Props) {
  const t = useTranslations('incidents');
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState('');
  const all = [...BUILTIN_VIEWS, ...saved];
  const active = all.find((view) => view.id === activeId) ?? null;
  const label = (view: InboxView) => (view.builtin ? t(`ux.views.builtin.${view.name}`) : view.name);

  return (
    <>
      <Menu position="bottom-start" withinPortal width={260}>
        <Menu.Target>
          <Button variant="default" size="xs" leftSection={<IconBookmark size={13} />} rightSection={<IconChevronDown size={12} />}>
            {active ? label(active) : t('ux.views.custom')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{t('ux.views.builtinLabel')}</Menu.Label>
          {BUILTIN_VIEWS.map((view) => (
            <Menu.Item key={view.id} onClick={() => onApply(view)} fw={view.id === activeId ? 700 : undefined}>
              {label(view)}
            </Menu.Item>
          ))}
          {saved.length > 0 ? <Menu.Label>{t('ux.views.savedLabel')}</Menu.Label> : null}
          {saved.map((view) => (
            <Menu.Item
              key={view.id}
              onClick={() => onApply(view)}
              fw={view.id === activeId ? 700 : undefined}
              rightSection={
                <ActionIcon
                  component="span"
                  size="xs"
                  variant="subtle"
                  color="red"
                  aria-label={t('ux.views.delete', { name: view.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(view.id);
                  }}
                >
                  <IconTrash size={12} />
                </ActionIcon>
              }
            >
              {view.name}
            </Menu.Item>
          ))}
          {canSave ? (
            <>
              <Menu.Divider />
              <Menu.Item disabled={saved.length >= MAX_SAVED_VIEWS} onClick={() => setDialog(true)}>
                {t('ux.views.saveCurrent')}
              </Menu.Item>
            </>
          ) : null}
        </Menu.Dropdown>
      </Menu>
      <Modal opened={dialog} onClose={() => setDialog(false)} title={t('ux.views.saveTitle')} centered size="sm">
        <TextInput
          label={t('ux.views.name')}
          value={name}
          maxLength={60}
          data-autofocus
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && name.trim()) {
              onSave(name);
              setName('');
              setDialog(false);
            }
          }}
        />
        <Group justify="flex-end" mt="md" gap="xs">
          <Button variant="default" size="sm" onClick={() => setDialog(false)}>
            {t('ux.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!name.trim()}
            onClick={() => {
              onSave(name);
              setName('');
              setDialog(false);
            }}
          >
            {t('ux.views.save')}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
