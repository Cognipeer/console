'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { FormField, FormRow } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import type { BucketDetail } from '../filesApi';
import { useUpdateBucket } from '../useFilesQueries';
import { bucketErrorMessage } from './bucketErrors';
import {
  DESCRIPTION_MAX_LENGTH,
  descriptionProblem,
  isDirty,
  nameProblem,
  NAME_MAX_LENGTH,
  settingsPatch,
  valuesOf,
  type BucketStatusValue,
  type SettingsValues,
} from './settingsModel';

export interface SettingsGeneralCardProps {
  bucket: BucketDetail;
  /** The person may change the bucket and it is not being deleted. */
  editable: boolean;
}

const sameValues = (a: SettingsValues, b: SettingsValues) =>
  a.name === b.name && a.description === b.description && a.status === b.status;

/**
 * General: the name, the description and whether the bucket takes changes. Saving sends only what changed. A
 * bucket an agent keeps its session files in cannot be disabled: the server says so and the sentence is shown
 * under the form.
 */
export default function SettingsGeneralCard({ bucket, editable }: SettingsGeneralCardProps) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const update = useUpdateBucket();

  const savedName = bucket.name;
  const savedDescription = bucket.description;
  const savedStatus = bucket.status;
  const saved = useMemo(
    () => valuesOf({ name: savedName, description: savedDescription, status: savedStatus }),
    [savedName, savedDescription, savedStatus],
  );
  const [values, setValues] = useState<SettingsValues>(saved);
  const [error, setError] = useState<string | null>(null);

  // The saved bucket changed (a refresh, a change made elsewhere): start from it again, unless there are unsaved edits.
  const lastSaved = useRef(saved);
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = saved;
    setValues((current) => (sameValues(current, previous) ? saved : current));
  }, [saved]);

  const problem = nameProblem(values.name);
  const descriptionIssue = descriptionProblem(values.description);
  const dirty = isDirty(values, bucket);
  const canSave = editable && dirty && !problem && !descriptionIssue && !update.isPending;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSave) return;
    setError(null);
    try {
      await update.mutateAsync({ bucketKey: bucket.key, patch: settingsPatch(values, bucket) });
      notifications.show({ color: 'green', message: t('general.saved') });
    } catch (failure) {
      setError(bucketErrorMessage(failure, tc));
    }
  };

  return (
    <DetailCard title={t('general.title')} description={t('general.description')}>
      <form onSubmit={(event) => void submit(event)} noValidate aria-label={t('general.title')}>
        <FormRow cols={1}>
          <FormField label={t('general.name')} required>
            <TextInput
              aria-label={t('general.name')}
              value={values.name}
              disabled={!editable}
              error={
                !editable || !problem
                  ? undefined
                  : problem === 'required'
                    ? t('general.nameRequired')
                    : t('general.nameTooLong', { max: NAME_MAX_LENGTH })
              }
              onChange={(event) => {
                // Read the value now: React clears `currentTarget` once the handler returns, and the updater may run later.
                const { value } = event.currentTarget;
                setValues((current) => ({ ...current, name: value }));
              }}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('general.descriptionLabel')}>
            <Textarea
              aria-label={t('general.descriptionLabel')}
              minRows={3}
              autosize
              value={values.description}
              disabled={!editable}
              error={editable && descriptionIssue ? t('general.descriptionTooLong', { max: DESCRIPTION_MAX_LENGTH }) : undefined}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setValues((current) => ({ ...current, description: value }));
              }}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField
            label={t('general.status')}
            hint={values.status === 'active' ? t('general.statusActiveHint') : t('general.statusDisabledHint')}
          >
            <select
              className="ds-select"
              aria-label={t('general.status')}
              value={values.status}
              disabled={!editable}
              onChange={(event) => {
                const value = event.currentTarget.value as BucketStatusValue;
                setValues((current) => ({ ...current, status: value }));
              }}
            >
              <option value="active">{t('general.statusActive')}</option>
              <option value="disabled">{t('general.statusDisabled')}</option>
            </select>
          </FormField>
        </FormRow>
        {error ? (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} role="alert" mt="sm">
            {error}
          </Alert>
        ) : null}
        {editable ? (
          <div style={{ marginTop: 12 }}>
            <Button
              type="submit"
              color="teal"
              size="xs"
              loading={update.isPending}
              disabled={!dirty || Boolean(problem) || Boolean(descriptionIssue)}
            >
              {t('general.save')}
            </Button>
          </div>
        ) : null}
      </form>
    </DetailCard>
  );
}
