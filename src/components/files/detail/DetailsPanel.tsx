'use client';

import { useId, type ReactNode } from 'react';
import Link from 'next/link';
import { Anchor, Badge } from '@mantine/core';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { FileRecordView } from '@/lib/services/files';
import { formatRelativeTime } from '@/components/providers/providerAccessModel';
import { createdByWho } from '../bucket/FileBrowseParts';
import { expiryLabel, isSessionFile, sessionHref } from '../bucket/fileBrowse';
import { CopyButton, formatBytes, hasMarkdownCopy } from '../shared';
import { apiSnippets, checksumKind, originOf } from './detailModel';
import styles from './FileDetailDrawer.module.css';

export interface DetailsPanelProps {
  bucketKey: string;
  record: FileRecordView;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The exact time, with how long ago it was beside it. */
function When({ value, locale }: { value: Date | string | null | undefined; locale: string }) {
  const date = toDate(value);
  if (!date) return <span className="ds-faint">—</span>;
  return (
    <>
      <time dateTime={date.toISOString()}>{date.toLocaleString(locale)}</time>
      <span className="ds-faint">{formatRelativeTime(date, locale)}</span>
    </>
  );
}

/** Who put the file there: the name of the person, or the system actor; a removed account says nothing. */
function Uploader({ record }: { record: FileRecordView }) {
  if (isSessionFile(record) && record.uploadedBy) {
    return record.uploadedByName ? (
      <span title={record.uploadedBy}>{record.uploadedByName}</span>
    ) : (
      <span className="ds-mono">{record.uploadedBy}</span>
    );
  }
  const who = createdByWho(record, false);
  return who ? <span>{who}</span> : <span className="ds-faint">—</span>;
}

/** The session an agent file belongs to, and when it goes away. */
function SessionRows({ record, locale }: { record: FileRecordView; locale: string }) {
  const ts = useTranslations('files');
  const href = sessionHref(record.agentId, record.conversationId);
  const label = [record.agentKey, record.conversationId].filter(Boolean).join(' · ');
  const expiry = expiryLabel(record.expiresAt, new Date(), locale);
  const expiresAt = toDate(record.expiresAt);

  return (
    <>
      <Row label={ts('columns.session')}>
        <Badge size="xs" variant="light" color="grape">
          {ts('session.badge')}
        </Badge>
        {href ? (
          <>
            <Anchor component={Link} href={href} size="sm">
              {ts('session.open')}
            </Anchor>
            {label ? <span className="ds-mono ds-faint">{label}</span> : null}
          </>
        ) : (
          <span className="ds-mono ds-faint">{label || ts('session.openUnknownAgent', { id: record.conversationId ?? '' })}</span>
        )}
      </Row>
      <Row label={ts('columns.expires')}>
        {expiry.kind === 'none' ? (
          <span>{ts('session.neverExpires')}</span>
        ) : (
          <>
            <span className={expiry.kind === 'expired' ? styles.expired : styles.valueText} title={expiresAt?.toLocaleString(locale)}>
              {expiry.kind === 'expired' ? `${ts('session.expired')} · ${expiry.text}` : expiry.text}
            </span>
            <span className="ds-faint">{ts('session.removedAutomatically')}</span>
          </>
        )}
      </Row>
    </>
  );
}

/** The calls of the client API for this file, each with a copy button. */
function ApiSection({ bucketKey, record }: DetailsPanelProps) {
  const t = useTranslations('files.detail');
  const titleId = useId();
  // The page runs in the browser: the address in the snippets is the one the person is using right now.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const snippets = apiSnippets(origin, bucketKey, record.key, { markdown: hasMarkdownCopy(record) });

  return (
    <section className={styles.api} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.apiTitle}>
        {t('api.title')}
      </h3>
      <p className={styles.apiHint}>{t('api.hint')}</p>
      {snippets.map((snippet) => {
        const title =
          snippet.id === 'download' ? t('api.download') : snippet.id === 'downloadMarkdown' ? t('api.downloadMarkdown') : t('api.delete');
        return (
          <div key={snippet.id} className={styles.snippet}>
            <div className={styles.snippetHead}>
              <span>{title}</span>
              <CopyButton value={snippet.code} label={t('api.copy', { what: title })} />
            </div>
            <pre className={`ds-code-block ${styles.code}`}>
              <code>{snippet.code}</code>
            </pre>
          </div>
        );
      })}
    </section>
  );
}

/** Everything the record says about the file, and how to reach it through the API. */
export default function DetailsPanel({ bucketKey, record }: DetailsPanelProps) {
  const t = useTranslations('files.detail');
  const locale = useLocale();
  const origin = originOf(record);
  const checksum = record.checksum?.trim();
  const created = toDate(record.createdAt);
  const updated = toDate(record.updatedAt);
  // A record that was never changed has the same time twice: say it once.
  const showUpdated = updated !== null && (created === null || Math.abs(updated.getTime() - created.getTime()) >= 1000);

  return (
    <div>
      <dl className={styles.kv}>
        <Row label={t('details.name')}>
          <span className={styles.valueText}>{record.name}</span>
        </Row>
        <Row label={t('details.key')}>
          <span className={`ds-mono ${styles.valueText}`}>{record.key}</span>
          <CopyButton value={record.key} label={t('details.copyKey', { name: record.name })} />
        </Row>
        <Row label={t('details.size')}>
          {t('details.sizeExact', { size: formatBytes(record.size), bytes: record.size.toLocaleString(locale) })}
        </Row>
        <Row label={t('details.contentType')}>
          {record.contentType ? <span className="ds-mono">{record.contentType}</span> : <span className="ds-faint">{t('details.notRecorded')}</span>}
        </Row>
        <Row label={checksum && checksumKind(checksum) === 'sha256' ? t('details.checksumSha256') : t('details.checksum')}>
          {checksum ? (
            <>
              <span className={`ds-mono ${styles.valueText}`}>{checksum}</span>
              <CopyButton value={checksum} label={t('details.copyChecksum')} />
            </>
          ) : (
            <span className="ds-faint">{t('details.notRecorded')}</span>
          )}
        </Row>
        <Row label={t('details.origin')}>
          {origin === 'agent_output'
            ? t('details.originAgent')
            : origin === 'import'
              ? t('details.originImport')
              : t('details.originUpload')}
        </Row>
        <Row label={t('details.uploadedBy')}>
          <Uploader record={record} />
        </Row>
        <Row label={t('details.created')}>
          <When value={record.createdAt} locale={locale} />
        </Row>
        {showUpdated ? (
          <Row label={t('details.updated')}>
            <When value={record.updatedAt} locale={locale} />
          </Row>
        ) : null}
        {isSessionFile(record) ? <SessionRows record={record} locale={locale} /> : null}
      </dl>
      <ApiSection bucketKey={bucketKey} record={record} />
    </div>
  );
}
