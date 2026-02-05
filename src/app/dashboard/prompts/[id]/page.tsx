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
  rem,
  ScrollArea,
  Stack,
  Table,
  Tabs,
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
  IconMessage,
  IconPlayerPlay,
  IconRefresh,
  IconSend,
  IconSparkles,
  IconTemplate,
  IconTrash,
  IconVariable,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { Playground } from '@/components/playground';
import type { PromptView, PromptVersionView, PromptCommentView } from '@/lib/services/prompts';
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
  const [comments, setComments] = useState<PromptCommentView[]>([]);
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
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
      const [promptResponse, versionsResponse, commentsResponse] = await Promise.all([
        fetch(`/api/prompts/${promptId}`),
        fetch(`/api/prompts/${promptId}/versions`),
        fetch(`/api/prompts/${promptId}/comments`),
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

      if (commentsResponse.ok) {
        const commentsData = await commentsResponse.json();
        setComments(commentsData.comments ?? []);
      } else {
        setComments([]);
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

  const handleAddComment = async () => {
    if (!newComment.trim() || !promptId) return;

    setSubmittingComment(true);
    try {
      const response = await fetch(`/api/prompts/${promptId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newComment.trim() }),
      });

      if (response.ok) {
        const data = await response.json();
        setComments((prev) => [data.comment, ...prev]);
        setNewComment('');
        notifications.show({
          title: t('comments.addedTitle'),
          message: t('comments.addedMessage'),
          color: 'teal',
        });
      } else {
        throw new Error('Failed to add comment');
      }
    } catch (error) {
      console.error('Failed to add comment:', error);
      notifications.show({
        title: t('comments.errorTitle'),
        message: t('comments.errorMessage'),
        color: 'red',
      });
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!promptId) return;

    try {
      const response = await fetch(`/api/prompts/${promptId}/comments/${commentId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setComments((prev) => prev.filter((c) => c.id !== commentId));
      }
    } catch (error) {
      console.error('Failed to delete comment:', error);
    }
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

      {/* Info Bar */}
      <Paper withBorder radius="md" p="sm">
        <Group justify="space-between" wrap="wrap">
          <Group gap="lg">
            <Group gap={4}>
              <Text size="sm" c="dimmed">{t('fields.key')}:</Text>
              <Code>{prompt.key}</Code>
            </Group>
            <Group gap={4}>
              <Text size="sm" c="dimmed">{t('fields.version')}:</Text>
              <Badge variant="outline" size="sm">v{prompt.currentVersion ?? 1}</Badge>
            </Group>
          </Group>
          <Group gap="lg">
            <Group gap={4}>
              <Text size="sm" c="dimmed">{t('fields.createdAt')}:</Text>
              <Text size="sm">{formatDate(prompt.createdAt)}</Text>
            </Group>
            <Group gap={4}>
              <Text size="sm" c="dimmed">{t('fields.updatedAt')}:</Text>
              <Text size="sm">{formatDate(prompt.updatedAt)}</Text>
            </Group>
          </Group>
        </Group>
      </Paper>

      {/* Tab Navigation */}
      <Tabs defaultValue="template" variant="outline">
        <Tabs.List>
          <Tabs.Tab value="template" leftSection={<IconTemplate style={{ width: rem(16), height: rem(16) }} />}>
            {t('tabs.template')}
          </Tabs.Tab>
          <Tabs.Tab value="versions" leftSection={<IconHistory style={{ width: rem(16), height: rem(16) }} />}>
            {t('tabs.versions')}
          </Tabs.Tab>
          <Tabs.Tab value="playground" leftSection={<IconPlayerPlay style={{ width: rem(16), height: rem(16) }} />}>
            {t('tabs.playground')}
          </Tabs.Tab>
        </Tabs.List>

        {/* Template & Preview Tab */}
        <Tabs.Panel value="template" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder radius="lg" p="lg" h="100%">
                <Stack gap="md">
                  <Group gap={8}>
                    <ThemeIcon variant="light" color="indigo" radius="md">
                      <IconTemplate size={16} />
                    </ThemeIcon>
                    <Text fw={600}>{t('sections.template')}</Text>
                  </Group>
                  <ScrollArea h={300} type="auto">
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
                    minRows={4}
                    maxRows={6}
                    autosize
                    styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
                    error={previewResult.error}
                  />
                  <Divider label={t('sections.renderedOutput')} labelPosition="left" />
                  <ScrollArea h={150} type="auto">
                    <Code block style={{ whiteSpace: 'pre-wrap' }}>
                      {previewResult.preview || '(empty)'}
                    </Code>
                  </ScrollArea>
                </Stack>
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        {/* Versions Tab */}
        <Tabs.Panel value="versions" pt="md">
          <Paper withBorder radius="lg" p="lg">
            <Stack gap="md">
              <Group justify="space-between">
                <Text fw={600}>{t('sections.recentVersions')}</Text>
                <Button
                  variant="light"
                  size="xs"
                  leftSection={<IconHistory size={14} />}
                  onClick={() => setVersionHistoryOpen(true)}
                >
                  {t('actions.versionHistory')}
                </Button>
              </Group>
              {versions.length > 0 ? (
                <ScrollArea type="auto">
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('versions.version')}</Table.Th>
                        <Table.Th>{t('versions.createdAt')}</Table.Th>
                        <Table.Th>{t('versions.comment')}</Table.Th>
                        <Table.Th>{t('versions.template')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {versions.map((v) => (
                        <Table.Tr key={v.id}>
                          <Table.Td>
                            <Badge variant={v.isLatest ? 'filled' : 'outline'} size="sm" color={v.isLatest ? 'green' : 'gray'}>
                              v{v.version} {v.isLatest && '(latest)'}
                            </Badge>
                          </Table.Td>
                          <Table.Td>{formatDate(v.createdAt)}</Table.Td>
                          <Table.Td>
                            <Text size="sm" c="dimmed" lineClamp={1} maw={200}>
                              {v.comment || '—'}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed" lineClamp={2} maw={300} style={{ fontFamily: 'monospace' }}>
                              {v.template.substring(0, 100)}{v.template.length > 100 && '...'}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              ) : (
                <Center py="xl">
                  <Text size="sm" c="dimmed">{t('versions.empty')}</Text>
                </Center>
              )}
            </Stack>
          </Paper>

          {/* Comments Section */}
          <Paper withBorder radius="lg" p="lg" mt="md">
            <Stack gap="md">
              <Group gap={8}>
                <ThemeIcon variant="light" color="blue" radius="md">
                  <IconMessage size={16} />
                </ThemeIcon>
                <Text fw={600}>{t('comments.title')}</Text>
                <Badge variant="light" size="sm">{comments.length}</Badge>
              </Group>

              {/* Add Comment */}
              <Group gap="sm" align="flex-end">
                <Textarea
                  placeholder={t('comments.placeholder')}
                  value={newComment}
                  onChange={(e) => setNewComment(e.currentTarget.value)}
                  minRows={2}
                  maxRows={4}
                  autosize
                  style={{ flex: 1 }}
                />
                <Button
                  leftSection={<IconSend size={16} />}
                  loading={submittingComment}
                  onClick={handleAddComment}
                  disabled={!newComment.trim()}
                >
                  {t('comments.add')}
                </Button>
              </Group>

              {/* Comments List */}
              {comments.length > 0 ? (
                <Stack gap="sm">
                  {comments.map((comment) => (
                    <Paper key={comment.id} withBorder p="sm" radius="md" bg="gray.0">
                      <Group justify="space-between" align="flex-start">
                        <Stack gap={4} style={{ flex: 1 }}>
                          <Group gap="xs">
                            <Text size="sm" fw={500}>
                              {comment.createdByName || 'User'}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {formatDate(comment.createdAt)}
                            </Text>
                            {comment.version && (
                              <Badge variant="outline" size="xs">v{comment.version}</Badge>
                            )}
                          </Group>
                          <Text size="sm">{comment.content}</Text>
                        </Stack>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size="sm"
                          onClick={() => handleDeleteComment(comment.id)}
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              ) : (
                <Center py="md">
                  <Text size="sm" c="dimmed">{t('comments.empty')}</Text>
                </Center>
              )}
            </Stack>
          </Paper>
        </Tabs.Panel>

        {/* Playground Tab */}
        <Tabs.Panel value="playground" pt="md">
          <Paper withBorder radius="lg" p="lg" mb="md">
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
            onSystemPromptChange={() => {
              // Optional: could update preview data based on the prompt
            }}
            title={t('sections.playgroundChat')}
            chatHeight={500}
          />
        </Tabs.Panel>
      </Tabs>

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
