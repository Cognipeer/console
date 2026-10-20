'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { BucketDetail } from '../filesApi';
import { isLocalDiskProvider } from '../list/providerModel';
import { filesErrorMessage, formatCount, StorageLocation } from '../shared';
import { useImportFromStorage } from '../useFilesQueries';
import { canRetryImport, EMPTY_IMPORT_PROGRESS, runImportScan, type ImportProgress } from './importScan';

export interface ImportFromStorageDialogProps {
  bucket: BucketDetail;
  opened: boolean;
  onClose: () => void;
}

type Phase = 'idle' | 'running' | 'done' | 'stopped' | 'failed';

function Counts({ progress }: { progress: ImportProgress }) {
  const t = useTranslations('files.bucket');
  const locale = useLocale();
  const items: Array<[string, number]> = [
    [t('import.scanned'), progress.scanned],
    [t('import.imported'), progress.imported],
    [t('import.skipped'), progress.skipped],
  ];
  return (
    <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 28px', margin: 0 }}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="ds-faint" style={{ fontSize: 12 }}>
            {label}
          </dt>
          <dd style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{formatCount(value, locale)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Import from storage": registers the objects that already sit in the provider under the bucket's location as
 * files here (a bucket filled from outside lists nothing until then). The server reads a page of objects at a time;
 * this runs the pages one after the other, shows the counts as they grow, and can be stopped and continued. Nothing
 * in the storage is changed. A disabled bucket is refused by the server, so the dialog is only offered for an
 * active one.
 */
export default function ImportFromStorageDialog({ bucket, opened, onClose }: ImportFromStorageDialogProps) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const importStep = useImportFromStorage();
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ImportProgress>(EMPTY_IMPORT_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  // A refusal that a second try cannot change (a storage location another bucket uses) has none.
  const [retryable, setRetryable] = useState(true);
  const locale = useLocale();
  const stopRequested = useRef(false);

  // Every opening starts from the explanation.
  useEffect(() => {
    if (!opened) return;
    stopRequested.current = false;
    setPhase('idle');
    setProgress(EMPTY_IMPORT_PROGRESS);
    setError(null);
    setRetryable(true);
  }, [opened]);

  // A scan that is still going when the dialog goes away stops after its current request.
  useEffect(
    () => () => {
      stopRequested.current = true;
    },
    [],
  );

  const start = async (from?: ImportProgress) => {
    stopRequested.current = false;
    setPhase('running');
    setError(null);
    setRetryable(true);
    if (!from) setProgress(EMPTY_IMPORT_PROGRESS);
    const run = await runImportScan({
      step: (input) => importStep.mutateAsync({ bucketKey: bucket.key, input }),
      from,
      shouldStop: () => stopRequested.current,
      onProgress: setProgress,
    });
    setProgress(run.progress);
    if (run.outcome === 'failed') {
      setError(filesErrorMessage(run.error, tc, 'importFromStorage'));
      setRetryable(canRetryImport(run.error));
    }
    setPhase(run.outcome);
  };

  const running = phase === 'running';

  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (!running) onClose();
      }}
      title={t('import.title')}
      centered
      size="md"
      closeOnClickOutside={!running}
      closeOnEscape={!running}
      withCloseButton={!running}
      data-testid="import-modal"
    >
      <Stack gap="sm">
        {phase === 'idle' ? (
          <>
            <Text size="sm">{t('import.intro')}</Text>
            <div>
              <Text size="xs" c="dimmed" mb={4}>
                {t('import.scansLabel')}
              </Text>
              <StorageLocation
                location={bucket.storageLocation}
                localDisk={bucket.provider ? isLocalDiskProvider(bucket.provider) : false}
                copyable={false}
              />
            </div>
            <Text size="sm" c="dimmed">
              {t('import.safe')}
            </Text>
            <Text size="sm" c="dimmed">
              {t('import.markdownNote')}
            </Text>
            <Group justify="flex-end" gap="xs" mt="xs">
              <Button variant="default" onClick={onClose}>
                {t('import.cancel')}
              </Button>
              <Button color="teal" onClick={() => void start()} data-testid="import-start">
                {t('import.start')}
              </Button>
            </Group>
          </>
        ) : (
          <>
            {running ? (
              <Group gap="xs" role="status" aria-live="polite">
                <Loader size="xs" />
                <Text size="sm">{t('import.running')}</Text>
              </Group>
            ) : null}
            {phase === 'done' ? (
              <Alert color="teal" icon={<IconCheck size={16} />} role="status">
                {progress.imported > 0 ? t('import.doneImported', { count: formatCount(progress.imported, locale) }) : t('import.doneNothing')}
              </Alert>
            ) : null}
            {phase === 'stopped' ? (
              <Alert color="yellow" icon={<IconAlertTriangle size={16} />} role="status">
                {t('import.stopped')}
              </Alert>
            ) : null}
            {phase === 'failed' ? (
              <Alert color="red" icon={<IconAlertTriangle size={16} />} role="alert" title={t('import.failedTitle')}>
                {error}
              </Alert>
            ) : null}
            <Counts progress={progress} />
            <Group justify="flex-end" gap="xs" mt="xs">
              {running ? (
                <Button
                  variant="default"
                  onClick={() => {
                    stopRequested.current = true;
                  }}
                  data-testid="import-stop"
                >
                  {t('import.stop')}
                </Button>
              ) : (
                <>
                  {phase === 'stopped' || (phase === 'failed' && retryable) ? (
                    <Button color="teal" onClick={() => void start(progress)} data-testid="import-resume">
                      {phase === 'failed' ? t('import.retry') : t('import.resume')}
                    </Button>
                  ) : null}
                  <Button variant="default" onClick={onClose} data-testid="import-close">
                    {t('import.close')}
                  </Button>
                </>
              )}
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
