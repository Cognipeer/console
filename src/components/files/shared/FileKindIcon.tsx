'use client';

import { ThemeIcon } from '@mantine/core';
import { AttachmentIcon } from '@/components/agents/session/SessionAttachments';
import { useTranslations } from '@/lib/i18n';
import { fileKindOf, type FileKind, type FileLike } from './fileKind';

const TONE: Record<FileKind, string> = {
  pdf: 'red',
  image: 'grape',
  text: 'gray',
  office: 'blue',
  other: 'gray',
};

export interface FileKindIconProps {
  file: FileLike;
  /** Size of the glyph in pixels; the tile around it is a little larger. */
  size?: number;
}

/** The glyph of a file's type (the same one the session files use) on a tile tinted by its class. Decorative: the name sits next to it. */
export function FileKindIcon({ file, size = 16 }: FileKindIconProps) {
  const kind = fileKindOf(file);
  return (
    <ThemeIcon variant="light" color={TONE[kind]} size={size + 12} radius="md" aria-hidden="true">
      <AttachmentIcon file={{ mimeType: file.contentType ?? '', name: file.name ?? file.key ?? '' }} size={size} />
    </ThemeIcon>
  );
}

/** The labels of the five classes (and "All types"), in the viewer's language. */
export function useFileKindLabels(): Record<FileKind | 'all', string> {
  const t = useTranslations('files.common');
  return {
    all: t('kind.all'),
    pdf: 'PDF',
    image: t('kind.image'),
    text: t('kind.text'),
    office: t('kind.office'),
    other: t('kind.other'),
  };
}

export interface FileKindChipProps {
  file: FileLike;
}

/** The class of a file as a small neutral chip (PDF, Image, Text, Office document, Other). */
export function FileKindChip({ file }: FileKindChipProps) {
  const labels = useFileKindLabels();
  return <span className="ds-badge">{labels[fileKindOf(file)]}</span>;
}
