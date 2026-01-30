'use client';

import { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  TextInput,
  PasswordInput,
  Button,
  Paper,
  Title,
  Text,
  Container,
  Anchor,
  Stack,
  Group,
  Select,
  Center,
  Loader,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconUserPlus } from '@tabler/icons-react';
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
        // Try to access a protected endpoint to check if user is authenticated
        const response = await fetch('/api/tokens', {
          method: 'GET',
          credentials: 'include', // Include cookies
        });

        if (response.ok) {
          // User is authenticated, redirect to dashboard
          router.push('/dashboard');
          return;
        }
      } catch {
        router.push('/login');
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
    return (
      <Center style={{ height: '100vh', width: '100vw', background: 'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-blue-0) 100%)' }}>
        <Loader size="lg" color="teal" />
      </Center>
    );
  }

  return (
    <Container
      size={480}
      py={40}
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: '100vh',
      }}>
      <Stack gap="xl" w="100%">
        <div style={{ textAlign: 'center' }}>
          <Title order={1} mb="sm" fw={700} style={{ fontSize: '2rem' }}>
            {t('hero.title')}
          </Title>
          <Text c="dimmed" size="md">
            {t('hero.subtitle')}
          </Text>
        </div>

        <Paper withBorder shadow="lg" p={36} radius="lg" style={{ background: 'white' }}>
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack gap="md">
              <TextInput
                label={t('form.name.label')}
                placeholder={t('form.name.placeholder')}
                required
                size="md"
                {...form.getInputProps('name')}
              />

              <TextInput
                label={t('form.email.label')}
                placeholder={t('form.email.placeholder')}
                required
                size="md"
                {...form.getInputProps('email')}
              />

              <TextInput
                label={t('form.companyName.label')}
                placeholder={t('form.companyName.placeholder')}
                required
                size="md"
                description={t('form.companyName.description')}
                {...form.getInputProps('companyName')}
              />

              <PasswordInput
                label={t('form.password.label')}
                placeholder={t('form.password.placeholder')}
                required
                size="md"
                {...form.getInputProps('password')}
              />

              <PasswordInput
                label={t('form.confirmPassword.label')}
                placeholder={t('form.confirmPassword.placeholder')}
                required
                size="md"
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
                mt="md"
                type="submit"
                size="lg"
                fullWidth
                loading={loading}
                leftSection={<IconUserPlus size={20} />}
                variant="gradient"
                gradient={{ from: 'teal', to: 'cyan', deg: 90 }}>
                {t('form.submit')}
              </Button>
            </Stack>
          </form>
        </Paper>

        <Group justify="center">
          <Text size="sm" c="dimmed">
            {t('footer.cta')}{' '}
            <Anchor href="/login" size="sm" fw={600}>
              {t('footer.link')}
            </Anchor>
          </Text>
        </Group>
      </Stack>
    </Container>
  );
}
