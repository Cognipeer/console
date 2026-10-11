'use client';

/**
 * The two pieces of the bucket view that are about folders and session files:
 * the path above the list, and the session / expiry / uploader cells of a file
 * that an agent session uploaded. Presentational — `FileObjectManager` owns the
 * data (see fileBrowse.ts for the rules).
 */

import Link from 'next/link';
import { ActionIcon, Anchor, Badge, Breadcrumbs, Group, Table, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconArrowUp, IconChevronRight, IconHome } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { FileRecordView } from '@/lib/services/files';
import { breadcrumbs, expiryLabel, isSessionFile, parentPrefix, sessionHref } from './fileBrowse';

export interface FolderPathProps {
    /** The folder being viewed (`''` = the bucket root). */
    prefix: string;
    onOpen: (prefix: string) => void;
}

/** Root / folder / sub-folder — every part but the last opens that folder; the arrow goes up one level. */
export function FolderPath({ prefix, onOpen }: FolderPathProps) {
    const t = useTranslations('files');
    const crumbs = breadcrumbs(prefix);
    const parent = parentPrefix(prefix);
    return (
        <Group gap={6} wrap="nowrap">
            {parent !== null ? (
                <Tooltip label={t('browse.up')} withArrow>
                    <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('browse.up')} onClick={() => onOpen(parent)}>
                        <IconArrowUp size={14} />
                    </ActionIcon>
                </Tooltip>
            ) : null}
            <nav aria-label={t('browse.pathLabel')}>
                <Breadcrumbs separator={<IconChevronRight size={12} />} separatorMargin={4}>
                    {crumbs.map((crumb, index) => {
                        const label = crumb.label || t('browse.rootLabel');
                        const icon = index === 0 ? <IconHome size={13} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} /> : null;
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

export interface SessionFileCellsProps {
    record: Pick<FileRecordView, 'purpose' | 'conversationId' | 'agentKey' | 'expiresAt' | 'uploadedBy' | 'uploadedByName'>;
    /** The agent's id when it is known (the session page is addressed by it); the link is omitted without it. */
    agentId?: string;
    now: Date;
    locale: string;
}

/** Session link, expiry and uploader of a session file; dashes for any other file. */
export function SessionFileCells({ record, agentId, now, locale }: SessionFileCellsProps) {
    const t = useTranslations('files');
    if (!isSessionFile(record)) {
        return (
            <>
                <Table.Td><Text size="xs" c="dimmed">—</Text></Table.Td>
                <Table.Td><Text size="xs" c="dimmed">—</Text></Table.Td>
                <Table.Td><Text size="xs" c="dimmed">—</Text></Table.Td>
            </>
        );
    }

    const href = sessionHref(agentId, record.conversationId);
    const label = [record.agentKey, record.conversationId].filter(Boolean).join(' · ');
    const expiry = expiryLabel(record.expiresAt, now, locale);

    return (
        <>
            <Table.Td>
                <Group gap={6} wrap="nowrap">
                    <Badge size="xs" variant="light" color="grape">{t('session.badge')}</Badge>
                    {href ? (
                        <Tooltip label={t('session.open')} withArrow>
                            <Anchor component={Link} href={href} size="xs" ff="monospace">{label}</Anchor>
                        </Tooltip>
                    ) : (
                        <Text size="xs" ff="monospace" c="dimmed">{label || t('session.openUnknownAgent', { id: record.conversationId ?? '' })}</Text>
                    )}
                </Group>
            </Table.Td>
            <Table.Td>
                {expiry.kind === 'none' ? (
                    <Text size="xs" c="dimmed">{t('session.neverExpires')}</Text>
                ) : (
                    <Tooltip
                        label={`${new Date(record.expiresAt as Date | string).toLocaleString()} · ${t('session.removedAutomatically')}`}
                        withArrow
                        multiline
                        w={240}
                    >
                        <Text size="xs" c={expiry.kind === 'expired' ? 'red' : undefined}>
                            {expiry.kind === 'expired' ? `${t('session.expired')} · ${expiry.text}` : expiry.text}
                        </Text>
                    </Tooltip>
                )}
            </Table.Td>
            <Table.Td>
                {/* A person's name when the id is a user of the tenant; the id itself otherwise (a system actor). */}
                {record.uploadedByName
                    ? <Text size="xs" title={record.uploadedBy}>{record.uploadedByName}</Text>
                    : <Text size="xs" ff="monospace" c="dimmed">{record.uploadedBy ?? '—'}</Text>}
            </Table.Td>
        </>
    );
}
