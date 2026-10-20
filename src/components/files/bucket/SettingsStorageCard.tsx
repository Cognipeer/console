'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Alert, Button, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconExternalLink, IconLock, IconPlayerPlay, IconX } from '@tabler/icons-react';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { formatLatency } from '@/components/providers/providerAccessModel';
import ProviderTestSteps from '@/components/providers/ProviderTestSteps';
import { useTranslations } from '@/lib/i18n';
import type { BucketDetail, FileProviderTestResult } from '../filesApi';
import { CopyButton, filesErrorMessage, ProviderHealthChip, providerHref, StorageLocation } from '../shared';
import { useTestFileProvider, useUpdateBucket } from '../useFilesQueries';
import { bucketErrorMessage } from './bucketErrors';
import {
  driverNameOf,
  effectivePrefix,
  isPrefixLocked,
  mayOpenProviders,
  normalizePrefixInput,
  PREFIX_MAX_LENGTH,
  prefixProblem,
} from './settingsModel';
import styles from './bucket.module.css';

export interface SettingsStorageCardProps {
  bucket: BucketDetail;
  /** The person may change the bucket and it is not being deleted. */
  editable: boolean;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={styles.rowLabel}>{label}</dt>
      <dd className={styles.rowValue}>{children}</dd>
    </>
  );
}

/** What a connection test said: whether it worked, how long it took, and each step it ran. */
function TestOutcome({ result }: { result: FileProviderTestResult }) {
  const t = useTranslations('files.bucket');
  return (
    <div className={styles.testResult} role="status" aria-live="polite">
      {result.ok === true ? (
        <div className={styles.testHead} style={{ color: 'var(--ds-ok)' }}>
          <IconCheck size={14} stroke={2.2} aria-hidden="true" />
          <span>{t('storage.testOk', { latency: formatLatency(result.latencyMs) })}</span>
        </div>
      ) : result.ok === false ? (
        <>
          <div className={styles.testHead} style={{ color: 'var(--ds-err-text)' }}>
            <IconX size={14} stroke={2.2} aria-hidden="true" />
            <span>{t('storage.testFailed')}</span>
          </div>
          {result.message ? <div className="ds-muted" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>{result.message}</div> : null}
        </>
      ) : (
        <div className={styles.testHead}>{t('storage.testNone')}</div>
      )}
      <ProviderTestSteps steps={result.details?.steps} />
    </div>
  );
}

/** The bucket's prefix: fixed once the bucket has files (changing it would orphan them), a field before that. */
function PrefixRow({ bucket, editable }: SettingsStorageCardProps) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const update = useUpdateBucket();
  const locked = isPrefixLocked(bucket);
  const current = effectivePrefix(bucket);
  const [text, setText] = useState(current);
  const [error, setError] = useState<string | null>(null);

  // The saved prefix changed (a refresh): start from it.
  useEffect(() => {
    setText(current);
  }, [current]);

  const display = current ? `${current}/` : t('storage.prefixRoot');
  const problem = prefixProblem(text);
  const next = normalizePrefixInput(text);
  const changed = next !== current;

  if (locked || !editable) {
    return (
      <>
        <span className="ds-mono">{display}</span>
        {locked ? (
          <div className={styles.lockNote}>
            <IconLock size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{t('storage.prefixLocked')}</span>
          </div>
        ) : null}
      </>
    );
  }

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || problem || update.isPending) return;
    setError(null);
    try {
      await update.mutateAsync({ bucketKey: bucket.key, patch: { prefix: next } });
      notifications.show({ color: 'green', message: t('storage.prefixSaved') });
    } catch (failure) {
      setError(bucketErrorMessage(failure, tc));
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} noValidate aria-label={t('storage.prefix')}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <TextInput
          aria-label={t('storage.prefix')}
          value={text}
          placeholder={t('storage.prefixPlaceholder')}
          classNames={{ input: 'ds-mono' }}
          style={{ flex: '1 1 220px', minWidth: 0 }}
          error={
            problem === 'tooLong'
              ? t('storage.prefixTooLong', { max: PREFIX_MAX_LENGTH })
              : problem === 'dotSegments'
                ? t('storage.prefixDots')
                : problem === 'controlChars'
                  ? t('storage.prefixControl')
                  : undefined
          }
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <Button type="submit" size="xs" variant="default" loading={update.isPending} disabled={!changed || Boolean(problem)} style={{ marginTop: 3 }}>
          {t('storage.prefixSave')}
        </Button>
      </div>
      <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        {t('storage.prefixHint')}
      </div>
      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} role="alert" mt="xs">
          {error}
        </Alert>
      ) : null}
    </form>
  );
}

/**
 * Storage: which provider keeps the files, how it is doing (with a test on demand), the prefix, where the files
 * physically are and the bucket's key. The provider itself is changed in the Providers area, so this card only
 * links to it.
 */
export default function SettingsStorageCard({ bucket, editable }: SettingsStorageCardProps) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const user = useDashboardUser();
  const test = useTestFileProvider();

  const provider = bucket.provider;
  const providerId = provider?._id !== undefined && provider._id !== null && provider._id !== '' ? String(provider._id) : null;
  const link = mayOpenProviders(user?.role) ? providerHref(provider) : null;
  // The server's own disk needs no test.
  const canTest = providerId !== null && bucket.providerHealth?.state !== 'builtin';

  return (
    <DetailCard title={t('storage.title')} description={t('storage.description')}>
      <dl className={styles.rows}>
        <Row label={t('storage.provider')}>
          {provider ? (
            <>
              <div style={{ fontWeight: 500 }}>{provider.label}</div>
              <div className="ds-muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
                {driverNameOf(provider)}
              </div>
            </>
          ) : (
            <span className="ds-faint">{t('storage.providerMissing')}</span>
          )}
          <ProviderHealthChip health={bucket.providerHealth} href={link} />
          <div className={styles.rowActions}>
            {canTest ? (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconPlayerPlay size={13} stroke={1.7} />}
                loading={test.isPending}
                onClick={() => providerId && test.mutate(providerId)}
              >
                {t('storage.testNow')}
              </Button>
            ) : null}
            {link ? (
              <Button component={Link} href={link} size="xs" variant="default" leftSection={<IconExternalLink size={13} stroke={1.7} />}>
                {t('storage.openProvider')}
              </Button>
            ) : null}
          </div>
          {test.isError ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} role="alert" mt="xs">
              {filesErrorMessage(test.error, tc, 'providerTest')}
            </Alert>
          ) : null}
          {test.data ? <TestOutcome result={test.data} /> : null}
        </Row>
        <Row label={t('storage.prefix')}>
          <PrefixRow bucket={bucket} editable={editable} />
        </Row>
        <Row label={t('storage.location')}>
          <StorageLocation location={bucket.storageLocation} />
        </Row>
        <Row label={t('storage.key')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className="ds-mono">{bucket.key}</span>
            <CopyButton value={bucket.key} label={t('storage.copyKey')} />
          </span>
        </Row>
      </dl>
    </DetailCard>
  );
}
