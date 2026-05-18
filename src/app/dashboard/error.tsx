'use client';

import { Button, Center, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';

export default function DashboardError({ reset }: { reset: () => void }) {
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
        <Button leftSection={<IconRefresh size={16} />} variant="light" onClick={reset}>
          Retry
        </Button>
      </Stack>
    </Center>
  );
}
