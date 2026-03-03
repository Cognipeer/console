'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
  Box,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import PageHeader from '@/components/layout/PageHeader';
import {
  IconBook2,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconArrowRight,
  IconFileText,
  IconPuzzle,
  IconDatabase,
} from '@tabler/icons-react';
import CreateRagModuleModal from '@/components/rag/CreateRagModuleModal';

interface RagModuleView {
  _id: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  chunkConfig: {
    strategy: string;
    chunkSize: number;
    chunkOverlap: number;
  };
  status: string;
  totalDocuments?: number;
  totalChunks?: number;
  createdAt?: string;
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function strategyLabel(strategy: string) {
  switch (strategy) {
    case 'recursive_character':
      return 'Recursive Character';
    case 'token':
      return 'Token Based';
    default:
      return strategy;
  }
}

export default function RagDashboardPage() {
  const router = useRouter();
  const [modules, setModules] = useState<RagModuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const loadModules = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/rag/modules', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load RAG modules');
      const data = await res.json();
      setModules(data.modules ?? []);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load RAG modules',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadModules();
  }, [loadModules]);

  const handleDelete = async (mod: RagModuleView) => {
    const confirmed = window.confirm(`Delete RAG module "${mod.name}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/rag/modules/${encodeURIComponent(mod.key)}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to delete module');
      }
      notifications.show({ color: 'green', title: 'RAG module deleted', message: `${mod.name} has been removed.` });
      setModules((prev) => prev.filter((m) => m.key !== mod.key));
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to delete module',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleCreated = (ragModule: Record<string, unknown>) => {
    setCreateModalOpen(false);
    router.push(`/dashboard/rag/${encodeURIComponent(ragModule.key as string)}`);
  };

  const totalDocs = modules.reduce((sum, m) => sum + (m.totalDocuments ?? 0), 0);
  const totalChunks = modules.reduce((sum, m) => sum + (m.totalChunks ?? 0), 0);
  const activeCount = modules.filter((m) => m.status === 'active').length;

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconBook2 size={18} />}
        title="Knowledge Engine"
        subtitle="Manage retrieval-augmented generation modules — ingest documents, query knowledge, and monitor usage."
        actions={
          <>
            <Button
              variant="light"
              size="xs"
              leftSection={refreshing ? <Loader size={12} /> : <IconRefresh size={14} />}
              onClick={() => void loadModules()}
              disabled={refreshing}
            >
              Refresh
            </Button>
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => setCreateModalOpen(true)}
            >
              Create Module
            </Button>
          </>
        }
      />

      {/* Stats */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Total Modules
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {modules.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="violet">
              <IconBook2 size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Active
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {activeCount}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconPuzzle size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Total Documents
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {totalDocs}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="cyan">
              <IconFileText size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Total Chunks
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {totalChunks}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="orange">
              <IconDatabase size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Modules Table */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="md">
          <div>
            <Text fw={600} size="lg">All RAG Modules</Text>
            <Text size="sm" c="dimmed">Click on a module to view documents, run queries, and see usage</Text>
          </div>
        </Group>

        {loading ? (
          <Center py="xl">
            <Loader size="md" color="violet" />
          </Center>
        ) : modules.length === 0 ? (
          <Center py="xl">
            <Stack gap="md" align="center">
              <ThemeIcon size={80} radius="xl" variant="light" color="violet">
                <IconBook2 size={40} />
              </ThemeIcon>
              <Stack gap={4} align="center">
                <Text size="lg" fw={500}>No RAG Modules Yet</Text>
                <Text size="sm" c="dimmed" ta="center" maw={400}>
                  Create your first RAG module to start ingesting documents and querying knowledge.
                </Text>
              </Stack>
              <Button
                leftSection={<IconPlus size={16} />}
                onClick={() => setCreateModalOpen(true)}
                variant="gradient"
                gradient={{ from: 'violet', to: 'cyan', deg: 90 }}
              >
                Create Module
              </Button>
            </Stack>
          </Center>
        ) : (
          <Box style={{ overflow: 'hidden', borderRadius: 'var(--mantine-radius-md)' }}>
            <Table verticalSpacing="md" horizontalSpacing="md" highlightOnHover>
              <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
                <Table.Tr>
                  <Table.Th style={{ fontWeight: 600 }}>Module</Table.Th>
                  <Table.Th style={{ fontWeight: 600 }}>Strategy</Table.Th>
                  <Table.Th style={{ fontWeight: 600, textAlign: 'center' }}>Documents</Table.Th>
                  <Table.Th style={{ fontWeight: 600, textAlign: 'center' }}>Chunks</Table.Th>
                  <Table.Th style={{ fontWeight: 600 }}>Status</Table.Th>
                  <Table.Th style={{ fontWeight: 600 }}>Created</Table.Th>
                  <Table.Th style={{ fontWeight: 600, textAlign: 'center' }}>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {modules.map((mod) => {
                  const navigateToDetail = () =>
                    router.push(`/dashboard/rag/${encodeURIComponent(mod.key)}`);

                  return (
                    <Table.Tr
                      key={mod.key}
                      onClick={navigateToDetail}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateToDetail(); }
                      }}
                      style={{ cursor: 'pointer', transition: 'background-color 0.15s ease' }}
                    >
                      <Table.Td>
                        <Group gap="sm">
                          <ThemeIcon size={40} radius="md" variant="light" color="violet">
                            <IconBook2 size={20} />
                          </ThemeIcon>
                          <Stack gap={2}>
                            <Text fw={600} size="sm">{mod.name}</Text>
                            <Text size="xs" c="dimmed" ff="monospace">{mod.key}</Text>
                          </Stack>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color="grape" size="sm">
                          {strategyLabel(mod.chunkConfig.strategy)}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Center>
                          <Badge variant="filled" color="cyan" size="md" radius="sm">
                            {mod.totalDocuments ?? 0}
                          </Badge>
                        </Center>
                      </Table.Td>
                      <Table.Td>
                        <Center>
                          <Badge variant="filled" color="orange" size="md" radius="sm">
                            {mod.totalChunks ?? 0}
                          </Badge>
                        </Center>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          color={mod.status === 'active' ? 'teal' : 'gray'}
                          size="sm"
                        >
                          {mod.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">{formatDate(mod.createdAt)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" justify="center">
                          <Tooltip label="View details" withArrow>
                            <ActionIcon
                              variant="light"
                              color="violet"
                              radius="md"
                              onClick={(e) => { e.stopPropagation(); navigateToDetail(); }}
                            >
                              <IconArrowRight size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete module" withArrow>
                            <ActionIcon
                              variant="light"
                              color="red"
                              radius="md"
                              onClick={(e) => { e.stopPropagation(); void handleDelete(mod); }}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Paper>

      <CreateRagModuleModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={handleCreated}
      />
    </Stack>
  );
}
