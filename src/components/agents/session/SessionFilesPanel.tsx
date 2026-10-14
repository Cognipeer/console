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

import { useState } from 'react';
import Link from 'next/link';
import { ActionIcon, Alert, Anchor, Badge, Box, Button, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconDownload, IconFileText, IconTrash } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { expiryLabel } from '@/components/files/fileBrowse';
import { AttachmentIcon, AttachmentPreviewModal, AttachmentThumb } from './SessionAttachments';
import { CHIP_CAPTION, CHIP_LINK } from './attachmentChipStyles';
import { formatFileSize, isImageAttachment } from './sessionAttachmentsUi';
import {
    bucketHref,
    conversionBadge,
    fileLocation,
    sessionFileContentUrl,
    sessionFileLinks,
    type AttachmentView,
    type SessionFileItem,
} from './sessionFilesUi';

export interface SessionFilesPanelProps {
    /** The session the files belong to; with both, each file can be opened and saved from here. */
    agentId?: string;
    sessionId?: string;
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
    agentId,
    sessionId,
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
    const [preview, setPreview] = useState<AttachmentView | null>(null);
    const linkable = Boolean(agentId && sessionId);

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
                <Text size="xs" fw={700} tt="uppercase" style={{ color: CHIP_CAPTION }} data-testid="files-panel-title">{t('tab')}</Text>
                <Text size="xs" fw={600} data-testid="held-count">
                    {maxFiles !== undefined ? t('filesHeld', { count: files.length, max: maxFiles }) : t('filesHeldNoMax', { count: files.length })}
                </Text>
            </Group>
            <Text size="10px" style={{ color: CHIP_CAPTION }}>{t('filesIntro')}</Text>

            {files.length === 0 ? (
                <Text size="xs" style={{ color: CHIP_CAPTION }}>{t('filesEmpty')}</Text>
            ) : (
                <Stack gap="xs">
                    {files.map((file) => {
                        const location = fileLocation(file);
                        const bucket = bucketHref(file.bucketKey);
                        const badge = conversionBadge(file);
                        const expiry = expiryLabel(file.expiresAt, clock, locale);
                        const busy = deleting.includes(file.id);
                        // The original is shown (an image) or saved from the session's content route; a converted file also has its text.
                        // A file past its expiry is gone for the server too, so there is nothing to open.
                        const links = linkable && expiry.kind !== 'expired' ? sessionFileLinks(agentId!, sessionId!, file.id) : null;
                        const view: AttachmentView = { fileId: file.id, name: file.name, mimeType: file.mimeType, size: file.size, ...links };
                        const picture = Boolean(links) && isImageAttachment(file);
                        const textUrl = links && file.conversionStatus === 'succeeded' && !isImageAttachment(file)
                            ? sessionFileContentUrl(agentId!, sessionId!, file.id, { variant: 'markdown', disposition: 'attachment' })
                            : null;
                        return (
                            <Box key={file.id} p="xs" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 'var(--mantine-radius-sm)' }}>
                                <Group gap="xs" wrap="nowrap" align="flex-start" justify="space-between">
                                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }} align="flex-start">
                                        {picture
                                            ? <AttachmentThumb file={view} size={32} onOpen={() => setPreview(view)} />
                                            : <Box style={{ marginTop: 2, flexShrink: 0, display: 'flex' }}><AttachmentIcon file={file} size={14} /></Box>}
                                        <Box style={{ minWidth: 0 }}>
                                            <Text size="xs" fw={600} truncate title={file.name}>{file.name}</Text>
                                            <Group gap={6} wrap="wrap">
                                                <Text size="10px" style={{ color: CHIP_CAPTION }}>{formatFileSize(file.size)} · {file.mimeType}</Text>
                                                {badge ? (
                                                    <Tooltip label={file.conversionError ?? ''} disabled={!file.conversionError} withArrow multiline w={220}>
                                                        <Badge size="xs" variant="light" color={badge.color} styles={{ root: { color: 'var(--ds-text)' } }}>{t(badge.key)}</Badge>
                                                    </Tooltip>
                                                ) : null}
                                            </Group>
                                        </Box>
                                    </Group>
                                    <Group gap={2} wrap="nowrap">
                                        {links ? (
                                            <Tooltip label={t('download')} withArrow>
                                                <ActionIcon component="a" href={links.downloadUrl} download={file.name} size="sm" variant="subtle" color="gray" aria-label={t('downloadFile', { name: file.name })}>
                                                    <IconDownload size={13} />
                                                </ActionIcon>
                                            </Tooltip>
                                        ) : null}
                                        {textUrl ? (
                                            <Tooltip label={t('downloadText')} withArrow>
                                                <ActionIcon component="a" href={textUrl} size="sm" variant="subtle" color="gray" aria-label={t('downloadText')}>
                                                    <IconFileText size={13} />
                                                </ActionIcon>
                                            </Tooltip>
                                        ) : null}
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
                                </Group>

                                <Stack gap={2} mt={6}>
                                    {location ? (
                                        <Group gap={4} wrap="nowrap">
                                            <Text size="10px" style={{ flexShrink: 0, color: CHIP_CAPTION }}>{t('filesLocation')}</Text>
                                            {bucket ? (
                                                <Tooltip label={`${t('filesOpenBucket')} · ${location}`} withArrow>
                                                    <Anchor component={Link} href={bucket} size="10px" ff="monospace" truncate style={{ color: CHIP_LINK }} data-testid="file-location-link">{location}</Anchor>
                                                </Tooltip>
                                            ) : (
                                                <Text size="10px" ff="monospace" truncate title={location}>{location}</Text>
                                            )}
                                        </Group>
                                    ) : null}
                                    <Text size="10px" style={{ color: expiry.kind === 'expired' ? 'var(--ds-err-text)' : CHIP_CAPTION }}>
                                        {expiry.kind === 'none'
                                            ? t('filesNoExpiry')
                                            : expiry.kind === 'expired'
                                                ? `${t('filesExpired')} · ${expiry.text}`
                                                : t('filesExpires', { when: expiry.text })}
                                        {file.uploadedBy || file.uploadedByName ? ` · ${t('filesUploadedBy', { who: file.uploadedByName ?? file.uploadedBy })}` : ''}
                                    </Text>
                                </Stack>
                            </Box>
                        );
                    })}
                </Stack>
            )}
            <AttachmentPreviewModal file={preview} onClose={() => setPreview(null)} />
        </Stack>
    );
}
