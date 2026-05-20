'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button,
  PasswordInput,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconBolt,
  IconLogin,
  IconShieldLock,
  IconUsers,
} from '@tabler/icons-react';
import LoadingState from '@/components/common/LoadingState';
import AuthShell from '@/components/layout/AuthShell';
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
    initialValues: { email: '', password: '' },
    validate: {
      email: (value) =>
        /^\S+@\S+$/.test(value) ? null : tValidation('invalidEmail'),
      password: (value) =>
        value.length >= 8 ? null : tValidation('passwordMinLength'),
    },
  });

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
      } catch {
        setCheckingAuth(false);
      } finally {
        setCheckingAuth(false);
      }
    };
    void checkAuth();
  }, [router]);

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        color: 'teal',
      });
      router.push(data.mustChangePassword ? '/change-password' : '/dashboard');
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tNotifications('loginGenericError'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  if (checkingAuth) {
    return <LoadingState minHeight="100vh" size="lg" label={tCommon('loading')} />;
  }

  return (
    <AuthShell
      title={t('hero.title')}
      subtitle={t('hero.subtitle')}
      highlights={[
        {
          icon: <IconBolt size={13} stroke={1.7} />,
          label: 'Inference, agents, tracing — one console.',
        },
        {
          icon: <IconShieldLock size={13} stroke={1.7} />,
          label: 'Guardrails, PII redaction, audit logs out of the box.',
        },
        {
          icon: <IconUsers size={13} stroke={1.7} />,
          label: 'Multi-tenant, project-scoped permissions.',
        },
      ]}
      footer={
        <>
          {t('footer.cta')}{' '}
          <Link
            href="/register"
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
          <TextInput
            label={t('form.email.label')}
            placeholder={t('form.email.placeholder')}
            required
            size="md"
            autoComplete="email"
            {...form.getInputProps('email')}
          />

          <PasswordInput
            label={t('form.password.label')}
            placeholder={t('form.password.placeholder')}
            required
            size="md"
            autoComplete="current-password"
            {...form.getInputProps('password')}
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Link
              href="/forgot-password"
              style={{
                fontSize: 12.5,
                color: 'var(--ds-text-muted)',
                textDecoration: 'none',
              }}
            >
              Forgot password?
            </Link>
          </div>

          <Button
            type="submit"
            color="teal"
            size="md"
            fullWidth
            loading={loading}
            leftSection={<IconLogin size={16} stroke={1.7} />}
            mt={4}
          >
            {t('form.submit')}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
