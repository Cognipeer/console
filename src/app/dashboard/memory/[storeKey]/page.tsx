'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  SimpleGrid,
  Tooltip,
  Pagination,
} from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconBulb,
  IconDatabase,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

interface MemoryStoreDetail {
  _id: string;
  key: string;
  name: string;
  description?: string;
  vectorProviderKey: string;
  vectorIndexKey?: string;
  embeddingModelKey: string;
  status: string;
  memoryCount: number;
  config?: {
    deduplication?: boolean;
    autoEmbed?: boolean;
    defaultTopK?: number;
    defaultMinScore?: number;
    defaultScope?: string;
  };
  createdAt?: string;
  lastActivityAt?: string;
}

interface MemoryItem {
  _id: string;
  content: string;
  scope: string;
  scopeId?: string;
  tags?: string[];
  importance?: number;
  source?: string;
  accessCount?: number;
  createdAt?: string;
}

interface SearchMatch {
  id: string;
  content: string;
  score: number;
  scope: string;
  tags: string[];
  importance: number;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'teal';
    case 'inactive': return 'gray';
    case 'error': return 'red';
    default: return 'gray';
  }
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function MemoryStoreDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('memory');
  const storeKey = params.storeKey as string;

  const [store, setStore] = useState<MemoryStoreDetail | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const limit = 20;

  const loadStore = useCallback(async () => {
    try {
      const res = await fetch(`/api/memory/stores/${storeKey}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        setStore(await res.json());
      }
    } catch (err) {
      console.error('Failed to load store', err);
    }
  }, [storeKey]);

  const loadMemories = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(limit));
      const res = await fetch(
        `/api/memory/stores/${storeKey}/memories?${params.toString()}`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const data = await res.json();
        setMemories(data.items || []);
        setTotal(data.total || 0);
      }
    } catch (err) {
      console.error('Failed to load memories', err);
    } finally {
      setLoading(false);
    }
  }, [storeKey, page]);

  useEffect(() => {
    loadStore();
    loadMemories();
  }, [loadStore, loadMemories]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(
        `/api/memory/stores/${storeKey}/memories?query=${encodeURIComponent(searchQuery)}`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.memories || []);
      }
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: t('searchError'),
        color: 'red',
      });
    } finally {
      setSearching(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this memory store and all its data?')) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/memory/stores/${storeKey}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        notifications.show({
          title: t('storeDeleted'),
          message: t('storeDeletedMessage'),
          color: 'teal',
        });
        router.push('/dashboard/memory');
      } else {
        throw new Error('Failed to delete');
      }
    } catch {
      notifications.show({
        title: t('error'),
        message: t('deleteError'),
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  };

  if (loading && !store) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <>
      <PageHeader
        icon={<IconBulb size={18} />}
        title={store?.name || storeKey}
        subtitle={store?.description || `Memory store ${storeKey}`}
        iconColor="violet"
        actions={
          <Group gap="xs">
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/memory')}
            >
              {t('back')}
            </Button>
            <ActionIcon
              variant="subtle"
              size="lg"
              onClick={() => {
                setLoading(true);
                loadStore();
                loadMemories();
              }}
              aria-label="Refresh"
            >
              <IconRefresh size={18} />
            </ActionIcon>
            <Tooltip label={t('deleteStore')}>
              <ActionIcon
                variant="subtle"
                color="red"
                size="lg"
                loading={deleting}
                onClick={handleDelete}
              >
                <IconTrash size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        }
      />

      {/* Store info cards */}
      {store && (
        <SimpleGrid cols={{ base: 1, sm: 4 }} mb="lg">
          <Card withBorder p="sm" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {t('status')}
            </Text>
            <Badge color={statusColor(store.status)} variant="light" mt={4}>
              {store.status}
            </Badge>
          </Card>
          <Card withBorder p="sm" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {t('memoryCount')}
            </Text>
            <Text fw={700} size="lg" mt={4}>
              {store.memoryCount ?? 0}
            </Text>
          </Card>
          <Card withBorder p="sm" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {t('vectorProvider')}
            </Text>
            <Text size="sm" mt={4} ff="monospace">
              {store.vectorProviderKey}
            </Text>
          </Card>
          <Card withBorder p="sm" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {t('embeddingModel')}
            </Text>
            <Text size="sm" mt={4} ff="monospace">
              {store.embeddingModelKey}
            </Text>
          </Card>
        </SimpleGrid>
      )}

      {/* Semantic search */}
      <Paper withBorder p="md" radius="md" mb="lg">
        <Text fw={600} mb="sm">
          {t('searchMemories')}
        </Text>
        <Group>
          <TextInput
            placeholder={t('searchPlaceholder')}
            leftSection={<IconSearch size={16} />}
            style={{ flex: 1 }}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
          />
          <Button
            onClick={handleSearch}
            loading={searching}
            leftSection={<IconSearch size={14} />}
          >
            {t('searchMemories')}
          </Button>
        </Group>

        {searchResults && (
          <Stack mt="md" gap="sm">
            <Text size="sm" c="dimmed">
              {searchResults.length} {t('results')}
            </Text>
            {searchResults.map((match) => (
              <Card key={match.id} withBorder p="sm" radius="sm">
                <Group justify="space-between" mb={4}>
                  <Badge size="xs" variant="light">
                    {match.scope}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {t('score')}: {match.score.toFixed(3)}
                  </Text>
                </Group>
                <Text size="sm" lineClamp={3}>
                  {match.content}
                </Text>
                {match.tags.length > 0 && (
                  <Group mt={4} gap={4}>
                    {match.tags.map((tag) => (
                      <Badge key={tag} size="xs" variant="light" color="gray">
                        {tag}
                      </Badge>
                    ))}
                  </Group>
                )}
              </Card>
            ))}
          </Stack>
        )}
      </Paper>

      {/* Memory items table */}
      <Paper withBorder radius="md">
        <Group justify="space-between" p="md" pb={0}>
          <Text fw={600}>
            <ThemeIcon variant="light" size="sm" mr={8} color="violet">
              <IconDatabase size={14} />
            </ThemeIcon>
            {t('memoryCount')}: {total}
          </Text>
        </Group>

        {loading ? (
          <Center py="xl">
            <Loader size="md" />
          </Center>
        ) : memories.length === 0 ? (
          <Stack align="center" py="xl" gap="sm">
            <Text fw={600}>{t('noMemories')}</Text>
            <Text size="sm" c="dimmed" maw={400} ta="center">
              {t('noMemoriesDescription')}
            </Text>
          </Stack>
        ) : (
          <>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('content')}</Table.Th>
                  <Table.Th>{t('scope')}</Table.Th>
                  <Table.Th>{t('tags')}</Table.Th>
                  <Table.Th>{t('importance')}</Table.Th>
                  <Table.Th>{t('source')}</Table.Th>
                  <Table.Th>{t('createdAt')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {memories.map((item) => (
                  <Table.Tr key={item._id}>
                    <Table.Td maw={400}>
                      <Text size="sm" lineClamp={2}>
                        {item.content}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light">
                        {item.scope}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {(item.tags || []).slice(0, 3).map((tag) => (
                          <Badge key={tag} size="xs" variant="light" color="gray">
                            {tag}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{item.importance ?? 0.5}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{item.source || '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{formatDate(item.createdAt)}</Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {totalPages > 1 && (
              <Group justify="center" py="md">
                <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
              </Group>
            )}
          </>
        )}
      </Paper>
    </>
  );
}
