'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, PasswordInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconKey, IconShieldLock, IconCheck } from '@tabler/icons-react';
import AuthShell from '@/components/layout/AuthShell';

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
    <AuthShell
      title="Change your password"
      subtitle="You signed in with a temporary password. Please set a new password to continue."
      highlights={[
        {
          icon: <IconShieldLock size={13} stroke={1.7} />,
          label: 'Required for new accounts.',
        },
        {
          icon: <IconKey size={13} stroke={1.7} />,
          label: "Choose a password you don't use elsewhere.",
        },
      ]}
    >
      <form onSubmit={form.onSubmit(submit)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <PasswordInput
            label="Current password"
            required
            size="md"
            autoComplete="current-password"
            {...form.getInputProps('currentPassword')}
          />
          <PasswordInput
            label="New password"
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('newPassword')}
          />
          <PasswordInput
            label="Confirm new password"
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
            Update password
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
