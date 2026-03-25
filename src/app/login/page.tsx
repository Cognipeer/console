'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  TextInput,
  PasswordInput,
  Button,
  Text,
  Anchor,
  Stack,
  Group,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconLogin } from '@tabler/icons-react';
import LoadingState from '@/components/common/LoadingState';
import AuthShell from '@/components/layout/AuthShell';
import { useTranslations } from '@/lib/i18n';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const t = useTranslations('login');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');

  const form = useForm({
    initialValues: {
      email: '',
      password: '',
    },
    validate: {
      email: (value) =>
        /^\S+@\S+$/.test(value) ? null : tValidation('invalidEmail'),
      password: (value) =>
        value.length >= 8 ? null : tValidation('passwordMinLength'),
    },
  });

  // Check if user is already authenticated
  useEffect(() => {
    const checkAuth = async () => {
      try {
          const response = await fetch('/api/auth/session', {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        });

        if (response.ok) {
          const data = (await response.json()) as { mustChangePassword?: boolean };
          router.push(data.mustChangePassword ? '/change-password' : '/dashboard');
          return;
        }
        } catch {
          setCheckingAuth(false);
      } finally {
        setCheckingAuth(false);
      }
    };

    checkAuth();
  }, [router]);

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: values.email.trim().toLowerCase(),
          password: values.password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        notifications.show({
          title: tNotifications('loginFailedTitle'),
          message: data.error || tNotifications('invalidCredentials'),
          color: 'red',
        });
        return;
      }

      notifications.show({
        title: tCommon('success'),
        message: tNotifications('loginSuccess'),
        color: 'green',
      });

      router.push(data.mustChangePassword ? '/change-password' : '/dashboard');
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tNotifications('loginGenericError'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  // Show loading state while checking authentication
  if (checkingAuth) {
    return <LoadingState minHeight="100vh" size="lg" label={tCommon('loading')} />;
  }

  return (
    <AuthShell
      title={t('hero.title')}
      subtitle={t('hero.subtitle')}
      footer={
        <Group justify="center">
          <Text size="sm" c="dimmed">
            {t('footer.cta')}{' '}
            <Anchor href="/register" size="sm" fw={600}>
              {t('footer.link')}
            </Anchor>
          </Text>
        </Group>
      }
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="lg">
          <TextInput
            label={t('form.email.label')}
            placeholder={t('form.email.placeholder')}
            required
            size="md"
            autoComplete="email"
            {...form.getInputProps('email')}
          />

          <PasswordInput
            label={t('form.password.label')}
            placeholder={t('form.password.placeholder')}
            required
            size="md"
            autoComplete="current-password"
            {...form.getInputProps('password')}
          />

          <Anchor href="/forgot-password" size="sm" ta="right">
            Forgot password?
          </Anchor>

          <Button
            mt="xs"
            type="submit"
            size="lg"
            fullWidth
            loading={loading}
            leftSection={<IconLogin size={20} />}
            variant="gradient"
          >
            {t('form.submit')}
          </Button>
        </Stack>
      </form>
    </AuthShell>
  );
}
