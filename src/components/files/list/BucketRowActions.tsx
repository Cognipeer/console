'use client';

import { ActionIcon, Menu } from '@mantine/core';
import { IconBan, IconCheck, IconDots, IconFolderOpen, IconSettings, IconTrash } from '@tabler/icons-react';
import { RowActionItems, type DataGridRowAction } from '@/components/common/ui/DataGrid';
import { useTranslations } from '@/lib/i18n';
import { deleteRules } from '../bucket/settingsModel';
import type { BucketListItem } from '../filesApi';
import { bucketHref } from './bucketListModel';

export interface BucketRowActionsProps {
  bucket: BucketListItem;
  /** The person may change buckets: Enable / Disable and Delete are only drawn for them. */
  canWrite: boolean;
  /** A status change of this bucket is on its way. */
  busy: boolean;
  onNavigate: (href: string) => void;
  onToggleStatus: (bucket: BucketListItem) => void;
  /** The time the row is judged at (`useNow`): a bucket that has been `deleting` for long enough can be deleted again. */
  now: number;
}

/**
 * The "⋯" menu of a bucket row. The button is named with the bucket ("Actions for Marketing assets"), so a row of
 * identical buttons is still a list a screen reader can tell apart.
 *
 * Deleting is not done here: it needs the choice of whether the files go too, an agent check and a confirmation,
 * which live on the bucket's Settings tab (its danger zone), so "Delete bucket…" opens that tab. For a bucket whose
 * deletion stopped with an error, or whose background run has been going on for so long that it was probably lost,
 * the same item reads "Delete again…" and goes to the same place.
 */
export default function BucketRowActions({ bucket, canWrite, busy, onNavigate, onToggleStatus, now }: BucketRowActionsProps) {
  const t = useTranslations('files.list');
  const disabled = bucket.status === 'disabled';
  const rules = deleteRules(bucket, now);
  const again = rules.stalled || rules.lastError !== null;
  // A bucket that is being deleted takes no more changes.
  const editable = canWrite && !bucket.deleting;

  const actions: DataGridRowAction<BucketListItem>[] = [
    { id: 'open', label: t('actions.open'), icon: <IconFolderOpen size={14} />, onClick: () => onNavigate(bucketHref(bucket.key)) },
    { id: 'settings', label: t('actions.settings'), icon: <IconSettings size={14} />, onClick: () => onNavigate(bucketHref(bucket.key, 'settings')) },
    {
      id: 'toggle',
      label: disabled ? t('actions.enable') : t('actions.disable'),
      icon: disabled ? <IconCheck size={14} /> : <IconBan size={14} />,
      hidden: !editable,
      disabled: busy,
      onClick: () => onToggleStatus(bucket),
    },
    {
      id: 'delete',
      label: again ? t('actions.deleteAgain') : t('actions.delete'),
      icon: <IconTrash size={14} />,
      color: 'red',
      divider: true,
      hidden: !canWrite || (bucket.deleting === true && !rules.stalled),
      onClick: () => onNavigate(bucketHref(bucket.key, 'settings')),
    },
  ];

  return (
    <Menu withinPortal position="bottom-end" withArrow>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="md"
          radius="md"
          aria-label={t('actions.menuFor', { name: bucket.name })}
          // The row opens the bucket on a click: the menu button and its items must not.
          onClick={(event) => event.stopPropagation()}
        >
          <IconDots size={16} stroke={1.7} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
        <RowActionItems actions={actions} row={bucket} />
      </Menu.Dropdown>
    </Menu>
  );
}
