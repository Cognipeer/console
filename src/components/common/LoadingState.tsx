'use client';

import { Center, Loader, Stack, Text } from '@mantine/core';

interface LoadingStateProps {
  label?: string;
  minHeight?: number | string;
  size?: string | number;
}

export default function LoadingState({
  label,
  minHeight = 180,
  size = 'sm',
}: LoadingStateProps) {
  return (
    <Center mih={minHeight} px="md">
      <Stack gap="sm" align="center">
        <Loader size={size} color="teal" />
        {label ? (
          <Text size="sm" c="dimmed" ta="center">
            {label}
          </Text>
        ) : null}
      </Stack>
    </Center>
  );
}