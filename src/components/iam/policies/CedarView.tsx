'use client';

import { Fragment, type ReactNode } from 'react';
import { useTranslations } from '@/lib/i18n';
import type { ValidationDetail } from '../api';
import classes from './policyEditor.module.css';

const TOKEN =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*")|(@[A-Za-z_]\w*)|\b(permit|forbid|when|unless|principal|action|resource|context|in|is|has|like|if|then|else|true|false)\b/g;

/** Minimal Cedar highlighting (keywords, strings, comments, annotations): enough to read a policy at a glance. */
export function highlightCedarLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of line.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) out.push(<Fragment key={`t${n++}`}>{line.slice(last, index)}</Fragment>);
    const [text, comment, string, annotation] = match;
    const cls = comment ? 'cb-com' : string ? 'cb-str' : annotation ? 'cb-fn' : 'cb-kw';
    out.push(
      <span key={`t${n++}`} className={cls}>
        {text}
      </span>,
    );
    last = index + text.length;
  }
  if (last < line.length) out.push(<Fragment key={`t${n++}`}>{line.slice(last)}</Fragment>);
  return out;
}

interface CedarViewProps {
  code: string;
  /** Lines with an error are marked. */
  errors?: readonly ValidationDetail[];
  maxHeight?: number;
  /** Shown when `code` is empty. */
  empty?: ReactNode;
}

export default function CedarView({ code, errors = [], maxHeight, empty }: CedarViewProps) {
  if (!code.trim()) {
    return (
      <div className="ds-code-block" style={{ padding: '14px 16px', opacity: 0.7 }}>
        {empty ?? '—'}
      </div>
    );
  }
  const errorLines = new Set(errors.map((e) => e.line).filter((l): l is number => typeof l === 'number'));
  const lines = code.replace(/\s+$/, '').split('\n');
  return (
    <div className={`ds-code-block ${classes.cedar}`} style={{ padding: '12px 0', maxHeight }} role="region" aria-label="Cedar">
      {lines.map((line, i) => (
        <div key={i} className={`${classes.cedarLine} ${errorLines.has(i + 1) ? classes.cedarLineErr : ''}`}>
          <span className={classes.cedarLineNum}>{i + 1}</span>
          <span>{line === '' ? ' ' : highlightCedarLine(line)}</span>
        </div>
      ))}
    </div>
  );
}

/** Errors / warnings under a Cedar view: "line 3, col 5: message". */
export function IssueList({
  items,
  tone,
  lineLabel,
}: {
  items: readonly ValidationDetail[];
  tone: 'error' | 'warning';
  lineLabel: (line: number, col?: number) => string;
}) {
  const t = useTranslations('iamCenter');
  if (items.length === 0) return null;
  // An issue with a known `code` is worded in the user's language; anything else shows the server's text.
  const wording = (item: ValidationDetail): string => {
    if (!item.code) return item.message;
    const key = `issueCodes.${item.code}`;
    const text = t(key, item.params);
    return text === `iamCenter.${key}` ? item.message : text;
  };
  return (
    <ul className={classes.errorList} style={tone === 'warning' ? { color: 'var(--ds-warn)' } : undefined}>
      {items.map((item, i) => (
        <li key={i}>
          {typeof item.line === 'number' ? <span>{lineLabel(item.line, item.col)}</span> : null}
          {wording(item)}
        </li>
      ))}
    </ul>
  );
}
