'use client';

/**
 * The Files tab beside a session: every file the session holds, as the server
 * lists them — name, size, whether its text could be read, where it is stored
 * (`<bucket>/<path>`), when it expires — with a delete. The count comes from the
 * list, not from the messages: a file uploaded over the API, or removed by the
 * retention sweep, shows up (or goes) here without a message saying so.
 *
 * Presentational — `AgentSessionView` owns the fetch and the delete.
 */

import Link from 'next/link';
import { ActionIcon, Alert, Anchor, Badge, Box, Button, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconFile, IconPhoto, IconTrash } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { expiryLabel } from '@/components/files/fileBrowse';
import { formatFileSize } from './sessionAttachmentsUi';
import { bucketHref, conversionBadge, fileLocation, type SessionFileItem } from './sessionFilesUi';

export interface SessionFilesPanelProps {
    /** null until the first list has arrived. */
    files: SessionFileItem[] | null;
    /** The list could not be loaded. */
    failed?: boolean;
    /** The most files the session may hold (the agent's setting); omitted when the agent takes no files. */
    maxFiles?: number;
    /** A session that came in over the API / A2A is read-only here. */
    readOnly?: boolean;
    /** Ids being deleted right now. */
    deleting?: string[];
    onDelete: (file: SessionFileItem) => void;
    onRetry: () => void;
    /** For tests: the clock the expiry phrases are measured from. */
    now?: Date;
}

export default function SessionFilesPanel({
    files,
    failed,
    maxFiles,
    readOnly,
    deleting = [],
    onDelete,
    onRetry,
    now,
}: SessionFilesPanelProps) {
    const t = useTranslations('agents.attachments');
    const locale = useLocale();
    const clock = now ?? new Date();

    if (failed && !files) {
        return (
            <Alert variant="light" color="red" icon={<IconAlertTriangle size={14} />} p="xs">
                <Stack gap={6}>
                    <Text size="xs">{t('filesLoadFailed')}</Text>
                    <Group>
                        <Button size="compact-xs" variant="light" color="red" onClick={onRetry}>{t('filesRetry')}</Button>
                    </Group>
                </Stack>
            </Alert>
        );
    }

    if (!files) {
        return <Group justify="center" py="md"><Loader size="sm" /></Group>;
    }

    return (
        <Stack gap="sm">
            <Group justify="space-between" align="baseline" wrap="nowrap">
                <Text size="xs" fw={700} tt="uppercase" c="dimmed">{t('tab')}</Text>
                <Text size="xs" fw={600} data-testid="held-count">
                    {maxFiles !== undefined ? t('filesHeld', { count: files.length, max: maxFiles }) : t('filesHeldNoMax', { count: files.length })}
                </Text>
            </Group>
            <Text size="10px" c="dimmed">{t('filesIntro')}</Text>

            {files.length === 0 ? (
                <Text size="xs" c="dimmed">{t('filesEmpty')}</Text>
            ) : (
                <Stack gap="xs">
                    {files.map((file) => {
                        const location = fileLocation(file);
                        const bucket = bucketHref(file.bucketKey);
                        const badge = conversionBadge(file);
                        const expiry = expiryLabel(file.expiresAt, clock, locale);
                        const busy = deleting.includes(file.id);
                        return (
                            <Box key={file.id} p="xs" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 'var(--mantine-radius-sm)' }}>
                                <Group gap="xs" wrap="nowrap" align="flex-start" justify="space-between">
                                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }} align="flex-start">
                                        {file.mimeType.toLowerCase().startsWith('image/') ? <IconPhoto size={14} style={{ marginTop: 2, flexShrink: 0 }} /> : <IconFile size={14} style={{ marginTop: 2, flexShrink: 0 }} />}
                                        <Box style={{ minWidth: 0 }}>
                                            <Text size="xs" fw={600} truncate title={file.name}>{file.name}</Text>
                                            <Group gap={6} wrap="wrap">
                                                <Text size="10px" c="dimmed">{formatFileSize(file.size)} · {file.mimeType}</Text>
                                                {badge ? (
                                                    <Tooltip label={file.conversionError ?? ''} disabled={!file.conversionError} withArrow multiline w={220}>
                                                        <Badge size="xs" variant="light" color={badge.color}>{t(badge.key)}</Badge>
                                                    </Tooltip>
                                                ) : null}
                                            </Group>
                                        </Box>
                                    </Group>
                                    {readOnly ? null : (
                                        <Tooltip label={t('filesDelete')} withArrow>
                                            <ActionIcon
                                                size="sm"
                                                variant="subtle"
                                                color="red"
                                                aria-label={t('filesDelete')}
                                                loading={busy}
                                                disabled={busy}
                                                onClick={() => onDelete(file)}
                                            >
                                                <IconTrash size={13} />
                                            </ActionIcon>
                                        </Tooltip>
                                    )}
                                </Group>

                                <Stack gap={2} mt={6}>
                                    {location ? (
                                        <Group gap={4} wrap="nowrap">
                                            <Text size="10px" c="dimmed" style={{ flexShrink: 0 }}>{t('filesLocation')}</Text>
                                            {bucket ? (
                                                <Tooltip label={`${t('filesOpenBucket')} · ${location}`} withArrow>
                                                    <Anchor component={Link} href={bucket} size="10px" ff="monospace" truncate>{location}</Anchor>
                                                </Tooltip>
                                            ) : (
                                                <Text size="10px" ff="monospace" truncate title={location}>{location}</Text>
                                            )}
                                        </Group>
                                    ) : null}
                                    <Text size="10px" c={expiry.kind === 'expired' ? 'red' : 'dimmed'}>
                                        {expiry.kind === 'none'
                                            ? t('filesNoExpiry')
                                            : expiry.kind === 'expired'
                                                ? `${t('filesExpired')} · ${expiry.text}`
                                                : t('filesExpires', { when: expiry.text })}
                                        {file.uploadedBy ? ` · ${t('filesUploadedBy', { who: file.uploadedBy })}` : ''}
                                    </Text>
                                </Stack>
                            </Box>
                        );
                    })}
                </Stack>
            )}
        </Stack>
    );
}
