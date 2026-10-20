'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Anchor, Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { isFilesApiError, type BucketDetail } from '../filesApi';
import { formatCount } from '../shared';
import { useDeleteBucket } from '../useFilesQueries';
import { bucketErrorMessage } from './bucketErrors';
import { agentFilesHref, deleteRules } from './settingsModel';

export interface DeleteBucketDialogProps {
  bucket: BucketDetail;
  opened: boolean;
  onClose: () => void;
}

/** Where the person lands once the bucket is gone. */
const LIST_HREF = '/dashboard/files';

/**
 * Deleting a bucket, asked in the one place that can answer the follow-up questions:
 * - an agent keeps its session files here: nothing to decide, the agents are listed with a link to where they pick
 *   another bucket;
 * - the bucket holds files: they are removed from the storage provider too, and only after the person ticks that
 *   explicitly (without it the server refuses a bucket that is not empty);
 * - an empty bucket: a plain confirmation.
 * Deleting the files is a background job (the answer is "deleting"): the dialog closes and the bucket page shows the
 * progress.
 */
export default function DeleteBucketDialog({ bucket, opened, onClose }: DeleteBucketDialogProps) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const locale = useLocale();
  const router = useRouter();
  const deleteBucket = useDeleteBucket();
  const rules = deleteRules(bucket);

  const [alsoFiles, setAlsoFiles] = useState(false);
  // The numbers said the bucket was empty, the server found files: the choice has to be made after all.
  const [foundFiles, setFoundFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every opening starts from the careful choice.
  useEffect(() => {
    if (!opened) return;
    setAlsoFiles(false);
    setFoundFiles(false);
    setError(null);
  }, [opened]);

  const pending = deleteBucket.isPending;
  const showFilesOption = rules.needsFilesConsent || foundFiles;
  const providerName = bucket.provider?.label?.trim() || bucket.providerKey;
  const count = formatCount(rules.fileCount, locale);
  const canConfirm = !rules.blocked && !rules.deleting && (!showFilesOption || alsoFiles) && !pending;

  const confirm = async () => {
    if (!canConfirm) return;
    setError(null);
    try {
      const result = await deleteBucket.mutateAsync({ bucketKey: bucket.key, ...(showFilesOption ? { deleteFiles: true } : {}) });
      if (result.status === 'deleted') {
        notifications.show({ color: 'green', message: t('delete.deleted', { name: bucket.name }) });
        onClose();
        router.push(LIST_HREF);
        return;
      }
      notifications.show({ color: 'blue', message: t('delete.started', { name: bucket.name }) });
      onClose();
    } catch (failure) {
      if (isFilesApiError(failure) && failure.code === 'bucket_not_empty') {
        setFoundFiles(true);
        setError(t('delete.errors.notEmpty'));
        return;
      }
      setError(bucketErrorMessage(failure, tc, 'deleteBucket'));
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (!pending) onClose();
      }}
      title={t('delete.title')}
      centered
      size="md"
      closeOnClickOutside={!pending}
      closeOnEscape={!pending}
      withCloseButton={!pending}
      data-testid="delete-bucket-modal"
    >
      {rules.blocked ? (
        <Stack gap="sm">
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />} role="note">
            {rules.agents.length === 1 ? t('delete.blockedOne') : t('delete.blockedMany', { count: rules.agents.length })}
          </Alert>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }} aria-label={t('delete.agentsLabel')}>
            {rules.agents.map((agent) => (
              <li key={agent.agentId}>
                <Anchor component={Link} href={agentFilesHref(agent)} size="sm">
                  {agent.name}
                </Anchor>
                <span className="ds-faint ds-mono">{` · ${agent.agentKey}`}</span>
              </li>
            ))}
          </ul>
          <Text size="sm" c="dimmed">
            {t('delete.blockedHint')}
          </Text>
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={onClose}>
              {t('delete.close')}
            </Button>
          </Group>
        </Stack>
      ) : rules.deleting ? (
        <Stack gap="sm">
          <Alert color="blue" icon={<IconInfoCircle size={16} />} role="status">
            {t('delete.alreadyDeleting')}
          </Alert>
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={onClose}>
              {t('delete.close')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Text size="sm" fw={500}>
            {t('delete.question', { name: bucket.name })}
          </Text>
          {showFilesOption ? (
            <>
              <Text size="sm" c="dimmed">
                {rules.fileCount === 1 ? t('delete.filesNoteOne', { provider: providerName }) : t('delete.filesNoteMany', { count, provider: providerName })}
              </Text>
              <Checkbox
                checked={alsoFiles}
                disabled={pending}
                onChange={(event) => setAlsoFiles(event.currentTarget.checked)}
                label={
                  rules.fileCount === 1
                    ? t('delete.alsoFilesOne', { provider: providerName })
                    : t('delete.alsoFilesMany', { count, provider: providerName })
                }
                data-autofocus
              />
            </>
          ) : (
            <Text size="sm" c="dimmed">
              {t('delete.noFiles')}
            </Text>
          )}
          {error ? (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} role="alert">
              {error}
            </Alert>
          ) : null}
          <Group justify="flex-end" gap="xs" mt="xs">
            <Button variant="default" onClick={onClose} disabled={pending}>
              {t('delete.cancel')}
            </Button>
            <Button color="red" loading={pending} disabled={!canConfirm} onClick={() => void confirm()} data-testid="delete-bucket-confirm">
              {t('delete.confirm')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
