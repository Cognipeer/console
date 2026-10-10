'use client';

/**
 * Attachments wherever a session is shown: the paperclip in the composer, the
 * chips of files waiting to be sent, the files on a message (the session page,
 * the session inspector, a request in tracing) and the Files tab.
 *
 * One look for all of them. An image is a thumbnail that opens full size; any
 * other file is a chip with its type icon, size and a link that saves it; a
 * file the server no longer holds is a muted "expired" chip. The pieces below
 * (`AttachmentIcon`, `AttachmentThumb`, `AttachmentPreviewModal`) are what the
 * Files tab and the pending chips are made of too.
 *
 * Presentational — the session view owns the uploads (`AgentSessionView`) and
 * the addresses come in on each file (`AttachmentView`).
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import {
    ActionIcon,
    Anchor,
    Badge,
    Box,
    Button,
    CloseButton,
    Group,
    Loader,
    Modal,
    Stack,
    Text,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import {
    IconAlertTriangle,
    IconClockOff,
    IconDownload,
    IconExternalLink,
    IconFile,
    IconFileCode,
    IconFileText,
    IconFileTypeDoc,
    IconFileTypePdf,
    IconFileTypeXls,
    IconFileZip,
    IconPaperclip,
    IconPhoto,
    IconPhotoOff,
    IconPresentation,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import {
    formatFileSize,
    isImageAttachment,
    lacksReadableText,
    type PendingAttachment,
} from './sessionAttachmentsUi';
import { attachmentKind, type AttachmentView } from './sessionFilesUi';

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

/* ── The shared pieces ───────────────────────────────────────────────────── */

/** The icon of a file's type: PDF, document, sheet, slides, archive, code, text, image — or a plain file. */
export function AttachmentIcon({ file, size = 12 }: { file: Pick<AttachmentView, 'mimeType' | 'name'>; size?: number }) {
    switch (attachmentKind(file)) {
        case 'image': return <IconPhoto size={size} />;
        case 'pdf': return <IconFileTypePdf size={size} />;
        case 'document': return <IconFileTypeDoc size={size} />;
        case 'spreadsheet': return <IconFileTypeXls size={size} />;
        case 'presentation': return <IconPresentation size={size} />;
        case 'archive': return <IconFileZip size={size} />;
        case 'code': return <IconFileCode size={size} />;
        case 'text': return <IconFileText size={size} />;
        default: return <IconFile size={size} />;
    }
}

/** A data: / blob: address cannot be opened in a tab of its own (browsers refuse it); it can still be shown and saved. */
function canOpenInTab(url: string): boolean {
    return !/^(?:data|blob):/i.test(url);
}

export interface AttachmentThumbProps {
    file: Pick<AttachmentView, 'name' | 'url'>;
    /** Side of the square, in pixels. */
    size: number;
    /** Click opens the preview; without it the thumbnail is only a picture. */
    onOpen?: () => void;
}

/** The picture of an image attachment, drawn from its address; a stand-in when it cannot be loaded. */
export function AttachmentThumb({ file, size, onOpen }: AttachmentThumbProps) {
    const t = useTranslations('agents.attachments');
    const [failed, setFailed] = useState(false);
    const frame = {
        width: size,
        height: size,
        borderRadius: 'var(--mantine-radius-sm)',
        border: '1px solid var(--mantine-color-default-border)',
        overflow: 'hidden',
        flexShrink: 0,
    } as const;

    const picture = failed || !file.url ? (
        <Tooltip label={t('imageUnavailable')} withArrow>
            <Box style={{ ...frame, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mantine-color-dimmed)' }}>
                <IconPhotoOff size={Math.max(12, Math.round(size / 2.5))} />
            </Box>
        </Tooltip>
    ) : (
        // A plain <img>: the address is a data: URI or a route of this app, which next/image has nothing to optimise.
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={file.url}
            alt={file.name}
            width={size}
            height={size}
            loading="lazy"
            onError={() => setFailed(true)}
            style={{ ...frame, display: 'block', objectFit: 'cover' }}
        />
    );

    if (!onOpen || failed || !file.url) return picture;
    return (
        <UnstyledButton onClick={onOpen} aria-label={t('preview', { name: file.name })} title={file.name} style={{ lineHeight: 0 }}>
            {picture}
        </UnstyledButton>
    );
}

/** An image at full size, with the ways to save or open it. */
export function AttachmentPreviewModal({ file, onClose }: { file: AttachmentView | null; onClose: () => void }) {
    const t = useTranslations('agents.attachments');
    const saveUrl = file ? (file.downloadUrl ?? file.url) : undefined;
    return (
        <Modal
            opened={Boolean(file)}
            onClose={onClose}
            title={file?.name}
            size="xl"
            centered
            // Opened from inside the full-screen session inspector, which sits at the default layer.
            zIndex={400}
        >
            {file ? (
                <Stack gap="sm" align="center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={file.url}
                        alt={file.name}
                        style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
                    />
                    <Group gap="xs">
                        {saveUrl ? (
                            <Button component="a" href={saveUrl} download={file.name} size="xs" variant="light" leftSection={<IconDownload size={14} />}>
                                {t('download')}
                            </Button>
                        ) : null}
                        {file.url && canOpenInTab(file.url) ? (
                            <Button component="a" href={file.url} target="_blank" rel="noreferrer" size="xs" variant="subtle" color="gray" leftSection={<IconExternalLink size={14} />}>
                                {t('openInTab')}
                            </Button>
                        ) : null}
                    </Group>
                </Stack>
            ) : null}
        </Modal>
    );
}

function chipText(file: Pick<AttachmentView, 'name' | 'size'>): string {
    return file.size === undefined ? file.name : `${file.name} · ${formatFileSize(file.size)}`;
}

const CHIP_LABEL_STYLES = { label: { textTransform: 'none', fontWeight: 500 } } as const;

/** A file that is not an image (or whose picture is not available): icon, name, size, and a link that saves it. */
function AttachmentFileChip({ file }: { file: AttachmentView }) {
    const t = useTranslations('agents.attachments');

    if (file.expired) {
        return (
            <Tooltip label={t('expiredHint')} withArrow multiline w={240}>
                <Badge
                    variant="outline"
                    color="gray"
                    size="md"
                    radius="sm"
                    leftSection={<IconClockOff size={12} />}
                    data-expired="true"
                    styles={{ root: { opacity: 0.7, borderStyle: 'dashed' }, label: { textTransform: 'none', fontWeight: 500 } }}
                >
                    {chipText(file)} · {t('filesExpired')}
                </Badge>
            </Tooltip>
        );
    }

    if (file.reference) {
        return (
            <Tooltip label={t('referenceHint')} withArrow multiline w={260}>
                <Badge variant="light" color="gray" size="md" radius="sm" leftSection={<IconPhoto size={12} />} styles={CHIP_LABEL_STYLES}>
                    {file.name} · {t('referenceLabel')}
                </Badge>
            </Tooltip>
        );
    }

    if (file.external && file.url) {
        // An address on another site: a link to follow on purpose, never loaded by this page.
        return (
            <Tooltip label={t('externalHint', { url: file.url })} withArrow multiline w={300}>
                <Badge
                    component="a"
                    href={file.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    variant="light"
                    color="gray"
                    size="md"
                    radius="sm"
                    leftSection={<IconPhoto size={12} />}
                    rightSection={<IconExternalLink size={11} />}
                    style={{ cursor: 'pointer' }}
                    styles={CHIP_LABEL_STYLES}
                >
                    {file.name}
                </Badge>
            </Tooltip>
        );
    }

    const saveUrl = file.downloadUrl ?? file.url;
    if (!saveUrl) {
        return (
            <Badge variant="light" color="gray" size="md" radius="sm" leftSection={<AttachmentIcon file={file} />} styles={CHIP_LABEL_STYLES}>
                {chipText(file)}
            </Badge>
        );
    }
    // A browser can show a PDF or a text file itself; the server decides whether it will be served inline.
    const kind = attachmentKind(file);
    const openUrl = file.url && (kind === 'pdf' || kind === 'text') && canOpenInTab(file.url) ? file.url : null;
    return (
        <Group gap={2} wrap="nowrap">
            <Tooltip label={t('downloadFile', { name: file.name })} withArrow>
                <Badge
                    component="a"
                    href={saveUrl}
                    download={file.name}
                    variant="light"
                    color="gray"
                    size="md"
                    radius="sm"
                    leftSection={<AttachmentIcon file={file} />}
                    rightSection={<IconDownload size={11} />}
                    style={{ cursor: 'pointer' }}
                    styles={CHIP_LABEL_STYLES}
                >
                    {chipText(file)}
                </Badge>
            </Tooltip>
            {openUrl ? (
                <Tooltip label={t('openInTab')} withArrow>
                    <ActionIcon component="a" href={openUrl} target="_blank" rel="noreferrer" size="sm" variant="subtle" color="gray" aria-label={t('openInTab')}>
                        <IconExternalLink size={12} />
                    </ActionIcon>
                </Tooltip>
            ) : null}
        </Group>
    );
}

/** An image attachment as a tile: the thumbnail, and its name beneath. */
function AttachmentImageTile({ file, onOpen }: { file: AttachmentView; onOpen: () => void }) {
    return (
        <Stack gap={2} w={84} data-testid="attachment-thumbnail">
            <AttachmentThumb file={file} size={84} onOpen={onOpen} />
            <Text size="10px" c="dimmed" truncate title={file.name}>{file.name}</Text>
        </Stack>
    );
}

/**
 * The files on a message. Images are thumbnails that open full size; the rest
 * are chips that save the file; a file that is gone shows muted as expired.
 */
export function MessageAttachments({ attachments }: { attachments?: ReadonlyArray<AttachmentView> }) {
    const [preview, setPreview] = useState<AttachmentView | null>(null);
    if (!attachments || attachments.length === 0) return null;

    const drawsAsPicture = (file: AttachmentView) =>
        isImageAttachment(file) && Boolean(file.url) && !file.expired && !file.reference && !file.external;
    const pictures = attachments.filter(drawsAsPicture);
    const others = attachments.filter((file) => !drawsAsPicture(file));

    return (
        <Stack gap={6} mt={4} data-testid="message-attachments">
            {pictures.length > 0 ? (
                <Group gap={8} wrap="wrap" align="flex-start" data-testid="attachment-thumbnails">
                    {pictures.map((file, index) => (
                        <AttachmentImageTile key={`${file.fileId}:${index}`} file={file} onOpen={() => setPreview(file)} />
                    ))}
                </Group>
            ) : null}
            {others.length > 0 ? (
                <Group gap={6} wrap="wrap">
                    {others.map((file, index) => (
                        <AttachmentFileChip key={`${file.fileId}:${index}`} file={file} />
                    ))}
                </Group>
            ) : null}
            <AttachmentPreviewModal file={preview} onClose={() => setPreview(null)} />
        </Stack>
    );
}

/* ── Files waiting to be sent ────────────────────────────────────────────── */

export interface AttachmentChipsProps {
    files: PendingAttachment[];
    /** Files being uploaded right now (by name). */
    uploading: string[];
    disabled?: boolean;
    onRemove: (fileId: string) => void;
    /** The agent's model cannot be sent images: its name and where its input types are set. Images then wear a warning. */
    textOnlyModel?: { name: string; href: string } | null;
    /** Where a waiting file can be shown from; images then show their thumbnail. Without it they are plain chips. */
    linksFor?: (file: PendingAttachment) => { url: string; downloadUrl: string };
}

/** The files waiting to be sent, each with its conversion status. */
export function AttachmentChips({ files, uploading, disabled, onRemove, textOnlyModel, linksFor }: AttachmentChipsProps) {
    const t = useTranslations('agents.attachments');
    const [preview, setPreview] = useState<AttachmentView | null>(null);
    if (files.length === 0 && uploading.length === 0) return null;
    // An image the model cannot take is not sent; the turn only records a note about it.
    const unsent = (file: PendingAttachment) => Boolean(textOnlyModel) && isImageAttachment(file);
    const warning = textOnlyModel && files.some(unsent) ? textOnlyModel : null;
    return (
        <Stack gap={4} mb={6} data-testid="attachment-chips">
            <Group gap={6} wrap="wrap">
                {files.map((file) => {
                    const links = linksFor?.(file);
                    const view: AttachmentView = { fileId: file.fileId, name: file.name, mimeType: file.mimeType, size: file.size, ...links };
                    const picture = links && isImageAttachment(file) && !unsent(file);
                    return (
                        <Badge
                            key={file.fileId}
                            variant="light"
                            color={unsent(file) || lacksReadableText(file) ? 'orange' : 'gray'}
                            size="lg"
                            radius="sm"
                            leftSection={unsent(file)
                                ? <IconAlertTriangle size={12} />
                                : picture
                                    ? <AttachmentThumb file={view} size={18} onOpen={() => setPreview(view)} />
                                    : <AttachmentIcon file={file} />}
                            rightSection={
                                <CloseButton size="xs" aria-label={t('remove')} disabled={disabled} onClick={() => onRemove(file.fileId)} />
                            }
                            styles={CHIP_LABEL_STYLES}
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
                    );
                })}
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
            <AttachmentPreviewModal file={preview} onClose={() => setPreview(null)} />
        </Stack>
    );
}
