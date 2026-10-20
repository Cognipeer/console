'use client';

import { CopyButton } from '../shared';
import styles from './bucket.module.css';

export interface CodeBlockProps {
  code: string;
  /** What the block is, for a screen reader and for the copy button ("Copy the cURL sample"). */
  label: string;
  copyLabel: string;
}

/** A code sample on the dark code surface with a copy button. It scrolls inside its own box, never the page. */
export default function CodeBlock({ code, label, copyLabel }: CodeBlockProps) {
  return (
    <div className={styles.codeWrap}>
      <div className={styles.codeCopy}>
        <CopyButton value={code} label={copyLabel} />
      </div>
      {/* The sample scrolls sideways inside its box, so a keyboard user has to be able to focus it to scroll it. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre className={styles.code} tabIndex={0} role="region" aria-label={label}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
