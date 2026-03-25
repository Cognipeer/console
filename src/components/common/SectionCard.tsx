'use client';

import { Group, Paper, PaperProps, Stack, Text } from '@mantine/core';
import { ComponentPropsWithoutRef, ReactNode } from 'react';

interface SectionCardProps
  extends PaperProps,
    Pick<
      ComponentPropsWithoutRef<'div'>,
      'onClick' | 'onKeyDown' | 'role' | 'tabIndex' | 'aria-label'
    > {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export default function SectionCard({
  title,
  description,
  actions,
  children,
  p = 'lg',
  radius = 'lg',
  shadow = 'xs',
  ...paperProps
}: SectionCardProps) {
  return (
    <Paper p={p} radius={radius} shadow={shadow} {...paperProps}>
      <Stack gap={children ? 'lg' : 0}>
        {title || description || actions ? (
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
            <Stack gap={4} flex={1} maw={720}>
              {typeof title === 'string' ? (
                <Text fw={650} size="lg">
                  {title}
                </Text>
              ) : (
                title
              )}
              {typeof description === 'string' ? (
                <Text size="sm" c="dimmed">
                  {description}
                </Text>
              ) : (
                description
              )}
            </Stack>
            {actions}
          </Group>
        ) : null}
        {children}
      </Stack>
    </Paper>
  );
}