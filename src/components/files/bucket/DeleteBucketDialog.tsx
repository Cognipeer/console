'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Anchor, Button, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { isFilesApiError, type BucketDetail, type DeleteBucketOptions } from '../filesApi';
import { formatCount, useNow } from '../shared';
import { useDeleteBucket } from '../useFilesQueries';
import { bucketErrorMessage } from './bucketErrors';
import { agentFilesHref, deleteRules, type DeleteRules } from './settingsModel';

export interface DeleteBucketDialogProps {
  bucket: BucketDetail;
  opened: boolean;
  onClose: () => void;
}

/** Where the person lands once the bucket is gone. */
const LIST_HREF = '/dashboard/files';

/** What becomes of the files of a bucket that holds some: removed from the provider with it, or left where they are. */
type FilesChoice = 'files' | 'bucketOnly';

/**
 * Deleting a bucket, asked in the one place that can answer the follow-up questions:
 * - an agent keeps its session files here: nothing to decide, the agents are listed with a link to where they pick
 *   another bucket;
 * - the bucket holds files: the person says what happens to them - they are removed from the storage provider too (a
 *   background job; the bucket reports `deleting` until it is gone), or only the bucket goes and the files stay in the
 *   provider. No choice is made for them: the button stays off until one is picked;
 * - the last "delete with its files" stopped with an error: the reason is shown and the same choice is asked again;
 * - the bucket has been `deleting` so long that the background run was probably lost: "Delete again" queues it anew;
 * - an empty bucket: a plain confirmation.
 * A storage location another bucket uses refuses the delete with its files; the server's sentence is shown and the
 * choice moves to "only the bucket", which that sentence recommends. For a bucket whose run looks lost that is the
 * way out, since the run cannot be asked for again there: the server lets "only the bucket" (`force`) past a bucket
 * that is being deleted, so the choice is offered once the server has refused and not before - a run that is still
 * going would keep removing files.
 */
export default function DeleteBucketDialog({ bucket, opened, onClose }: DeleteBucketDialogProps) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const locale = useLocale();
  const router = useRouter();
  const deleteBucket = useDeleteBucket();
  const now = useNow(30_000, opened && bucket.deleting === true);
  const liveRules = deleteRules(bucket, now);
  // What the dialog said when it was answered. A delete with its files that was just queued makes the bucket report
  // `deleting` while the dialog is still fading out; that must not swap what it shows.
  const [answered, setAnswered] = useState<DeleteRules | null>(null);
  const rules = answered ?? liveRules;

  const [choice, setChoice] = useState<FilesChoice | null>(null);
  // The numbers said the bucket was empty, the server found files: the choice has to be made after all.
  const [foundFiles, setFoundFiles] = useState(false);
  // Asking again for a bucket that is being deleted was refused because another bucket uses its storage location: the
  // run cannot be queued anew, so what becomes of the files has to be answered after all.
  const [locationShared, setLocationShared] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every opening starts without a choice made.
  useEffect(() => {
    if (!opened) return;
    setAnswered(null);
    setChoice(null);
    setFoundFiles(false);
    setLocationShared(false);
    setError(null);
  }, [opened]);

  const pending = deleteBucket.isPending;
  // What becomes of the files of a bucket that is being deleted was answered when the deletion was asked for: it is
  // asked about again only when the server has refused to take the run anew.
  const asksAboutFiles = rules.deleting ? rules.stalled && locationShared : rules.holdsFiles || foundFiles;
  const providerName = bucket.provider?.label?.trim() || bucket.providerKey;
  const count = formatCount(rules.fileCount, locale);
  // A bucket that is being deleted takes the run asked for again once it looks lost, and nothing else.
  const canConfirm = !rules.blocked && !pending && (!rules.deleting || rules.stalled) && (!asksAboutFiles || choice !== null);

  const confirm = async () => {
    if (!canConfirm) return;
    setError(null);
    // A bucket that is being deleted is asked for again, with its files, until the server refuses that.
    const again = rules.deleting && !asksAboutFiles;
    const options: DeleteBucketOptions = again || choice === 'files' ? { deleteFiles: true } : asksAboutFiles ? { force: true } : {};
    try {
      const result = await deleteBucket.mutateAsync({ bucketKey: bucket.key, ...options });
      if (result.status === 'deleted') {
        notifications.show({
          color: 'green',
          message: options.force ? t('delete.deletedKeepingFiles', { name: bucket.name, provider: providerName }) : t('delete.deleted', { name: bucket.name }),
        });
        onClose();
        router.push(LIST_HREF);
        return;
      }
      notifications.show({ color: 'blue', message: t('delete.started', { name: bucket.name }) });
      setAnswered(liveRules);
      onClose();
    } catch (failure) {
      if (isFilesApiError(failure) && failure.code === 'bucket_not_empty') {
        setFoundFiles(true);
        setChoice(null);
        setError(t('delete.errors.notEmpty'));
        return;
      }
      // The sentence for a location another bucket uses recommends deleting the bucket without its files. For a bucket
      // whose run looks lost there was no choice on screen yet: the refusal brings it, and "only the bucket" is the
      // way out, as the run cannot be asked for again.
      if (isFilesApiError(failure) && failure.code === 'storage_location_shared' && options.deleteFiles) {
        setChoice('bucketOnly');
        if (rules.deleting) setLocationShared(true);
      }
      setError(bucketErrorMessage(failure, tc, 'deleteBucket'));
    }
  };

  const failure = error ? (
    <Alert color="red" icon={<IconAlertTriangle size={16} />} role="alert">
      {error}
    </Alert>
  ) : null;

  // What becomes of the files: asked when the bucket is first deleted, and again for a bucket whose run cannot be
  // asked for anew.
  const filesChoice = (
    <Radio.Group value={choice ?? ''} onChange={(value) => setChoice(value as FilesChoice)} label={t('delete.choiceLabel')}>
      <Stack gap="xs" mt="xs">
        <Radio
          value="files"
          disabled={pending}
          label={
            rules.fileCount === 1
              ? t('delete.withFilesOne')
              : rules.fileCount > 1
                ? t('delete.withFilesMany', { count })
                : t('delete.withFilesSome')
          }
          description={
            rules.fileCount === 1
              ? t('delete.withFilesNoteOne', { provider: providerName })
              : t('delete.withFilesNoteMany', { provider: providerName })
          }
          data-autofocus
        />
        <Radio
          value="bucketOnly"
          disabled={pending}
          label={t('delete.bucketOnly')}
          description={
            rules.fileCount === 1
              ? t('delete.bucketOnlyNoteOne', { provider: providerName })
              : t('delete.bucketOnlyNoteMany', { provider: providerName })
          }
        />
      </Stack>
    </Radio.Group>
  );

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
          <Alert color={rules.stalled ? 'yellow' : 'blue'} icon={<IconInfoCircle size={16} />} role="status">
            {rules.stalled ? t('delete.stalled') : t('delete.alreadyDeleting')}
          </Alert>
          {asksAboutFiles ? filesChoice : null}
          {failure}
          <Group justify="flex-end" gap="xs" mt="xs">
            <Button variant="default" onClick={onClose} disabled={pending}>
              {t('delete.close')}
            </Button>
            {rules.stalled ? (
              <Button color="red" loading={pending} disabled={!canConfirm} onClick={() => void confirm()} data-testid="delete-bucket-confirm">
                {/* The run asked for again, or - once the server has refused that - only the bucket. */}
                {asksAboutFiles && choice === 'bucketOnly' ? t('delete.confirm') : t('delete.deleteAgain')}
              </Button>
            ) : null}
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Text size="sm" fw={500}>
            {t('delete.question', { name: bucket.name })}
          </Text>
          {rules.lastError ? (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} role="note">
              <div>{t('delete.previousFailure', { reason: rules.lastError })}</div>
              <div className="ds-muted" style={{ marginTop: 4 }}>
                {t('delete.previousFailureHint')}
              </div>
            </Alert>
          ) : null}
          {asksAboutFiles ? (
            <>
              <Text size="sm" c="dimmed">
                {rules.fileCount === 1
                  ? t('delete.filesIntroOne', { provider: providerName })
                  : rules.fileCount > 1
                    ? t('delete.filesIntroMany', { count, provider: providerName })
                    : t('delete.filesIntroSome', { provider: providerName })}
              </Text>
              {filesChoice}
            </>
          ) : (
            <Text size="sm" c="dimmed">
              {t('delete.noFiles')}
            </Text>
          )}
          {failure}
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
