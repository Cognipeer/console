'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconPlus,
  IconRefresh,
  IconServerBolt,
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconBan,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import PageHeader from '@/components/layout/PageHeader';
import { useTranslations } from '@/lib/i18n';

dayjs.extend(relativeTime);

interface InferenceServer {
  _id: string;
  key: string;
  name: string;
  type: string;
  baseUrl: string;
  status: 'active' | 'disabled' | 'errored';
  pollIntervalSeconds: number;
  lastPolledAt?: string;
  lastError?: string;
  createdAt: string;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'teal';
    case 'errored': return 'red';
    case 'disabled': return 'gray';
    default: return 'gray';
  }
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'active':
      return <IconCheck size={16} />;
    case 'errored':
      return <IconAlertTriangle size={16} />;
    default:
      return <IconBan size={16} />;
  }
}

export default function InferenceMonitoringPage() {
  const router = useRouter();
  const t = useTranslations('inferenceMonitoring');
  const tNav = useTranslations('navigation');
  const [servers, setServers] = useState<InferenceServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpened, addHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      type: 'vllm',
      baseUrl: '',
      apiKey: '',
      pollIntervalSeconds: 60,
    },
    validate: {
      name: (value) => (value.trim().length < 2 ? 'Name is required' : null),
      baseUrl: (value) => {
        if (!value.trim()) return 'URL is required';
        try {
          new URL(value);
          return null;
        } catch {
          return 'Invalid URL';
        }
      },
    },
  });

  const fetchServers = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      const res = await fetch('/api/inference-monitoring/servers');
      if (res.ok) {
        const data = await res.json();
        setServers(data.servers || []);
      }
    } catch (err) {
      console.error('Failed to fetch servers:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  const handleCreate = async (values: typeof form.values) => {
    try {
      setCreating(true);
      const res = await fetch('/api/inference-monitoring/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create server');
      }

      notifications.show({
        title: 'Success',
        message: t('serverCreated'),
        color: 'teal',
      });
      form.reset();
      addHandlers.close();
      await fetchServers();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to create server',
        color: 'red',
      });
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <Center h={400}>
        <Loader size="lg" color="teal" />
      </Center>
    );
  }

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconServerBolt size={18} />}
        title={tNav('inferenceMonitoring')}
        subtitle={t('subtitle')}
        actions={
          <>
            <Button
              variant="light"
              size="xs"
              onClick={() => fetchServers(true)}
              loading={refreshing}
              leftSection={<IconRefresh size={14} />}
            >
              Refresh
            </Button>
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={addHandlers.open}
            >
              {t('addServer')}
            </Button>
          </>
        }
      />

      {servers.length === 0 ? (
        <Paper p="xl" radius="lg" withBorder>
          <Center py="xl">
            <Stack gap="md" align="center">
              <ThemeIcon size={60} radius="xl" variant="light" color="gray">
                <IconServerBolt size={30} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                {t('noServers')}
              </Text>
              <Button
                variant="light"
                leftSection={<IconPlus size={14} />}
                onClick={addHandlers.open}
              >
                {t('addServer')}
              </Button>
            </Stack>
          </Center>
        </Paper>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {servers.map((server) => (
            <Paper
              key={server.key}
              withBorder
              radius="lg"
              p="lg"
              style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
              onClick={() => router.push(`/dashboard/inference-monitoring/${encodeURIComponent(server.key)}`)}
            >
              <Stack gap="sm">
                <Group justify="space-between" align="center">
                  <Group gap="sm">
                    <ThemeIcon size={36} radius="md" variant="light" color={statusColor(server.status)}>
                      <StatusIcon status={server.status} />
                    </ThemeIcon>
                    <div>
                      <Text fw={600} lineClamp={1}>{server.name}</Text>
                      <Text size="xs" c="dimmed">{server.type.toUpperCase()}</Text>
                    </div>
                  </Group>
                  <Badge size="sm" variant="light" radius="xl" color={statusColor(server.status)}>
                    {server.status.toUpperCase()}
                  </Badge>
                </Group>

                <Text size="xs" c="dimmed" lineClamp={1} ff="monospace">
                  {server.baseUrl}
                </Text>

                <Group gap="lg">
                  <Text size="xs" c="dimmed">
                    <IconActivity size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                    Every {server.pollIntervalSeconds}s
                  </Text>
                  {server.lastPolledAt && (
                    <Text size="xs" c="dimmed">
                      Last: {dayjs(server.lastPolledAt).fromNow()}
                    </Text>
                  )}
                </Group>

                {server.lastError && (
                  <Text size="xs" c="red" lineClamp={2}>
                    {server.lastError}
                  </Text>
                )}
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}

      {/* Add Server Modal */}
      <Modal
        opened={addOpened}
        onClose={addHandlers.close}
        title={t('addServer')}
        size="md"
      >
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="md">
            <TextInput
              label={t('serverName')}
              placeholder={t('form.namePlaceholder')}
              required
              {...form.getInputProps('name')}
            />
            <Select
              label={t('serverType')}
              data={[{ value: 'vllm', label: 'vLLM' }]}
              required
              {...form.getInputProps('type')}
            />
            <TextInput
              label={t('baseUrl')}
              placeholder={t('form.urlPlaceholder')}
              required
              {...form.getInputProps('baseUrl')}
            />
            <TextInput
              label={t('apiKey')}
              placeholder={t('form.apiKeyPlaceholder')}
              {...form.getInputProps('apiKey')}
            />
            <NumberInput
              label={t('pollInterval')}
              description={t('form.pollIntervalHelp')}
              min={10}
              max={3600}
              {...form.getInputProps('pollIntervalSeconds')}
            />
            <Group justify="flex-end" mt="md">
              <Button variant="light" onClick={addHandlers.close}>
                Cancel
              </Button>
              <Button type="submit" loading={creating}>
                {t('addServer')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
