'use client';

/** The card the Access tab is built from, and the two states every card shares: loading and a failed load. */

import type { ReactNode } from 'react';
import { Button, Group, Paper, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';

export interface AccessCardProps {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  color?: string;
  /** Buttons at the end of the header. */
  actions?: ReactNode;
  children: ReactNode;
}

export function AccessCard({ icon, title, description, color = 'violet', actions, children }: AccessCardProps) {
  return (
    <Paper component="section" aria-label={title} withBorder radius="lg" p="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="md">
        <Group gap={8} align="flex-start" wrap="nowrap">
          <ThemeIcon variant="light" color={color} radius="md">{icon}</ThemeIcon>
          <div>
            <Text fw={600}>{title}</Text>
            {description ? <Text size="sm" c="dimmed">{description}</Text> : null}
          </div>
        </Group>
        {actions}
      </Group>
      {children}
    </Paper>
  );
}

/** A card whose data has not arrived: grey bars where the text will be. */
export function CardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <Stack gap="xs" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={14} width={index === 0 ? '60%' : '40%'} radius="sm" />
      ))}
    </Stack>
  );
}

/** A failed load must not look like "nothing here": it says what failed and offers another try. */
export function CardError({ message, detail, onRetry }: { message: string; detail?: string; onRetry: () => void }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start" role="alert">
      <IconAlertTriangle size={16} color="var(--mantine-color-red-6)" style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm">{message}</Text>
        {detail ? <Text size="xs" c="dimmed">{detail}</Text> : null}
      </div>
      <Button size="xs" variant="light" color="red" leftSection={<IconRefresh size={12} />} onClick={onRetry}>
        Retry
      </Button>
    </Group>
  );
}
