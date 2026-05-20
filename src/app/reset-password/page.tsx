'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PasswordInput, Button, Center, Loader } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconLock,
  IconCheck,
  IconAlertTriangle,
  IconShieldLock,
  IconKey,
} from '@tabler/icons-react';
import AuthShell from '@/components/layout/AuthShell';

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
      <AuthShell
        title="Invalid reset link"
        subtitle="This password reset link is invalid or has expired. Please request a new one."
        highlights={[
          {
            icon: <IconAlertTriangle size={13} stroke={1.7} />,
            label: 'Reset links expire after 1 hour.',
          },
          {
            icon: <IconKey size={13} stroke={1.7} />,
            label: 'Request a fresh link to continue.',
          },
        ]}
        footer={
          <>
            Remember your password?{' '}
            <Link
              href="/login"
              style={{
                color: 'var(--ds-accent)',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Back to login
            </Link>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Button
            color="teal"
            size="md"
            fullWidth
            leftSection={<IconKey size={16} stroke={1.7} />}
            onClick={() => router.push('/forgot-password')}
          >
            Request new link
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (success) {
    return (
      <AuthShell
        title="Password reset successful"
        subtitle="Your password has been updated. You can now log in with your new password."
        highlights={[
          {
            icon: <IconCheck size={13} stroke={1.7} />,
            label: 'Your password is updated.',
          },
          {
            icon: <IconShieldLock size={13} stroke={1.7} />,
            label: 'Use it to sign in next time.',
          },
        ]}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Button
            color="teal"
            size="md"
            fullWidth
            leftSection={<IconCheck size={16} stroke={1.7} />}
            onClick={() => router.push('/login')}
          >
            Go to login
          </Button>
        </div>
      </AuthShell>
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
    <AuthShell
      title="Set new password"
      subtitle="Choose a strong password for your account."
      highlights={[
        {
          icon: <IconShieldLock size={13} stroke={1.7} />,
          label: 'Strong passwords protect your tenant.',
        },
        {
          icon: <IconKey size={13} stroke={1.7} />,
          label: 'Min 8 chars, mixed case + number.',
        },
      ]}
      footer={
        <>
          Remember your password?{' '}
          <Link
            href="/login"
            style={{
              color: 'var(--ds-accent)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Back to login
          </Link>
        </>
      }
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <PasswordInput
            label="New Password"
            placeholder="Enter new password"
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('newPassword')}
          />
          <PasswordInput
            label="Confirm Password"
            placeholder="Confirm new password"
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('confirmPassword')}
          />

          <div
            style={{
              fontSize: 12.5,
              color: 'var(--ds-text-muted)',
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Password requirements:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>At least 8 characters</li>
              <li>Uppercase and lowercase letters</li>
              <li>At least one digit</li>
              <li>At least one special character</li>
            </ul>
          </div>

          <Button
            type="submit"
            color="teal"
            size="md"
            fullWidth
            loading={loading}
            leftSection={<IconLock size={16} stroke={1.7} />}
            mt={4}
          >
            Reset password
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <Center mih="100vh">
          <Loader />
        </Center>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}
