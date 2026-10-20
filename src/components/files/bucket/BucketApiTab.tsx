'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Alert, Button, SegmentedControl } from '@mantine/core';
import { IconBook, IconInfoCircle, IconKey } from '@tabler/icons-react';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { useTranslations } from '@/lib/i18n';
import type { BucketDetail } from '../filesApi';
import { CopyButton } from '../shared';
import CodeBlock from './CodeBlock';
import {
  API_OPERATIONS,
  apiBaseUrl,
  buildSnippet,
  listResponseExample,
  routeOf,
  SAMPLE_FILE_KEY,
  TOKEN_PLACEHOLDER,
  uploadResponseExample,
  type ApiLanguage,
  type ApiOperation,
} from './apiSnippets';
import styles from './bucket.module.css';

export interface BucketApiTabProps {
  bucket: BucketDetail;
  /** Whether the person may change files (the tab itself only reads). */
  canWrite: boolean;
}

/** Where API tokens are made. */
const TOKENS_HREF = '/dashboard/tokens';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={styles.rowLabel}>{label}</dt>
      <dd className={styles.rowValue}>{children}</dd>
    </>
  );
}

function Copyable({ value, label }: { value: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
      <span className="ds-mono" style={{ overflowWrap: 'anywhere' }}>
        {value}
      </span>
      <CopyButton value={value} label={label} />
    </span>
  );
}

/**
 * The API tab: how to reach this bucket from code. The host is the one this page is served from, the key is this
 * bucket's, and every sample is the request the client API really takes (the tests pin them to its routes). The
 * object key a file gets is not the bucket's prefix plus a name: it is generated, and it is what the download and
 * delete calls take.
 */
export function BucketApiTab({ bucket }: BucketApiTabProps) {
  const t = useTranslations('files.bucket');
  const { openDocs } = useDocsDrawer();
  const [origin, setOrigin] = useState('');
  const [language, setLanguage] = useState<ApiLanguage>('curl');

  // The host is known in the browser only; until then (and on the server render) the samples show a placeholder.
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const context = { origin, bucketKey: bucket.key };
  const baseUrl = apiBaseUrl(origin);
  const authHeader = `Authorization: Bearer ${TOKEN_PLACEHOLDER}`;

  const operationText: Record<ApiOperation, { title: string; text: string }> = {
    list: { title: t('api.operations.list.title'), text: t('api.operations.list.text') },
    listFolder: { title: t('api.operations.listFolder.title'), text: t('api.operations.listFolder.text') },
    upload: { title: t('api.operations.upload.title'), text: t('api.operations.upload.text') },
    uploadToFolder: { title: t('api.operations.uploadToFolder.title'), text: t('api.operations.uploadToFolder.text') },
    download: { title: t('api.operations.download.title'), text: t('api.operations.download.text') },
    delete: { title: t('api.operations.delete.title'), text: t('api.operations.delete.text') },
  };
  const languageName: Record<ApiLanguage, string> = { curl: 'cURL', typescript: 'TypeScript', python: 'Python' };
  const requirement: Record<ApiLanguage, string> = {
    curl: t('api.requirements.curl'),
    typescript: t('api.requirements.typescript'),
    python: t('api.requirements.python'),
  };

  return (
    <div className={styles.stack}>
      {bucket.status !== 'active' ? (
        <Alert color="yellow" icon={<IconInfoCircle size={16} />} role="note">
          {t('api.disabledNote')}
        </Alert>
      ) : null}

      <DetailCard
        title={t('api.connect.title')}
        description={t('api.connect.description')}
        actions={
          <Button size="xs" variant="default" leftSection={<IconBook size={13} stroke={1.7} />} onClick={() => openDocs('api-files')}>
            {t('api.docs')}
          </Button>
        }
      >
        <dl className={styles.rows}>
          <Row label={t('api.connect.baseUrl')}>
            <Copyable value={baseUrl} label={t('api.connect.copyBaseUrl')} />
          </Row>
          <Row label={t('api.connect.bucketKey')}>
            <Copyable value={bucket.key} label={t('api.connect.copyBucketKey')} />
          </Row>
          <Row label={t('api.connect.auth')}>
            <Copyable value={authHeader} label={t('api.connect.copyAuth')} />
            <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              {t('api.connect.authHint')}{' '}
              <Button component={Link} href={TOKENS_HREF} size="compact-xs" variant="subtle" leftSection={<IconKey size={12} stroke={1.7} />}>
                {t('api.connect.createToken')}
              </Button>
            </div>
          </Row>
        </dl>
      </DetailCard>

      <DetailCard title={t('api.examples.title')} description={t('api.examples.description')}>
        <div className={styles.langBar}>
          <SegmentedControl
            size="xs"
            aria-label={t('api.languageLabel')}
            value={language}
            onChange={(value) => setLanguage(value as ApiLanguage)}
            data={(['curl', 'typescript', 'python'] as const).map((value) => ({ value, label: languageName[value] }))}
          />
          <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            {requirement[language]}
          </div>
        </div>
        {API_OPERATIONS.map((operation) => (
          <section key={operation} className={styles.operation} aria-labelledby={`api-op-${operation}`}>
            <div className={styles.operationHead}>
              <h3 id={`api-op-${operation}`} className={styles.operationTitle}>
                {operationText[operation].title}
              </h3>
              <span className={`ds-mono ${styles.operationRoute}`}>{routeOf(operation, bucket.key)}</span>
            </div>
            <p className={styles.operationText}>{operationText[operation].text}</p>
            <CodeBlock
              code={buildSnippet(operation, language, context)}
              label={t('api.sampleLabel', { operation: operationText[operation].title, language: languageName[language] })}
              copyLabel={t('api.copySample', { operation: operationText[operation].title })}
            />
          </section>
        ))}
      </DetailCard>

      <DetailCard title={t('api.keys.title')} description={t('api.keys.description', { example: SAMPLE_FILE_KEY })}>
        <div className={styles.twoCol}>
          <div>
            <p className={styles.operationText}>{t('api.keys.uploadAnswer')}</p>
            <CodeBlock
              code={uploadResponseExample(bucket.key)}
              label={t('api.keys.uploadAnswerLabel')}
              copyLabel={t('api.keys.copyUploadAnswer')}
            />
          </div>
          <div>
            <p className={styles.operationText}>{t('api.keys.listAnswer')}</p>
            <CodeBlock code={listResponseExample()} label={t('api.keys.listAnswerLabel')} copyLabel={t('api.keys.copyListAnswer')} />
          </div>
        </div>
      </DetailCard>
    </div>
  );
}
