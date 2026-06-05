'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@mantine/core';
import {
  IconAlertTriangle,
  IconRefresh,
  IconLogout,
  IconUserOff,
} from '@tabler/icons-react';
import AuthShell from '@/components/layout/AuthShell';

export default function NoProjectPage() {
  const router = useRouter();
  const [checkingAccess, setCheckingAccess] = useState(false);

  const handleCheckAccess = async () => {
    if (checkingAccess) return;
    setCheckingAccess(true);
    try {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      if (!res.ok) {
        router.replace('/login');
        return;
      }

      const session = (await res.json()) as { projectCount?: number; mustChangePassword?: boolean };

      if (session.mustChangePassword) {
        router.replace('/change-password');
        return;
      }

      if ((session.projectCount ?? 0) > 0) {
        router.replace('/dashboard');
        return;
      }
    } finally {
      setCheckingAccess(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
    }
  };

  return (
    <AuthShell
      title="No project assigned"
      subtitle="Your account isn't assigned to any project yet."
      highlights={[
        {
          icon: <IconUserOff size={13} stroke={1.7} />,
          label: 'Ask a tenant admin to assign you to a project.',
        },
        {
          icon: <IconAlertTriangle size={13} stroke={1.7} />,
          label: 'You won’t see workspace content until then.',
        },
      ]}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p
          style={{
            fontSize: 13,
            color: 'var(--ds-text-muted)',
            margin: 0,
            lineHeight: 1.55,
          }}
        >
          Once an admin grants you project access, click refresh to continue to
          your dashboard. Otherwise you can sign out and return later.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Button
            color="teal"
            size="md"
            fullWidth
            loading={checkingAccess}
            leftSection={<IconRefresh size={16} stroke={1.7} />}
            onClick={handleCheckAccess}
          >
            Refresh access
          </Button>
          <Button
            variant="default"
            size="md"
            fullWidth
            leftSection={<IconLogout size={16} stroke={1.7} />}
            onClick={handleLogout}
          >
            Log out
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}
