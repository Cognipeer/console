'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconChartBar, IconEdit, IconEye, IconPlug, IconPlus, IconRefresh, IconTool } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { ModelProviderView } from '@/lib/services/models/types';
import CreateModelModal from '@/components/models/CreateModelModal';
import type { IModel } from '@/lib/database';

interface ModelPricing {
  currency?: string;
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
}

interface ModelDto {
  _id: string;
  name: string;
  description?: string;
  key: string;
  provider?: string; // deprecated legacy field
  providerKey: string;
  providerDriver: string;
  category: 'llm' | 'embedding';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  pricing: ModelPricing;
  settings: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const t = useTranslations('models');
  const tNav = useTranslations('navigation');
  const router = useRouter();

  const loadModels = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/models?includeProviders=true', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Failed to load models');
      }
      const data = await response.json();
      setModels((data.models ?? []) as ModelDto[]);
      setProviders((data.providers ?? []) as ModelProviderView[]);
    } catch (error) {
      console.error('Failed to load models', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const openCreateModal = () => {
    setCreateModalOpen(true);
  };

  const handleProviderCreated = (provider: ModelProviderView) => {
    setProviders((current) => {
      const filtered = current.filter((existing) => existing.key !== provider.key);
      const next = [...filtered, provider];
      next.sort((a, b) => a.label.localeCompare(b.label));
      return next;
    });
  };

  const handleModelCreated = ({ model, provider }: { model: IModel; provider: ModelProviderView }) => {
    const normalized: ModelDto = {
      _id: String(model._id ?? crypto.randomUUID()),
      name: model.name,
      description: model.description,
      key: model.key,
      provider: model.provider,
      providerKey: model.providerKey,
      providerDriver: model.providerDriver,
      category: model.category,
      modelId: model.modelId,
      isMultimodal: model.isMultimodal,
      supportsToolCalls: model.supportsToolCalls,
      pricing: model.pricing as ModelPricing,
      settings: model.settings ?? {},
      createdAt: model.createdAt ? String(model.createdAt) : undefined,
      updatedAt: model.updatedAt ? String(model.updatedAt) : undefined,
    };

    setModels((current) => {
      const filtered = current.filter((existing) => existing._id !== normalized._id);
      return [normalized, ...filtered];
    });
    setProviders((current) => {
      if (current.some((existing) => existing.key === provider.key)) {
        return current;
      }
      return [...current, provider];
    });
    loadModels();
  };

  const llmModels = useMemo(() => models.filter((model) => model.category === 'llm'), [models]);
  const embeddingModels = useMemo(() => models.filter((model) => model.category === 'embedding'), [models]);
  const providerLookup = useMemo(() => {
    const map = new Map<string, ModelProviderView>();
    providers.forEach((provider) => {
      map.set(provider.key, provider);
    });
    return map;
  }, [providers]);

  const renderPricing = (pricing: ModelPricing) => {
    const currency = pricing.currency || 'USD';
    return (
      <Stack gap={3}>
        <Text size="xs" c="dimmed">
          In: {pricing.inputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}/1M
        </Text>
        <Text size="xs" c="dimmed">
          Out: {pricing.outputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}/1M
        </Text>
        {pricing.cachedTokenPer1M ? (
          <Text size="xs" c="dimmed">
            Cache: {pricing.cachedTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}/1M
          </Text>
        ) : null}
      </Stack>
    );
  };

  const renderModelTable = (records: ModelDto[]) => (
    <Paper withBorder radius="md" p="md">
      <Table highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('list.columns.name')}</Table.Th>
            <Table.Th>{t('list.columns.provider')}</Table.Th>
            <Table.Th>{t('list.columns.key')}</Table.Th>
            <Table.Th>{t('list.columns.modelId')}</Table.Th>
            <Table.Th>{t('list.columns.capabilities')}</Table.Th>
            <Table.Th>{t('list.columns.pricing')}</Table.Th>
            <Table.Th style={{ width: 80 }}>
              <Center>{t('list.columns.actions')}</Center>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {records.length === 0 && !loading ? (
            <Table.Tr>
              <Table.Td colSpan={7}>
                <Center py="lg">
                  <Stack gap="xs" align="center">
                    <Text size="sm" c="dimmed">
                      {t('list.empty')}
                    </Text>
                    <Button onClick={openCreateModal} leftSection={<IconPlus size={16} />} variant="light">
                      {t('actions.create')}
                    </Button>
                  </Stack>
                </Center>
              </Table.Td>
            </Table.Tr>
          ) : null}
          {records.map((model) => (
            <Table.Tr
              key={model._id}
              onClick={() => router.push(`/dashboard/models/${model._id}`)}
              style={{ cursor: 'pointer' }}
            >
              <Table.Td>
                <Stack gap={4}>
                  <Group gap={6}>
                    <Text fw={500} size="sm">{model.name}</Text>
                    <Badge variant="light" color={model.category === 'llm' ? 'blue' : 'gray'} size="sm">
                      {model.category === 'llm' ? t('list.badges.llm') : t('list.badges.embedding')}
                    </Badge>
                  </Group>
                  {model.description ? (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {model.description}
                    </Text>
                  ) : null}
                </Stack>
              </Table.Td>
              <Table.Td>
                <Badge color="gray" variant="light" size="sm">
                  {providerLookup.get(model.providerKey)?.label || model.provider || model.providerKey}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" ff="monospace">{model.key}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">{model.modelId}</Text>
              </Table.Td>
              <Table.Td>
                <Group gap={4}>
                  {model.isMultimodal ? (
                    <Tooltip label={t('list.capabilities.multimodal')}>
                      <ThemeIcon size={20} radius="md" variant="light" color="gray">
                        <IconEye size={12} />
                      </ThemeIcon>
                    </Tooltip>
                  ) : null}
                  {model.supportsToolCalls ? (
                    <Tooltip label={t('list.capabilities.tools')}>
                      <ThemeIcon size={20} radius="md" variant="light" color="gray">
                        <IconTool size={12} />
                      </ThemeIcon>
                    </Tooltip>
                  ) : null}
                </Group>
              </Table.Td>
              <Table.Td>{renderPricing(model.pricing)}</Table.Td>
              <Table.Td>
                <Center>
                  <Menu withinPortal position="bottom-end">
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <IconChartBar size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        component={Link}
                        href={`/dashboard/models/${model._id}`}
                        leftSection={<IconEye size={14} />}
                      >
                        {t('actions.viewDetails')}
                      </Menu.Item>
                      <Menu.Item
                        component={Link}
                        href={`/dashboard/models/${model._id}/edit`}
                        leftSection={<IconEdit size={14} />}
                      >
                        {t('actions.edit')}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Center>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {loading ? (
        <Center py="md">
          <Loader size="sm" />
        </Center>
      ) : null}
    </Paper>
  );

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>{tNav('models')}</Title>
          <Text size="sm" c="dimmed" mt={4}>
            {t('list.subtitle')}
          </Text>
        </div>
        <Group gap="xs">
          <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={loadModels}>
            {t('actions.refresh')}
          </Button>
          <Button onClick={openCreateModal} leftSection={<IconPlug size={16} />}>
            {t('actions.create')}
          </Button>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
        <Paper withBorder radius="md" p="md">
          <Stack gap={4}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={500}>
              {t('metrics.totalModels')}
            </Text>
            <Text fw={600} size="xl">
              {models.length}
            </Text>
          </Stack>
        </Paper>
        <Paper withBorder radius="md" p="md">
          <Stack gap={4}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={500}>
              {t('metrics.llmModels')}
            </Text>
            <Text fw={600} size="xl">
              {llmModels.length}
            </Text>
          </Stack>
        </Paper>
        <Paper withBorder radius="md" p="md">
          <Stack gap={4}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={500}>
              {t('metrics.embeddingModels')}
            </Text>
            <Text fw={600} size="xl">
              {embeddingModels.length}
            </Text>
          </Stack>
        </Paper>
        <Paper withBorder radius="md" p="md">
          <Stack gap={4}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={500}>
              {t('metrics.providers')}
            </Text>
            <Text fw={600} size="xl">
              {providers.length}
            </Text>
          </Stack>
        </Paper>
      </SimpleGrid>

      <Stack gap="md">
        <Stack gap="sm">
          <Group gap="xs" align="center">
            <ThemeIcon variant="light" color="gray" radius="md" size="sm">
              <IconChartBar size={16} />
            </ThemeIcon>
            <Text fw={600} size="md">{t('list.sections.llm')}</Text>
            <Badge variant="light" color="gray" size="sm">{llmModels.length}</Badge>
          </Group>
          {renderModelTable(llmModels)}
        </Stack>

        <Stack gap="sm">
          <Group gap="xs" align="center">
            <ThemeIcon variant="light" color="gray" radius="md" size="sm">
              <IconPlug size={16} />
            </ThemeIcon>
            <Text fw={600} size="md">{t('list.sections.embedding')}</Text>
            <Badge variant="light" color="gray" size="sm">{embeddingModels.length}</Badge>
          </Group>
          {renderModelTable(embeddingModels)}
        </Stack>
      </Stack>

      <CreateModelModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        onProviderCreated={handleProviderCreated}
        onCreated={handleModelCreated}
      />
    </Stack>
  );
}
