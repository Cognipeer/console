'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import Mustache from 'mustache';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Code,
  CopyButton,
  Divider,
  Grid,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconCheck,
  IconCode,
  IconCopy,
  IconEdit,
  IconHistory,
  IconRefresh,
  IconSparkles,
  IconTemplate,
  IconVariable,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { Playground } from '@/components/playground';
import type { PromptView, PromptVersionView } from '@/lib/services/prompts';
import PromptEditorModal from '@/components/prompts/PromptEditorModal';
import PromptVersionHistoryModal from '@/components/prompts/PromptVersionHistoryModal';

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function extractTemplateVariables(template: string): string[] {
  const matches = Array.from(template.matchAll(/{{\s*([^{}\s]+)\s*}}/g));
  const vars = matches
    .map((match) => match[1])
    .filter((value) => value && !['#', '/', '^', '!', '>'].some((prefix) => value.startsWith(prefix)));
  return Array.from(new Set(vars));
}

export default function PromptDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const t = useTranslations('promptDetail');
  const tNav = useTranslations('navigation');
  const [prompt, setPrompt] = useState<PromptView | null>(null);
  const [versions, setVersions] = useState<PromptVersionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [previewData, setPreviewData] = useState('{\n  "name": "World"\n}');
  const [renderedSystemPrompt, setRenderedSystemPrompt] = useState('');

  const promptId = params?.id;

  const fetchDetail = useCallback(async (showNotifications = false) => {
    if (!promptId) return;
    try {
      const [promptResponse, versionsResponse] = await Promise.all([
        fetch(`/api/prompts/${promptId}`),
        fetch(`/api/prompts/${promptId}/versions`),
      ]);

      if (!promptResponse.ok) {
        throw new Error('Prompt not found');
      }

      const promptData = await promptResponse.json();
      setPrompt(promptData.prompt);

      if (versionsResponse.ok) {
        const versionsData = await versionsResponse.json();
        setVersions(versionsData.versions ?? []);
      } else {
        setVersions([]);
      }

      if (showNotifications) {
        notifications.show({
          title: 'Data refreshed',
          message: 'Latest prompt data is now visible.',
          color: 'teal',
        });
      }
    } catch (error) {
      console.error('Failed to load prompt detail', error);
      notifications.show({
        title: 'Unable to load prompt',
        message: 'We could not load the prompt detail. Please try again shortly.',
        color: 'red',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [promptId]);

  useEffect(() => {
    if (promptId) {
      setLoading(true);
      fetchDetail();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptId]);

  // Extract variables from template
  const variables = useMemo(() => {
    if (!prompt?.template) return [];
    return extractTemplateVariables(prompt.template);
  }, [prompt?.template]);

  // Render preview
  const previewResult = useMemo(() => {
    if (!prompt?.template) return { preview: '', error: null };
    try {
      const data = previewData.trim().length > 0 ? JSON.parse(previewData) : {};
      return {
        preview: Mustache.render(prompt.template, data),
        error: null as string | null,
      };
    } catch (error) {
      return {
        preview: '',
        error: error instanceof Error ? error.message : 'Invalid JSON',
      };
    }
  }, [previewData, prompt?.template]);

  // Update rendered system prompt when preview changes
  useEffect(() => {
    if (previewResult.preview && !previewResult.error) {
      setRenderedSystemPrompt((current) => {
        return current !== previewResult.preview ? previewResult.preview : current;
      });
    }
  }, [previewResult]);

  const handlePromptSaved = (updatedPrompt: PromptView) => {
    setPrompt(updatedPrompt);
    setEditorOpen(false);
    fetchDetail(true);
  };

  const handleVersionRestored = () => {
    fetchDetail(true);
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  if (!prompt) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">{t('errors.notFound')}</Text>
          <Button
            leftSection={<IconArrowLeft size={16} />}
            onClick={() => router.push('/dashboard/prompts')}
          >
            {t('actions.backToList')}
          </Button>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background:
            'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}
      >
        <Group justify="space-between" align="flex-start">
          <Group gap="md" align="flex-start">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'teal', to: 'cyan', deg: 135 }}
            >
              <IconSparkles size={26} />
            </ThemeIcon>
            <div>
              <Group gap={8} align="center">
                <Title order={2}>{prompt.name}</Title>
                <Badge variant="outline" color="gray" size="sm">
                  v{prompt.currentVersion ?? 1}
                </Badge>
              </Group>
              <Group gap={8} mt={6}>
                <Badge color="blue" variant="light">
                  {prompt.key}
                </Badge>
                <CopyButton value={prompt.key}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied!' : 'Copy key'}>
                      <ActionIcon size="sm" variant="subtle" onClick={copy}>
                        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
              {prompt.description && (
                <Text size="sm" c="dimmed" mt={6}>
                  {prompt.description}
                </Text>
              )}
            </div>
          </Group>
          <Group gap="xs">
            <Button
              variant="light"
              leftSection={<IconHistory size={16} />}
              onClick={() => setVersionHistoryOpen(true)}
            >
              {t('actions.versionHistory')}
            </Button>
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              loading={refreshing}
              onClick={() => fetchDetail(true)}
            >
              {t('actions.refresh')}
            </Button>
            <Button
              leftSection={<IconEdit size={16} />}
              onClick={() => setEditorOpen(true)}
            >
              {t('actions.edit')}
            </Button>
          </Group>
        </Group>
      </Paper>

      <Grid>
        {/* Template Section */}
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Paper withBorder radius="lg" p="lg" h="100%">
            <Stack gap="md">
              <Group gap={8}>
                <ThemeIcon variant="light" color="indigo" radius="md">
                  <IconTemplate size={16} />
                </ThemeIcon>
                <Text fw={600}>{t('sections.template')}</Text>
              </Group>
              <ScrollArea h={200} type="auto">
                <Code block style={{ whiteSpace: 'pre-wrap' }}>
                  {prompt.template}
                </Code>
              </ScrollArea>
              {variables.length > 0 && (
                <>
                  <Divider label={t('sections.variables')} labelPosition="left" />
                  <Group gap={6}>
                    {variables.map((v) => (
                      <Badge key={v} variant="light" color="grape" leftSection={<IconVariable size={12} />}>
                        {v}
                      </Badge>
                    ))}
                  </Group>
                </>
              )}
            </Stack>
          </Paper>
        </Grid.Col>

        {/* Preview Section */}
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Paper withBorder radius="lg" p="lg" h="100%">
            <Stack gap="md">
              <Group gap={8}>
                <ThemeIcon variant="light" color="teal" radius="md">
                  <IconCode size={16} />
                </ThemeIcon>
                <Text fw={600}>{t('sections.preview')}</Text>
              </Group>
              <Textarea
                label={t('form.previewDataLabel')}
                description={t('form.previewDataDescription')}
                value={previewData}
                onChange={(e) => setPreviewData(e.currentTarget.value)}
                minRows={3}
                maxRows={5}
                autosize
                styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
                error={previewResult.error}
              />
              <Divider label={t('sections.renderedOutput')} labelPosition="left" />
              <ScrollArea h={100} type="auto">
                <Code block style={{ whiteSpace: 'pre-wrap' }}>
                  {previewResult.preview || '(empty)'}
                </Code>
              </ScrollArea>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>

      {/* Info Section */}
      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap="sm">
              <Text fw={600}>{t('sections.info')}</Text>
              <Stack gap={4}>
                <Text size="sm"><strong>{t('fields.key')}:</strong> <code>{prompt.key}</code></Text>
                <Text size="sm"><strong>{t('fields.version')}:</strong> v{prompt.currentVersion ?? 1}</Text>
                <Text size="sm"><strong>{t('fields.createdAt')}:</strong> {formatDate(prompt.createdAt)}</Text>
                <Text size="sm"><strong>{t('fields.updatedAt')}:</strong> {formatDate(prompt.updatedAt)}</Text>
              </Stack>
            </Stack>
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 8 }}>
          <Paper withBorder radius="lg" p="lg">
            <Stack gap="md">
              <Text fw={600}>{t('sections.recentVersions')}</Text>
              {versions.length > 0 ? (
                <ScrollArea h={120} type="auto">
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('versions.version')}</Table.Th>
                        <Table.Th>{t('versions.createdAt')}</Table.Th>
                        <Table.Th>{t('versions.preview')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {versions.slice(0, 5).map((v) => (
                        <Table.Tr key={v.id}>
                          <Table.Td>
                            <Badge variant="outline" size="sm">
                              v{v.version}
                            </Badge>
                          </Table.Td>
                          <Table.Td>{formatDate(v.createdAt)}</Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {v.template.slice(0, 50)}...
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              ) : (
                <Center py="sm">
                  <Text size="sm" c="dimmed">{t('versions.empty')}</Text>
                </Center>
              )}
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>

      {/* Playground Section */}
      <Paper withBorder radius="lg" p="lg">
        <Stack gap="md">
          <Group gap={8}>
            <ThemeIcon variant="light" color="violet" radius="md">
              <IconSparkles size={16} />
            </ThemeIcon>
            <Text fw={600}>{t('sections.playground')}</Text>
          </Group>
          <Text size="sm" c="dimmed">
            {t('playground.description')}
          </Text>
        </Stack>
      </Paper>

      <Playground
        initialSystemPrompt={renderedSystemPrompt}
        hideModelSelector={false}
        onSystemPromptChange={(newPrompt) => {
          // Optional: could update preview data based on the prompt
        }}
        title={t('sections.playgroundChat')}
        chatHeight={400}
      />

      {/* Modals */}
      <PromptEditorModal
        opened={editorOpen}
        onClose={() => setEditorOpen(false)}
        prompt={prompt}
        onSaved={handlePromptSaved}
      />

      <PromptVersionHistoryModal
        opened={versionHistoryOpen}
        onClose={() => setVersionHistoryOpen(false)}
        prompt={prompt}
        onVersionRestored={handleVersionRestored}
      />
    </Stack>
  );
}
