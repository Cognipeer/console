'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Center,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
    validate: {
      currentPassword: (v) => (v ? null : 'Current password is required'),
      newPassword: (v) => (v.length >= 8 ? null : 'Password must be at least 8 characters'),
      confirmPassword: (v, values) =>
        v === values.newPassword ? null : 'Passwords do not match',
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
        throw new Error(body?.error || 'Failed to change password');
      }

      notifications.show({
        title: 'Password',
        message: 'Password updated',
        color: 'green',
      });

      router.replace('/dashboard');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to change password';
      notifications.show({ title: 'Password', message, color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Center mih="100vh" p="md">
      <Paper shadow="sm" radius="md" withBorder p="xl" maw={520} w="100%">
        <Stack gap="sm">
          <Title order={2}>Change your password</Title>
          <Text c="dimmed">
            You signed in with a temporary password. Please set a new password to continue.
          </Text>

          <form onSubmit={form.onSubmit(submit)}>
            <Stack gap="sm">
              <PasswordInput
                label="Current password"
                required
                {...form.getInputProps('currentPassword')}
              />
              <PasswordInput
                label="New password"
                required
                {...form.getInputProps('newPassword')}
              />
              <PasswordInput
                label="Confirm new password"
                required
                {...form.getInputProps('confirmPassword')}
              />
              <Button type="submit" loading={loading}>
                Update password
              </Button>
            </Stack>
          </form>
        </Stack>
      </Paper>
    </Center>
  );
}
