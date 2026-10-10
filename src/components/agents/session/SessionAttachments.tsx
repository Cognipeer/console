'use client';

/**
 * Attachments in the session view: the paperclip in the composer, the chips of
 * files waiting to be sent, and the files shown on a user message.
 *
 * Presentational — the session view owns the uploads (`AgentSessionView`).
 */

import { useRef } from 'react';
import Link from 'next/link';
import { ActionIcon, Anchor, Badge, CloseButton, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconFile, IconPaperclip, IconPhoto } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { IAgentMessageAttachment } from '@/lib/database/provider/types.domain';
import {
    formatFileSize,
    isImageAttachment,
    lacksReadableText,
    type PendingAttachment,
} from './sessionAttachmentsUi';

export interface AttachButtonProps {
    disabled?: boolean;
    /** `accept` of the file dialog; empty = any file. */
    accept?: string;
    onFiles: (files: File[]) => void;
}

export function AttachButton({ disabled, accept, onFiles }: AttachButtonProps) {
    const t = useTranslations('agents.attachments');
    const inputRef = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                accept={accept || undefined}
                onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = '';
                    if (files.length > 0) onFiles(files);
                }}
            />
            <Tooltip label={t('attach')} withArrow>
                <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    aria-label={t('attach')}
                    disabled={disabled}
                    onClick={() => inputRef.current?.click()}
                >
                    <IconPaperclip size={14} />
                </ActionIcon>
            </Tooltip>
        </>
    );
}

function FileIcon({ file }: { file: Pick<IAgentMessageAttachment, 'mimeType'> }) {
    return isImageAttachment(file) ? <IconPhoto size={12} /> : <IconFile size={12} />;
}

export interface AttachmentChipsProps {
    files: PendingAttachment[];
    /** Files being uploaded right now (by name). */
    uploading: string[];
    disabled?: boolean;
    onRemove: (fileId: string) => void;
    /** The agent's model cannot be sent images: its name and where its input types are set. Images then wear a warning. */
    textOnlyModel?: { name: string; href: string } | null;
}

/** The files waiting to be sent, each with its conversion status. */
export function AttachmentChips({ files, uploading, disabled, onRemove, textOnlyModel }: AttachmentChipsProps) {
    const t = useTranslations('agents.attachments');
    if (files.length === 0 && uploading.length === 0) return null;
    // An image the model cannot take is not sent; the turn only records a note about it.
    const unsent = (file: PendingAttachment) => Boolean(textOnlyModel) && isImageAttachment(file);
    const warning = textOnlyModel && files.some(unsent) ? textOnlyModel : null;
    return (
        <Stack gap={4} mb={6} data-testid="attachment-chips">
            <Group gap={6} wrap="wrap">
                {files.map((file) => (
                    <Badge
                        key={file.fileId}
                        variant="light"
                        color={unsent(file) || lacksReadableText(file) ? 'orange' : 'gray'}
                        size="lg"
                        radius="sm"
                        leftSection={unsent(file) ? <IconAlertTriangle size={12} /> : <FileIcon file={file} />}
                        rightSection={
                            <CloseButton size="xs" aria-label={t('remove')} disabled={disabled} onClick={() => onRemove(file.fileId)} />
                        }
                        styles={{ label: { textTransform: 'none', fontWeight: 500 } }}
                    >
                        <Tooltip
                            label={unsent(file)
                                ? t('imageTextOnly', { model: textOnlyModel!.name })
                                : lacksReadableText(file) ? t('noText') : `${file.mimeType} · ${formatFileSize(file.size)}`}
                            withArrow
                        >
                            <span>{file.name} <Text span size="10px" c="dimmed">{formatFileSize(file.size)}</Text></span>
                        </Tooltip>
                    </Badge>
                ))}
                {uploading.map((name) => (
                    <Badge key={`up-${name}`} variant="outline" color="gray" size="lg" radius="sm" leftSection={<Loader size={10} />} styles={{ label: { textTransform: 'none' } }}>
                        {name}
                    </Badge>
                ))}
            </Group>
            {warning ? (
                <Group gap={6} wrap="wrap" role="alert" data-testid="image-warning">
                    <IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />
                    <Text size="xs" c="orange.7">{t('imageTextOnly', { model: warning.name })}</Text>
                    <Anchor component={Link} href={warning.href} size="xs">{t('imageChangeInModels')}</Anchor>
                </Group>
            ) : null}
        </Stack>
    );
}

/** The files on a user message. */
export function MessageAttachments({ attachments }: { attachments?: IAgentMessageAttachment[] }) {
    if (!attachments || attachments.length === 0) return null;
    return (
        <Group gap={6} mt={4} wrap="wrap" data-testid="message-attachments">
            {attachments.map((file) => (
                <Badge
                    key={file.fileId}
                    variant="light"
                    color="gray"
                    size="md"
                    radius="sm"
                    leftSection={<FileIcon file={file} />}
                    styles={{ label: { textTransform: 'none', fontWeight: 500 } }}
                >
                    {file.name} · {formatFileSize(file.size)}
                </Badge>
            ))}
        </Group>
    );
}
