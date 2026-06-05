'use client';

import { useState } from 'react';
import { TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconMail, IconUser, IconUserPlus } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';

interface InviteUserModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type RoleValue = 'user' | 'project_admin' | 'admin';

export default function InviteUserModal({ opened, onClose, onSuccess }: InviteUserModalProps) {
  const t = useTranslations('settings.inviteModal');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');
  const [submitting, setSubmitting] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      email: '',
      role: 'user' as RoleValue,
    },
    validate: {
      name: (value) => (value.length >= 2 ? null : tValidation('nameMinLength')),
      email: (value) => (/^\S+@\S+$/.test(value) ? null : tValidation('invalidEmail')),
      role: (value) => (value ? null : tValidation('roleRequired')),
    },
  });

  const values = form.values;
  const validName = values.name.trim().length >= 2;
  const validEmail = /^\S+@\S+$/.test(values.email);
  const validRole = Boolean(values.role);

  const checklist = [
    { id: 1, label: t('form.name.label'), done: validName },
    { id: 2, label: t('form.email.label'), done: validEmail },
    { id: 3, label: t('form.role.label'), done: validRole },
  ];

  const canSubmit = validName && validEmail && validRole;

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setSubmitting(true);
    try {
      const response = await fetch('/api/users/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || t('errors.invite'));
      }

      notifications.show({
        title: tNotifications('inviteSuccessTitle'),
        message: t('messages.inviteSuccess', { email: values.email }),
        color: 'green',
      });

      form.reset();
      onClose();
      onSuccess();
    } catch (error: unknown) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: error instanceof Error ? error.message : t('errors.invite'),
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const roleOptions: Array<{ value: RoleValue; label: string }> = [
    { value: 'user', label: t('form.role.options.user') },
    { value: 'project_admin', label: t('form.role.options.project_admin') },
    { value: 'admin', label: t('form.role.options.admin') },
  ];

  const roleLabel = roleOptions.find((o) => o.value === values.role)?.label;

  const summary = (
    <>
      <SummaryGroup title={t('title')}>
        <SummaryKV
          label={t('form.name.label')}
          value={values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={t('form.email.label')}
          value={values.email || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={t('form.role.label')}
          value={
            roleLabel ? (
              <span className="ds-badge ds-badge-info">{roleLabel}</span>
            ) : (
              <span className="ds-faint">—</span>
            )
          }
        />
      </SummaryGroup>
      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconUserPlus size={16} />}
      title={t('title')}
      subtitle="Send an invitation email so a new teammate can join your workspace."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: t('form.submit'),
        loading: submitting,
        disabled: !canSubmit,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      <FormSection
        number={1}
        title={t('form.name.label')}
        description="Identify the person you are inviting."
        done={validName && validEmail}
      >
        <FormRow cols={2}>
          <FormField label={t('form.name.label')} required>
            <TextInput
              placeholder={t('form.name.placeholder')}
              leftSection={<IconUser size={16} />}
              {...form.getInputProps('name')}
            />
          </FormField>
          <FormField label={t('form.email.label')} required>
            <TextInput
              placeholder={t('form.email.placeholder')}
              type="email"
              leftSection={<IconMail size={16} />}
              {...form.getInputProps('email')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title={t('form.role.label')}
        description="Choose what the invitee will be able to do in your workspace."
        done={validRole}
      >
        <ChipPicker<RoleValue>
          options={roleOptions}
          value={values.role}
          onChange={(v) => form.setFieldValue('role', v as RoleValue)}
        />
      </FormSection>
    </FormShell>
  );
}
