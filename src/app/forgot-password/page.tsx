'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TextInput, Button } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconMailForward,
  IconCheck,
  IconMail,
  IconClock,
} from '@tabler/icons-react';
import AuthShell from '@/components/layout/AuthShell';

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
      <AuthShell
        title="Check your email"
        subtitle="If an account exists with that email address, we've sent a password reset link. It will expire in 1 hour."
        highlights={[
          {
            icon: <IconMail size={13} stroke={1.7} />,
            label: "We'll email you a reset link.",
          },
          {
            icon: <IconClock size={13} stroke={1.7} />,
            label: 'Link is valid for 1 hour.',
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
          <p style={{ fontSize: 13, color: 'var(--ds-text-muted)', margin: 0 }}>
            Didn&apos;t get an email? Check your spam folder, or try again with
            the correct organization slug.
          </p>
          <Button
            color="teal"
            size="md"
            fullWidth
            leftSection={<IconCheck size={16} stroke={1.7} />}
            onClick={() => router.push('/login')}
          >
            Back to login
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and organization slug to receive a reset link."
      highlights={[
        {
          icon: <IconMail size={13} stroke={1.7} />,
          label: "We'll email you a reset link.",
        },
        {
          icon: <IconClock size={13} stroke={1.7} />,
          label: 'Link is valid for 1 hour.',
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
          <TextInput
            label="Organization Slug"
            placeholder="my-company"
            required
            size="md"
            {...form.getInputProps('slug')}
          />
          <TextInput
            label="Email"
            placeholder="you@example.com"
            required
            size="md"
            autoComplete="email"
            {...form.getInputProps('email')}
          />
          <Button
            type="submit"
            color="teal"
            size="md"
            fullWidth
            loading={loading}
            leftSection={<IconMailForward size={16} stroke={1.7} />}
            mt={4}
          >
            Send reset link
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
