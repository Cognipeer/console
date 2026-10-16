'use client';

import { useEffect, useRef, useState } from 'react';
import { Select, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBroadcast } from '@tabler/icons-react';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { ALL_CHANNEL_TYPES, type AlertChannelType, type ChannelTestResult, type LibraryChannelDto } from '../alertTypes';
import { readApiError } from '../apiError';
import { buildChannelTestBody, channelEditsSecrets, isStoredChannel, type ChannelItem } from '../channelItems';
import ChannelsEditor from '../ChannelsEditor';
import {
  MAX_LIBRARY_NAME,
  buildCreateLibraryBody,
  buildUpdateLibraryBody,
  emptyLibraryForm,
  libraryFormFromEntry,
  libraryFormToItem,
  validateLibraryForm,
  type LibraryFormValues,
} from './libraryUi';

export interface LibraryChannelFormProps {
  opened: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** The entry being edited; absent = create. */
  entry?: LibraryChannelDto | null;
}

/** Full-screen create/edit of one library channel. The kind is fixed once the entry exists. */
export default function LibraryChannelForm({ opened, onClose, onSaved, entry }: LibraryChannelFormProps) {
  const t = useTranslations('alerts');
  const isEdit = Boolean(entry);
  const [values, setValues] = useState<LibraryFormValues>(() => (entry ? libraryFormFromEntry(entry) : emptyLibraryForm()));
  const [saving, setSaving] = useState(false);

  // Re-seed whenever the form opens (or switches entry), from the entry handed in at that moment.
  const entryRef = useRef(entry);
  entryRef.current = entry;
  useEffect(() => {
    if (!opened) return;
    setValues(entryRef.current ? libraryFormFromEntry(entryRef.current) : emptyLibraryForm());
  }, [opened, entry?.id]);

  const item = libraryFormToItem(values, entry);
  const issue = validateLibraryForm(values, entry);

  const applyItem = (next: ChannelItem) =>
    setValues((current) => ({
      ...current,
      recipients: next.recipients,
      url: next.url ?? '',
      secret: next.secret ?? '',
      routingKey: next.routingKey ?? '',
      replace: Boolean(next.replace),
      clearSecret: Boolean(next.clearSecret),
    }));

  // A typed destination is tested as typed; an untouched stored one by its library id (the server holds the secret).
  const testable = (channel: ChannelItem) =>
    isStoredChannel(channel) && !channelEditsSecrets(channel) ? Boolean(entry) : buildChannelTestBody(channel, null) !== null;
  const onTest = async (channel: ChannelItem): Promise<ChannelTestResult> => {
    const byReference = isStoredChannel(channel) && !channelEditsSecrets(channel) && entry;
    const res = await fetch(byReference ? `/api/alerts/channels/library/${entry.id}/test` : '/api/alerts/channels/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: byReference ? '{}' : JSON.stringify(buildChannelTestBody(channel, null)),
    });
    const data = (await res.json().catch(() => null)) as { result?: ChannelTestResult; message?: string; error?: string } | null;
    if (!res.ok || !data?.result) throw new Error(data?.message ?? data?.error ?? t('channels.testNoDetail'));
    return data.result;
  };

  const issueText = (): string | undefined => {
    if (!issue) return undefined;
    if (issue.code === 'nameRequired') return t('libraryUx.nameRequired');
    if (issue.code === 'nameTooLong') return t('libraryUx.nameTooLong', { max: MAX_LIBRARY_NAME });
    if (issue.code === 'recipientsRequired') return t('libraryUx.recipientsRequired');
    return undefined;
  };

  const submit = async () => {
    if (issue) return;
    setSaving(true);
    try {
      const res = await fetch(entry ? `/api/alerts/channels/library/${entry.id}` : '/api/alerts/channels/library', {
        method: entry ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry ? buildUpdateLibraryBody(values, entry) : buildCreateLibraryBody(values)),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('libraryUx.saveFailed')));
      notifications.show({
        title: t(isEdit ? 'libraryUx.updated' : 'libraryUx.created'),
        message: t(isEdit ? 'libraryUx.updatedMessage' : 'libraryUx.createdMessage', { name: values.name.trim() }),
        color: 'teal',
      });
      onSaved();
      onClose();
    } catch (error) {
      notifications.show({ title: t('error'), message: error instanceof Error ? error.message : t('libraryUx.saveFailed'), color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBroadcast size={16} />}
      title={isEdit ? t('libraryUx.editTitle') : t('libraryUx.createTitle')}
      subtitle={t('libraryUx.formSubtitle')}
      primaryAction={{ label: isEdit ? t('save') : t('create'), loading: saving, disabled: Boolean(issue), onClick: () => void submit() }}
      secondaryAction={{ label: t('cancel'), onClick: onClose }}
    >
      <FormSection number={1} title={t('libraryUx.sectionName')} description={t('libraryUx.sectionNameDescription')} done={!issue || (issue.code !== 'nameRequired' && issue.code !== 'nameTooLong')}>
        <FormRow cols={2}>
          <FormField label={t('libraryUx.name')} required>
            <TextInput
              aria-label={t('libraryUx.name')}
              placeholder={t('libraryUx.namePlaceholder')}
              maxLength={MAX_LIBRARY_NAME}
              value={values.name}
              error={values.name.length > 0 && (issue?.code === 'nameRequired' || issue?.code === 'nameTooLong') ? issueText() : undefined}
              onChange={(event) => setValues((current) => ({ ...current, name: event.currentTarget.value }))}
            />
          </FormField>
          <FormField label={t('libraryUx.kind')} hint={isEdit ? t('libraryUx.kindFixed') : undefined}>
            <Select
              aria-label={t('libraryUx.kind')}
              data={ALL_CHANNEL_TYPES.map((kind) => ({ value: kind, label: t(`channelTypes.${kind}`) }))}
              value={values.kind}
              allowDeselect={false}
              disabled={isEdit}
              onChange={(next) => next && setValues({ ...emptyLibraryForm(next as AlertChannelType), name: values.name })}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title={t('libraryUx.sectionDestination')} description={t('libraryUx.sectionDestinationDescription')} done={!issue}>
        <ChannelsEditor value={[item]} onChange={(next) => next[0] && applyItem(next[0])} single maxChannels={1} onTest={onTest} canTest={testable} />
        {issue?.code === 'recipientsRequired' && values.name.trim() ? (
          <Text size="xs" c="red" role="alert">
            {issueText()}
          </Text>
        ) : null}
        {entry && entry.usedBy.length > 0 ? (
          <Text size="xs" c="dimmed">
            {t('libraryUx.editImpact', { count: new Set(entry.usedBy.map((use) => use.ruleId)).size })}
          </Text>
        ) : null}
      </FormSection>
    </FormShell>
  );
}
