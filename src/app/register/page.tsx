'use client';

import { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  TextInput,
  PasswordInput,
  Button,
  Text,
  Anchor,
  Stack,
  Group,
  Select,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconUserPlus } from '@tabler/icons-react';
import LoadingState from '@/components/common/LoadingState';
import AuthShell from '@/components/layout/AuthShell';
import { useTranslations } from '@/lib/i18n';

export default function RegisterPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const t = useTranslations('register');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const licenseOptions = useMemo(
    () => [
      { value: 'FREE', label: t('form.license.options.free') },
      { value: 'STARTER', label: t('form.license.options.starter') },
      { value: 'PROFESSIONAL', label: t('form.license.options.professional') },
      { value: 'ENTERPRISE', label: t('form.license.options.enterprise') },
    ],
    [t],
  );

  const form = useForm({
    initialValues: {
      name: '',
      email: '',
      companyName: '',
      password: '',
      confirmPassword: '',
      licenseType: 'FREE',
    },
    validate: {
      name: (value) =>
        value.length >= 2 ? null : tValidation('nameMinLength'),
      email: (value) =>
        /^\S+@\S+$/.test(value) ? null : tValidation('invalidEmail'),
      companyName: (value) =>
        value.length >= 2 ? null : tValidation('companyNameMinLength'),
      password: (value) =>
        value.length >= 8 ? null : tValidation('passwordMinLength'),
      confirmPassword: (value, values) =>
        value === values.password ? null : tValidation('passwordsDoNotMatch'),
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
        // Network error — still show the register form
      }

      setCheckingAuth(false);
    };

    checkAuth();
  }, [router]);

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          companyName: values.companyName,
          password: values.password,
          licenseType: values.licenseType,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        notifications.show({
          title: tNotifications('registrationFailedTitle'),
          message: data.error || tNotifications('registrationFailedMessage'),
          color: 'red',
        });
        return;
      }

      notifications.show({
        title: tCommon('success'),
        message: tNotifications('registrationSuccess'),
        color: 'green',
      });

      router.push('/dashboard');
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tNotifications('registrationGenericError'),
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
            <Anchor href="/login" size="sm" fw={600}>
              {t('footer.link')}
            </Anchor>
          </Text>
        </Group>
      }
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput
            label={t('form.name.label')}
            placeholder={t('form.name.placeholder')}
            required
            size="md"
            autoComplete="name"
            {...form.getInputProps('name')}
          />

          <TextInput
            label={t('form.email.label')}
            placeholder={t('form.email.placeholder')}
            required
            size="md"
            autoComplete="email"
            {...form.getInputProps('email')}
          />

          <TextInput
            label={t('form.companyName.label')}
            placeholder={t('form.companyName.placeholder')}
            required
            size="md"
            description={t('form.companyName.description')}
            autoComplete="organization"
            {...form.getInputProps('companyName')}
          />

          <PasswordInput
            label={t('form.password.label')}
            placeholder={t('form.password.placeholder')}
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('password')}
          />

          <PasswordInput
            label={t('form.confirmPassword.label')}
            placeholder={t('form.confirmPassword.placeholder')}
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('confirmPassword')}
          />

          <Select
            label={t('form.license.label')}
            placeholder={t('form.license.placeholder')}
            data={licenseOptions}
            size="md"
            {...form.getInputProps('licenseType')}
          />

          <Button
            mt="xs"
            type="submit"
            size="lg"
            fullWidth
            loading={loading}
            leftSection={<IconUserPlus size={20} />}
            variant="gradient"
          >
            {t('form.submit')}
          </Button>
        </Stack>
      </form>
    </AuthShell>
  );
}
