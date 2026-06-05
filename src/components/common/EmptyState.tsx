'use client';

import { Center, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  minHeight?: number | string;
}

export default function EmptyState({
  title,
  description,
  icon,
  action,
  minHeight = 200,
}: EmptyStateProps) {
  return (
    <Center mih={minHeight} px="md">
      <Stack gap="sm" align="center" maw={420} ta="center">
        <ThemeIcon size={52} radius="xl" variant="light" color="gray">
          {icon ?? <IconInbox size={24} stroke={1.6} />}
        </ThemeIcon>
        <Stack gap={4} align="center">
          <Text fw={600} size="md">
            {title}
          </Text>
          {description ? (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          ) : null}
        </Stack>
        {action}
      </Stack>
    </Center>
  );
}