'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
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
  provider: string;
  category: 'llm' | 'embedding';
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  pricing: ModelPricing;
  settings: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface ProviderDefinitionDto {
  id: string;
  label: string;
  description: string;
  categories: Array<'llm' | 'embedding'>;
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [providers, setProviders] = useState<ProviderDefinitionDto[]>([]);
  const [loading, setLoading] = useState(true);
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
      setModels(data.models ?? []);
      setProviders(data.providers ?? []);
    } catch (error) {
      console.error('Failed to load models', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const llmModels = useMemo(() => models.filter((model) => model.category === 'llm'), [models]);
  const embeddingModels = useMemo(() => models.filter((model) => model.category === 'embedding'), [models]);

  const renderPricing = (pricing: ModelPricing) => {
    const currency = pricing.currency || 'USD';
    return (
      <Stack gap={2}>
        <Text size="xs" c="dimmed">
          {t('list.pricing.prompt', { price: pricing.inputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 }), currency })}
        </Text>
        <Text size="xs" c="dimmed">
          {t('list.pricing.completion', { price: pricing.outputTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 }), currency })}
        </Text>
        {pricing.cachedTokenPer1M ? (
          <Text size="xs" c="dimmed">
            {t('list.pricing.cached', { price: pricing.cachedTokenPer1M.toLocaleString(undefined, { maximumFractionDigits: 2 }), currency })}
          </Text>
        ) : null}
      </Stack>
    );
  };

  const renderModelTable = (records: ModelDto[]) => (
    <Paper withBorder radius="md" p="sm">
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
                    <Button component={Link} href="/dashboard/models/new" leftSection={<IconPlus size={16} />}>
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
                  <Group gap={8}>
                    <Text fw={600}>{model.name}</Text>
                    <Badge variant="light" color={model.category === 'llm' ? 'indigo' : 'teal'}>
                      {model.category === 'llm' ? t('list.badges.llm') : t('list.badges.embedding')}
                    </Badge>
                  </Group>
                  {model.description ? (
                    <Text size="xs" c="dimmed">
                      {model.description}
                    </Text>
                  ) : null}
                </Stack>
              </Table.Td>
              <Table.Td>
                <Badge color="grape" variant="light">
                  {providers.find((provider) => provider.id === model.provider)?.label || model.provider}
                </Badge>
              </Table.Td>
              <Table.Td>
                <code>{model.key}</code>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{model.modelId}</Text>
              </Table.Td>
              <Table.Td>
                <Group gap={6}>
                  {model.isMultimodal ? (
                    <Tooltip label={t('list.capabilities.multimodal')}>
                      <ThemeIcon size="sm" radius="md" variant="light" color="violet">
                        <IconEye size={14} />
                      </ThemeIcon>
                    </Tooltip>
                  ) : null}
                  {model.supportsToolCalls ? (
                    <Tooltip label={t('list.capabilities.tools')}>
                      <ThemeIcon size="sm" radius="md" variant="light" color="lime">
                        <IconTool size={14} />
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
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>{tNav('models')}</Title>
          <Text size="sm" c="dimmed">
            {t('list.subtitle')}
          </Text>
        </div>
        <Group gap="xs">
          <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={loadModels}>
            {t('actions.refresh')}
          </Button>
          <Button component={Link} href="/dashboard/models/new" leftSection={<IconPlug size={16} />}>
            {t('actions.create')}
          </Button>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
        <Card withBorder radius="md" padding="md">
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {t('metrics.totalModels')}
            </Text>
            <Text fw={600} size="lg">
              {models.length}
            </Text>
          </Stack>
        </Card>
        <Card withBorder radius="md" padding="md">
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {t('metrics.llmModels')}
            </Text>
            <Text fw={600} size="lg">
              {llmModels.length}
            </Text>
          </Stack>
        </Card>
        <Card withBorder radius="md" padding="md">
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {t('metrics.embeddingModels')}
            </Text>
            <Text fw={600} size="lg">
              {embeddingModels.length}
            </Text>
          </Stack>
        </Card>
        <Card withBorder radius="md" padding="md">
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {t('metrics.providers')}
            </Text>
            <Text fw={600} size="lg">
              {providers.length}
            </Text>
          </Stack>
        </Card>
      </SimpleGrid>

      <Stack gap="lg">
        <Stack gap={12}>
          <Group gap="xs">
            <ThemeIcon variant="light" color="indigo" radius="md">
              <IconChartBar size={16} />
            </ThemeIcon>
            <Text fw={600}>{t('list.sections.llm')}</Text>
          </Group>
          {renderModelTable(llmModels)}
        </Stack>

        <Stack gap={12}>
          <Group gap="xs">
            <ThemeIcon variant="light" color="teal" radius="md">
              <IconPlug size={16} />
            </ThemeIcon>
            <Text fw={600}>{t('list.sections.embedding')}</Text>
          </Group>
          {renderModelTable(embeddingModels)}
        </Stack>
      </Stack>
    </Stack>
  );
}
