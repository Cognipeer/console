'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  ThemeIcon,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconSearch,
} from '@tabler/icons-react';
import PromptEditorModal from '@/components/prompts/PromptEditorModal';
import type { PromptView } from '@/lib/services/prompts';
import { useTranslations } from '@/lib/i18n';

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function PromptsPage() {
  const tNav = useTranslations('navigation');
  const router = useRouter();
  const [prompts, setPrompts] = useState<PromptView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [search, setSearch] = useState('');

  const loadPrompts = useCallback(async () => {
    setRefreshing(true);
    try {
      const query = search.trim().length > 0 ? `?search=${encodeURIComponent(search.trim())}` : '';
      const response = await fetch(`/api/prompts${query}`, { cache: 'no-store' });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to load prompts' }));
        throw new Error(error.error ?? 'Failed to load prompts');
      }
      const data = await response.json();
      setPrompts((data.prompts ?? []) as PromptView[]);
    } catch (error) {
      console.error(error);
      notifications.show({
        title: 'Unable to load prompts',
        message: error instanceof Error ? error.message : 'Unexpected error',
        color: 'red',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search]);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  const rows = useMemo(
    () =>
      prompts.map((prompt) => (
        <Table.Tr
          key={prompt.id}
          onClick={() => router.push(`/dashboard/prompts/${prompt.id}`)}
          style={{ cursor: 'pointer', transition: 'background-color 0.15s ease' }}
        >
          <Table.Td>
            <Stack gap={2}>
              <Text fw={600}>{prompt.name}</Text>
              {prompt.description ? (
                <Text size="xs" c="dimmed" lineClamp={2}>
                  {prompt.description}
                </Text>
              ) : (
                <Text size="xs" c="dimmed">No description</Text>
              )}
            </Stack>
          </Table.Td>
          <Table.Td>
            <Badge variant="light" color="blue">
              {prompt.key}
            </Badge>
          </Table.Td>
          <Table.Td>
            <Badge variant="outline" color="gray" size="sm">
              v{prompt.currentVersion ?? 1}
            </Badge>
          </Table.Td>
          <Table.Td>{formatDate(prompt.updatedAt ?? prompt.createdAt)}</Table.Td>
        </Table.Tr>
      )),
    [prompts, router],
  );

  const handleSaved = (prompt: PromptView) => {
    setPrompts((current) => {
      const exists = current.find((item) => item.id === prompt.id);
      if (exists) {
        return current.map((item) => (item.id === prompt.id ? prompt : item));
      }
      return [prompt, ...current];
    });
  };

  return (
    <Stack gap="lg">
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}
      >
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'teal', to: 'cyan', deg: 135 }}
            >
              <IconSparkles size={26} />
            </ThemeIcon>
            <div>
              <Title order={2}>{tNav('prompts')}</Title>
              <Text size="sm" c="dimmed" mt={4}>
                Create reusable templates with Mustache variables and fetch them by key.
              </Text>
            </div>
          </Group>
          <Group gap="xs">
            <Button
              variant="light"
              leftSection={refreshing ? <Loader size={14} /> : <IconRefresh size={16} />}
              onClick={() => void loadPrompts()}
              disabled={refreshing}
            >
              Refresh
            </Button>
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => setEditorOpen(true)}
              variant="gradient"
              gradient={{ from: 'teal', to: 'cyan', deg: 90 }}
            >
              New prompt
            </Button>
          </Group>
        </Group>
      </Paper>

      <Group justify="space-between" align="center">
        <TextInput
          placeholder="Search prompts"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          style={{ maxWidth: 320 }}
        />
        <Text size="sm" c="dimmed">
          {prompts.length} prompt{prompts.length === 1 ? '' : 's'}
        </Text>
      </Group>

      <Paper withBorder radius="lg" p="md">
        {loading ? (
          <Center py="xl">
            <Loader size="md" />
          </Center>
        ) : prompts.length === 0 ? (
          <Center py="xl" c="dimmed">
            No prompts yet. Create one to get started.
          </Center>
        ) : (
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Prompt</Table.Th>
                <Table.Th>Key</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{rows}</Table.Tbody>
          </Table>
        )}
      </Paper>

      <PromptEditorModal
        opened={editorOpen}
        onClose={() => setEditorOpen(false)}
        prompt={null}
        onSaved={handleSaved}
      />
    </Stack>
  );
}
