'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconDownload,
  IconPlayerPlay,
  IconRefresh,
  IconSpeakerphone,
} from '@tabler/icons-react';

interface TtsPlaygroundProps {
  modelKey: string;
  /** Voice options exposed by the provider capability (capabilities['tts.voices']). */
  voices?: string[];
}

const DEFAULT_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
];

const FORMATS = [
  { value: 'mp3', label: 'mp3' },
  { value: 'opus', label: 'opus' },
  { value: 'aac', label: 'aac' },
  { value: 'flac', label: 'flac' },
  { value: 'wav', label: 'wav' },
  { value: 'pcm', label: 'pcm' },
];

export default function TtsPlayground({ modelKey, voices }: TtsPlaygroundProps) {
  const voiceOptions = voices && voices.length > 0 ? voices : DEFAULT_VOICES;
  const [text, setText] = useState(
    'Merhaba! Cognipeer Console üzerinde TTS playground çalışıyor.',
  );
  const [voice, setVoice] = useState<string>(voiceOptions[0] ?? 'alloy');
  const [format, setFormat] = useState<string>('mp3');
  const [speed, setSpeed] = useState<number | ''>(1);
  const [instructions, setInstructions] = useState('');
  const [running, setRunning] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const run = async () => {
    if (!text.trim()) {
      notifications.show({
        color: 'orange',
        title: 'Enter text',
        message: 'Provide some input text before synthesizing.',
      });
      return;
    }
    setRunning(true);
    setError(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setLatency(null);
    setBytes(null);
    const t0 = performance.now();
    try {
      const response = await fetch('/api/dashboard/playground/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelKey,
          input: text,
          voice,
          response_format: format,
          ...(typeof speed === 'number' ? { speed } : {}),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `Request failed (${response.status})`);
      }
      const blob = await response.blob();
      setAudioUrl(URL.createObjectURL(blob));
      setBytes(blob.size);
      setLatency(performance.now() - t0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'TTS request failed';
      setError(message);
      notifications.show({ color: 'red', title: 'Speech synthesis failed', message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group gap="xs">
            <IconSpeakerphone size={18} />
            <Text fw={600}>Speech synthesis</Text>
          </Group>

          <Textarea
            label="Text"
            placeholder="Type something to synthesize…"
            autosize
            minRows={4}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />

          <Group grow>
            {voices && voices.length > 0 ? (
              <Select
                label="Voice"
                data={voiceOptions}
                value={voice}
                onChange={(v) => setVoice(v ?? voiceOptions[0])}
                searchable
              />
            ) : (
              <TextInput
                label="Voice"
                placeholder={voiceOptions[0]}
                value={voice}
                onChange={(e) => setVoice(e.currentTarget.value)}
                description="Free-form — provider determines valid voice ids."
              />
            )}
            <Select
              label="Output format"
              data={FORMATS}
              value={format}
              onChange={(v) => setFormat(v ?? 'mp3')}
            />
            <NumberInput
              label="Speed"
              min={0.25}
              max={4}
              step={0.05}
              decimalScale={2}
              value={speed}
              onChange={(v) => setSpeed(typeof v === 'number' ? v : '')}
            />
          </Group>

          <Textarea
            label="Voice instructions (optional)"
            description="Some providers (e.g. gpt-4o-mini-tts) take free-text style guidance."
            placeholder="Speak in a calm, professional tone."
            autosize
            minRows={2}
            value={instructions}
            onChange={(e) => setInstructions(e.currentTarget.value)}
          />

          <Group justify="flex-end">
            <Button
              variant="default"
              leftSection={<IconRefresh size={14} />}
              disabled={running}
              onClick={() => {
                if (audioUrl) URL.revokeObjectURL(audioUrl);
                setAudioUrl(null);
                setError(null);
                setLatency(null);
                setBytes(null);
              }}
            >
              Reset
            </Button>
            <Button
              leftSection={<IconPlayerPlay size={14} />}
              loading={running}
              onClick={run}
            >
              Synthesize
            </Button>
          </Group>
        </Stack>
      </Paper>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      {audioUrl && (
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600}>Audio output</Text>
              <Group gap={6}>
                {bytes !== null && (
                  <Badge variant="light">{(bytes / 1024).toFixed(1)} KB</Badge>
                )}
                {latency !== null && (
                  <Badge variant="light" color="gray">
                    {latency.toFixed(0)} ms
                  </Badge>
                )}
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconDownload size={14} />}
                  component="a"
                  href={audioUrl}
                  download={`speech.${format}`}
                >
                  Download
                </Button>
              </Group>
            </Group>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={audioUrl} controls style={{ width: '100%' }} />
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
