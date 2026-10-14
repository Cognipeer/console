'use client';

import { Suspense, useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Button,
  Center,
  Divider,
  Loader,
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
import { ssoErrorMessageKey, ssoErrorNeedsAdmin } from '@/lib/auth/ssoLoginErrors';
import { useTranslations } from '@/lib/i18n';
import { assignIfPortal, buildChangePasswordPath, buildLoginPath, safeReturnTo } from '@/lib/security/returnTo';

type SsoDiscovery =
  | { available: false }
  | { available: true; mode: 'direct'; startUrl: string }
  | { available: true; mode: 'email' };

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [sso, setSso] = useState<SsoDiscovery>({ available: false });
  const [ssoStep, setSsoStep] = useState(false);
  const [ssoEmail, setSsoEmail] = useState('');
  const t = useTranslations('login');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  // Where a successful sign-in lands (e.g. /p/<portal> for a shared portal
  // link). Re-validated on every use; anything not a same-origin path is
  // /dashboard.
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const afterLoginPath = (mustChangePassword?: boolean) =>
    mustChangePassword ? buildChangePasswordPath(returnTo) : returnTo;

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
          const dest = data.mustChangePassword ? buildChangePasswordPath(returnTo) : returnTo;
          if (!assignIfPortal(dest)) router.push(dest);
          return;
        }
      } catch {
        /* not signed in — the finally shows the form */
      } finally {
        setCheckingAuth(false);
      }
    };
    void checkAuth();
  }, [router, returnTo]);

  useEffect(() => {
    const discover = async () => {
      try {
        const response = await fetch('/api/auth/sso/discover', {
          method: 'GET',
          cache: 'no-store',
        });
        if (!response.ok) return;
        const data = (await response.json()) as SsoDiscovery;
        setSso(data);
      } catch {
        // The button is always shown; a failed discovery check just means it
        // falls back to the email step instead of a direct single-tenant redirect.
      }
    };
    void discover();
  }, []);

  useEffect(() => {
    const errorCode = searchParams.get('ssoError');
    if (!errorCode) return;
    notifications.show({
      title: tNotifications('loginFailedTitle'),
      message: t(`sso.errors.${ssoErrorMessageKey(errorCode)}`),
      color: 'red',
      ...(ssoErrorNeedsAdmin(errorCode) ? { autoClose: false } : {}),
    });
    // Keep the return trip: the person still has to sign in another way.
    router.replace(buildLoginPath(searchParams.get('returnTo')));
  }, [searchParams, router, t, tNotifications]);

  const handleSsoButtonClick = () => {
    if (sso.available && sso.mode === 'direct') {
      const joiner = sso.startUrl.includes('?') ? '&' : '?';
      window.location.href = `${sso.startUrl}${joiner}returnTo=${encodeURIComponent(returnTo)}`;
      return;
    }
    setSsoStep(true);
  };

  const handleSsoEmailSubmit = () => {
    const email = ssoEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tValidation('invalidEmail'),
        color: 'red',
      });
      return;
    }
    window.location.href = `/api/auth/sso/start?email=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(returnTo)}`;
  };

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
      const dest = afterLoginPath(data.mustChangePassword);
      if (!assignIfPortal(dest)) router.push(dest);
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
      titleAccent={t('hero.titleAccent')}
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
      {ssoStep ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <TextInput
            label={t('sso.emailStep.title')}
            description={t('sso.emailStep.description')}
            placeholder={t('sso.emailStep.placeholder')}
            required
            size="md"
            autoComplete="email"
            value={ssoEmail}
            onChange={(event) => setSsoEmail(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSsoEmailSubmit();
              }
            }}
          />

          <Button
            color="teal"
            size="md"
            fullWidth
            leftSection={<IconShieldLock size={16} stroke={1.7} />}
            onClick={handleSsoEmailSubmit}
          >
            {t('sso.emailStep.continue')}
          </Button>

          <Button variant="subtle" color="gray" size="sm" onClick={() => setSsoStep(false)}>
            {t('sso.emailStep.back')}
          </Button>
        </div>
      ) : (
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

            <Divider label={t('sso.divider')} labelPosition="center" my={2} />
            <Button
              variant="default"
              size="md"
              fullWidth
              leftSection={<IconShieldLock size={16} stroke={1.7} />}
              onClick={handleSsoButtonClick}
            >
              {t('sso.button')}
            </Button>
          </div>
        </form>
      )}
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <Center mih="100vh">
          <Loader />
        </Center>
      }
    >
      <LoginPageContent />
    </Suspense>
  );
}
