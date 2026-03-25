'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  PasswordInput,
  Button,
  Paper,
  Title,
  Text,
  Container,
  Stack,
  Anchor,
  List,
  Center,
  Loader,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconLock, IconCheck, IconAlertTriangle } from '@tabler/icons-react';

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const form = useForm({
    initialValues: {
      newPassword: '',
      confirmPassword: '',
    },
    validate: {
      newPassword: (value) => {
        if (value.length < 8) return 'Password must be at least 8 characters';
        if (!/[A-Z]/.test(value)) return 'Must contain an uppercase letter';
        if (!/[a-z]/.test(value)) return 'Must contain a lowercase letter';
        if (!/\d/.test(value)) return 'Must contain a digit';
        if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(value))
          return 'Must contain a special character';
        return null;
      },
      confirmPassword: (value, values) =>
        value !== values.newPassword ? 'Passwords do not match' : null,
    },
  });

  if (!token) {
    return (
      <Container size={420} my={80}>
        <Paper withBorder shadow="md" p={30} radius="md">
          <Stack align="center" gap="md">
            <IconAlertTriangle size={48} color="var(--mantine-color-orange-6)" />
            <Title order={3} ta="center">
              Invalid reset link
            </Title>
            <Text c="dimmed" size="sm" ta="center">
              This password reset link is invalid or has expired. Please request
              a new one.
            </Text>
            <Button
              variant="light"
              fullWidth
              onClick={() => router.push('/forgot-password')}
            >
              Request new link
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  if (success) {
    return (
      <Container size={420} my={80}>
        <Paper withBorder shadow="md" p={30} radius="md">
          <Stack align="center" gap="md">
            <IconCheck size={48} color="var(--mantine-color-green-6)" />
            <Title order={3} ta="center">
              Password reset successful
            </Title>
            <Text c="dimmed" size="sm" ta="center">
              Your password has been updated. You can now log in with your new
              password.
            </Text>
            <Button fullWidth onClick={() => router.push('/login')}>
              Go to login
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: values.newPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        notifications.show({
          title: 'Error',
          message: data.error || 'Failed to reset password',
          color: 'red',
        });
        return;
      }

      setSuccess(true);
    } catch {
      notifications.show({
        title: 'Error',
        message: 'Something went wrong. Please try again.',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container size={420} my={80}>
      <Title ta="center" order={2}>
        Set new password
      </Title>
      <Text c="dimmed" size="sm" ta="center" mt={5} mb={20}>
        Choose a strong password for your account
      </Text>

      <Paper withBorder shadow="md" p={30} radius="md">
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack>
            <PasswordInput
              label="New Password"
              placeholder="Enter new password"
              required
              {...form.getInputProps('newPassword')}
            />
            <PasswordInput
              label="Confirm Password"
              placeholder="Confirm new password"
              required
              {...form.getInputProps('confirmPassword')}
            />

            <Text size="xs" c="dimmed">
              Password requirements:
            </Text>
            <List size="xs" c="dimmed" spacing={2}>
              <List.Item>At least 8 characters</List.Item>
              <List.Item>Uppercase and lowercase letters</List.Item>
              <List.Item>At least one digit</List.Item>
              <List.Item>At least one special character</List.Item>
            </List>

            <Button
              type="submit"
              fullWidth
              loading={loading}
              leftSection={<IconLock size={16} />}
            >
              Reset password
            </Button>
          </Stack>
        </form>

        <Text ta="center" mt="md" size="sm">
          <Anchor component="button" onClick={() => router.push('/login')}>
            Back to login
          </Anchor>
        </Text>
      </Paper>
    </Container>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <Container size={420} my={80}>
          <Center>
            <Loader />
          </Center>
        </Container>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}
