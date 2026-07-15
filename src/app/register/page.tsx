'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  TextInput,
  PasswordInput,
  Button,
  Alert,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconUserPlus, IconBolt, IconCheck, IconLock } from '@tabler/icons-react';
import LoadingState from '@/components/common/LoadingState';
import AuthShell from '@/components/layout/AuthShell';
import { useTranslations } from '@/lib/i18n';

type RegistrationMode = 'open' | 'beta' | 'disabled';

export default function RegisterPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>('open');
  const t = useTranslations('register');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const form = useForm({
    initialValues: {
      name: '',
      email: '',
      companyName: '',
      password: '',
      confirmPassword: '',
      accessCode: '',
    },
    validate: {
      name: (value) =>
        value.length >= 2 ? null : tValidation('nameMinLength'),
      email: (value) =>
        /^\S+@\S+$/.test(value) ? null : tValidation('invalidEmail'),
      companyName: (value) =>
        value.length >= 2 ? null : tValidation('companyNameMinLength'),
      password: (value) =>
        value.length >= 8 ? null : tValidation('passwordMinLength'),
      confirmPassword: (value, values) =>
        value === values.password ? null : tValidation('passwordsDoNotMatch'),
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
      } catch {
        // Network error — still show the register form
      }

      setCheckingAuth(false);
    };

    const checkRegistrationMode = async () => {
      try {
        const response = await fetch('/api/auth/register/options', {
          cache: 'no-store',
        });
        if (response.ok) {
          const data = (await response.json()) as { mode?: RegistrationMode };
          if (data.mode === 'beta' || data.mode === 'disabled') {
            setRegistrationMode(data.mode);
          }
        }
      } catch {
        // Network error — fall back to the open-registration form
      }
    };

    checkAuth();
    checkRegistrationMode();
  }, [router]);

  const handleSubmit = async (values: typeof form.values) => {
    if (registrationMode === 'beta' && !values.accessCode.trim()) {
      form.setFieldError('accessCode', tValidation('accessCodeRequired'));
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          companyName: values.companyName,
          password: values.password,
          ...(registrationMode === 'beta'
            ? { accessCode: values.accessCode.trim() }
            : {}),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        notifications.show({
          title: tNotifications('registrationFailedTitle'),
          message: data.error || tNotifications('registrationFailedMessage'),
          color: 'red',
        });
        return;
      }

      notifications.show({
        title: tCommon('success'),
        message: tNotifications('registrationSuccess'),
        color: 'green',
      });

      router.push('/dashboard');
    } catch {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tNotifications('registrationGenericError'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  // Show loading state while checking authentication
  if (checkingAuth) {
    return <LoadingState minHeight="100vh" size="lg" label={tCommon('loading')} />;
  }

  return (
    <AuthShell
      title={t('hero.title')}
      subtitle={t('hero.subtitle')}
      highlights={[
        {
          icon: <IconCheck size={13} stroke={1.7} />,
          label: 'Free for personal projects.',
        },
        {
          icon: <IconBolt size={13} stroke={1.7} />,
          label: 'Onboard in under a minute.',
        },
        {
          icon: <IconUserPlus size={13} stroke={1.7} />,
          label: 'Production-ready out of the box.',
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
      {registrationMode === 'disabled' ? (
        <Alert
          color="gray"
          icon={<IconLock size={16} stroke={1.7} />}
          title={t('disabled.title')}
        >
          {t('disabled.message')}
        </Alert>
      ) : (
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {registrationMode === 'beta' && (
            <TextInput
              label={t('form.accessCode.label')}
              placeholder={t('form.accessCode.placeholder')}
              description={t('form.accessCode.description')}
              required
              size="md"
              autoComplete="off"
              {...form.getInputProps('accessCode')}
            />
          )}

          <TextInput
            label={t('form.name.label')}
            placeholder={t('form.name.placeholder')}
            required
            size="md"
            autoComplete="name"
            {...form.getInputProps('name')}
          />

          <TextInput
            label={t('form.email.label')}
            placeholder={t('form.email.placeholder')}
            required
            size="md"
            autoComplete="email"
            {...form.getInputProps('email')}
          />

          <TextInput
            label={t('form.companyName.label')}
            placeholder={t('form.companyName.placeholder')}
            required
            size="md"
            description={t('form.companyName.description')}
            autoComplete="organization"
            {...form.getInputProps('companyName')}
          />

          <PasswordInput
            label={t('form.password.label')}
            placeholder={t('form.password.placeholder')}
            required
            size="md"
            autoComplete="new-password"
            {...form.getInputProps('password')}
          />

          <PasswordInput
            label={t('form.confirmPassword.label')}
            placeholder={t('form.confirmPassword.placeholder')}
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
            leftSection={<IconUserPlus size={16} stroke={1.7} />}
            mt={4}
          >
            {t('form.submit')}
          </Button>
        </div>
      </form>
      )}
    </AuthShell>
  );
}
