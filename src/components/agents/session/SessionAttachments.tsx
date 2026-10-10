'use client';

/**
 * Attachments in the session view: the paperclip in the composer, the chips of
 * files waiting to be sent, and the files shown on a user message.
 *
 * Presentational — the session view owns the uploads (`AgentSessionView`).
 */

import { useRef } from 'react';
import { ActionIcon, Badge, CloseButton, Group, Loader, Text, Tooltip } from '@mantine/core';
import { IconFile, IconPaperclip, IconPhoto } from '@tabler/icons-react';
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
}

/** The files waiting to be sent, each with its conversion status. */
export function AttachmentChips({ files, uploading, disabled, onRemove }: AttachmentChipsProps) {
    const t = useTranslations('agents.attachments');
    if (files.length === 0 && uploading.length === 0) return null;
    return (
        <Group gap={6} mb={6} wrap="wrap" data-testid="attachment-chips">
            {files.map((file) => (
                <Badge
                    key={file.fileId}
                    variant="light"
                    color={lacksReadableText(file) ? 'orange' : 'gray'}
                    size="lg"
                    radius="sm"
                    leftSection={<FileIcon file={file} />}
                    rightSection={
                        <CloseButton size="xs" aria-label={t('remove')} disabled={disabled} onClick={() => onRemove(file.fileId)} />
                    }
                    styles={{ label: { textTransform: 'none', fontWeight: 500 } }}
                >
                    <Tooltip label={lacksReadableText(file) ? t('noText') : `${file.mimeType} · ${formatFileSize(file.size)}`} withArrow>
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
