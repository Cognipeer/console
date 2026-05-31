'use client';

import { useCallback, useEffect, useState } from 'react';
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
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowRight, IconInfoCircle, IconRocket, IconStackPush, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { GpuFleetApi } from '../_lib/api';
import { formatRelative } from '../_lib/format';
import type { PoolView } from '../_lib/types';
import BulkDeployModal from './BulkDeployModal';

export default function GpuFleetPoolsPage() {
  const [pools, setPools] = useState<PoolView[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await GpuFleetApi.listPools<{ pools: PoolView[] }>();
      setPools(data.pools);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to load pools',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 8_000);
    return () => clearInterval(id);
  }, [load]);

  const deletePool = async (key: string) => {
    if (!confirm(`Delete pool "${key}"? Member deployments stay running.`)) return;
    try {
      await GpuFleetApi.deletePool(key);
      notifications.show({ color: 'gray', title: 'Pool deleted', message: key });
      void load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Delete failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · GPU Fleet · Pools"
        title="Model pools"
        subtitle="Group identical deployments behind a single OpenAI-compatible endpoint with load balancing."
        actions={
          <Button leftSection={<IconRocket size={14} />} onClick={() => setBulkOpen(true)}>
            Bulk deploy model
          </Button>
        }
      />

      {pools.length === 0 ? (
        <Card withBorder p="lg">
          <Stack gap="md" align="center">
            <ThemeIcon size="xl" radius="xl" variant="light">
              <IconStackPush size={28} />
            </ThemeIcon>
            <Title order={5}>What is a pool?</Title>
            <Text c="dimmed" ta="center" size="sm" maw={560}>
              When the same model runs on multiple hosts, a pool puts them behind a single
              OpenAI-compatible endpoint with load balancing. Your apps see one URL —
              GPU Fleet handles request distribution behind the scenes.
            </Text>
            <List
              spacing="xs"
              size="sm"
              center
              maw={560}
              icon={
                <ThemeIcon size={20} radius="xl" color="blue">
                  <IconArrowRight size={12} />
                </ThemeIcon>
              }
            >
              <List.Item>
                <strong>Bulk deploy</strong> — pick a model + N hosts, create deployments + pool atomically. <em>Recommended.</em>
              </List.Item>
              <List.Item>
                Already running the same model on different hosts? Create an empty pool and use
                &quot;Add member&quot; to attach the existing deployments.
              </List.Item>
            </List>
            <Group>
              <Button leftSection={<IconRocket size={14} />} onClick={() => setBulkOpen(true)}>
                Start bulk deploy
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : (
        <Stack gap="sm">
          {pools.map((pool) => (
            <Card key={pool.key} withBorder>
              <Group justify="space-between" align="flex-start">
                <Stack gap={4}>
                  <Group gap="xs">
                    <IconStackPush size={18} />
                    <Anchor component={Link} href={`/dashboard/gpu-fleet/pools/${pool.key}`} fw={600}>
                      {pool.name}
                    </Anchor>
                    <Badge color="blue" variant="light" size="sm">{pool.algorithm}</Badge>
                    <Badge color={pool.status === 'active' ? 'teal' : 'gray'} variant="light" size="sm">
                      {pool.status}
                    </Badge>
                    {pool.providerKey ? (
                      <Badge color="violet" variant="light" size="sm">in Model Hub</Badge>
                    ) : null}
                  </Group>
                  <Text size="xs" c="dimmed">
                    model: <Code>{pool.modelName}</Code> · {pool.deploymentIds.length} member
                    {pool.deploymentIds.length === 1 ? '' : 's'} · created {formatRelative(pool.createdAt)}
                  </Text>
                </Stack>
                <Button
                  variant="default"
                  size="xs"
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => deletePool(pool.key)}
                >
                  Delete
                </Button>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      <BulkDeployModal
        opened={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDeployed={() => {
          setBulkOpen(false);
          void load();
        }}
      />
    </PageContainer>
  );
}
