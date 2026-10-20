'use client';

/**
 * The pieces of the Files tab that are about folders and session files: the path above the list, and the
 * session / expiry / uploader cells of a file that an agent session uploaded. Presentational: the tab owns the
 * data (see fileBrowse.ts for the rules). Each cell fills one column of the grid.
 */

import type { MouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import { ActionIcon, Anchor, Badge, Breadcrumbs, Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconArrowUp, IconChevronRight, IconHome } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { FileRecordView } from '@/lib/services/files';
import { breadcrumbs, expiryLabel, isSessionFile, parentPrefix, sessionHref } from './fileBrowse';

export interface FolderPathProps {
  /** The folder being viewed (`''` = the bucket root). */
  prefix: string;
  onOpen: (prefix: string) => void;
}

/** Root / folder / sub-folder: every part but the last opens that folder; the arrow goes up one level. */
export function FolderPath({ prefix, onOpen }: FolderPathProps) {
  const t = useTranslations('files');
  const crumbs = breadcrumbs(prefix);
  const parent = parentPrefix(prefix);
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      {parent !== null ? (
        <Tooltip label={t('browse.up')} withArrow>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('browse.up')} onClick={() => onOpen(parent)}>
            <IconArrowUp size={14} />
          </ActionIcon>
        </Tooltip>
      ) : null}
      <nav aria-label={t('browse.pathLabel')} style={{ minWidth: 0 }}>
        <Breadcrumbs separator={<IconChevronRight size={12} />} separatorMargin={4} style={{ flexWrap: 'wrap' }}>
          {crumbs.map((crumb, index) => {
            const label = crumb.label || t('browse.rootLabel');
            // The page's reset draws every <svg> as a block, which would put the icon on a line of its own above the label.
            const icon = index === 0 ? <IconHome size={13} style={{ display: 'inline-block', marginRight: 4, verticalAlign: 'text-bottom' }} aria-hidden="true" /> : null;
            return index === crumbs.length - 1 ? (
              <Text key={crumb.prefix} size="sm" fw={600} aria-current="page">{icon}{label}</Text>
            ) : (
              <UnstyledButton key={crumb.prefix} onClick={() => onOpen(crumb.prefix)}>
                <Text size="sm" c="blue">{icon}{label}</Text>
              </UnstyledButton>
            );
          })}
        </Breadcrumbs>
      </nav>
    </Group>
  );
}

/**
 * Who the line under a file's name says created it, or null for no line.
 *
 * A person is named, never shown by id. A session file's "Uploaded by" cell already says who put it
 * there, so the line would only repeat it. A system actor (`system`, `system:cron`) is shown as it
 * is; an id that belongs to no user of the tenant (a removed account) says nothing rather than a
 * 36-character id.
 */
export function createdByWho(
  record: Pick<FileRecordView, 'purpose' | 'uploadedBy' | 'createdBy' | 'createdByName'>,
  uploaderColumnShown: boolean,
): string | null {
  if (uploaderColumnShown && isSessionFile(record) && record.uploadedBy) return null;
  if (record.createdByName) return record.createdByName;
  if (!record.createdBy) return 'system';
  if (record.createdBy === 'system' || record.createdBy.includes(':')) return record.createdBy;
  return null;
}

type SessionRecord = Pick<
  FileRecordView,
  'purpose' | 'conversationId' | 'agentKey' | 'expiresAt' | 'uploadedBy' | 'uploadedByName'
>;

function Dash() {
  return (
    <Text size="xs" c="dimmed">
      —
    </Text>
  );
}

/** The small "Session file" badge beside the name of a file an agent session uploaded. */
export function SessionBadge() {
  const t = useTranslations('files');
  return (
    <Badge size="xs" variant="light" color="grape">
      {t('session.badge')}
    </Badge>
  );
}

export interface SessionLinkCellProps {
  record: Pick<SessionRecord, 'purpose' | 'conversationId' | 'agentKey'>;
  /** The agent's id when it is known (the session page is addressed by it); the link is omitted without it. */
  agentId?: string;
}

/** The session a file belongs to, linked to its page when the agent is known; a dash for any other file. */
export function SessionLinkCell({ record, agentId }: SessionLinkCellProps) {
  const t = useTranslations('files');
  if (!isSessionFile(record)) return <Dash />;
  const href = sessionHref(agentId, record.conversationId);
  const label = [record.agentKey, record.conversationId].filter(Boolean).join(' · ');
  return href ? (
    <Tooltip label={t('session.open')} withArrow>
      <Anchor component={Link} href={href} size="xs" ff="monospace">
        {label}
      </Anchor>
    </Tooltip>
  ) : (
    <Text size="xs" ff="monospace" c="dimmed">
      {label || t('session.openUnknownAgent', { id: record.conversationId ?? '' })}
    </Text>
  );
}

export interface ExpiryCellProps {
  record: Pick<SessionRecord, 'purpose' | 'expiresAt'>;
  now: Date;
  locale: string;
}

/** When a session file goes away (red once it should have); a dash for any other file. */
export function ExpiryCell({ record, now, locale }: ExpiryCellProps) {
  const t = useTranslations('files');
  if (!isSessionFile(record)) return <Dash />;
  const expiry = expiryLabel(record.expiresAt, now, locale);
  if (expiry.kind === 'none') {
    return (
      <Text size="xs" c="dimmed">
        {t('session.neverExpires')}
      </Text>
    );
  }
  return (
    <Tooltip
      label={`${new Date(record.expiresAt as Date | string).toLocaleString(locale)} · ${t('session.removedAutomatically')}`}
      withArrow
      multiline
      w={240}
    >
      <Text size="xs" c={expiry.kind === 'expired' ? 'red' : undefined}>
        {expiry.kind === 'expired' ? `${t('session.expired')} · ${expiry.text}` : expiry.text}
      </Text>
    </Tooltip>
  );
}

export interface UploaderCellProps {
  record: Pick<SessionRecord, 'purpose' | 'uploadedBy' | 'uploadedByName'>;
}

/** Who uploaded a session file; a dash for any other file. */
export function UploaderCell({ record }: UploaderCellProps) {
  if (!isSessionFile(record)) return <Dash />;
  // A person's name when the id is a user of the tenant; the id itself otherwise (a system actor).
  return record.uploadedByName ? (
    <Text size="xs" title={record.uploadedBy}>
      {record.uploadedByName}
    </Text>
  ) : (
    <Text size="xs" ff="monospace" c="dimmed">
      {record.uploadedBy ?? '—'}
    </Text>
  );
}

const stopRowClick = (event: MouseEvent<HTMLElement>) => event.stopPropagation();

/**
 * Keeps a click inside a control of a clickable row (a checkbox, a menu) from also opening the row. React sends
 * the events of a menu that is drawn in a portal up through the tree it was declared in, so the menu belongs
 * inside this wrapper too.
 */
export function CellHit({ children }: { children: ReactNode }) {
  return (
    <div role="presentation" onClick={stopRowClick} style={{ display: 'inline-flex', alignItems: 'center' }}>
      {children}
    </div>
  );
}
