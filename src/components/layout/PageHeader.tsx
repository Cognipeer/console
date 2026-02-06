'use client';

import { Group, Paper, Text, Title, ThemeIcon } from '@mantine/core';
import { ReactNode } from 'react';

interface PageHeaderProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  iconColor?: string;
}

export default function PageHeader({
  icon,
  title,
  subtitle,
  actions,
  iconColor = 'teal',
}: PageHeaderProps) {
  return (
    <Paper
      p="md"
      radius="md"
      withBorder
      style={{
        background: `linear-gradient(135deg, var(--mantine-color-${iconColor}-0) 0%, var(--mantine-color-${iconColor}-0) 100%)`,
        borderColor: `var(--mantine-color-${iconColor}-1)`,
      }}
    >
      <Group justify="space-between" align="center">
        <Group gap="sm">
          <ThemeIcon
            size={36}
            radius="md"
            variant="light"
            color={iconColor}
          >
            {icon}
          </ThemeIcon>
          <div>
            <Title order={3} size="h4">{title}</Title>
            {subtitle && (
              <Text size="xs" c="dimmed">
                {subtitle}
              </Text>
            )}
          </div>
        </Group>
        {actions && (
          <Group gap="xs">
            {actions}
          </Group>
        )}
      </Group>
    </Paper>
  );
}
