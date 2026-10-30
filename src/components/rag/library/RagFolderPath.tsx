'use client';

/**
 * Where the Documents tab is: the knowledge base, then the folders down to the open one. Every crumb but the last
 * opens that place, the arrow goes up one level, and the open folder's own ⋯ menu sits at the end of the path.
 * Presentational: the library owns the data and the menu.
 */

import type { ReactNode } from 'react';
import { ActionIcon, Breadcrumbs, Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconArrowUp, IconChevronRight, IconHome } from '@tabler/icons-react';

export interface RagFolderCrumb {
  id: string;
  name: string;
}

export interface RagFolderPathProps {
  moduleName: string;
  /** The folders from the top level down to the open one; empty = the top level. */
  chain: RagFolderCrumb[];
  /** `null` = the top level. */
  onOpen: (folderId: string | null) => void;
  /** The ⋯ menu of the open folder (absent when it offers nothing). */
  menu?: ReactNode;
  /** The line at the right: what the place holds. */
  summary?: ReactNode;
}

export default function RagFolderPath({ moduleName, chain, onOpen, menu, summary }: RagFolderPathProps) {
  const parentId = chain.length > 1 ? chain[chain.length - 2].id : null;
  // The page's reset draws every <svg> as a block, which would put the icon on a line of its own above the label.
  const home = (
    <IconHome size={13} style={{ display: 'inline-block', marginRight: 4, verticalAlign: 'text-bottom' }} aria-hidden="true" />
  );
  return (
    <Group justify="space-between" gap="sm" mb="sm" wrap="wrap">
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        {chain.length > 0 ? (
          <Tooltip label="Up one level" withArrow>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Up one level" onClick={() => onOpen(parentId)}>
              <IconArrowUp size={14} />
            </ActionIcon>
          </Tooltip>
        ) : null}
        <nav aria-label="Folder path" style={{ minWidth: 0 }}>
          <Breadcrumbs separator={<IconChevronRight size={12} />} separatorMargin={4} style={{ flexWrap: 'wrap' }}>
            {chain.length === 0 ? (
              <Text size="sm" fw={600} aria-current="page">{home}{moduleName}</Text>
            ) : (
              <UnstyledButton onClick={() => onOpen(null)}>
                <Text size="sm" c="blue">{home}{moduleName}</Text>
              </UnstyledButton>
            )}
            {chain.map((crumb, index) => (
              index === chain.length - 1 ? (
                <Text key={crumb.id} size="sm" fw={600} aria-current="page">{crumb.name}</Text>
              ) : (
                <UnstyledButton key={crumb.id} onClick={() => onOpen(crumb.id)}>
                  <Text size="sm" c="blue">{crumb.name}</Text>
                </UnstyledButton>
              )
            ))}
          </Breadcrumbs>
        </nav>
        {menu}
      </Group>
      {summary ? <Text size="xs" c="dimmed">{summary}</Text> : null}
    </Group>
  );
}
