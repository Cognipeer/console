'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Paper,
  Text,
  Group,
  Stack,
  Button,
  TextInput,
  Textarea,
  Select,
  Slider,
  ActionIcon,
  Loader,
  Center,
  ScrollArea,
  ThemeIcon,
  Tabs,
  Divider,
  Badge,
  Code,
  CopyButton,
  Tooltip,
  Box,
  NumberInput,
  Pagination,
  Card,
  Collapse,
  UnstyledButton,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { DatePickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import {
  IconRobot,
  IconSend,
  IconPlus,
  IconMessageCircle,
  IconTimeline,
  IconCode,
  IconCopy,
  IconCheck,
  IconTrash,
  IconSearch,
  IconCalendar,
  IconRefresh,
  IconChevronDown,
  IconChevronRight,
  IconSettings,
  IconDatabase,
  IconShield,
  IconTool,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import PageHeader from '@/components/layout/PageHeader';
import SessionTable from '@/components/tracing/SessionTable';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolSelectorModal, type ToolBinding } from './ToolSelectorModal';

interface Agent {
  _id: string;
  key: string;
  name: string;
  description?: string;
  config: {
    modelKey: string;
    systemPrompt?: string;
    promptKey?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    knowledgeEngineKey?: string;
    inputGuardrailKey?: string;
    outputGuardrailKey?: string;
    toolBindings?: ToolBinding[];
  };
  status: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface Model {
  _id: string;
  key: string;
  name: string;
  modelId: string;
  category: string;
}

interface Prompt {
  _id: string;
  key: string;
  name: string;
  template: string;
}

interface RagModule {
  _id: string;
  key: string;
  name: string;
  status: string;
}

interface Guardrail {
  _id: string;
  key: string;
  name: string;
  target: string;
  enabled: boolean;
}

interface TracingSessionRecord {
  sessionId: string;
  threadId?: string;
  agentName?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totalEvents?: number;
  totalTokens?: number;
}

const DEFAULT_PAGE_SIZE = 25;

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;
  const t = useTranslations('agents');

  const [agent, setAgent] = useState<Agent | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [ragModules, setRagModules] = useState<RagModule[]>([]);
  const [guardrails, setGuardrails] = useState<Guardrail[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string | null>('playground');

  // Collapsible section state
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [toolSelectorOpen, setToolSelectorOpen] = useState(false);
  const [toolBindings, setToolBindings] = useState<ToolBinding[]>([]);

  // Chat state (in-memory only — no DB conversations)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatViewportRef = useRef<HTMLDivElement>(null);

  // Config form
  const configForm = useForm({
    initialValues: {
      modelKey: '',
      promptMode: 'custom' as 'custom' | 'prompt',
      systemPrompt: '',
      promptKey: '',
      temperature: 0.7,
      topP: 1,
      maxTokens: 4096,
      knowledgeEngineKey: '',
      inputGuardrailKey: '',
      outputGuardrailKey: '',
    },
  });

  // Tracing state (with pagination & date filter)
  const [tracingSessions, setTracingSessions] = useState<TracingSessionRecord[]>([]);
  const [tracingTotal, setTracingTotal] = useState(0);
  const [tracingLoading, setTracingLoading] = useState(false);
  const [tracingRefreshing, setTracingRefreshing] = useState(false);
  const [tracingPage, setTracingPage] = useState(1);
  const [tracingPageSize, setTracingPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [tracingStatusFilter, setTracingStatusFilter] = useState<string | null>(null);
  const [tracingDateRange, setTracingDateRange] = useState<[Date | null, Date | null]>([null, null]);

  const tracingPagination = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(tracingTotal / tracingPageSize));
    return { totalPages };
  }, [tracingTotal, tracingPageSize]);

  // ── Data Loading ──────────────────────────────────────────────

  const loadAgent = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setAgent(data.agent);

        // Populate form from agent config
        const cfg = data.agent.config;
        configForm.setValues({
          modelKey: cfg.modelKey || '',
          promptMode: cfg.promptKey ? 'prompt' : 'custom',
          systemPrompt: cfg.systemPrompt || '',
          promptKey: cfg.promptKey || '',
          temperature: cfg.temperature ?? 0.7,
          topP: cfg.topP ?? 1,
          maxTokens: cfg.maxTokens ?? 4096,
          knowledgeEngineKey: cfg.knowledgeEngineKey || '',
          inputGuardrailKey: cfg.inputGuardrailKey || '',
          outputGuardrailKey: cfg.outputGuardrailKey || '',
        });
        setToolBindings(cfg.toolBindings ?? []);
      }
    } catch (err) {
      console.error('Failed to load agent', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const loadModels = async () => {
    try {
      const res = await fetch('/api/models?category=llm', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setModels(data.models ?? []);
      }
    } catch (err) {
      console.error('Failed to load models', err);
    }
  };

  const loadPrompts = async () => {
    try {
      const res = await fetch('/api/prompts', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setPrompts(data.prompts ?? []);
      }
    } catch (err) {
      console.error('Failed to load prompts', err);
    }
  };

  const loadRagModules = async () => {
    try {
      const res = await fetch('/api/rag/modules?status=active', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setRagModules(data.modules ?? []);
      }
    } catch (err) {
      console.error('Failed to load RAG modules', err);
    }
  };

  const loadGuardrails = async () => {
    try {
      const res = await fetch('/api/guardrails?enabled=true', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setGuardrails(data.guardrails ?? []);
      }
    } catch (err) {
      console.error('Failed to load guardrails', err);
    }
  };

  const loadTracingSessions = useCallback(async (isRefresh = false) => {
    if (!agent) return;
    if (isRefresh) setTracingRefreshing(true);
    else setTracingLoading(true);

    try {
      const params = new URLSearchParams();
      params.set('agent', agent.name);
      params.set('limit', tracingPageSize.toString());
      params.set('skip', ((tracingPage - 1) * tracingPageSize).toString());
      if (tracingStatusFilter) params.set('status', tracingStatusFilter);
      const [from, to] = tracingDateRange;
      if (from) params.set('from', from.toISOString());
      if (to) params.set('to', to.toISOString());

      const res = await fetch(`/api/tracing/sessions?${params.toString()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        setTracingSessions(data.sessions ?? []);
        setTracingTotal(data.total ?? 0);
      }
    } catch (err) {
      console.error('Failed to load tracing sessions', err);
    } finally {
      setTracingLoading(false);
      setTracingRefreshing(false);
    }
  }, [agent, tracingPage, tracingPageSize, tracingStatusFilter, tracingDateRange]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadAgent(), loadModels(), loadPrompts(), loadRagModules(), loadGuardrails()]);
      setLoading(false);
    })();
  }, [loadAgent]);

  useEffect(() => {
    if (activeTab === 'traces' && agent) {
      loadTracingSessions();
    }
  }, [activeTab, agent, loadTracingSessions]);

  // ── Chat Actions (in-memory, no DB) ──────────────────────────

  const clearChat = () => {
    setChatMessages([]);
    setChatInput('');
  };

  const sendMessage = async () => {
    if (!chatInput.trim() || chatLoading) return;

    const message = chatInput.trim();
    setChatInput('');
    setChatLoading(true);

    // Optimistic update: add user message
    const updatedMessages: ChatMessage[] = [
      ...chatMessages,
      { role: 'user', content: message },
    ];
    setChatMessages(updatedMessages);

    try {
      const res = await fetch(`/api/agents/${agentId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history: chatMessages, // send previous messages as context
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Chat failed');
      }

      const data = await res.json();
      setChatMessages([
        ...updatedMessages,
        { role: 'assistant', content: data.content },
      ]);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      notifications.show({
        title: t('notifications.error'),
        message: errMsg,
        color: 'red',
      });
      // Revert optimistic update
      setChatMessages(chatMessages);
    } finally {
      setChatLoading(false);
    }
  };

  // Auto-scroll chat
  useEffect(() => {
    if (chatViewportRef.current) {
      chatViewportRef.current.scrollTop = chatViewportRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // ── Config Save ──────────────────────────────────────────────

  const handleSaveConfig = async () => {
    const values = configForm.values;
    try {
      const newConfig: Record<string, unknown> = {
        modelKey: values.modelKey,
        temperature: values.temperature,
        topP: values.topP,
        maxTokens: values.maxTokens,
        knowledgeEngineKey: values.knowledgeEngineKey || undefined,
        inputGuardrailKey: values.inputGuardrailKey || undefined,
        outputGuardrailKey: values.outputGuardrailKey || undefined,
        toolBindings: toolBindings.length > 0 ? toolBindings : undefined,
      };

      if (values.promptMode === 'custom') {
        newConfig.systemPrompt = values.systemPrompt;
        newConfig.promptKey = undefined;
      } else {
        newConfig.promptKey = values.promptKey;
        newConfig.systemPrompt = undefined;
      }

      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: newConfig }),
      });

      if (res.ok) {
        const data = await res.json();
        setAgent(data.agent);
        notifications.show({
          title: t('notifications.saved'),
          message: t('notifications.savedDesc'),
          color: 'teal',
        });
      }
    } catch {
      notifications.show({
        title: t('notifications.error'),
        message: t('notifications.saveFailed'),
        color: 'red',
      });
    }
  };

  if (loading) {
    return (
      <Center h={400}>
        <Loader />
      </Center>
    );
  }

  if (!agent) {
    return (
      <Center h={400}>
        <Text c="dimmed">{t('notFound')}</Text>
      </Center>
    );
  }

  return (
    <>
      <PageHeader
        icon={<IconRobot size={20} />}
        title={agent.name}
        subtitle={agent.description || agent.key}
      />

      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="playground" leftSection={<IconMessageCircle size={14} />}>
            {t('tabs.playground')}
          </Tabs.Tab>
          <Tabs.Tab value="traces" leftSection={<IconTimeline size={14} />}>
            {t('tabs.traces')}
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconCode size={14} />}>
            {t('tabs.usage')}
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Playground Tab ──────────────────────────────────── */}
        <Tabs.Panel value="playground">
          <Group align="stretch" gap="md" style={{ minHeight: 600 }} wrap="nowrap">
            {/* Left: Configuration Panel */}
            <Paper
              withBorder
              radius="md"
              p="md"
              style={{ width: 340, flexShrink: 0, overflow: 'auto' }}
            >
              <Stack gap="md">
                <Text size="sm" fw={600}>
                  {t('config.title')}
                </Text>

                <Select
                  label={t('config.model')}
                  placeholder={t('config.modelPlaceholder')}
                  data={models.map((m) => ({
                    value: m.key,
                    label: `${m.name} (${m.modelId})`,
                  }))}
                  searchable
                  {...configForm.getInputProps('modelKey')}
                />

                <Divider label={t('config.promptSection')} labelPosition="center" />

                <Select
                  label={t('config.promptMode')}
                  data={[
                    { value: 'custom', label: t('config.customPrompt') },
                    { value: 'prompt', label: t('config.selectPrompt') },
                  ]}
                  {...configForm.getInputProps('promptMode')}
                />

                {configForm.values.promptMode === 'custom' ? (
                  <Textarea
                    label={t('config.systemPrompt')}
                    placeholder={t('config.systemPromptPlaceholder')}
                    minRows={4}
                    maxRows={12}
                    autosize
                    {...configForm.getInputProps('systemPrompt')}
                  />
                ) : (
                  <Select
                    label={t('config.prompt')}
                    placeholder={t('config.promptPlaceholder')}
                    data={prompts.map((p) => ({
                      value: p.key,
                      label: p.name,
                    }))}
                    searchable
                    {...configForm.getInputProps('promptKey')}
                  />
                )}

                {/* ── Knowledge Engine ─────────────────────── */}
                <Divider label={t('config.knowledgeEngine')} labelPosition="center" />

                <Select
                  label={t('config.knowledgeEngine')}
                  description={t('config.knowledgeEngineDescription')}
                  placeholder={t('config.knowledgeEnginePlaceholder')}
                  data={ragModules.map((r) => ({
                    value: r.key,
                    label: r.name,
                  }))}
                  searchable
                  clearable
                  leftSection={<IconDatabase size={14} />}
                  {...configForm.getInputProps('knowledgeEngineKey')}
                />

                {/* ── Guardrails ───────────────────────────── */}
                <Divider label={t('config.guardrails')} labelPosition="center" />

                <Select
                  label={t('config.inputGuardrail')}
                  description={t('config.inputGuardrailDescription')}
                  placeholder={t('config.inputGuardrailPlaceholder')}
                  data={guardrails.map((g) => ({
                    value: g.key,
                    label: g.name,
                  }))}
                  searchable
                  clearable
                  leftSection={<IconShield size={14} />}
                  {...configForm.getInputProps('inputGuardrailKey')}
                />

                <Select
                  label={t('config.outputGuardrail')}
                  description={t('config.outputGuardrailDescription')}
                  placeholder={t('config.outputGuardrailPlaceholder')}
                  data={guardrails.map((g) => ({
                    value: g.key,
                    label: g.name,
                  }))}
                  searchable
                  clearable
                  leftSection={<IconShield size={14} />}
                  {...configForm.getInputProps('outputGuardrailKey')}
                />

                {/* ── Tools ────────────────────────────────── */}
                <Divider label={t('config.tools')} labelPosition="center" />

                <Text size="xs" c="dimmed">
                  {t('config.toolsDescription')}
                </Text>

                {toolBindings.length > 0 ? (
                  <Stack gap={4}>
                    {toolBindings.map((b) => (
                      <Group key={`${b.source}::${b.sourceKey}`} gap="xs">
                        <Badge size="xs" variant="light" color="gray">
                          {b.source.toUpperCase()}
                        </Badge>
                        <Text size="xs" fw={500}>{b.sourceKey}</Text>
                        <Badge size="xs" variant="light" color="blue">
                          {b.toolNames.length} tool(s)
                        </Badge>
                      </Group>
                    ))}
                  </Stack>
                ) : (
                  <Text size="xs" c="dimmed" fs="italic">
                    {t('config.noToolsSelected')}
                  </Text>
                )}

                <Button
                  variant="light"
                  size="xs"
                  leftSection={<IconTool size={14} />}
                  onClick={() => setToolSelectorOpen(true)}
                >
                  {toolBindings.length > 0 ? t('config.editTools') : t('config.addTools')}
                </Button>

                <ToolSelectorModal
                  opened={toolSelectorOpen}
                  onClose={() => setToolSelectorOpen(false)}
                  value={toolBindings}
                  onChange={setToolBindings}
                />

                {/* ── Advanced Settings (collapsible) ─────── */}
                <Divider />
                <UnstyledButton
                  onClick={() => setAdvancedOpen((o) => !o)}
                  style={{ width: '100%' }}
                >
                  <Group gap="xs">
                    {advancedOpen ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
                    <IconSettings size={16} />
                    <Text size="sm" fw={600}>{t('config.advancedSettings')}</Text>
                  </Group>
                </UnstyledButton>

                <Collapse in={advancedOpen}>
                  <Stack gap="md" mt="xs">
                    <div>
                      <Text size="sm" mb={4}>
                        {t('config.temperature')}: {configForm.values.temperature}
                      </Text>
                      <Slider
                        min={0}
                        max={2}
                        step={0.1}
                        marks={[
                          { value: 0, label: '0' },
                          { value: 1, label: '1' },
                          { value: 2, label: '2' },
                        ]}
                        {...configForm.getInputProps('temperature')}
                      />
                    </div>

                    <div>
                      <Text size="sm" mb={4}>
                        {t('config.topP')}: {configForm.values.topP}
                      </Text>
                      <Slider
                        min={0}
                        max={1}
                        step={0.05}
                        marks={[
                          { value: 0, label: '0' },
                          { value: 0.5, label: '0.5' },
                          { value: 1, label: '1' },
                        ]}
                        {...configForm.getInputProps('topP')}
                      />
                    </div>

                    <NumberInput
                      label={t('config.maxTokens')}
                      min={1}
                      max={128000}
                      {...configForm.getInputProps('maxTokens')}
                    />
                  </Stack>
                </Collapse>

                <Button onClick={handleSaveConfig} size="sm" fullWidth>
                  {t('config.save')}
                </Button>
              </Stack>
            </Paper>

            {/* Right: Chat Area */}
            <Paper
              withBorder
              radius="md"
              style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}
            >
              {/* Chat Header */}
              <Group
                p="sm"
                justify="space-between"
                style={{
                  borderBottom: '1px solid var(--mantine-color-gray-3)',
                }}
              >
                <Group gap="xs">
                  <Text size="sm" fw={600}>
                    {t('chat.title')}
                  </Text>
                  {chatMessages.length > 0 && (
                    <Badge size="xs" variant="light" color="gray">
                      {chatMessages.length} {t('chat.messages')}
                    </Badge>
                  )}
                </Group>
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconTrash size={14} />}
                  onClick={clearChat}
                  disabled={chatMessages.length === 0 && !chatLoading}
                >
                  {t('chat.newChat')}
                </Button>
              </Group>

              {/* Chat Messages */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                {chatMessages.length === 0 && !chatLoading ? (
                  <Center style={{ flex: 1 }}>
                    <Stack align="center" gap="sm">
                      <ThemeIcon size={48} radius="xl" variant="light" color="gray">
                        <IconRobot size={24} />
                      </ThemeIcon>
                      <Text fw={600}>{agent.name}</Text>
                      <Text size="sm" c="dimmed" ta="center" maw={300}>
                        {agent.description || t('chat.startDescription')}
                      </Text>
                    </Stack>
                  </Center>
                ) : (
                  <>
                    <ScrollArea
                      style={{ flex: 1 }}
                      viewportRef={chatViewportRef}
                      p="md"
                    >
                      <Stack gap="md">
                        {chatMessages.map((msg, i) => (
                          <Group
                            key={i}
                            justify={msg.role === 'user' ? 'flex-end' : 'flex-start'}
                            align="flex-start"
                          >
                            <Paper
                              p="sm"
                              radius="md"
                              withBorder={msg.role === 'assistant'}
                              style={{
                                maxWidth: '75%',
                                background:
                                  msg.role === 'user'
                                    ? 'var(--mantine-color-blue-light)'
                                    : undefined,
                              }}
                            >
                              {msg.role === 'assistant' ? (
                                <Box
                                  style={{
                                    fontSize: 'var(--mantine-font-size-sm)',
                                    lineHeight: 1.5,
                                    overflowWrap: 'anywhere',
                                  }}
                                >
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {msg.content}
                                  </ReactMarkdown>
                                </Box>
                              ) : (
                                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                  {msg.content}
                                </Text>
                              )}
                            </Paper>
                          </Group>
                        ))}
                        {chatLoading && (
                          <Group justify="flex-start">
                            <Paper p="sm" radius="md" withBorder>
                              <Loader size="xs" />
                            </Paper>
                          </Group>
                        )}
                      </Stack>
                    </ScrollArea>

                    {/* Input */}
                    <Group
                      p="sm"
                      gap="sm"
                      style={{
                        borderTop: '1px solid var(--mantine-color-gray-3)',
                      }}
                    >
                      <TextInput
                        placeholder={t('chat.inputPlaceholder')}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                          }
                        }}
                        style={{ flex: 1 }}
                        disabled={chatLoading}
                        rightSection={
                          <ActionIcon
                            size="sm"
                            variant="filled"
                            onClick={sendMessage}
                            disabled={!chatInput.trim() || chatLoading}
                          >
                            <IconSend size={14} />
                          </ActionIcon>
                        }
                      />
                    </Group>
                  </>
                )}

                {/* Always-visible input when no messages */}
                {chatMessages.length === 0 && !chatLoading && (
                  <Group
                    p="sm"
                    gap="sm"
                    style={{
                      borderTop: '1px solid var(--mantine-color-gray-3)',
                    }}
                  >
                    <TextInput
                      placeholder={t('chat.inputPlaceholder')}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendMessage();
                        }
                      }}
                      style={{ flex: 1 }}
                      disabled={chatLoading}
                      rightSection={
                        <ActionIcon
                          size="sm"
                          variant="filled"
                          onClick={sendMessage}
                          disabled={!chatInput.trim() || chatLoading}
                        >
                          <IconSend size={14} />
                        </ActionIcon>
                      }
                    />
                  </Group>
                )}
              </div>
            </Paper>
          </Group>
        </Tabs.Panel>

        {/* ── Traces Tab ─────────────────────────────────────── */}
        <Tabs.Panel value="traces">
          <Stack gap="md">
            {/* Filters */}
            <Card withBorder shadow="sm" p="md">
              <Group gap="md" wrap="wrap">
                <Select
                  label={t('traces.statusFilter')}
                  placeholder={t('traces.allStatuses')}
                  data={[
                    { value: 'success', label: 'Success' },
                    { value: 'error', label: 'Error' },
                    { value: 'running', label: 'Running' },
                  ]}
                  value={tracingStatusFilter}
                  onChange={(value) => {
                    setTracingStatusFilter(value);
                    setTracingPage(1);
                  }}
                  clearable
                  style={{ minWidth: 180 }}
                />
                <DatePickerInput
                  type="range"
                  label={t('traces.dateRange')}
                  placeholder={t('traces.selectRange')}
                  value={tracingDateRange}
                  onChange={(value) => {
                    setTracingDateRange(value as [Date | null, Date | null]);
                    setTracingPage(1);
                  }}
                  leftSection={<IconCalendar size={16} />}
                  clearable
                  style={{ minWidth: 260 }}
                />
                <Select
                  label={t('traces.pageSize')}
                  data={['25', '50', '100'].map((v) => ({ value: v, label: `${v} rows` }))}
                  value={tracingPageSize.toString()}
                  onChange={(v) => {
                    setTracingPageSize(v ? parseInt(v, 10) : DEFAULT_PAGE_SIZE);
                    setTracingPage(1);
                  }}
                  style={{ minWidth: 140 }}
                />
                <Box style={{ alignSelf: 'flex-end' }}>
                  <Button
                    leftSection={<IconRefresh size={14} />}
                    variant="light"
                    size="sm"
                    onClick={() => loadTracingSessions(true)}
                    loading={tracingRefreshing}
                  >
                    {t('traces.refresh')}
                  </Button>
                </Box>
              </Group>
            </Card>

            {/* Sessions table */}
            <Paper withBorder shadow="sm" p="md">
              <Stack gap="md">
                <Group justify="space-between" align="center">
                  <Text fw={600}>{t('traces.sessions')}</Text>
                  <Badge size="sm" variant="light">
                    {tracingTotal} total
                  </Badge>
                </Group>

                <SessionTable
                  sessions={tracingSessions}
                  loading={tracingLoading}
                  onRowClick={(sessionId) =>
                    router.push(`/dashboard/tracing/sessions/${sessionId}`)
                  }
                  onThreadClick={(threadId) =>
                    router.push(`/dashboard/tracing/threads/${threadId}`)
                  }
                />

                {tracingPagination.totalPages > 1 && (
                  <Group justify="space-between" align="center">
                    <Text size="sm" c="dimmed">
                      Page {tracingPage} of {tracingPagination.totalPages}
                    </Text>
                    <Pagination
                      total={tracingPagination.totalPages}
                      value={tracingPage}
                      onChange={setTracingPage}
                    />
                  </Group>
                )}
              </Stack>
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* ── Usage Tab ──────────────────────────────────────── */}
        <Tabs.Panel value="usage">
          <Stack gap="md">
            <Paper withBorder radius="md" p="md">
              <Stack gap="md">
                <Text size="lg" fw={600}>
                  {t('usage.title')}
                </Text>
                <Text size="sm" c="dimmed">
                  {t('usage.description', { name: agent.name })}
                </Text>

                <Divider />

                {/* ── SDK Usage ─────────────────────────────── */}
                <Text size="sm" fw={600}>
                  {t('usage.sdkTitle')}
                </Text>

                <Text size="sm" c="dimmed" mb="xs">
                  {t('usage.installLabel')}
                </Text>
                <Box>
                  <Group gap="xs" align="center">
                    <Code block style={{ flex: 1 }}>
                      npm install @cognipeer/console-sdk
                    </Code>
                    <CopyButton value="npm install @cognipeer/console-sdk">
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy'}>
                          <ActionIcon
                            variant="subtle"
                            onClick={copy}
                            color={copied ? 'teal' : 'gray'}
                          >
                            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                  </Group>
                </Box>

                <Text size="sm" c="dimmed" mb="xs">
                  {t('usage.chatLabel')}
                </Text>
                <Code block>
                  {`import { ConsoleClient } from '@cognipeer/console-sdk';

const client = new ConsoleClient({
  apiKey: 'YOUR_API_KEY',
  baseURL: '${typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com'}',
});

// ── Single turn ──────────────────────────────────
const response = await client.agents.responses.create({
  model: '${agent.key}',
  input: 'Hello, how can you help me?',
});
console.log(response.output[0].content[0].text);

// ── Multi-turn conversation ──────────────────────
// Pass previous_response_id to continue the conversation
const followUp = await client.agents.responses.create({
  model: '${agent.key}',
  input: 'Tell me more about that',
  previous_response_id: response.id,
});
console.log(followUp.output[0].content[0].text);

// ── Structured input (message array) ─────────────
const res = await client.agents.responses.create({
  model: '${agent.key}',
  input: [
    { role: 'user', content: 'Summarize the key points' },
  ],
  previous_response_id: followUp.id,
});`}
                </Code>

                <Divider />

                {/* ── REST Usage ────────────────────────────── */}
                <Text size="sm" fw={600}>
                  {t('usage.restTitle')}
                </Text>

                <Text size="sm" c="dimmed" mb="xs">
                  {t('usage.restLabel')}
                </Text>
                <Code block>
                  {`# First message
curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com'}/api/client/v1/responses \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${agent.key}",
    "input": "Hello, how can you help me?"
  }'

# Continue conversation (use the id from the previous response)
curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com'}/api/client/v1/responses \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${agent.key}",
    "input": "Tell me more about that",
    "previous_response_id": "resp_<conversation_id>"
  }'`}
                </Code>

                <Divider />

                {/* ── Response Format ──────────────────────── */}
                <Text size="sm" fw={600}>
                  {t('usage.responseTitle')}
                </Text>
                <Code block>
                  {`{
  "id": "resp_<conversation_id>",
  "object": "response",
  "model": "${agent.name}",
  "output": [
    {
      "id": "msg_abc123",
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Agent response text..."
        }
      ]
    }
  ],
  "status": "completed",
  "usage": {
    "input_tokens": 50,
    "output_tokens": 100,
    "total_tokens": 150
  },
  "created_at": 1719500000,
  "previous_response_id": null
}`}
                </Code>
              </Stack>
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
