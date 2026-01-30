'use client';

import { Modal, TextInput, Select, Button, Stack } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconMail, IconUser, IconShieldCheck } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

interface InviteUserModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function InviteUserModal({ opened, onClose, onSuccess }: InviteUserModalProps) {
  const t = useTranslations('settings.inviteModal');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');

  const form = useForm({
    initialValues: {
      name: '',
      email: '',
      role: 'user',
    },
    validate: {
      name: (value) => (value.length >= 2 ? null : tValidation('nameMinLength')),
      email: (value) => (/^\S+@\S+$/.test(value) ? null : tValidation('invalidEmail')),
      role: (value) => (value ? null : tValidation('roleRequired')),
    },
  });

  const handleSubmit = async (values: typeof form.values) => {
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
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('title')} size="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput
            label={t('form.name.label')}
            placeholder={t('form.name.placeholder')}
            required
            leftSection={<IconUser size={16} />}
            {...form.getInputProps('name')}
          />

          <TextInput
            label={t('form.email.label')}
            placeholder={t('form.email.placeholder')}
            required
            type="email"
            leftSection={<IconMail size={16} />}
            {...form.getInputProps('email')}
          />

          <Select
            label={t('form.role.label')}
            placeholder={t('form.role.placeholder')}
            required
            leftSection={<IconShieldCheck size={16} />}
            data={[
              { value: 'user', label: t('form.role.options.user') },
              { value: 'project_admin', label: 'Project Admin' },
              { value: 'admin', label: t('form.role.options.admin') },
            ]}
            {...form.getInputProps('role')}
          />

          <Button type="submit" fullWidth>
            {t('form.submit')}
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}
