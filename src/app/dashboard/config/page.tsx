'use client';

import { useCallback, useEffect, useState } from 'react';
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
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/layout/PageHeader';
import { notifications } from '@mantine/notifications';
import {
  IconChevronRight,
  IconFolder,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconKey,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import CreateConfigGroupModal from '../../../components/config/CreateConfigGroupModal';

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

export default function ConfigPage() {
  const t = useTranslations('config');
  const router = useRouter();
  const [groups, setGroups] = useState<ConfigGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createGroupModalOpen, setCreateGroupModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const res = await fetch(`/api/config/groups?${params.toString()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        const groupList = data.groups || [];
        // For each group, load items
        const groupsWithItems: ConfigGroup[] = await Promise.all(
          groupList.map(async (group: ConfigGroup) => {
            try {
              const itemsRes = await fetch(`/api/config/groups/${group._id}/items`, {
                cache: 'no-store',
              });
              if (itemsRes.ok) {
                const itemsData = await itemsRes.json();
                return { ...group, items: itemsData.items || [] };
              }
            } catch {
              // ignore
            }
            return { ...group, items: [] };
          }),
        );
        setGroups(groupsWithItems);
      }
    } catch (err) {
      console.error('Failed to load config groups', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadGroups();
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm(t('confirmDeleteGroup'))) return;
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
      handleRefresh();
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: err instanceof Error ? err.message : t('deleteError'),
        color: 'red',
      });
    } finally {
      setDeletingId(null);
    }
  };

  const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0);
  const totalSecrets = groups.reduce(
    (sum, g) => sum + g.items.filter((i) => i.isSecret).length,
    0,
  );

  return (
    <>
      <PageHeader
        icon={<IconLock size={18} />}
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
              onClick={() => setCreateGroupModalOpen(true)}
            >
              {t('createGroup')}
            </Button>
          </Group>
        }
      />

      {/* Stats */}
      <SimpleGrid cols={{ base: 1, sm: 3 }} mb="lg">
        <Paper withBorder p="md" radius="md">
          <Group>
            <ThemeIcon variant="light" size="lg" color="violet">
              <IconFolder size={20} />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                {t('totalGroups')}
              </Text>
              <Text fw={700} size="xl">
                {groups.length}
              </Text>
            </div>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group>
            <ThemeIcon variant="light" size="lg" color="blue">
              <IconKey size={20} />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                {t('totalItems')}
              </Text>
              <Text fw={700} size="xl">
                {totalItems}
              </Text>
            </div>
          </Group>
        </Paper>
        <Paper withBorder p="md" radius="md">
          <Group>
            <ThemeIcon variant="light" size="lg" color="red">
              <IconLock size={20} />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                {t('secrets')}
              </Text>
              <Text fw={700} size="xl">
                {totalSecrets}
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

      {/* Groups list */}
      {loading ? (
        <Center py="xl">
          <Loader size="md" />
        </Center>
      ) : groups.length === 0 ? (
        <Paper withBorder radius="md">
          <Stack align="center" py="xl" gap="sm">
            <ThemeIcon variant="light" size={60} radius="xl" color="gray">
              <IconFolder size={32} />
            </ThemeIcon>
            <Text fw={600} size="lg">
              {t('noGroups')}
            </Text>
            <Text size="sm" c="dimmed" maw={400} ta="center">
              {t('noGroupsDescription')}
            </Text>
            <Button
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setCreateGroupModalOpen(true)}
            >
              {t('createFirstGroup')}
            </Button>
          </Stack>
        </Paper>
      ) : (
        <Stack gap="sm">
          {groups.map((group) => {
            return (
              <Paper
                key={group._id}
                withBorder
                radius="md"
                style={{ cursor: 'pointer' }}
                onClick={() => router.push(`/dashboard/config/${group._id}`)}
              >
                <Group
                  p="md"
                  justify="space-between"
                >
                  <Group gap="sm">
                    <ThemeIcon variant="light" color="violet" size="sm">
                      <IconFolder size={14} />
                    </ThemeIcon>
                    <div>
                      <Group gap="xs">
                        <Text fw={600} size="sm">
                          {group.name}
                        </Text>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {group.key}
                        </Text>
                      </Group>
                      {group.description && (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {group.description}
                        </Text>
                      )}
                    </div>
                  </Group>

                  <Group gap="xs" onClick={(e) => e.stopPropagation()}>
                    <Badge size="sm" variant="light">
                      {group.items.length} {t('items')}
                    </Badge>
                    <Badge
                      size="sm"
                      variant="light"
                      color="red"
                    >
                      {group.items.filter((item) => item.isSecret).length} {t('secrets')}
                    </Badge>
                    {(group.tags || []).slice(0, 2).map((tag) => (
                      <Badge key={tag} size="xs" variant="light" color="gray">
                        {tag}
                      </Badge>
                    ))}
                    <Tooltip label={t('deleteGroup')}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        loading={deletingId === group._id}
                        onClick={() => handleDeleteGroup(group._id)}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <ThemeIcon variant="light" color="gray" size="sm">
                      <IconChevronRight size={14} />
                    </ThemeIcon>
                  </Group>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}

      <CreateConfigGroupModal
        opened={createGroupModalOpen}
        onClose={() => setCreateGroupModalOpen(false)}
        onCreated={() => {
          setCreateGroupModalOpen(false);
          handleRefresh();
        }}
      />

    </>
  );
}
