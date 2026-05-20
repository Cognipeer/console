'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  ActionIcon,
  Badge,
  Code,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCircuitChangeover,
  IconRefresh,
  IconRestore,
  IconSearch,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import type {
  INodeRecord,
  InstanceAssignmentMode,
  InstanceEntityType,
} from '@/lib/core/cluster';

interface AssignableInstance {
  entityType: InstanceEntityType;
  entityId: string;
  name: string;
  subtitle?: string;
  tenantId: string;
  tenantSlug: string;
  projectId?: string | null;
  nodeName: string;
  mode: InstanceAssignmentMode;
  explicit: boolean;
}

interface ClusterOverview {
  thisNodeName: string;
  defaultNodeName: string;
  nodes: INodeRecord[];
}

const ENTITY_LABELS: Record<InstanceEntityType, string> = {
  agent: 'Agents',
  mcp: 'MCP Servers',
  browser: 'Browsers',
  'js-sandbox': 'JS Sandboxes',
  'inference-server': 'Inference Servers',
  'alert-rule': 'Alert Rules',
  automation: 'Automations',
  crawler: 'Crawlers',
};

const ENTITY_ORDER: InstanceEntityType[] = [
  'agent',
  'mcp',
  'browser',
  'js-sandbox',
  'inference-server',
  'alert-rule',
  'automation',
  'crawler',
];

export default function ClusterInstancesPage() {
  const [instances, setInstances] = useState<AssignableInstance[]>([]);
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);

  const reload = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const [instancesRes, overviewRes] = await Promise.all([
        fetch('/api/cluster/instances', { cache: 'no-store' }),
        fetch('/api/cluster/overview', { cache: 'no-store' }),
      ]);
      if (!instancesRes.ok || !overviewRes.ok) throw new Error('Failed to load cluster data');
      const instancesData = (await instancesRes.json()) as { instances: AssignableInstance[] };
      const overviewData = (await overviewRes.json()) as ClusterOverview;
      setInstances(instancesData.instances ?? []);
      setOverview(overviewData);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to load cluster data',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? instances.filter(
        (i) =>
          i.name.toLowerCase().includes(q)
          || i.entityId.toLowerCase().includes(q)
          || i.tenantSlug.toLowerCase().includes(q)
          || i.nodeName.toLowerCase().includes(q),
      )
      : instances;

    const map = new Map<InstanceEntityType, AssignableInstance[]>();
    for (const inst of filtered) {
      const list = map.get(inst.entityType) ?? [];
      list.push(inst);
      map.set(inst.entityType, list);
    }
    return map;
  }, [instances, query]);

  const onlineNodeOptions = useMemo(() => {
    if (!overview) return [];
    return overview.nodes
      .filter((n) => n.status !== 'offline')
      .map((n) => ({
        value: n.name,
        label: n.name === overview.defaultNodeName ? `${n.name} (default)` : n.name,
      }));
  }, [overview]);

  const assignNode = useCallback(
    async (inst: AssignableInstance, nodeName: string, mode: InstanceAssignmentMode) => {
      const key = `${inst.entityType}:${inst.entityId}`;
      setPending(key);
      try {
        const res = await fetch(
          `/api/cluster/assignments/${inst.entityType}/${encodeURIComponent(inst.entityId)}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ nodeName, mode }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Assignment failed');
        }
        notifications.show({
          color: 'teal',
          title: 'Assigned',
          message: `${inst.name} → ${nodeName} (${mode})`,
        });
        await reload(true);
      } catch (error) {
        notifications.show({
          color: 'red',
          title: 'Error',
          message: error instanceof Error ? error.message : 'Assignment failed',
        });
      } finally {
        setPending(null);
      }
    },
    [reload],
  );

  const resetAssignment = useCallback(
    async (inst: AssignableInstance) => {
      const key = `${inst.entityType}:${inst.entityId}`;
      setPending(key);
      try {
        const res = await fetch(
          `/api/cluster/assignments/${inst.entityType}/${encodeURIComponent(inst.entityId)}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Reset failed');
        }
        notifications.show({
          color: 'gray',
          title: 'Reset to default',
          message: inst.name,
        });
        await reload(true);
      } catch (error) {
        notifications.show({
          color: 'red',
          title: 'Error',
          message: error instanceof Error ? error.message : 'Reset failed',
        });
      } finally {
        setPending(null);
      }
    },
    [reload],
  );

  return (
    <PageContainer>
      <PageHeader
        title="Cluster Instances"
        subtitle="Assign individual service instances (agents, MCP servers, browsers, sandboxes, alert rules, inference servers) to specific cluster nodes."
        actions={(
          <Tooltip label="Refresh">
            <ActionIcon variant="default" onClick={() => reload(true)} loading={refreshing}>
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      />

      <Group mb="md" gap="sm" align="flex-end">
        <TextInput
          leftSection={<IconSearch size={14} />}
          placeholder="Search by name, tenant, node…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          style={{ minWidth: 320 }}
        />
        <Text size="xs" c="dimmed">
          Default node: <Code>{overview?.defaultNodeName || '—'}</Code>
        </Text>
      </Group>

      {loading ? (
        <Text c="dimmed">Loading…</Text>
      ) : instances.length === 0 ? (
        <Stack align="center" my="xl">
          <IconCircuitChangeover size={32} />
          <Text c="dimmed">No assignable instances yet.</Text>
        </Stack>
      ) : (
        <Accordion multiple defaultValue={ENTITY_ORDER as string[]}>
          {ENTITY_ORDER.filter((t) => (grouped.get(t)?.length ?? 0) > 0).map((entityType) => {
            const list = grouped.get(entityType) ?? [];
            return (
              <Accordion.Item key={entityType} value={entityType}>
                <Accordion.Control>
                  <Group justify="space-between" pr="md">
                    <Text fw={600}>{ENTITY_LABELS[entityType]}</Text>
                    <Badge variant="light">{list.length}</Badge>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    {list.map((inst) => {
                      const key = `${inst.entityType}:${inst.entityId}`;
                      const isPending = pending === key;
                      return (
                        <Group
                          key={key}
                          wrap="nowrap"
                          justify="space-between"
                          gap="md"
                          py={6}
                          px={10}
                          style={{
                            borderTop: '1px solid var(--mantine-color-default-border)',
                          }}
                        >
                          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                            <Group gap={6}>
                              <Text fw={500} truncate>{inst.name}</Text>
                              {!inst.explicit ? (
                                <Badge size="xs" variant="light" color="gray">default</Badge>
                              ) : null}
                            </Group>
                            <Text size="xs" c="dimmed" truncate>
                              {inst.subtitle ? `${inst.subtitle} · ` : ''}
                              {inst.tenantSlug}
                            </Text>
                          </Stack>

                          <Select
                            data={onlineNodeOptions}
                            value={inst.nodeName}
                            onChange={(value) => {
                              if (value && value !== inst.nodeName) {
                                void assignNode(inst, value, inst.mode);
                              }
                            }}
                            disabled={isPending}
                            style={{ width: 220 }}
                          />

                          <SegmentedControl
                            value={inst.mode}
                            onChange={(value) => {
                              if (value !== inst.mode && (value === 'strict' || value === 'preferred')) {
                                void assignNode(inst, inst.nodeName, value);
                              }
                            }}
                            data={[
                              { value: 'strict', label: 'Strict' },
                              { value: 'preferred', label: 'Preferred' },
                            ]}
                            size="xs"
                            disabled={isPending}
                          />

                          <Tooltip label="Reset to default (remove assignment)">
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              onClick={() => void resetAssignment(inst)}
                              disabled={!inst.explicit || isPending}
                            >
                              <IconRestore size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      );
                    })}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
        </Accordion>
      )}
    </PageContainer>
  );
}
