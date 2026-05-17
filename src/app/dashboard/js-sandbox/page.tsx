'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconCode,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import type { JsSandboxRuntimeView } from '@/lib/services/jsSandbox/types';

interface LibraryDescriptor {
  key: string;
  label: string;
  description: string;
}

interface CreateRuntimeForm {
  name: string;
  key: string;
  description: string;
  libraries: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  memoryLimitMb: number;
  maxCodeSizeBytes: number;
}

type StatusFilter = 'all' | 'active' | 'disabled';

const DEFAULT_CODE_SIZE = 64 * 1024;

export default function JsSandboxPage() {
  const [runtimes, setRuntimes] = useState<JsSandboxRuntimeView[]>([]);
  const [libraries, setLibraries] = useState<LibraryDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<JsSandboxRuntimeView | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [createOpened, createHandlers] = useDisclosure(false);

  const form = useForm<CreateRuntimeForm>({
    initialValues: {
      name: '',
      key: '',
      description: '',
      libraries: ['std:collections', 'std:math'],
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 30_000,
      memoryLimitMb: 64,
      maxCodeSizeBytes: DEFAULT_CODE_SIZE,
    },
    validate: {
      name: (value) => (value.trim().length < 2 ? 'Name is required' : null),
      key: (value) =>
        value.trim().length > 0 && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.trim())
          ? 'Use lowercase kebab-case'
          : null,
      maxTimeoutMs: (value, values) =>
        value < values.defaultTimeoutMs ? 'Max timeout must be greater than default timeout' : null,
    },
  });

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runtimeRes, librariesRes] = await Promise.all([
        fetch('/api/js-sandbox/runtimes', { cache: 'no-store' }),
        fetch('/api/js-sandbox/libraries', { cache: 'no-store' }),
      ]);
      if (!runtimeRes.ok) throw new Error('Failed to load JS runtimes');
      const runtimeBody = (await runtimeRes.json()) as { runtimes?: JsSandboxRuntimeView[] };
      const librariesBody = librariesRes.ok
        ? ((await librariesRes.json()) as { libraries?: LibraryDescriptor[] })
        : { libraries: [] };
      setRuntimes(runtimeBody.runtimes ?? []);
      setLibraries(librariesBody.libraries ?? []);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to load JS Sandbox',
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const summary = useMemo(() => {
    const active = runtimes.filter((runtime) => runtime.status === 'active').length;
    return {
      total: runtimes.length,
      active,
      disabled: runtimes.length - active,
      libraries: new Set(runtimes.flatMap((runtime) => runtime.libraries)).size,
    };
  }, [runtimes]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return runtimes.filter((runtime) => {
      if (statusFilter !== 'all' && runtime.status !== statusFilter) return false;
      if (!term) return true;
      return [
        runtime.name,
        runtime.key,
        runtime.description ?? '',
        runtime.libraries.join(' '),
      ].join(' ').toLowerCase().includes(term);
    });
  }, [runtimes, search, statusFilter]);

  async function handleCreate(values: CreateRuntimeForm) {
    setCreating(true);
    try {
      const res = await fetch('/api/js-sandbox/runtimes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          key: values.key.trim() || undefined,
          description: values.description.trim() || undefined,
          libraries: values.libraries,
          limits: {
            defaultTimeoutMs: values.defaultTimeoutMs,
            maxTimeoutMs: values.maxTimeoutMs,
            memoryLimitMb: values.memoryLimitMb,
            maxCodeSizeBytes: values.maxCodeSizeBytes,
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to create runtime');
      notifications.show({ color: 'teal', title: 'Created', message: 'JS runtime created' });
      form.reset();
      createHandlers.close();
      await load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to create runtime',
      });
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/js-sandbox/runtimes/${encodeURIComponent(deleteTarget.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to delete runtime');
      }
      notifications.show({ color: 'teal', title: 'Deleted', message: 'JS runtime removed' });
      setDeleteTarget(null);
      await load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to delete runtime',
      });
    }
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · JS Sandbox"
        title="JS Sandbox"
        subtitle="Create managed JavaScript runtimes and execute code through the console or client API."
        actions={
          <Group gap="xs">
            <Tooltip label="Refresh">
              <ActionIcon variant="subtle" onClick={load} loading={refreshing}>
                <IconRefresh size={16} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
            <Button variant="default" leftSection={<IconPlus size={14} stroke={1.7} />} size="sm" onClick={createHandlers.open}>
              New Runtime
            </Button>
          </Group>
        }
      />

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Summary label="Runtimes" value={summary.total} color="indigo" />
        <Summary label="Active" value={summary.active} color="teal" />
        <Summary label="Disabled" value={summary.disabled} color="gray" />
        <Summary label="Libraries" value={summary.libraries} color="blue" />
      </SimpleGrid>

      <Paper withBorder p="md" radius="lg">
        <Group justify="space-between" wrap="wrap">
          <TextInput
            placeholder="Search runtime, key or library"
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            size="xs"
            style={{ minWidth: 280 }}
          />
          <SegmentedControl
            size="xs"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
            data={[
              { label: 'All', value: 'all' },
              { label: 'Active', value: 'active' },
              { label: 'Disabled', value: 'disabled' },
            ]}
          />
        </Group>
      </Paper>

      {loading ? (
        <Paper withBorder p="xl" radius="lg">
          <Group justify="center">
            <Loader size="sm" />
          </Group>
        </Paper>
      ) : filtered.length === 0 ? (
        <Paper withBorder p="xl" radius="lg">
          <Stack align="center" gap="sm">
            <ThemeIcon size={52} radius="xl" variant="light" color="indigo">
              <IconCode size={26} />
            </ThemeIcon>
            <Text fw={600}>{runtimes.length === 0 ? 'No JS runtimes yet' : 'No runtimes match your filter'}</Text>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={createHandlers.open}>
              Create runtime
            </Button>
          </Stack>
        </Paper>
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          {filtered.map((runtime) => (
            <Paper key={runtime.id} withBorder p="md" radius="lg">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <ThemeIcon size={38} radius="md" variant="light" color="indigo">
                    <IconCode size={20} />
                  </ThemeIcon>
                  <div style={{ minWidth: 0 }}>
                    <Text
                      component={Link}
                      href={`/dashboard/js-sandbox/${runtime.id}`}
                      fw={600}
                      size="sm"
                      lineClamp={1}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      {runtime.name}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {runtime.key}
                    </Text>
                  </div>
                </Group>
                <Group gap={4}>
                  <Tooltip label="Open settings">
                    <ActionIcon
                      component={Link}
                      href={`/dashboard/js-sandbox/${runtime.id}?tab=settings`}
                      variant="subtle"
                      color="gray"
                      size="sm"
                    >
                      <IconSettings size={14} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Delete">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      onClick={() => setDeleteTarget(runtime)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>

              <Text size="sm" c="dimmed" lineClamp={2} mt="sm">
                {runtime.description || 'No description'}
              </Text>

              <Group gap={6} wrap="wrap" mt="md">
                <Badge variant="light" color={runtime.status === 'active' ? 'teal' : 'gray'}>
                  {runtime.status}
                </Badge>
                <Badge variant="light" color="indigo">
                  {runtime.engine}
                </Badge>
                <Badge variant="light" color="blue">
                  {runtime.limits.memoryLimitMb} MB
                </Badge>
                <Badge variant="light" color="gray">
                  {runtime.limits.defaultTimeoutMs} ms
                </Badge>
              </Group>

              <Group gap={6} wrap="wrap" mt="sm">
                {runtime.libraries.length === 0 ? (
                  <Text size="xs" c="dimmed">No libraries selected</Text>
                ) : runtime.libraries.map((library: string) => (
                  <Badge key={library} variant="light" color="gray">
                    {library}
                  </Badge>
                ))}
              </Group>
            </Paper>
          ))}
        </SimpleGrid>
      )}

      <Modal opened={createOpened} onClose={createHandlers.close} title="Create JS runtime" size="lg">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <TextInput label="Name" withAsterisk {...form.getInputProps('name')} />
            <TextInput label="Key" description="Optional lowercase identifier" {...form.getInputProps('key')} />
            <Textarea label="Description" minRows={2} {...form.getInputProps('description')} />

            <Checkbox.Group label="Libraries" {...form.getInputProps('libraries')}>
              <SimpleGrid cols={{ base: 1, sm: 2 }} mt="xs">
                {libraries.map((library) => (
                  <Checkbox
                    key={library.key}
                    value={library.key}
                    label={library.label}
                    description={library.description}
                  />
                ))}
              </SimpleGrid>
            </Checkbox.Group>

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput label="Default timeout" suffix=" ms" min={100} max={120_000} step={500} {...form.getInputProps('defaultTimeoutMs')} />
              <NumberInput label="Max timeout" suffix=" ms" min={100} max={120_000} step={500} {...form.getInputProps('maxTimeoutMs')} />
              <NumberInput label="Memory limit" suffix=" MB" min={8} max={512} step={8} {...form.getInputProps('memoryLimitMb')} />
              <NumberInput label="Max code size" suffix=" bytes" min={1_024} max={1024 * 1024} step={1_024} {...form.getInputProps('maxCodeSizeBytes')} />
            </SimpleGrid>

            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={createHandlers.close}>Cancel</Button>
              <Button type="submit" loading={creating}>Create</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal opened={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete JS runtime">
        <Stack gap="sm">
          <Text size="sm">
            Delete <Text span fw={600}>{deleteTarget?.name}</Text>? Execution history is kept for audit.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button color="red" onClick={confirmDelete}>Delete</Button>
          </Group>
        </Stack>
      </Modal>
    </PageContainer>
  );
}

function Summary({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Paper withBorder p="md" radius="lg">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
      <Text fw={700} size="xl" mt={4} c={color}>{value}</Text>
    </Paper>
  );
}
