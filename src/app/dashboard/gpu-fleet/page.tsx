'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  List,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCpu,
  IconHeartbeat,
  IconRocket,
  IconAlertTriangle,
  IconArrowRight,
  IconBoxModel,
  IconCircleCheck,
  IconSparkles,
  IconStackPush,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import { GpuFleetApi } from './_lib/api';
import { formatRelative, statusColor } from './_lib/format';
import type { HostView } from './_lib/types';

interface HostsResponse {
  hosts: HostView[];
}

export default function GpuFleetOverviewPage() {
  const [hosts, setHosts] = useState<HostView[]>([]);
  const [pending, setPending] = useState<HostView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [all, pendingResp] = await Promise.all([
        GpuFleetApi.listHosts<HostsResponse>(),
        GpuFleetApi.listPendingClaim<HostsResponse>(),
      ]);
      setHosts(all.hosts);
      setPending(pendingResp.hosts);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to load fleet',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), 10_000);
    return () => clearInterval(id);
  }, [load]);

  const stats = useMemo(() => {
    const claimed = hosts.filter((h) => h.status !== 'pending_claim');
    const online = claimed.filter((h) => h.status === 'online').length;
    const offline = claimed.filter((h) => h.status === 'offline').length;
    const totalGpus = hosts.reduce((acc, h) => {
      const gpus = (h.inventory?.gpus as unknown[] | undefined)?.length ?? 0;
      return acc + gpus;
    }, 0);
    return {
      hostsTotal: claimed.length,
      online,
      offline,
      pending: pending.length,
      totalGpus,
    };
  }, [hosts, pending]);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · GPU Fleet"
        title="GPU Fleet"
        subtitle="Hosts, slices, deployments, and pools — managed from one place."
        actions={
          <Group>
            <Button component={Link} href="/dashboard/gpu-fleet/onboarding" leftSection={<IconRocket size={16} />}>
              Onboard hosts
            </Button>
          </Group>
        }
      />

      <SimpleGrid cols={{ base: 2, md: 5 }} spacing="md" mb="md">
        <StatTile label="Hosts" value={stats.hostsTotal} icon={<IconCpu size={18} />} />
        <StatTile label="Online" value={stats.online} icon={<IconHeartbeat size={18} />} />
        <StatTile label="Offline" value={stats.offline} icon={<IconAlertTriangle size={18} />} />
        <StatTile label="Pending claim" value={stats.pending} icon={<IconRocket size={18} />} />
        <StatTile label="GPUs total" value={stats.totalGpus} icon={<IconCpu size={18} />} />
      </SimpleGrid>

      {pending.length > 0 ? (
        <Card mb="md" withBorder>
          <Group justify="space-between" mb="xs">
            <Title order={5}>
              {pending.length} host{pending.length === 1 ? '' : 's'} awaiting claim
            </Title>
            <Anchor component={Link} href="/dashboard/gpu-fleet/onboarding" size="sm">
              Open onboarding →
            </Anchor>
          </Group>
          <Text size="sm" c="dimmed">
            Agents connected via the fleet token but have not been promoted yet. Claim them to begin issuing deployments.
          </Text>
        </Card>
      ) : null}

      {hosts.length === 0 && pending.length === 0 && !loading ? (
        <Card withBorder p="lg">
          <Stack gap="md" align="center">
            <ThemeIcon size="xl" radius="xl" variant="light">
              <IconSparkles size={28} />
            </ThemeIcon>
            <Title order={4}>Welcome to GPU Fleet</Title>
            <Text c="dimmed" ta="center" size="sm" maw={520}>
              Connect your GPU machines to the console and deploy models end-to-end.
              Follow these three steps to get started:
            </Text>
            <List
              spacing="xs"
              size="sm"
              center
              icon={
                <ThemeIcon color="blue" size={20} radius="xl">
                  <IconArrowRight size={12} />
                </ThemeIcon>
              }
              maw={520}
            >
              <List.Item>
                Generate an install command in the <strong>Onboarding</strong> tab and run it on each GPU host.
              </List.Item>
              <List.Item>
                Claim incoming <strong>pending</strong> hosts (give them a name, opt-in to terminal access).
              </List.Item>
              <List.Item>
                Pick a model from the <strong>Model Marketplace</strong> and deploy from the host detail page.
                Use <strong>Pools → Bulk deploy</strong> to roll the same model onto many hosts at once.
              </List.Item>
            </List>
            <Group>
              <Button
                component={Link}
                href="/dashboard/gpu-fleet/onboarding"
                leftSection={<IconRocket size={14} />}
              >
                Go to onboarding
              </Button>
              <Button
                component={Link}
                href="/dashboard/gpu-fleet/models"
                variant="default"
                leftSection={<IconBoxModel size={14} />}
              >
                Browse catalog
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : (
        <Card withBorder>
          <Group justify="space-between" mb="md">
            <Title order={5}>Hosts</Title>
            <Badge color="gray" variant="light">
              {loading ? '…' : `${hosts.length} total`}
            </Badge>
          </Group>
          {hosts.length === 0 ? (
            <Alert color="blue" icon={<IconCircleCheck size={16} />}>
              No claimed hosts yet. {pending.length} host{pending.length === 1 ? '' : 's'} waiting to be claimed in the Onboarding tab.
            </Alert>
          ) : (
            <Stack gap="xs">
              {hosts.map((h) => <HostRow key={h.id} host={h} />)}
            </Stack>
          )}
          {hosts.length > 0 ? (
            <Group mt="md" gap="xs">
              <Button
                component={Link}
                href="/dashboard/gpu-fleet/pools"
                size="xs"
                variant="default"
                leftSection={<IconStackPush size={14} />}
              >
                Manage pools
              </Button>
              <Button
                component={Link}
                href="/dashboard/gpu-fleet/models"
                size="xs"
                variant="default"
                leftSection={<IconBoxModel size={14} />}
              >
                Model marketplace
              </Button>
            </Group>
          ) : null}
        </Card>
      )}
    </PageContainer>
  );
}

function HostRow({ host }: { host: HostView }) {
  const accelerator = (host.inventory?.accelerator as string | undefined) ?? 'cpu';
  const gpuCount = ((host.inventory?.gpus as unknown[] | undefined)?.length) ?? 0;
  return (
    <Link
      href={`/dashboard/gpu-fleet/hosts/${host.id}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <Card withBorder padding="sm">
        <Group justify="space-between">
          <Group gap="md">
            <Badge color={statusColor(host.status)} variant="dot">
              {host.status}
            </Badge>
            <Stack gap={2}>
              <Text fw={600} size="sm">{host.name}</Text>
              <Text size="xs" c="dimmed">
                <Code>{accelerator}</Code> · {gpuCount} GPU · agent v{host.agentVersion ?? '?'}
              </Text>
            </Stack>
          </Group>
          <Text size="xs" c="dimmed">
            heartbeat {formatRelative(host.lastHeartbeatAt)}
          </Text>
        </Group>
      </Card>
    </Link>
  );
}
