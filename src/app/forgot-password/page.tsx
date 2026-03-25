'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  TextInput,
  Button,
  Paper,
  Title,
  Text,
  Container,
  Anchor,
  Stack,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconMailForward, IconCheck } from '@tabler/icons-react';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const form = useForm({
    initialValues: {
      email: '',
      slug: '',
    },
    validate: {
      email: (value) =>
        /^\S+@\S+$/.test(value) ? null : 'Invalid email address',
      slug: (value) =>
        value.trim().length > 0 ? null : 'Organization slug is required',
    },
  });

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });

      if (res.status === 429) {
        notifications.show({
          title: 'Too many requests',
          message: 'Please wait before requesting another reset link.',
          color: 'orange',
        });
        return;
      }

      // Always show success to prevent email enumeration
      setSubmitted(true);
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

  if (submitted) {
    return (
      <Container size={420} my={80}>
        <Paper withBorder shadow="md" p={30} radius="md">
          <Stack align="center" gap="md">
            <IconCheck size={48} color="var(--mantine-color-green-6)" />
            <Title order={3} ta="center">
              Check your email
            </Title>
            <Text c="dimmed" size="sm" ta="center">
              If an account exists with that email address, we&apos;ve sent a
              password reset link. It will expire in 1 hour.
            </Text>
            <Button
              variant="light"
              fullWidth
              mt="md"
              onClick={() => router.push('/login')}
            >
              Back to login
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  return (
    <Container size={420} my={80}>
      <Title ta="center" order={2}>
        Reset your password
      </Title>
      <Text c="dimmed" size="sm" ta="center" mt={5} mb={20}>
        Enter your email and organization slug to receive a reset link
      </Text>

      <Paper withBorder shadow="md" p={30} radius="md">
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack>
            <TextInput
              label="Organization Slug"
              placeholder="my-company"
              required
              {...form.getInputProps('slug')}
            />
            <TextInput
              label="Email"
              placeholder="you@example.com"
              required
              {...form.getInputProps('email')}
            />
            <Button
              type="submit"
              fullWidth
              loading={loading}
              leftSection={<IconMailForward size={16} />}
            >
              Send reset link
            </Button>
          </Stack>
        </form>

        <Text ta="center" mt="md" size="sm">
          Remember your password?{' '}
          <Anchor component="button" onClick={() => router.push('/login')}>
            Back to login
          </Anchor>
        </Text>
      </Paper>
    </Container>
  );
}
