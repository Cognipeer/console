'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Center, Paper, Stack, Text, Title } from '@mantine/core';

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
    <Center mih="100vh" p="md">
      <Paper shadow="sm" radius="md" withBorder p="xl" maw={520} w="100%">
        <Stack gap="sm">
          <Title order={2}>No project assigned</Title>
          <Text c="dimmed">
            Your account is not assigned to any project yet. Please contact a tenant admin to be assigned to a project.
          </Text>
          <Button onClick={handleCheckAccess} loading={checkingAccess}>
            Refresh access
          </Button>
          <Button variant="default" onClick={handleLogout}>
            Log out
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
