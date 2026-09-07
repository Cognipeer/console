'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Center, Loader } from '@mantine/core';
import LoadingState from '@/components/common/LoadingState';
import AuthShell from '@/components/layout/AuthShell';
import { useTranslations } from '@/lib/i18n';

function SsoCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ticket = searchParams.get('ticket');
  const tCommon = useTranslations('common');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticket) {
      setError('Missing sign-in ticket.');
      return;
    }

    const exchange = async () => {
      try {
        const response = await fetch('/api/auth/sso/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket }),
        });
        const data = await response.json();
        if (!response.ok) {
          setError(data.error || 'Single sign-on failed. Please try again.');
          return;
        }
        router.push(data.mustChangePassword ? '/change-password' : '/dashboard');
      } catch {
        setError('Single sign-on failed. Please try again.');
      }
    };

    void exchange();
  }, [ticket, router]);

  if (error) {
    return (
      <AuthShell title="Sign-in failed" subtitle="Something went wrong completing single sign-on.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center' }}>
          <p style={{ color: 'var(--ds-text-muted)' }}>{error}</p>
          <Link
            href="/login"
            style={{ color: 'var(--ds-accent)', fontWeight: 600, textDecoration: 'none' }}
          >
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return <LoadingState minHeight="100vh" size="lg" label={tCommon('loading')} />;
}

export default function SsoCallbackPage() {
  return (
    <Suspense
      fallback={
        <Center mih="100vh">
          <Loader />
        </Center>
      }
    >
      <SsoCallbackContent />
    </Suspense>
  );
}
