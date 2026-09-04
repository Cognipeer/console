'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Image,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconDownload,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
} from '@tabler/icons-react';

interface ImagePlaygroundProps {
  modelKey: string;
  /** Sizes the provider advertises (capabilities['image.sizes']). */
  sizes?: string[];
}

const DEFAULT_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024'];
const QUALITIES = [
  { value: '', label: 'Provider default' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

interface GeneratedEntry {
  url: string;
  revisedPrompt?: string;
  /** Set when the payload came back as base64, so it can be downloaded. */
  b64?: string;
}

export default function ImagePlayground({ modelKey, sizes }: ImagePlaygroundProps) {
  const sizeOptions = sizes && sizes.length > 0 ? sizes : DEFAULT_SIZES;
  const [prompt, setPrompt] = useState('A minimal flat illustration of a lighthouse at dusk');
  const [size, setSize] = useState<string>(sizeOptions[0] ?? '1024x1024');
  const [quality, setQuality] = useState<string>('');
  const [count, setCount] = useState<number | ''>(1);
  const [running, setRunning] = useState(false);
  const [images, setImages] = useState<GeneratedEntry[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Object URLs are only created for base64 payloads; a provider that answers
  // with a hosted URL is rendered directly and has nothing to revoke.
  useEffect(() => {
    return () => {
      for (const image of images) {
        if (image.b64) URL.revokeObjectURL(image.url);
      }
    };
  }, [images]);

  const run = async () => {
    if (!prompt.trim()) {
      notifications.show({
        color: 'orange',
        title: 'Enter a prompt',
        message: 'Describe the image you want before generating.',
      });
      return;
    }
    setRunning(true);
    setError(null);
    for (const image of images) {
      if (image.b64) URL.revokeObjectURL(image.url);
    }
    setImages([]);
    setLatency(null);
    setUsage(null);

    try {
      const response = await fetch('/api/dashboard/playground/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelKey,
          prompt: prompt.trim(),
          ...(typeof count === 'number' ? { n: count } : {}),
          ...(size && size !== 'auto' ? { size } : {}),
          ...(quality ? { quality } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }

      const entries: GeneratedEntry[] = (payload.data ?? []).map(
        (entry: { b64_json?: string; url?: string; revised_prompt?: string }) => {
          if (entry.b64_json) {
            const bytes = Uint8Array.from(atob(entry.b64_json), (c) => c.charCodeAt(0));
            const blob = new Blob([bytes], { type: 'image/png' });
            return {
              url: URL.createObjectURL(blob),
              b64: entry.b64_json,
              revisedPrompt: entry.revised_prompt,
            };
          }
          return { url: entry.url ?? '', revisedPrompt: entry.revised_prompt };
        },
      );

      setImages(entries.filter((entry) => entry.url));
      setLatency(typeof payload.latencyMs === 'number' ? payload.latencyMs : null);
      setUsage(payload.usage ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Image generation failed';
      setError(message);
      notifications.show({ color: 'red', title: 'Image generation failed', message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group gap="xs">
            <IconPhoto size={18} />
            <Text fw={600}>Image generation</Text>
          </Group>

          <Textarea
            label="Prompt"
            placeholder="Describe the image…"
            autosize
            minRows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />

          <Group grow>
            <Select
              label="Size"
              data={sizeOptions.map((value) => ({ value, label: value }))}
              value={size}
              onChange={(value) => setSize(value ?? sizeOptions[0] ?? '1024x1024')}
            />
            <Select
              label="Quality"
              data={QUALITIES}
              value={quality}
              onChange={(value) => setQuality(value ?? '')}
            />
            <NumberInput label="Count" min={1} max={4} value={count} onChange={(v) => setCount(v as number | '')} />
          </Group>

          <Group>
            <Button
              leftSection={running ? <IconRefresh size={14} /> : <IconPlayerPlay size={14} />}
              loading={running}
              onClick={run}
            >
              Generate
            </Button>
            {latency !== null ? <Badge variant="light">{Math.round(latency)} ms</Badge> : null}
            {usage?.images ? <Badge variant="light">{usage.images} image(s)</Badge> : null}
            {usage?.totalTokens ? <Badge variant="light">{usage.totalTokens} tokens</Badge> : null}
          </Group>
        </Stack>
      </Paper>

      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Generation failed">
          {error}
        </Alert>
      ) : null}

      {images.length > 0 ? (
        <SimpleGrid cols={{ base: 1, sm: images.length > 1 ? 2 : 1 }} spacing="md">
          {images.map((image, index) => (
            <Paper key={image.url} withBorder radius="md" p="sm">
              <Stack gap="xs">
                <Image src={image.url} alt={`Generated image ${index + 1}`} radius="sm" />
                {image.revisedPrompt ? (
                  <Text size="xs" c="dimmed">
                    Revised prompt: {image.revisedPrompt}
                  </Text>
                ) : null}
                <Group justify="flex-end">
                  <Button
                    component="a"
                    href={image.url}
                    download={`generated-${index + 1}.png`}
                    variant="light"
                    size="xs"
                    leftSection={<IconDownload size={14} />}
                  >
                    Download
                  </Button>
                </Group>
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      ) : null}
    </Stack>
  );
}
