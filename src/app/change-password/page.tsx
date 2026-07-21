'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, PasswordInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconKey, IconShieldLock, IconCheck } from '@tabler/icons-react';
import AuthShell from '@/components/layout/AuthShell';
import { useTranslations } from '@/lib/i18n';

export default function ChangePasswordPage() {
  const router = useRouter();
  const t = useTranslations('changePassword');
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
    validate: {
      currentPassword: (v) => (v ? null : t('validation.currentRequired')),
      newPassword: (v) => (v.length >= 8 ? null : t('validation.minLength')),
      confirmPassword: (v, values) =>
        v === values.newPassword ? null : t('validation.mismatch'),
    },
  });

  useEffect(() => {
    // If user isn't forced to change password, bounce to dashboard.
    const check = async () => {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      if (!res.ok) {
        router.replace('/login');
        return;
      }
      const data = (await res.json()) as { mustChangePassword?: boolean };
      if (!data.mustChangePassword) {
        router.replace('/dashboard');
      }
    };

    check();
  }, [router]);

  const submit = async (values: typeof form.values) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || t('notifications.failed'));
      }

      notifications.show({
        title: t('notifications.title'),
        message: t('notifications.updated'),
        color: 'green',
      });

      router.replace('/dashboard');
    } catch (error) {
      const message = error instanceof Error ? error.message : t('notifications.failed');
      notifications.show({ title: t('notifications.title'), message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title={t('hero.title')}
      titleAccent={t('hero.titleAccent')}
      subtitle={t('hero.subtitle')}
      highlights={[
        {
          icon: <IconShieldLock size={13} stroke={1.7} />,
          label: t('highlights.required'),
        },
        {
          icon: <IconKey size={13} stroke={1.7} />,
          label: t('highlights.unique'),
        },
      ]}
    >
      <form onSubmit={form.onSubmit(submit)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <PasswordInput
            label={t('form.currentPassword.label')}
            required
            size="md"
            autoComplete="current-password"
            {...form.getInputProps('currentPassword')}
          />
          <PasswordInput
            label={t('form.newPassword.label')}
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('newPassword')}
          />
          <PasswordInput
            label={t('form.confirmPassword.label')}
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('confirmPassword')}
          />
          <Button
            type="submit"
            color="teal"
            size="md"
            fullWidth
            loading={loading}
            leftSection={<IconCheck size={16} stroke={1.7} />}
            mt={4}
          >
            {t('form.submit')}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
