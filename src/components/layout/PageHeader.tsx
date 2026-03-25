'use client';

import { Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { ReactNode } from 'react';
import SectionCard from '@/components/common/SectionCard';

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
    <header>
      <SectionCard
        p={{ base: 'md', sm: 'lg' }}
        title={
          <Group gap="md" wrap="nowrap" align="flex-start">
            <ThemeIcon size={42} radius="lg" variant="light" color={iconColor}>
              {icon}
            </ThemeIcon>
            <Stack gap={2}>
              <Title order={1} size="h3">
                {title}
              </Title>
              {subtitle ? (
                <Text size="sm" c="dimmed">
                  {subtitle}
                </Text>
              ) : null}
            </Stack>
          </Group>
        }
        actions={actions ? <Group gap="xs" wrap="wrap">{actions}</Group> : undefined}
      />
    </header>
  );
}
