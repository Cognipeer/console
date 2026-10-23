'use client';

import { useMemo } from 'react';
import { IconFileOff } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { formatCount } from '../shared';
import { capText } from './detailModel';
import styles from './FileDetailDrawer.module.css';

export interface TextBlockProps {
  text: string;
  /** What a screen reader calls the block ("Text of report.txt"). */
  label: string;
  /** Shown instead of the block when the text is empty. */
  emptyLabel: string;
}

/**
 * The text of a file or of its Markdown copy, exactly as it is: plain text in a `<pre>`, never parsed as
 * Markdown or HTML (the content is whatever somebody uploaded). A very long text is cut, with a note.
 */
export default function TextBlock({ text, label, emptyLabel }: TextBlockProps) {
  const t = useTranslations('files.detail');
  const locale = useLocale();
  const capped = useMemo(() => capText(text), [text]);

  if (text.length === 0) {
    return (
      <div className={`${styles.previewBox} ${styles.empty}`}>
        <IconFileOff size={22} className={styles.emptyIcon} aria-hidden="true" />
        <span className={styles.emptyHint}>{emptyLabel}</span>
      </div>
    );
  }

  return (
    <>
      {/* A long text scrolls inside the block, so the block itself must be reachable with the keyboard. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre className={`${styles.previewBox} ${styles.previewText}`} tabIndex={0} role="region" aria-label={label}>
        {capped.text}
      </pre>
      {capped.truncated ? (
        <p className={styles.previewNote}>
          {t('preview.truncated', { shown: formatCount(capped.text.length, locale), total: formatCount(capped.total, locale) })}
        </p>
      ) : null}
    </>
  );
}
