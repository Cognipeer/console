'use client';

import { useState, useEffect } from 'react';
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
  Center,
  Loader,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconLogin } from '@tabler/icons-react';
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
      } catch (error) {
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

      router.push('/dashboard');
    } catch (error) {
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
    return (
      <Center style={{ height: '100vh', width: '100vw' }}>
        <Loader size="lg" />
      </Center>
    );
  }

  return (
    <Container
      size={420}
      py={20}
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: '100vh',
      }}>
      <Stack gap="lg" w="100%">
        <div style={{ textAlign: 'center' }}>
          <Title order={2} mb="xs" c="var(--mantine-color-anchor)">
            {t('hero.title')}
          </Title>
          <Text c="dimmed" size="sm">
            {t('hero.subtitle')}
          </Text>
        </div>

        <Paper withBorder shadow="md" p={30} radius="md">
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack gap="md">
              <TextInput
                label={t('form.email.label')}
                placeholder={t('form.email.placeholder')}
                required
                {...form.getInputProps('email')}
              />

              <PasswordInput
                label={t('form.password.label')}
                placeholder={t('form.password.placeholder')}
                required
                {...form.getInputProps('password')}
              />

              <Button
                mt="sm"
                type="submit"
                size="md"
                fullWidth
                loading={loading}
                leftSection={<IconLogin size={18} />}>
                {t('form.submit')}
              </Button>
            </Stack>
          </form>
        </Paper>

        <Group justify="center">
          <Text size="sm" c="dimmed">
            {t('footer.cta')}{' '}
            <Anchor href="/register" size="sm">
              {t('footer.link')}
            </Anchor>
          </Text>
        </Group>
      </Stack>
    </Container>
  );
}
