'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Collapse,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBrain,
  IconChevronDown,
  IconChevronRight,
  IconPlayerStop,
  IconRefresh,
  IconSend,
  IconSparkles,
  IconTrash,
  IconMessageChatbot,
  IconSettings,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useTranslations } from '@/lib/i18n';

export interface ModelOption {
  key: string;
  name: string;
  category: 'llm' | 'embedding';
  provider?: string;
}

export interface PlaygroundMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Reasoning / "thinking" trace emitted by reasoning models alongside content */
  reasoning?: string;
}

export interface PlaygroundProps {
  /** Pre-selected model key (e.g., from model detail page) */
  initialModelKey?: string;
  /** Pre-filled system prompt (e.g., from prompt detail page) */
  initialSystemPrompt?: string;
  /** Hide model selector when using in model detail context */
  hideModelSelector?: boolean;
  /** Hide system prompt input when using with fixed prompt */
  hideSystemPrompt?: boolean;
  /** Callback when system prompt changes (for prompt testing) */
  onSystemPromptChange?: (prompt: string) => void;
  /** Custom title for the playground section */
  title?: string;
  /** Custom height for the chat area */
  chatHeight?: number | string;
}

export function Playground({
  initialModelKey,
  initialSystemPrompt = '',
  hideModelSelector = false,
  hideSystemPrompt = false,
  onSystemPromptChange,
  title,
  chatHeight = 400,
}: PlaygroundProps) {
  const t = useTranslations('playground');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [selectedModel, setSelectedModel] = useState<string | null>(initialModelKey ?? null);
  const [systemPrompt, setSystemPrompt] = useState(initialSystemPrompt);
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load available models
  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const response = await fetch('/api/models?category=llm');
      if (!response.ok) throw new Error('Failed to load models');
      const data = await response.json();
      const llmModels = (data.models ?? [])
        .filter((m: { category: string }) => m.category === 'llm')
        .map((m: { key: string; name: string; category: string; provider?: string }) => ({
          key: m.key,
          name: m.name,
          category: m.category as 'llm' | 'embedding',
          provider: m.provider,
        }));
      setModels(llmModels);
      // Auto-select if initialModelKey matches or select first
      if (initialModelKey && llmModels.some((m: ModelOption) => m.key === initialModelKey)) {
        setSelectedModel(initialModelKey);
      } else if (!selectedModel && llmModels.length > 0) {
        setSelectedModel(llmModels[0].key);
      }
    } catch (error) {
      console.error('Failed to load models:', error);
      notifications.show({
        title: t('errors.loadModelsTitle'),
        message: t('errors.loadModelsMessage'),
        color: 'red',
      });
    } finally {
      setLoadingModels(false);
    }
  }, [initialModelKey, selectedModel, t]);

  useEffect(() => {
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialModelKey) {
      setSelectedModel(initialModelKey);
    }
  }, [initialModelKey]);

  useEffect(() => {
    if (initialSystemPrompt !== undefined) {
      setSystemPrompt(initialSystemPrompt);
    }
  }, [initialSystemPrompt]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollAreaRef.current) {
      const scrollElement = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, [messages, streamingContent]);

  const handleSystemPromptChange = (value: string) => {
    setSystemPrompt(value);
    onSystemPromptChange?.(value);
  };

  const sendMessage = async () => {
    if (!inputValue.trim() || !selectedModel || isGenerating) return;

    const userMessage: PlaygroundMessage = { role: 'user', content: inputValue.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsGenerating(true);
    setStreamingContent('');
    setStreamingReasoning('');

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // Build messages array with optional system prompt
      const chatMessages: PlaygroundMessage[] = [];
      if (systemPrompt.trim()) {
        chatMessages.push({ role: 'system', content: systemPrompt.trim() });
      }
      chatMessages.push(...messages, userMessage);

      const response = await fetch('/api/dashboard/playground/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: chatMessages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(error.error || 'Request failed');
      }

      // Handle streaming response
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let fullContent = '';
      let fullReasoning = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const choiceDelta = parsed.choices?.[0]?.delta ?? {};
              const reasoningDelta = extractReasoningDelta(choiceDelta);
              if (reasoningDelta) {
                fullReasoning += reasoningDelta;
                setStreamingReasoning(fullReasoning);
              }
              const delta = choiceDelta.content ?? '';
              if (delta) {
                fullContent += delta;
                setStreamingContent(fullContent);
              }
            } catch {
              // Skip unparseable chunks
            }
          }
        }
      }

      // Add completed assistant message
      if (fullContent || fullReasoning) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: fullContent,
            reasoning: fullReasoning || undefined,
          },
        ]);
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('Chat error:', error);
        notifications.show({
          title: t('errors.chatTitle'),
          message: error instanceof Error ? error.message : t('errors.chatMessage'),
          color: 'red',
        });
      }
    } finally {
      setIsGenerating(false);
      setStreamingContent('');
      setStreamingReasoning('');
      abortControllerRef.current = null;
      inputRef.current?.focus();
    }
  };

  const stopGeneration = () => {
    abortControllerRef.current?.abort();
    setIsGenerating(false);
    setStreamingContent('');
    setStreamingReasoning('');
  };

  const clearConversation = () => {
    setMessages([]);
    setStreamingContent('');
    setStreamingReasoning('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const modelOptions = models.map((m) => ({
    value: m.key,
    label: m.name,
  }));

  return (
    <Paper withBorder radius="lg" p="lg">
      <Stack gap="md">
        {/* Header */}
        <Group justify="space-between" align="center">
          <Group gap="sm">
            <ThemeIcon variant="light" color="violet" radius="md">
              <IconSparkles size={18} />
            </ThemeIcon>
            <Text fw={600}>{title ?? t('title')}</Text>
          </Group>
          <Group gap="xs">
            <Tooltip label={t('actions.clear')}>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={clearConversation}
                disabled={messages.length === 0 && !streamingContent}
              >
                <IconTrash size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('actions.refreshModels')}>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={loadModels}
                loading={loadingModels}
              >
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {/* Model Selector and System Prompt */}
        <Stack gap="xs">
          {!hideModelSelector && (
            <Select
              label={t('form.modelLabel')}
              placeholder={t('form.modelPlaceholder')}
              data={modelOptions}
              value={selectedModel}
              onChange={setSelectedModel}
              searchable
              disabled={loadingModels}
              leftSection={loadingModels ? <Loader size={16} /> : undefined}
            />
          )}

          {!hideSystemPrompt && (
            <Textarea
              label={t('form.systemPromptLabel')}
              placeholder={t('form.systemPromptPlaceholder')}
              value={systemPrompt}
              onChange={(e) => handleSystemPromptChange(e.currentTarget.value)}
              minRows={2}
              maxRows={4}
              autosize
              leftSection={<IconSettings size={16} />}
              styles={{
                input: { paddingLeft: 36 },
              }}
            />
          )}
        </Stack>

        {/* Chat Area */}
        <Paper
          withBorder
          radius="md"
          p={0}
          style={{ overflow: 'hidden' }}
        >
          <ScrollArea h={chatHeight} ref={scrollAreaRef} type="auto" offsetScrollbars>
            <Stack gap={0} p="sm">
              {messages.length === 0 && !streamingContent && !streamingReasoning ? (
                <Center py="xl">
                  <Stack gap="xs" align="center">
                    <ThemeIcon variant="light" color="gray" size="xl" radius="xl">
                      <IconMessageChatbot size={28} />
                    </ThemeIcon>
                    <Text size="sm" c="dimmed" ta="center">
                      {t('emptyState.title')}
                    </Text>
                    <Text size="xs" c="dimmed" ta="center">
                      {t('emptyState.subtitle')}
                    </Text>
                  </Stack>
                </Center>
              ) : (
                <>
                  {messages.map((msg, idx) => (
                    <MessageBubble key={idx} message={msg} />
                  ))}
                  {(streamingContent || streamingReasoning) && (
                    <MessageBubble
                      message={{
                        role: 'assistant',
                        content: streamingContent,
                        reasoning: streamingReasoning || undefined,
                      }}
                      isStreaming
                    />
                  )}
                </>
              )}
            </Stack>
          </ScrollArea>
        </Paper>

        {/* Input Area */}
        <Group gap="xs" align="flex-end">
          <Textarea
            ref={inputRef}
            placeholder={t('form.inputPlaceholder')}
            value={inputValue}
            onChange={(e) => setInputValue(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            minRows={1}
            maxRows={4}
            autosize
            disabled={!selectedModel || isGenerating}
            style={{ flex: 1 }}
          />
          {isGenerating ? (
            <Button
              color="red"
              variant="light"
              onClick={stopGeneration}
              leftSection={<IconPlayerStop size={18} />}
            >
              {t('actions.stop')}
            </Button>
          ) : (
            <Button
              onClick={sendMessage}
              disabled={!inputValue.trim() || !selectedModel}
              leftSection={<IconSend size={18} />}
            >
              {t('actions.send')}
            </Button>
          )}
        </Group>

        {/* Selected Model Info */}
        {selectedModel && (
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {t('info.usingModel')}:
            </Text>
            <Badge variant="light" size="sm">
              {models.find((m) => m.key === selectedModel)?.name ?? selectedModel}
            </Badge>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

interface MessageBubbleProps {
  message: PlaygroundMessage;
  isStreaming?: boolean;
}

function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const hasReasoning = !isUser && !isSystem && Boolean(message.reasoning?.trim());
  // While streaming, keep the thinking trace open; collapse it once the answer arrives.
  const [reasoningOpen, setReasoningOpen] = useState(
    Boolean(isStreaming && !message.content),
  );

  return (
    <Box
      py="xs"
      px="sm"
      style={{
        backgroundColor: isUser
          ? 'var(--mantine-color-blue-0)'
          : isSystem
            ? 'var(--mantine-color-gray-1)'
            : 'transparent',
        borderRadius: 'var(--mantine-radius-md)',
        marginBottom: 8,
      }}
    >
      <Group gap="xs" mb={4}>
        <Badge
          size="xs"
          variant={isUser ? 'filled' : 'light'}
          color={isUser ? 'blue' : isSystem ? 'gray' : 'violet'}
        >
          {isUser ? 'You' : isSystem ? 'System' : 'Assistant'}
        </Badge>
        {isStreaming && (
          <Loader size={12} />
        )}
      </Group>

      {hasReasoning && (
        <Box mb={message.content ? 6 : 0}>
          <UnstyledButton
            onClick={() => setReasoningOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <IconBrain size={13} style={{ color: 'var(--mantine-color-violet-6)' }} />
            <Text size="xs" c="violet.6" fw={500}>
              {isStreaming && !message.content ? 'Thinking…' : 'Reasoning'}
            </Text>
            {reasoningOpen ? (
              <IconChevronDown size={12} style={{ color: 'var(--mantine-color-violet-6)' }} />
            ) : (
              <IconChevronRight size={12} style={{ color: 'var(--mantine-color-violet-6)' }} />
            )}
          </UnstyledButton>
          <Collapse in={reasoningOpen}>
            <Text
              size="xs"
              c="dimmed"
              mt={4}
              pl="xs"
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                borderLeft: '2px solid var(--mantine-color-violet-2)',
              }}
            >
              {message.reasoning}
            </Text>
          </Collapse>
        </Box>
      )}

      {message.content && (
        <Text
          size="sm"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {message.content}
        </Text>
      )}
    </Box>
  );
}

/**
 * Reasoning models stream their chain-of-thought as `delta.reasoning_content`
 * (OpenAI-compatible) — and some emit `delta.reasoning` either as a plain string
 * or as `{ summary?: string|[], text?: string }`. Normalize to a string delta.
 */
function extractReasoningDelta(delta: Record<string, unknown>): string {
  const reasoningContent = delta.reasoning_content;
  if (typeof reasoningContent === 'string') return reasoningContent;

  const reasoning = delta.reasoning;
  if (typeof reasoning === 'string') return reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const r = reasoning as Record<string, unknown>;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.summary === 'string') return r.summary;
    if (Array.isArray(r.summary)) {
      return r.summary
        .map((s) =>
          typeof s === 'string'
            ? s
            : s && typeof s === 'object' && typeof (s as Record<string, unknown>).text === 'string'
              ? ((s as Record<string, unknown>).text as string)
              : '',
        )
        .join('');
    }
  }
  return '';
}

export default Playground;
