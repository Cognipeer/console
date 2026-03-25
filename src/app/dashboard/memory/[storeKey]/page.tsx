'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MemoryScope } from '@/lib/database';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Pagination,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import AddMemoryItemModal from '@/components/memory/AddMemoryItemModal';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconBulb,
  IconDatabase,
  IconPlus,
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
  createdAt?: string;
  lastActivityAt?: string;
}

interface MemoryItem {
  _id: string;
  content: string;
  scope: MemoryScope;
  scopeId?: string;
  tags?: string[];
  importance?: number;
  source?: 'chat' | 'api' | 'agent' | 'manual';
  createdAt?: string;
}

interface SearchMatch {
  id: string;
  content: string;
  score: number;
  scope: MemoryScope;
  scopeId?: string;
  tags: string[];
  importance: number;
  source?: 'chat' | 'api' | 'agent' | 'manual';
  createdAt?: string;
}

interface RecallResult {
  context: string;
  memories: SearchMatch[];
  storeKey: string;
}

type ScopeFilterValue = MemoryScope | 'all';

const PAGE_SIZE = 20;
const SEARCH_LIMIT = 10;
const RECALL_LIMIT = 5;

function supportsScopeId(scope: ScopeFilterValue): scope is Extract<MemoryScope, 'user' | 'agent' | 'session'> {
  return scope === 'user' || scope === 'agent' || scope === 'session';
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

function appendFilterParams(params: URLSearchParams, filter: { scope?: MemoryScope; scopeId?: string }) {
  if (filter.scope) {
    params.set('scope', filter.scope);
  }
  if (filter.scopeId) {
    params.set('scopeId', filter.scopeId);
  }
}

function getScopeLabel(t: ReturnType<typeof useTranslations>, scope?: string) {
  switch (scope) {
    case 'global':
      return t('scopes.global');
    case 'user':
      return t('scopes.user');
    case 'agent':
      return t('scopes.agent');
    case 'session':
      return t('scopes.session');
    default:
      return scope ?? '—';
  }
}

function getSourceLabel(t: ReturnType<typeof useTranslations>, source?: string) {
  switch (source) {
    case 'chat':
      return t('sources.chat');
    case 'api':
      return t('sources.api');
    case 'agent':
      return t('sources.agent');
    case 'manual':
      return t('sources.manual');
    default:
      return source ?? '—';
  }
}

function formatContextLabel(
  t: ReturnType<typeof useTranslations>,
  filter: { scope?: MemoryScope; scopeId?: string },
) {
  if (!filter.scope && !filter.scopeId) {
    return t('allContexts');
  }

  const parts: string[] = [];

  if (filter.scope) {
    parts.push(getScopeLabel(t, filter.scope));
  }

  if (filter.scopeId) {
    parts.push(filter.scopeId);
  }

  return parts.join(' / ');
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
  const [loadingStore, setLoadingStore] = useState(true);
  const [loadingMemories, setLoadingMemories] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingStore, setDeletingStore] = useState(false);
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
  const [clearingContext, setClearingContext] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const [draftScope, setDraftScope] = useState<ScopeFilterValue>('all');
  const [draftScopeId, setDraftScopeId] = useState('');
  const [filter, setFilter] = useState<{ scope?: MemoryScope; scopeId?: string }>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [recallQuery, setRecallQuery] = useState('');
  const [recallResult, setRecallResult] = useState<RecallResult | null>(null);
  const [recalling, setRecalling] = useState(false);

  const currentContextLabel = useMemo(() => formatContextLabel(t, filter), [filter, t]);
  const hasContextFilter = Boolean(filter.scope || filter.scopeId);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const loadStore = useCallback(async () => {
    try {
      const res = await fetch(`/api/memory/stores/${storeKey}`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error('Failed to load store');
      }

      setStore(await res.json());
    } catch (error) {
      console.error('Failed to load memory store', error);
    } finally {
      setLoadingStore(false);
    }
  }, [storeKey]);

  const loadMemories = useCallback(async () => {
    setLoadingMemories(true);

    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(PAGE_SIZE));
      appendFilterParams(params, filter);

      const res = await fetch(`/api/memory/stores/${storeKey}/memories?${params.toString()}`, {
        cache: 'no-store',
      });

      if (!res.ok) {
        throw new Error('Failed to load memories');
      }

      const data = await res.json();
      setMemories(data.items || []);
      setTotal(data.total || 0);
    } catch (error) {
      console.error('Failed to load memories', error);
    } finally {
      setLoadingMemories(false);
    }
  }, [filter, page, storeKey]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadStore(), loadMemories()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadMemories, loadStore]);

  useEffect(() => {
    void loadStore();
  }, [loadStore]);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  const handleApplyFilter = () => {
    const trimmedScopeId = draftScopeId.trim();

    setPage(1);
    setSearchResults(null);
    setRecallResult(null);
    setFilter({
      scope: draftScope === 'all' ? undefined : draftScope,
      scopeId: supportsScopeId(draftScope) && trimmedScopeId ? trimmedScopeId : undefined,
    });
  };

  const handleResetFilter = () => {
    setDraftScope('all');
    setDraftScopeId('');
    setPage(1);
    setSearchResults(null);
    setRecallResult(null);
    setFilter({});
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }

    setSearching(true);

    try {
      const params = new URLSearchParams();
      params.set('query', searchQuery.trim());
      params.set('limit', String(SEARCH_LIMIT));
      appendFilterParams(params, filter);

      const res = await fetch(`/api/memory/stores/${storeKey}/memories?${params.toString()}`, {
        cache: 'no-store',
      });

      if (!res.ok) {
        throw new Error(t('searchError'));
      }

      const data = await res.json();
      setSearchResults(data.memories || []);
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('searchError'),
        title: t('error'),
      });
    } finally {
      setSearching(false);
    }
  };

  const handleRecall = async () => {
    if (!recallQuery.trim()) {
      setRecallResult(null);
      return;
    }

    setRecalling(true);

    try {
      const res = await fetch(`/api/memory/stores/${storeKey}/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxTokens: 2000,
          query: recallQuery.trim(),
          scope: filter.scope,
          scopeId: filter.scopeId,
          topK: RECALL_LIMIT,
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || t('searchError'));
      }

      setRecallResult(await res.json());
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('searchError'),
        title: t('error'),
      });
    } finally {
      setRecalling(false);
    }
  };

  const handleDeleteStore = async () => {
    if (!window.confirm(t('deleteStoreConfirm'))) {
      return;
    }

    setDeletingStore(true);

    try {
      const res = await fetch(`/api/memory/stores/${storeKey}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error(t('deleteError'));
      }

      notifications.show({
        color: 'teal',
        message: t('storeDeletedMessage'),
        title: t('storeDeleted'),
      });
      router.push('/dashboard/memory');
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('deleteError'),
        title: t('error'),
      });
    } finally {
      setDeletingStore(false);
    }
  };

  const handleDeleteMemory = async (memoryId: string) => {
    if (!window.confirm(t('delete'))) {
      return;
    }

    setDeletingMemoryId(memoryId);

    try {
      const res = await fetch(`/api/memory/stores/${storeKey}/memories/${memoryId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || t('addMemoryError'));
      }

      notifications.show({
        color: 'teal',
        message: t('memoryDeletedMessage'),
        title: t('memoryDeleted'),
      });

      if (memories.length === 1 && page > 1) {
        setPage((currentPage) => currentPage - 1);
      } else {
        await Promise.all([loadStore(), loadMemories()]);
      }
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('addMemoryError'),
        title: t('error'),
      });
    } finally {
      setDeletingMemoryId(null);
    }
  };

  const handleClearContext = async () => {
    if (!hasContextFilter) {
      return;
    }

    if (!window.confirm(t('clearContextConfirm'))) {
      return;
    }

    setClearingContext(true);

    try {
      const params = new URLSearchParams();
      appendFilterParams(params, filter);

      const res = await fetch(`/api/memory/stores/${storeKey}/memories?${params.toString()}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const error = await res.json().catch(() => null);
        throw new Error(error?.error || t('clearContextError'));
      }

      setSearchResults(null);
      setRecallResult(null);
      setPage(1);
      await Promise.all([loadStore(), loadMemories()]);

      notifications.show({
        color: 'teal',
        message: t('clearContextSuccessMessage'),
        title: t('clearContextSuccess'),
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('clearContextError'),
        title: t('error'),
      });
    } finally {
      setClearingContext(false);
    }
  };

  if (loadingStore && !store) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  return (
    <>
      <PageHeader
        icon={<IconBulb size={18} />}
        iconColor="violet"
        title={store?.name || storeKey}
        subtitle={store?.description || t('manageStoreDescription')}
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
              loading={refreshing}
              onClick={() => {
                void refreshAll();
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
                loading={deletingStore}
                onClick={() => {
                  void handleDeleteStore();
                }}
              >
                <IconTrash size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        }
      />

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

      <Paper withBorder p="md" radius="md" mb="lg">
        <Stack gap="md">
          <div>
            <Text fw={600}>{t('contextFilterTitle')}</Text>
            <Text size="sm" c="dimmed">
              {t('contextFilterDescription')}
            </Text>
          </div>

          <Group align="flex-end">
            <Select
              label={t('scope')}
              data={[
                { value: 'all', label: t('allContexts') },
                { value: 'global', label: t('scopes.global') },
                { value: 'user', label: t('scopes.user') },
                { value: 'agent', label: t('scopes.agent') },
                { value: 'session', label: t('scopes.session') },
              ]}
              allowDeselect={false}
              value={draftScope}
              onChange={(value) => {
                const nextScope = (value as ScopeFilterValue) ?? 'all';
                setDraftScope(nextScope);

                if (!supportsScopeId(nextScope)) {
                  setDraftScopeId('');
                }
              }}
              w={{ base: '100%', sm: 180 }}
            />

            <TextInput
              label={t('scopeId')}
              placeholder={t('scopeIdPlaceholder')}
              value={draftScopeId}
              disabled={!supportsScopeId(draftScope)}
              onChange={(event) => setDraftScopeId(event.currentTarget.value)}
              style={{ flex: 1 }}
            />

            <Button variant="light" onClick={handleApplyFilter}>
              {t('applyFilter')}
            </Button>
            <Button variant="default" onClick={handleResetFilter}>
              {t('resetFilter')}
            </Button>
          </Group>

          <Group justify="space-between" align="center">
            <Text size="sm">
              <Text span fw={600}>{t('currentContext')}:</Text> {currentContextLabel}
            </Text>

            <Group gap="xs">
              <Button
                size="xs"
                leftSection={<IconPlus size={14} />}
                onClick={() => setAddModalOpen(true)}
              >
                {t('addMemory')}
              </Button>
              <Button
                size="xs"
                color="red"
                variant="light"
                leftSection={<IconTrash size={14} />}
                disabled={!hasContextFilter}
                loading={clearingContext}
                onClick={() => {
                  void handleClearContext();
                }}
              >
                {t('clearContext')}
              </Button>
            </Group>
          </Group>
        </Stack>
      </Paper>

      <Tabs defaultValue="browse" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="browse" leftSection={<IconDatabase size={14} />}>
            {t('browseTab')}
          </Tabs.Tab>
          <Tabs.Tab value="search" leftSection={<IconSearch size={14} />}>
            {t('searchTab')}
          </Tabs.Tab>
          <Tabs.Tab value="recall" leftSection={<IconBulb size={14} />}>
            {t('recallTab')}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="browse">
          <Paper withBorder radius="md">
            <Group justify="space-between" p="md" pb={0}>
              <div>
                <Text fw={600}>{t('allMemories')}</Text>
                <Text size="sm" c="dimmed">
                  {t('currentContext')}: {currentContextLabel}
                </Text>
              </div>
              <Text size="sm" c="dimmed">
                {t('memoryCount')}: {total}
              </Text>
            </Group>

            {loadingMemories ? (
              <Center py="xl">
                <Loader size="md" />
              </Center>
            ) : memories.length === 0 ? (
              <Stack align="center" py="xl" gap="sm">
                <Text fw={600}>{t('noMemories')}</Text>
                <Text size="sm" c="dimmed" maw={420} ta="center">
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
                      <Table.Th>{t('scopeId')}</Table.Th>
                      <Table.Th>{t('tags')}</Table.Th>
                      <Table.Th>{t('importance')}</Table.Th>
                      <Table.Th>{t('memorySource')}</Table.Th>
                      <Table.Th>{t('createdAt')}</Table.Th>
                      <Table.Th>{t('actions')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {memories.map((item) => (
                      <Table.Tr key={item._id}>
                        <Table.Td maw={420}>
                          <Text size="sm" lineClamp={2}>
                            {item.content}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge size="xs" variant="light">
                            {getScopeLabel(t, item.scope)}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{item.scopeId || '—'}</Text>
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
                          <Text size="sm">{(item.importance ?? 0.5).toFixed(2)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{getSourceLabel(t, item.source)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{formatDate(item.createdAt)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Tooltip label={t('delete')}>
                            <ActionIcon
                              color="red"
                              variant="subtle"
                              loading={deletingMemoryId === item._id}
                              onClick={() => {
                                void handleDeleteMemory(item._id);
                              }}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
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
        </Tabs.Panel>

        <Tabs.Panel value="search">
          <Paper withBorder p="md" radius="md">
            <Stack gap="md">
              <div>
                <Text fw={600}>{t('searchMemories')}</Text>
                <Text size="sm" c="dimmed">
                  {t('searchDescription')}
                </Text>
              </div>

              <Group>
                <TextInput
                  placeholder={t('searchPlaceholder')}
                  leftSection={<IconSearch size={16} />}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void handleSearch();
                    }
                  }}
                  style={{ flex: 1 }}
                />
                <Button
                  loading={searching}
                  leftSection={<IconSearch size={14} />}
                  onClick={() => {
                    void handleSearch();
                  }}
                >
                  {t('searchMemories')}
                </Button>
              </Group>

              {searchResults && (
                searchResults.length === 0 ? (
                  <Text size="sm" c="dimmed">{t('noSearchResults')}</Text>
                ) : (
                  <Stack gap="sm">
                    {searchResults.map((match) => (
                      <Card key={match.id} withBorder radius="md" p="md">
                        <Group justify="space-between" mb={6}>
                          <Group gap="xs">
                            <Badge size="xs" variant="light">
                              {getScopeLabel(t, match.scope)}
                            </Badge>
                            {match.scopeId && (
                              <Badge size="xs" variant="dot" color="gray">
                                {match.scopeId}
                              </Badge>
                            )}
                          </Group>
                          <Text size="xs" c="dimmed">
                            {t('score')}: {match.score.toFixed(3)}
                          </Text>
                        </Group>
                        <Text size="sm">{match.content || '—'}</Text>
                        {match.tags.length > 0 && (
                          <Group gap={4} mt="sm">
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
                )
              )}
            </Stack>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="recall">
          <Paper withBorder p="md" radius="md">
            <Stack gap="md">
              <div>
                <Text fw={600}>{t('recallTitle')}</Text>
                <Text size="sm" c="dimmed">
                  {t('recallDescription')}
                </Text>
              </div>

              <Group>
                <TextInput
                  placeholder={t('recallPlaceholder')}
                  leftSection={<IconBulb size={16} />}
                  value={recallQuery}
                  onChange={(event) => setRecallQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void handleRecall();
                    }
                  }}
                  style={{ flex: 1 }}
                />
                <Button
                  loading={recalling}
                  leftSection={<IconBulb size={14} />}
                  onClick={() => {
                    void handleRecall();
                  }}
                >
                  {t('recallTab')}
                </Button>
              </Group>

              {recallResult && (
                recallResult.memories.length === 0 && !recallResult.context ? (
                  <Text size="sm" c="dimmed">{t('noRecallResults')}</Text>
                ) : (
                  <Stack gap="md">
                    <Paper withBorder p="md" radius="md">
                      <Text fw={600} mb={8}>{t('recalledContext')}</Text>
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {recallResult.context || t('noRecallResults')}
                      </Text>
                    </Paper>

                    <div>
                      <Text fw={600} mb="sm">{t('relatedMemories')}</Text>
                      {recallResult.memories.length === 0 ? (
                        <Text size="sm" c="dimmed">{t('noRecallResults')}</Text>
                      ) : (
                        <Stack gap="sm">
                          {recallResult.memories.map((match) => (
                            <Card key={match.id} withBorder radius="md" p="md">
                              <Group justify="space-between" mb={6}>
                                <Group gap="xs">
                                  <Badge size="xs" variant="light">
                                    {getScopeLabel(t, match.scope)}
                                  </Badge>
                                  {match.scopeId && (
                                    <Badge size="xs" variant="dot" color="gray">
                                      {match.scopeId}
                                    </Badge>
                                  )}
                                </Group>
                                <Text size="xs" c="dimmed">
                                  {t('score')}: {match.score.toFixed(3)}
                                </Text>
                              </Group>
                              <Text size="sm">{match.content || '—'}</Text>
                            </Card>
                          ))}
                        </Stack>
                      )}
                    </div>
                  </Stack>
                )
              )}
            </Stack>
          </Paper>
        </Tabs.Panel>
      </Tabs>

      <AddMemoryItemModal
        opened={addModalOpen}
        storeKey={storeKey}
        defaultScope={filter.scope}
        defaultScopeId={filter.scopeId}
        onClose={() => setAddModalOpen(false)}
        onCreated={() => {
          setAddModalOpen(false);
          void refreshAll();
        }}
      />
    </>
  );
}
