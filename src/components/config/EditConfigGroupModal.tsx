'use client';

import { useCallback, useEffect } from 'react';
import { TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconEdit } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import { useUpdateConfigGroup } from '@/lib/api/queries/config';

interface ConfigGroupLike {
  _id: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
}

interface EditConfigGroupModalProps {
  opened: boolean;
  group: ConfigGroupLike | null;
  onClose: () => void;
  onUpdated: () => void;
}

export default function EditConfigGroupModal({
  opened,
  group,
  onClose,
  onUpdated,
}: EditConfigGroupModalProps) {
  const t = useTranslations('config');
  const updateGroup = useUpdateConfigGroup();
  const loading = updateGroup.isPending;

  const form = useForm({
    initialValues: { name: '', description: '', tags: '' },
    validate: {
      name: (v) => (!v.trim() ? t('nameRequired') : null),
    },
  });

  // Re-seed every time the form opens so a cancelled edit never lingers.
  useEffect(() => {
    if (!opened || !group) return;
    form.setValues({
      name: group.name || '',
      description: group.description || '',
      tags: (group.tags || []).join(', '),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, group]);

  const submit = useCallback(async () => {
    if (!group) return;
    const validation = form.validate();
    if (validation.hasErrors) return;
    const values = form.getValues();

    try {
      const tags = values.tags
        ? values.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        : undefined;

      await updateGroup.mutateAsync({
        id: group._id,
        name: values.name,
        description: values.description || undefined,
        tags,
      });

      notifications.show({
        title: t('groupUpdated'),
        message: t('groupUpdatedMessage'),
        color: 'teal',
      });
      onUpdated();
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: errorMessage(err, t('updateError')),
        color: 'red',
      });
    }
  }, [form, group, onUpdated, t, updateGroup]);

  const values = form.values;
  const validName = values.name.trim().length > 0;
  const checklist = [{ id: 'name', label: t('groupName'), done: validName }];

  const summary = (
    <>
      <SummaryGroup title={t('editGroup')}>
        <SummaryKV label={t('groupKey')} value={group?.key || '—'} mono />
        <SummaryKV label={t('groupName')} value={values.name || <span className="ds-faint">—</span>} />
        <SummaryKV label={t('tags')} value={values.tags || <span className="ds-faint">—</span>} />
      </SummaryGroup>
      <SummaryGroup title={t('preflight')}>
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconEdit size={16} />}
      title={t('editGroup')}
      subtitle={t('editGroupSubtitle')}
      summary={summary}
      footerStatus={t('ready', {
        done: checklist.filter((c) => c.done).length,
        total: checklist.length,
      })}
      primaryAction={{
        label: t('save'),
        icon: <IconCheck size={13} />,
        loading,
        disabled: !validName,
        onClick: () => {
          void submit();
        },
      }}
      secondaryAction={{ label: t('cancel'), onClick: onClose }}
    >
      <FormSection
        number={1}
        title={t('identity')}
        description={t('groupIdentityDescription')}
        done={validName}
      >
        <FormRow cols={2}>
          <FormField label={t('groupName')} required>
            <TextInput placeholder={t('groupNamePlaceholder')} {...form.getInputProps('name')} />
          </FormField>
          <FormField label={t('groupKey')} hint={t('groupKeyLocked')}>
            <TextInput value={group?.key || ''} readOnly />
          </FormField>
        </FormRow>
        <FormField label={t('description')} optional>
          <Textarea
            placeholder={t('groupDescriptionPlaceholder')}
            autosize
            minRows={2}
            {...form.getInputProps('description')}
          />
        </FormField>
        <FormField label={t('tags')} optional hint={t('tagsHint')}>
          <TextInput placeholder={t('tagsPlaceholder')} {...form.getInputProps('tags')} />
        </FormField>
      </FormSection>
    </FormShell>
  );
}
