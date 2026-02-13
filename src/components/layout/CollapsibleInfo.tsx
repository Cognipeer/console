'use client';

import { useState } from 'react';
import { Paper, Group, Text, UnstyledButton, Collapse, ThemeIcon } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconInfoCircle } from '@tabler/icons-react';
import { ReactNode } from 'react';

interface CollapsibleInfoProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  color?: string;
  action?: ReactNode;
}

export default function CollapsibleInfo({
  title,
  children,
  defaultOpen = false,
  color = 'teal',
  action,
}: CollapsibleInfoProps) {
  const [opened, setOpened] = useState(defaultOpen);

  return (
    <Paper
      withBorder
      radius="md"
      p="xs"
      style={{
        background: 'var(--mantine-color-gray-0)',
        borderColor: 'var(--mantine-color-gray-2)',
      }}
    >
      <Group justify="space-between" align="center">
        <UnstyledButton onClick={() => setOpened((o) => !o)} style={{ flex: 1 }}>
          <Group gap="xs">
            <ThemeIcon size={24} radius="sm" variant="light" color={color}>
              {opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ThemeIcon>
            <ThemeIcon size={24} radius="sm" variant="light" color={color}>
              <IconInfoCircle size={14} />
            </ThemeIcon>
            <Text size="sm" fw={500}>{title}</Text>
          </Group>
        </UnstyledButton>
        {action}
      </Group>
      <Collapse in={opened}>
        <Paper p="sm" pt="xs" style={{ background: 'transparent' }}>
          {children}
        </Paper>
      </Collapse>
    </Paper>
  );
}
