'use client';

import { useRouter } from 'next/navigation';
import { Stack, Paper, Group, Text, Button, List, ThemeIcon } from '@mantine/core';
import { IconFlask, IconBolt, IconChecks, IconArrowRight } from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';

export default function TracingEvalsHomePage() {
  const router = useRouter();

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconFlask size={18} />}
        title="Tracing Evals"
        subtitle="Generate draft eval cases from tracing data and score traced sessions."
        actions={
          <Group>
            <Button variant="light" onClick={() => router.push('/dashboard/tracing/evals/drafts')}>
              Drafts
            </Button>
            <Button onClick={() => router.push('/dashboard/tracing/evals/runs')}>
              Runs
            </Button>
          </Group>
        }
      />

      <Paper withBorder radius="lg" p="lg">
        <Stack gap="xs">
          <Text fw={600}>What is available in this phase</Text>
          <List
            spacing="xs"
            icon={
              <ThemeIcon color="teal" size={18} radius="xl">
                <IconChecks size={12} />
              </ThemeIcon>
            }
          >
            <List.Item>Generate candidate eval cases from existing tracing sessions</List.Item>
            <List.Item>Add risk tags and candidate assertions automatically</List.Item>
            <List.Item>Run rule-based scoring over selected traced sessions</List.Item>
          </List>

          <Group mt="sm">
            <Button
              variant="light"
              leftSection={<IconBolt size={14} />}
              rightSection={<IconArrowRight size={14} />}
              onClick={() => router.push('/dashboard/tracing/evals/drafts')}
            >
              Generate Drafts
            </Button>
            <Button
              leftSection={<IconFlask size={14} />}
              rightSection={<IconArrowRight size={14} />}
              onClick={() => router.push('/dashboard/tracing/evals/runs')}
            >
              Score Runs
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}
