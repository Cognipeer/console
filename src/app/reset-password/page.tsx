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
import { useTranslations } from '@/lib/i18n';

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const t = useTranslations('resetPassword');
  const tCommon = useTranslations('common');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const form = useForm({
    initialValues: {
      newPassword: '',
      confirmPassword: '',
    },
    validate: {
      newPassword: (value) => {
        if (value.length < 8) return t('validation.minLength');
        if (!/[A-Z]/.test(value)) return t('validation.uppercase');
        if (!/[a-z]/.test(value)) return t('validation.lowercase');
        if (!/\d/.test(value)) return t('validation.digit');
        if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(value))
          return t('validation.special');
        return null;
      },
      confirmPassword: (value, values) =>
        value !== values.newPassword ? t('validation.mismatch') : null,
    },
  });

  if (!token) {
    return (
      <AuthShell
        title={t('invalid.title')}
        subtitle={t('invalid.subtitle')}
        highlights={[
          {
            icon: <IconAlertTriangle size={13} stroke={1.7} />,
            label: t('invalid.expiry'),
          },
          {
            icon: <IconKey size={13} stroke={1.7} />,
            label: t('invalid.fresh'),
          },
        ]}
        footer={
          <>
            {t('footer.cta')}{' '}
            <Link
              href="/login"
              style={{
                color: 'var(--ds-accent)',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              {t('footer.link')}
            </Link>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Button
            className="auth-cta-primary"
            color="teal"
            size="md"
            fullWidth
            leftSection={<IconKey size={16} stroke={1.7} />}
            onClick={() => router.push('/forgot-password')}
          >
            {t('invalid.submit')}
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (success) {
    return (
      <AuthShell
        title={t('success.title')}
        subtitle={t('success.subtitle')}
        highlights={[
          {
            icon: <IconCheck size={13} stroke={1.7} />,
            label: t('success.updated'),
          },
          {
            icon: <IconShieldLock size={13} stroke={1.7} />,
            label: t('success.signIn'),
          },
        ]}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Button
            className="auth-cta-primary"
            color="teal"
            size="md"
            fullWidth
            leftSection={<IconCheck size={16} stroke={1.7} />}
            onClick={() => router.push('/login')}
          >
            {t('success.submit')}
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
          title: tCommon('error'),
          message: data.error || t('notifications.resetFailed'),
          color: 'red',
        });
        return;
      }

      setSuccess(true);
    } catch {
      notifications.show({
        title: tCommon('error'),
        message: t('notifications.genericError'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title={t('hero.title')}
      titleAccent={t('hero.titleAccent')}
      subtitle={t('hero.subtitle')}
      highlights={[
        {
          icon: <IconShieldLock size={13} stroke={1.7} />,
          label: t('highlights.strong'),
        },
        {
          icon: <IconKey size={13} stroke={1.7} />,
          label: t('highlights.requirements'),
        },
      ]}
      footer={
        <>
          {t('footer.cta')}{' '}
          <Link
            href="/login"
            style={{
              color: 'var(--ds-accent)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {t('footer.link')}
          </Link>
        </>
      }
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <PasswordInput
            label={t('form.newPassword.label')}
            placeholder={t('form.newPassword.placeholder')}
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('newPassword')}
          />
          <PasswordInput
            label={t('form.confirmPassword.label')}
            placeholder={t('form.confirmPassword.placeholder')}
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
              {t('requirements.title')}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>{t('requirements.length')}</li>
              <li>{t('requirements.case')}</li>
              <li>{t('requirements.digit')}</li>
              <li>{t('requirements.special')}</li>
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
            {t('form.submit')}
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
