'use client';

import { useState } from 'react';
import { Alert, Skeleton } from '@mantine/core';
import { IconAlertTriangle, IconEyeOff } from '@tabler/icons-react';
import { SkeletonRegion } from '@/components/common/ui/Skeletons';
import { useTranslations } from '@/lib/i18n';
import type { FileRecordView } from '@/lib/services/files';
import { objectPreviewUrl } from '../filesApi';
import { filesErrorMessage, formatBytes, PREVIEW_MAX_BYTES } from '../shared';
import { useObjectText } from '../useFilesQueries';
import { previewPlanOf } from './detailModel';
import TextBlock from './TextBlock';
import { usePreviewBlob } from './usePreviewBlob';
import styles from './FileDetailDrawer.module.css';

export interface PreviewPanelProps {
  bucketKey: string;
  record: FileRecordView;
}

function PreviewLoading({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label}>
      <Skeleton height={220} radius="md" />
    </SkeletonRegion>
  );
}

function PreviewFailed({ message }: { message: string }) {
  return (
    <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />} role="alert">
      {message}
    </Alert>
  );
}

function NoPreview({ reason }: { reason: 'type' | 'size' }) {
  const t = useTranslations('files.detail');
  return (
    <div className={`${styles.previewBox} ${styles.empty}`}>
      <IconEyeOff size={26} className={styles.emptyIcon} aria-hidden="true" />
      <span className={styles.emptyTitle}>{t('preview.none')}</span>
      <span className={styles.emptyHint}>
        {reason === 'size' ? t('preview.tooLarge', { limit: formatBytes(PREVIEW_MAX_BYTES) }) : t('preview.noneHint')}
      </span>
    </div>
  );
}

function ImagePreview({ bucketKey, record }: PreviewPanelProps) {
  const t = useTranslations('files.detail');
  const src = objectPreviewUrl(bucketKey, record.key);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <PreviewFailed message={t('preview.failed')} />;
  return (
    <div className={styles.previewBox}>
      {/* The address is an authenticated API route of this app, which `next/image` cannot fetch. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.previewImage} src={src} alt={record.name} onError={() => setFailedSrc(src)} />
    </div>
  );
}

function PdfPreview({ bucketKey, record }: PreviewPanelProps) {
  const t = useTranslations('files.detail');
  const tc = useTranslations('files.common');
  const blob = usePreviewBlob(bucketKey, record.key, true);
  if (blob.status === 'loading') return <PreviewLoading label={t('preview.loading')} />;
  if (blob.status === 'error') return <PreviewFailed message={filesErrorMessage(blob.error, tc)} />;
  return (
    <div className={styles.previewBox}>
      <iframe className={styles.previewFrame} src={blob.url} title={t('preview.frameTitle', { name: record.name })} />
    </div>
  );
}

function TextPreview({ bucketKey, record }: PreviewPanelProps) {
  const t = useTranslations('files.detail');
  const tc = useTranslations('files.common');
  const query = useObjectText(bucketKey, record.key, 'original');
  if (query.isPending) return <PreviewLoading label={t('preview.loading')} />;
  if (query.isError) return <PreviewFailed message={filesErrorMessage(query.error, tc)} />;
  return <TextBlock text={query.data} label={t('preview.textLabel', { name: record.name })} emptyLabel={t('preview.empty')} />;
}

/** The inline preview of a file: an image, a PDF or text where the server serves one, "no preview" for the rest. */
export default function PreviewPanel({ bucketKey, record }: PreviewPanelProps) {
  const plan = previewPlanOf(record);
  switch (plan.kind) {
    case 'image':
      return <ImagePreview bucketKey={bucketKey} record={record} />;
    case 'pdf':
      return <PdfPreview bucketKey={bucketKey} record={record} />;
    case 'text':
      return <TextPreview bucketKey={bucketKey} record={record} />;
    default:
      return <NoPreview reason={plan.reason} />;
  }
}
