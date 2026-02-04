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
import { IconChartBar, IconEdit, IconEye, IconPlug, IconPlus, IconRefresh, IconTool, IconSparkles, IconBrain, IconCpu } from '@tabler/icons-react';
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

  const renderModelTable = (records: ModelDto[], category: 'llm' | 'embedding') => (
    <Paper withBorder radius="lg" style={{ overflow: 'hidden' }}>
      <Table highlightOnHover verticalSpacing="md" horizontalSpacing="md">
        <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
          <Table.Tr>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.name')}</Table.Th>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.provider')}</Table.Th>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.modelId')}</Table.Th>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.capabilities')}</Table.Th>
            <Table.Th style={{ fontWeight: 600 }}>{t('list.columns.pricing')}</Table.Th>
            <Table.Th style={{ width: 80, textAlign: 'center', fontWeight: 600 }}>
              {t('list.columns.actions')}
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {records.length === 0 && !loading ? (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Center py="xl">
                  <Stack gap="md" align="center">
                    <ThemeIcon size={60} radius="xl" variant="light" color={category === 'llm' ? 'blue' : 'violet'}>
                      {category === 'llm' ? <IconBrain size={30} /> : <IconCpu size={30} />}
                    </ThemeIcon>
                    <Stack gap={4} align="center">
                      <Text size="sm" fw={500}>
                        {t('list.empty')}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Add your first {category === 'llm' ? 'LLM' : 'embedding'} model to get started
                      </Text>
                    </Stack>
                    <Button onClick={openCreateModal} leftSection={<IconPlus size={16} />} variant="light" color={category === 'llm' ? 'blue' : 'violet'}>
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
              style={{ cursor: 'pointer', transition: 'background-color 0.15s ease' }}
            >
              <Table.Td>
                <Group gap="sm">
                  <ThemeIcon size={36} radius="md" variant="light" color={model.category === 'llm' ? 'blue' : 'violet'}>
                    {model.category === 'llm' ? <IconBrain size={18} /> : <IconCpu size={18} />}
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Text fw={600} size="sm">{model.name}</Text>
                    {model.description ? (
                      <Text size="xs" c="dimmed" lineClamp={1} style={{ maxWidth: 200 }}>
                        {model.description}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed" ff="monospace">{model.key}</Text>
                    )}
                  </Stack>
                </Group>
              </Table.Td>
              <Table.Td>
                <Badge 
                  color="gray" 
                  variant="light" 
                  size="sm"
                  leftSection={<IconPlug size={10} />}
                >
                  {providerLookup.get(model.providerKey)?.label || model.provider || model.providerKey}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" ff="monospace" style={{ backgroundColor: 'var(--mantine-color-gray-0)', padding: '4px 8px', borderRadius: 4, display: 'inline-block' }}>
                  {model.modelId}
                </Text>
              </Table.Td>
              <Table.Td>
                <Group gap={6}>
                  {model.isMultimodal ? (
                    <Tooltip label={t('list.capabilities.multimodal')} withArrow>
                      <ThemeIcon size={24} radius="md" variant="light" color="teal">
                        <IconEye size={12} />
                      </ThemeIcon>
                    </Tooltip>
                  ) : null}
                  {model.supportsToolCalls ? (
                    <Tooltip label={t('list.capabilities.tools')} withArrow>
                      <ThemeIcon size={24} radius="md" variant="light" color="orange">
                        <IconTool size={12} />
                      </ThemeIcon>
                    </Tooltip>
                  ) : null}
                  {!model.isMultimodal && !model.supportsToolCalls && (
                    <Text size="xs" c="dimmed">—</Text>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>{renderPricing(model.pricing)}</Table.Td>
              <Table.Td>
                <Center>
                  <Menu withinPortal position="bottom-end" withArrow>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        radius="md"
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
        <Center py="lg">
          <Loader size="sm" color="teal" />
        </Center>
      ) : null}
    </Paper>
  );

  return (
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}>
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'teal', to: 'cyan', deg: 135 }}>
              <IconBrain size={26} />
            </ThemeIcon>
            <div>
              <Title order={2}>{tNav('models')}</Title>
              <Text size="sm" c="dimmed" mt={4}>
                {t('list.subtitle')}
              </Text>
            </div>
          </Group>
          <Group gap="xs">
            <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={loadModels}>
              {t('actions.refresh')}
            </Button>
            <Button 
              onClick={openCreateModal} 
              leftSection={<IconPlus size={16} />}
              variant="gradient"
              gradient={{ from: 'teal', to: 'cyan', deg: 90 }}>
              {t('actions.create')}
            </Button>
          </Group>
        </Group>
      </Paper>

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Paper withBorder radius="lg" p="lg" style={{ transition: 'all 0.2s ease' }}>
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                {t('metrics.totalModels')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {models.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="gray">
              <IconSparkles size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg" style={{ transition: 'all 0.2s ease' }}>
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                {t('metrics.llmModels')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {llmModels.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconBrain size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg" style={{ transition: 'all 0.2s ease' }}>
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                {t('metrics.embeddingModels')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="cyan">
                {embeddingModels.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="cyan">
              <IconCpu size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg" style={{ transition: 'all 0.2s ease' }}>
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                {t('metrics.providers')}
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {providers.length}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconPlug size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      <Stack gap="lg">
        <Paper p="lg" radius="lg" withBorder>
          <Group gap="sm" mb="md">
            <ThemeIcon variant="gradient" gradient={{ from: 'teal', to: 'cyan', deg: 90 }} radius="md" size="lg">
              <IconBrain size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="md">{t('list.sections.llm')}</Text>
              <Text size="xs" c="dimmed">Large Language Models for chat and completion</Text>
            </div>
            <Badge variant="filled" color="teal" size="lg" ml="auto">{llmModels.length}</Badge>
          </Group>
          {renderModelTable(llmModels, 'llm')}
        </Paper>

        <Paper p="lg" radius="lg" withBorder>
          <Group gap="sm" mb="md">
            <ThemeIcon variant="gradient" gradient={{ from: 'teal', to: 'cyan', deg: 90 }} radius="md" size="lg">
              <IconCpu size={20} />
            </ThemeIcon>
            <div>
              <Text fw={600} size="md">{t('list.sections.embedding')}</Text>
              <Text size="xs" c="dimmed">Embedding models for vector representations</Text>
            </div>
            <Badge variant="filled" color="teal" size="lg" ml="auto">{embeddingModels.length}</Badge>
          </Group>
          {renderModelTable(embeddingModels, 'embedding')}
        </Paper>
      </Stack>

      <CreateModelModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        onCreated={handleModelCreated}
      />
    </Stack>
  );
}
