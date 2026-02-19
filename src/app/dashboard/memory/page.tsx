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
  Stack,
  Table,
  Text,
  ThemeIcon,
  SimpleGrid,
  TextInput,
} from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import { notifications } from '@mantine/notifications';
import {
  IconPlus,
  IconRefresh,
  IconBulb,
  IconSearch,
  IconDatabase,
  IconBrain,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import CreateMemoryStoreModal from '@/components/memory/CreateMemoryStoreModal';

interface MemoryStoreItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  vectorProviderKey: string;
  embeddingModelKey: string;
  status: string;
  memoryCount: number;
  createdAt?: string;
  lastActivityAt?: string;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'teal';
    case 'inactive':
      return 'gray';
    case 'error':
      return 'red';
    default:
      return 'gray';
  }
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function MemoryPage() {
  const router = useRouter();
  const t = useTranslations('memory');
  const [stores, setStores] = useState<MemoryStoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [search, setSearch] = useState('');

  const loadStores = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const res = await fetch(`/api/memory/stores?${params.toString()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        setStores(data.stores || []);
      }
    } catch (err) {
      console.error('Failed to load memory stores', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search]);

  useEffect(() => {
    loadStores();
  }, [loadStores]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadStores();
  };

  const handleCreated = () => {
    setCreateModalOpen(false);
    notifications.show({
      title: t('storeCreated'),
      message: t('storeCreatedMessage'),
      color: 'teal',
    });
    handleRefresh();
  };

  const totalMemories = stores.reduce((sum, s) => sum + (s.memoryCount ?? 0), 0);
  const activeStores = stores.filter((s) => s.status === 'active').length;

  return (
    <>
      <PageHeader
        icon={<IconBulb size={18} />}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Group gap="xs">
            <ActionIcon
              variant="subtle"
              size="lg"
              loading={refreshing}
              onClick={handleRefresh}
              aria-label="Refresh"
            >
              <IconRefresh size={18} />
            </ActionIcon>
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => setCreateModalOpen(true)}
            >
              {t('createStore')}
            </Button>
          </Group>
        }
      />

      {/* Stats */}
      <SimpleGrid cols={{ base: 1, sm: 3 }} mb="lg">
        <Paper withBorder p="md" radius="md">
          <Group>
            <ThemeIcon variant="light" size="lg" color="violet">
              <IconBulb size={20} />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                {t('title')}
              </Text>
              <Text fw={700} size="xl">
                {stores.length}
              </Text>
            </div>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group>
            <ThemeIcon variant="light" size="lg" color="teal">
              <IconDatabase size={20} />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Total Memories
              </Text>
              <Text fw={700} size="xl">
                {totalMemories}
              </Text>
            </div>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group>
            <ThemeIcon variant="light" size="lg" color="blue">
              <IconBrain size={20} />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Active Stores
              </Text>
              <Text fw={700} size="xl">
                {activeStores}
              </Text>
            </div>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Search */}
      <TextInput
        placeholder={t('searchPlaceholder')}
        leftSection={<IconSearch size={16} />}
        mb="md"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleRefresh();
        }}
      />

      {/* Store table */}
      <Paper withBorder radius="md">
        {loading ? (
          <Center py="xl">
            <Loader size="md" />
          </Center>
        ) : stores.length === 0 ? (
          <Stack align="center" py="xl" gap="sm">
            <ThemeIcon variant="light" size={60} radius="xl" color="gray">
              <IconBulb size={32} />
            </ThemeIcon>
            <Text fw={600} size="lg">
              {t('noStores')}
            </Text>
            <Text size="sm" c="dimmed" maw={400} ta="center">
              {t('noStoresDescription')}
            </Text>
            <Button
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setCreateModalOpen(true)}
            >
              {t('createFirstStore')}
            </Button>
          </Stack>
        ) : (
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('storeName')}</Table.Th>
                <Table.Th>{t('storeKey')}</Table.Th>
                <Table.Th>{t('vectorProvider')}</Table.Th>
                <Table.Th>{t('embeddingModel')}</Table.Th>
                <Table.Th>{t('memoryCount')}</Table.Th>
                <Table.Th>{t('status')}</Table.Th>
                <Table.Th>{t('createdAt')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {stores.map((store) => (
                <Table.Tr
                  key={store.key}
                  style={{ cursor: 'pointer' }}
                  onClick={() => router.push(`/dashboard/memory/${store.key}`)}
                >
                  <Table.Td>
                    <Text fw={600} size="sm">
                      {store.name}
                    </Text>
                    {store.description && (
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {store.description}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {store.key}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{store.vectorProviderKey}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{store.embeddingModelKey}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{store.memoryCount ?? 0}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" color={statusColor(store.status)} variant="light">
                      {store.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{formatDate(store.createdAt)}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      <CreateMemoryStoreModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={handleCreated}
      />
    </>
  );
}
