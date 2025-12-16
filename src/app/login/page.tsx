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

      router.push(data.mustChangePassword ? '/change-password' : '/dashboard');
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
      <Center style={{ height: '100vh', width: '100vw', background: 'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-blue-0) 100%)' }}>
        <Loader size="lg" color="teal" />
      </Center>
    );
  }

  return (
    <Container
      size={440}
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
            <Stack gap="lg">
              <TextInput
                label={t('form.email.label')}
                placeholder={t('form.email.placeholder')}
                required
                size="md"
                {...form.getInputProps('email')}
              />

              <PasswordInput
                label={t('form.password.label')}
                placeholder={t('form.password.placeholder')}
                required
                size="md"
                {...form.getInputProps('password')}
              />

              <Button
                mt="sm"
                type="submit"
                size="lg"
                fullWidth
                loading={loading}
                leftSection={<IconLogin size={20} />}
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
            <Anchor href="/register" size="sm" fw={600}>
              {t('footer.link')}
            </Anchor>
          </Text>
        </Group>
      </Stack>
    </Container>
  );
}
