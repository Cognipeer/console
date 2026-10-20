'use client';

import { Loader, Tooltip, UnstyledButton, VisuallyHidden } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { FileMarkdownStatus } from '@/lib/database';
import { useTranslations } from '@/lib/i18n';

export interface MarkdownStatusBadgeProps {
  /** `markdownStatus` of the file record. */
  status?: FileMarkdownStatus | null;
  /** `markdownError` of the record; shown for a failed conversion. */
  error?: string | null;
}

/**
 * Where the Markdown copy of a file stands: ready, converting (a background job), failed (the reason is one hover
 * or focus away) or not converted (a quiet dash).
 */
export default function MarkdownStatusBadge({ status, error }: MarkdownStatusBadgeProps) {
  const t = useTranslations('files.common');

  if (status === 'succeeded') {
    return <span className="ds-badge ds-badge-ok">{t('markdown.ready')}</span>;
  }

  if (status === 'pending') {
    return (
      <span className="ds-badge ds-badge-info">
        <Loader size={10} color="currentColor" />
        {t('markdown.pending')}
      </span>
    );
  }

  if (status === 'failed') {
    const reason = error?.trim() || t('markdown.failureUnknown');
    const title = t('markdown.failureTitle');
    return (
      <span className="ds-badge ds-badge-err">
        {t('markdown.failed')}
        <Tooltip label={reason} multiline w={280} withArrow>
          <UnstyledButton
            type="button"
            aria-label={`${title}: ${reason}`}
            style={{ display: 'inline-flex', cursor: 'help' }}
          >
            <IconInfoCircle size={13} aria-hidden="true" />
          </UnstyledButton>
        </Tooltip>
      </span>
    );
  }

  // Not converted (skipped, or nothing recorded): a dash that still says why to a screen reader.
  return (
    <span className="ds-faint" title={status === 'skipped' ? t('markdown.skipped') : undefined}>
      —
      {status === 'skipped' ? <VisuallyHidden>{t('markdown.skipped')}</VisuallyHidden> : null}
    </span>
  );
}
