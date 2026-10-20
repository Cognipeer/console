'use client';

import { ActionIcon, Menu } from '@mantine/core';
import { IconCopy, IconDots, IconDownload, IconFileText, IconTrash } from '@tabler/icons-react';
import { RowActionItems, type DataGridRowAction } from '@/components/common/ui/DataGrid';
import { useTranslations } from '@/lib/i18n';
import type { FileRecordView } from '@/lib/services/files';
import type { ObjectVariant } from '../filesApi';
import { CellHit } from './FileBrowseParts';
import { hasMarkdownCopy } from './filesTabModel';

export interface FileRowMenuProps {
  record: FileRecordView;
  /** Delete… is drawn: the person may write and the bucket takes changes. */
  canDelete: boolean;
  onDownload: (record: FileRecordView, variant: ObjectVariant) => void;
  onCopyKey: (record: FileRecordView) => void;
  onDelete: (record: FileRecordView) => void;
}

/**
 * The "⋯" menu of a file row: the one place for its actions. The button is named with the file ("Actions for
 * report.pdf"), so a column of identical buttons is still a list a screen reader can tell apart. A click on the
 * button or on an item does not also open the row's drawer.
 */
export default function FileRowMenu({ record, canDelete, onDownload, onCopyKey, onDelete }: FileRowMenuProps) {
  const t = useTranslations('files.bucket');

  const actions: DataGridRowAction<FileRecordView>[] = [
    { id: 'download', label: t('row.downloadOriginal'), icon: <IconDownload size={14} />, onClick: (row) => onDownload(row, 'original') },
    {
      id: 'markdown',
      label: t('row.downloadMarkdown'),
      icon: <IconFileText size={14} />,
      hidden: !hasMarkdownCopy(record),
      onClick: (row) => onDownload(row, 'markdown'),
    },
    { id: 'copy', label: t('row.copyKey'), icon: <IconCopy size={14} />, onClick: onCopyKey },
    {
      id: 'delete',
      label: t('row.delete'),
      icon: <IconTrash size={14} />,
      color: 'red',
      divider: true,
      hidden: !canDelete,
      onClick: onDelete,
    },
  ];

  return (
    <CellHit>
      <Menu withinPortal position="bottom-end" withArrow>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" size="md" radius="md" aria-label={t('row.menuFor', { name: record.name })}>
            <IconDots size={16} stroke={1.7} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <RowActionItems actions={actions} row={record} />
        </Menu.Dropdown>
      </Menu>
    </CellHit>
  );
}
