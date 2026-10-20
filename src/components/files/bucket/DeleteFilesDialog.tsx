'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { BatchDeleteResult } from '../filesApi';
import { filesErrorMessage } from '../shared';
import { useBatchDeleteObjects } from '../useFilesQueries';
import { deleteInBatches, previewFailures } from './filesTabModel';

export interface DeleteFilesDialogProps {
  opened: boolean;
  bucketKey: string;
  /** The files to delete, by key (one from a row's menu, several from the bulk bar). */
  keys: readonly string[];
  /** The name of the file, said in the question when there is only one. */
  fileName?: string;
  onClose: () => void;
  /**
   * The run ended: what was deleted and what was not. Called when the dialog closes itself (everything went) and
   * also when it stays open to list the files that could not be deleted.
   */
  onFinished: (result: BatchDeleteResult) => void;
}

type Phase = 'confirm' | 'working' | 'result';

/**
 * The question before files are deleted, and the account afterwards. Up to 100 keys go in one request; more are
 * sent in turns. Each key succeeds or fails on its own, so a run that could not delete everything says which files
 * stayed and why instead of just reporting an error.
 */
export default function DeleteFilesDialog({ opened, bucketKey, keys, fileName, onClose, onFinished }: DeleteFilesDialogProps) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const batchDelete = useBatchDeleteObjects();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [processed, setProcessed] = useState(0);
  const [result, setResult] = useState<BatchDeleteResult | null>(null);

  // Every opening starts at the question.
  useEffect(() => {
    if (!opened) return;
    setPhase('confirm');
    setProcessed(0);
    setResult(null);
  }, [opened]);

  const single = keys.length === 1;
  const working = phase === 'working';

  const run = async () => {
    setPhase('working');
    setProcessed(0);
    const outcome = await deleteInBatches(keys, (batch) => batchDelete.mutateAsync({ bucketKey, keys: batch }), {
      describeError: (error) => filesErrorMessage(error, tc),
      onProgress: (done) => setProcessed(done),
    });
    onFinished(outcome);
    if (outcome.failed.length === 0) {
      notifications.show({
        color: 'green',
        message: outcome.deleted.length === 1 ? t('deleteFiles.doneOne') : t('deleteFiles.doneMany', { count: outcome.deleted.length }),
      });
      onClose();
      return;
    }
    setResult(outcome);
    setPhase('result');
  };

  const failures = result ? previewFailures(result.failed) : null;

  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (!working) onClose();
      }}
      title={single ? t('deleteFiles.titleOne') : t('deleteFiles.titleMany')}
      centered
      size="md"
      closeOnClickOutside={!working}
      closeOnEscape={!working}
      withCloseButton={!working}
      data-testid="delete-files-modal"
    >
      {phase === 'result' && result && failures ? (
        <Stack gap="sm">
          <Alert color="red" icon={<IconAlertTriangle size={16} />} role="alert">
            {result.deleted.length > 0
              ? t('deleteFiles.partial', { deleted: result.deleted.length, failed: result.failed.length })
              : result.failed.length === 1
                ? t('deleteFiles.noneOne')
                : t('deleteFiles.noneMany', { count: result.failed.length })}
          </Alert>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }} aria-label={t('deleteFiles.failedList')}>
            {failures.shown.map((failure) => (
              <li key={failure.key} style={{ overflowWrap: 'anywhere' }}>
                <span className="ds-mono">{failure.key}</span>
                <span className="ds-muted">{` — ${failure.error}`}</span>
              </li>
            ))}
          </ul>
          {failures.more > 0 ? (
            <Text size="xs" c="dimmed">
              {t('deleteFiles.more', { count: failures.more })}
            </Text>
          ) : null}
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={onClose} data-testid="delete-files-close">
              {t('deleteFiles.close')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Text size="sm" fw={500}>
            {single ? t('deleteFiles.questionOne', { name: fileName ?? keys[0] ?? '' }) : t('deleteFiles.questionMany', { count: keys.length })}
          </Text>
          <Text size="sm" c="dimmed">
            {t('deleteFiles.consequence')}
          </Text>
          {working ? (
            <Text size="sm" role="status" aria-live="polite">
              {t('deleteFiles.progress', { done: processed, total: keys.length })}
            </Text>
          ) : null}
          <Group justify="flex-end" gap="xs" mt="xs">
            <Button variant="default" onClick={onClose} disabled={working}>
              {t('deleteFiles.cancel')}
            </Button>
            <Button color="red" loading={working} onClick={() => void run()} data-testid="delete-files-confirm">
              {t('deleteFiles.confirm')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
