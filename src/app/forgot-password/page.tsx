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
import { useTranslations } from '@/lib/i18n';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const t = useTranslations('forgotPassword');
  const tCommon = useTranslations('common');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const form = useForm({
    initialValues: {
      email: '',
      slug: '',
    },
    validate: {
      email: (value) =>
        /^\S+@\S+$/.test(value) ? null : t('validation.invalidEmail'),
      slug: (value) =>
        value.trim().length > 0 ? null : t('validation.slugRequired'),
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
          title: t('notifications.tooManyTitle'),
          message: t('notifications.tooManyMessage'),
          color: 'orange',
        });
        return;
      }

      // Always show success to prevent email enumeration
      setSubmitted(true);
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

  if (submitted) {
    return (
      <AuthShell
        title={t('success.title')}
        titleAccent={t('success.titleAccent')}
        subtitle={t('success.subtitle')}
        highlights={[
          {
            icon: <IconMail size={13} stroke={1.7} />,
            label: t('highlights.emailLink'),
          },
          {
            icon: <IconClock size={13} stroke={1.7} />,
            label: t('highlights.validity'),
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
          <p style={{ fontSize: 13, color: 'var(--ds-text-muted)', margin: 0 }}>
            {t('success.note')}
          </p>
          <Button
            className="auth-cta-primary"
            color="teal"
            size="md"
            fullWidth
            leftSection={<IconCheck size={16} stroke={1.7} />}
            onClick={() => router.push('/login')}
          >
            {t('success.backToLogin')}
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('hero.title')}
      titleAccent={t('hero.titleAccent')}
      subtitle={t('hero.subtitle')}
      highlights={[
        {
          icon: <IconMail size={13} stroke={1.7} />,
          label: t('highlights.emailLink'),
        },
        {
          icon: <IconClock size={13} stroke={1.7} />,
          label: t('highlights.validity'),
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
          <TextInput
            label={t('form.slug.label')}
            placeholder={t('form.slug.placeholder')}
            required
            size="md"
            {...form.getInputProps('slug')}
          />
          <TextInput
            label={t('form.email.label')}
            placeholder={t('form.email.placeholder')}
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
            {t('form.submit')}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
