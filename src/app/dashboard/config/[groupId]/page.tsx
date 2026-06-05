'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  TextInput,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useParams, useRouter } from 'next/navigation';
import { notifications } from '@mantine/notifications';
import {
  IconEdit,
  IconFolder,
  IconKey,
  IconLock,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import DetailShell from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateConfigItemModal from '@/components/config/CreateConfigItemModal';
import EditConfigItemModal from '@/components/config/EditConfigItemModal';

interface ConfigItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  value: string;
  valueType: string;
  isSecret: boolean;
  tags?: string[];
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

interface ConfigGroup {
  _id: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  items: ConfigItem[];
  createdAt?: string;
  updatedAt?: string;
}

function typeColor(type: string): string {
  switch (type) {
    case 'string':
      return 'blue';
    case 'number':
      return 'orange';
    case 'boolean':
      return 'teal';
    case 'json':
      return 'grape';
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

export default function ConfigGroupDetailPage() {
  const t = useTranslations('config');
  const router = useRouter();
  const params = useParams<{ groupId: string }>();
  const groupId = params.groupId;

  const [group, setGroup] = useState<ConfigGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingGroup, setSavingGroup] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [createItemOpen, setCreateItemOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ConfigItem | null>(null);

  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      tags: '',
    },
    validate: {
      name: (value) => (!value.trim() ? 'Name is required' : null),
    },
  });

  const totalSecrets = useMemo(
    () => (group?.items || []).filter((item) => item.isSecret).length,
    [group?.items],
  );

  const loadGroup = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await fetch(`/api/config/groups/${groupId}`, {
        cache: 'no-store',
      });

      if (!res.ok) {
        if (res.status === 404) {
          notifications.show({
            title: t('error'),
            message: 'Config group not found',
            color: 'red',
          });
          router.push('/dashboard/config');
          return;
        }
        const data = await res.json();
        throw new Error(data.error || 'Failed to load config group');
      }

      const data = await res.json();
      const nextGroup: ConfigGroup = data.group;
      setGroup(nextGroup);
      form.setValues({
        name: nextGroup.name || '',
        description: nextGroup.description || '',
        tags: (nextGroup.tags || []).join(', '),
      });
    } catch (error) {
      notifications.show({
        title: t('error'),
        message: error instanceof Error ? error.message : 'Failed to load config group',
        color: 'red',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [form, groupId, router, t]);

  useEffect(() => {
    loadGroup();
  }, [loadGroup]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadGroup();
  };

  const handleSaveGroup = async (values: typeof form.values) => {
    if (!groupId) return;
    setSavingGroup(true);
    try {
      const tags = values.tags
        ? values.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        : undefined;

      const res = await fetch(`/api/config/groups/${groupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          tags,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('updateError'));
      }

      const data = await res.json();
      const updated = data.group as ConfigGroup;
      setGroup((prev) => (prev ? { ...prev, ...updated } : prev));

      notifications.show({
        title: t('editGroup'),
        message: t('itemUpdatedMessage'),
        color: 'teal',
      });
    } catch (error) {
      notifications.show({
        title: t('error'),
        message: error instanceof Error ? error.message : t('updateError'),
        color: 'red',
      });
    } finally {
      setSavingGroup(false);
    }
  };

  const handleDeleteGroup = async () => {
    if (!groupId || !confirm(t('confirmDeleteGroup'))) return;
    setDeletingId(groupId);
    try {
      const res = await fetch(`/api/config/groups/${groupId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('deleteError'));
      }

      notifications.show({
        title: t('groupDeleted'),
        message: t('groupDeletedMessage'),
        color: 'teal',
      });
      router.push('/dashboard/config');
    } catch (error) {
      notifications.show({
        title: t('error'),
        message: error instanceof Error ? error.message : t('deleteError'),
        color: 'red',
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!confirm(t('confirmDelete'))) return;
    setDeletingId(itemId);
    try {
      const res = await fetch(`/api/config/items/${itemId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('deleteError'));
      }

      notifications.show({
        title: t('itemDeleted'),
        message: t('itemDeletedMessage'),
        color: 'teal',
      });
      handleRefresh();
    } catch (error) {
      notifications.show({
        title: t('error'),
        message: error instanceof Error ? error.message : t('deleteError'),
        color: 'red',
      });
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  if (!group) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">Config group not found.</Text>
          <Button onClick={() => router.push('/dashboard/config')}>
            {t('backToGroups')}
          </Button>
        </Stack>
      </Center>
    );
  }

  const actions = (
    <>
      <Button
        variant="default"
        size="sm"
        leftSection={<IconRefresh size={14} stroke={1.7} />}
        loading={refreshing}
        onClick={handleRefresh}
      >
        Refresh
      </Button>
      <Button
        size="sm"
        leftSection={<IconPlus size={14} stroke={1.7} />}
        onClick={() => setCreateItemOpen(true)}
      >
        {t('createItem')}
      </Button>
      <ActionIcon
        variant="default"
        color="red"
        radius="md"
        size="lg"
        onClick={handleDeleteGroup}
        loading={deletingId === groupId}
        aria-label="Delete group"
      >
        <IconTrash size={15} stroke={1.7} />
      </ActionIcon>
    </>
  );

  return (
    <DetailShell
      backHref="/dashboard/config"
      backLabel="Back to config"
      icon={
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background: 'var(--ds-accent-soft)',
            color: 'var(--ds-accent)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <IconFolder size={22} stroke={1.7} />
        </div>
      }
      title={
        <>
          <h1 className="ds-h2" style={{ margin: 0, whiteSpace: 'nowrap' }}>
            {group.name}
          </h1>
          <StatusBadge status="info" label={`${group.items.length} items`} withDot={false} />
          {totalSecrets > 0 ? (
            <StatusBadge status="err" label={`${totalSecrets} secrets`} withDot={false} />
          ) : null}
        </>
      }
      meta={
        <>
          <span className="ds-mono">{group.key}</span>
          {group.description ? (
            <>
              <span className="ds-faint">·</span>
              <span>{group.description}</span>
            </>
          ) : null}
          {group.updatedAt ? (
            <>
              <span className="ds-faint">·</span>
              <span>Updated {formatDate(group.updatedAt)}</span>
            </>
          ) : null}
        </>
      }
      actions={actions}
    >
      <Stack gap="md">
        <Paper withBorder radius="md" p="md">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <Group gap="xs">
                <ThemeIcon variant="light" color="violet">
                  <IconFolder size={16} />
                </ThemeIcon>
                <Text fw={600}>{t('editGroup')}</Text>
              </Group>
              <Group gap="xs">
                <Badge variant="light" color="blue">
                  {group.items.length} {t('items')}
                </Badge>
                <Badge variant="light" color="red">
                  {totalSecrets} {t('secrets')}
                </Badge>
              </Group>
            </Group>

            <form onSubmit={form.onSubmit(handleSaveGroup)}>
              <Stack gap="sm">
                <TextInput
                  label={t('groupName')}
                  required
                  {...form.getInputProps('name')}
                />
                <TextInput
                  label={t('groupKey')}
                  value={group.key}
                  readOnly
                  leftSection={<IconKey size={14} />}
                />
                <Textarea
                  label={t('description')}
                  autosize
                  minRows={2}
                  {...form.getInputProps('description')}
                />
                <TextInput
                  label={t('tags')}
                  placeholder="Comma separated: api, credentials"
                  {...form.getInputProps('tags')}
                />
                <Group justify="flex-end">
                  <Button type="submit" loading={savingGroup} leftSection={<IconEdit size={14} />}>
                    {t('save')}
                  </Button>
                </Group>
              </Stack>
            </form>
          </Stack>
        </Paper>

        <Paper withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm">
            <Group gap="xs">
              <ThemeIcon variant="light" color="violet">
                <IconLock size={16} />
              </ThemeIcon>
              <Text fw={600}>{t('items')}</Text>
            </Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setCreateItemOpen(true)}
            >
              {t('createItem')}
            </Button>
          </Group>

          {group.items.length === 0 ? (
            <Stack align="center" py="lg" gap="xs">
              <Text size="sm" c="dimmed">
                {t('noItems')}
              </Text>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconPlus size={12} />}
                onClick={() => setCreateItemOpen(true)}
              >
                {t('createFirstItem')}
              </Button>
            </Stack>
          ) : (
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('itemName')}</Table.Th>
                  <Table.Th>{t('itemKey')}</Table.Th>
                  <Table.Th>{t('value')}</Table.Th>
                  <Table.Th>{t('valueType')}</Table.Th>
                  <Table.Th>{t('version')}</Table.Th>
                  <Table.Th>{t('updatedAt')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {group.items.map((item) => (
                  <Table.Tr key={item._id}>
                    <Table.Td>
                      <Group gap="xs">
                        {item.isSecret && (
                          <ThemeIcon variant="light" color="red" size="xs">
                            <IconLock size={12} />
                          </ThemeIcon>
                        )}
                        <div>
                          <Text fw={600} size="sm">
                            {item.name}
                          </Text>
                          {item.description && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {item.description}
                            </Text>
                          )}
                        </div>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {item.key}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {item.isSecret ? (
                        <Badge size="sm" variant="light" color="gray">
                          {t('masked')}
                        </Badge>
                      ) : (
                        <Text size="sm" lineClamp={1} maw={200}>
                          {item.value}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color={typeColor(item.valueType)}>
                        {item.valueType}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">v{item.version}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{formatDate(item.updatedAt || item.createdAt)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label={t('editItem')}>
                          <ActionIcon
                            variant="subtle"
                            color="blue"
                            size="sm"
                            onClick={() => setEditingItem(item)}
                          >
                            <IconEdit size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={t('deleteItem')}>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            size="sm"
                            loading={deletingId === item._id}
                            onClick={() => handleDeleteItem(item._id)}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Paper>
      </Stack>

      <CreateConfigItemModal
        opened={createItemOpen}
        groupId={group?._id || null}
        onClose={() => setCreateItemOpen(false)}
        onCreated={() => {
          setCreateItemOpen(false);
          handleRefresh();
        }}
      />

      <EditConfigItemModal
        opened={editingItem !== null}
        item={editingItem}
        onClose={() => setEditingItem(null)}
        onUpdated={() => {
          setEditingItem(null);
          handleRefresh();
        }}
      />
    </DetailShell>
  );
}
