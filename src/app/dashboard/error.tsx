'use client';

import { useEffect, useState } from 'react';
import { Button, Center, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconLifebuoy, IconRefresh } from '@tabler/icons-react';
import { isSupportAvailable, openSupport } from '@/lib/support/openSupport';

type DashboardErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  const [supportEnabled, setSupportEnabled] = useState(false);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    let active = true;
    void isSupportAvailable().then((enabled) => {
      if (active) setSupportEnabled(enabled);
    });
    return () => {
      active = false;
    };
  }, []);

  const reportToSupport = async () => {
    setReporting(true);
    try {
      await openSupport(document.documentElement.lang === 'en' ? 'en' : 'tr', {
        summary: error.message || 'Console dashboard error',
        category: 'dashboard_error',
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          digest: error.digest,
        },
      });
    } finally {
      setReporting(false);
    }
  };

  return (
    <Center mih={360} px="md">
      <Stack gap="sm" align="center" maw={420} ta="center">
        <ThemeIcon size={52} radius="xl" variant="light" color="red">
          <IconAlertTriangle size={24} stroke={1.7} />
        </ThemeIcon>
        <Stack gap={4}>
          <Text fw={600}>Dashboard could not be loaded</Text>
          <Text size="sm" c="dimmed">
            Retry the request. If it fails again, the route-level API response should be checked.
          </Text>
        </Stack>
        <Group gap="xs">
          <Button leftSection={<IconRefresh size={16} />} variant="light" onClick={reset}>
            Retry
          </Button>
          {supportEnabled ? (
            <Button
              leftSection={<IconLifebuoy size={16} />}
              variant="subtle"
              loading={reporting}
              onClick={() => void reportToSupport()}
            >
              Report to Support
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Center>
  );
}
