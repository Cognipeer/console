'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconClock,
  IconFileUpload,
  IconLanguage,
  IconMicrophone,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';

interface SttPlaygroundProps {
  modelKey: string;
}

interface SttResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ start: number; end: number; word: string }>;
  usage?: { inputSeconds?: number; inputTokens?: number; outputTokens?: number };
}

const RESPONSE_FORMATS = [
  { value: 'json', label: 'json' },
  { value: 'verbose_json', label: 'verbose_json (segments / words)' },
  { value: 'text', label: 'text' },
  { value: 'srt', label: 'srt' },
  { value: 'vtt', label: 'vtt' },
];

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function SttPlayground({ modelKey }: SttPlaygroundProps) {
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState('');
  const [prompt, setPrompt] = useState('');
  const [responseFormat, setResponseFormat] = useState('verbose_json');
  const [translate, setTranslate] = useState(false);
  const [temperature, setTemperature] = useState<number | ''>('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SttResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const resetRef = useRef<() => void>(() => {});
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
  }, []);

  useEffect(() => stopRecording, [stopRecording]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorderChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recorderChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimerRef.current) {
          clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        setRecording(false);
        const chunks = recorderChunksRef.current;
        recorderChunksRef.current = [];
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: 'audio/webm' });
        setFile(new File([blob], `mic-recording-${Date.now()}.webm`, { type: 'audio/webm' }));
        resetRef.current?.();
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
      setRecording(true);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Microphone unavailable',
        message: error instanceof Error ? error.message : 'Could not access the microphone.',
      });
    }
  }, []);

  const run = async () => {
    if (!file) {
      notifications.show({
        color: 'orange',
        title: 'Select an audio file',
        message: 'Upload a WAV, MP3, M4A, or WebM file to transcribe.',
      });
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    setLatency(null);
    const t0 = performance.now();
    try {
      const form = new FormData();
      form.append('model', modelKey);
      form.append('file', file, file.name);
      form.append('response_format', responseFormat);
      if (language.trim()) form.append('language', language.trim());
      if (prompt.trim()) form.append('prompt', prompt.trim());
      if (temperature !== '' && Number.isFinite(temperature)) {
        form.append('temperature', String(temperature));
      }
      if (translate) form.append('translate', 'true');

      const response = await fetch('/api/dashboard/playground/transcription', {
        method: 'POST',
        body: form,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      setResult(data as SttResult);
      setLatency(performance.now() - t0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transcription failed';
      setError(message);
      notifications.show({ color: 'red', title: 'Transcription failed', message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group justify="space-between">
            <Group gap="xs">
              <IconMicrophone size={18} />
              <Text fw={600}>Audio input</Text>
            </Group>
            {file && (
              <Group gap={6}>
                <Badge variant="light">{file.name}</Badge>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconX size={14} />}
                  onClick={() => {
                    setFile(null);
                    resetRef.current?.();
                  }}
                >
                  Clear
                </Button>
              </Group>
            )}
          </Group>

          <Group gap="xs">
            <FileButton
              resetRef={resetRef}
              accept="audio/*"
              onChange={setFile}
            >
              {(props) => (
                <Button
                  {...props}
                  variant="default"
                  disabled={recording}
                  leftSection={<IconFileUpload size={16} />}
                >
                  {file ? 'Replace audio file' : 'Choose audio file'}
                </Button>
              )}
            </FileButton>
            <Button
              variant={recording ? 'filled' : 'default'}
              color={recording ? 'red' : undefined}
              leftSection={
                recording ? <IconPlayerStop size={16} /> : <IconMicrophone size={16} />
              }
              onClick={() => {
                if (recording) stopRecording();
                else void startRecording();
              }}
            >
              {recording ? `Stop recording (${formatTime(recordSeconds)})` : 'Record from microphone'}
            </Button>
          </Group>

          <Group grow>
            <TextInput
              label="Language hint (ISO 639-1)"
              placeholder="tr, en, de, …"
              value={language}
              onChange={(e) => setLanguage(e.currentTarget.value)}
              leftSection={<IconLanguage size={14} />}
            />
            <Select
              label="Response format"
              data={RESPONSE_FORMATS}
              value={responseFormat}
              onChange={(v) => setResponseFormat(v ?? 'json')}
            />
          </Group>

          <Textarea
            label="Prompt (optional)"
            placeholder="Names of speakers, jargon, or style guidance to bias the transcription."
            autosize
            minRows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />

          <Group grow>
            <NumberInput
              label="Temperature"
              placeholder="0.0 – 1.0"
              min={0}
              max={1}
              step={0.1}
              decimalScale={2}
              value={temperature}
              onChange={(v) => setTemperature(typeof v === 'number' ? v : '')}
            />
            <Switch
              mt={24}
              label="Translate to English"
              description="Calls /audio/translations instead of /audio/transcriptions."
              checked={translate}
              onChange={(e) => setTranslate(e.currentTarget.checked)}
            />
          </Group>

          <Group justify="flex-end">
            <Button
              variant="default"
              leftSection={<IconRefresh size={14} />}
              disabled={running}
              onClick={() => {
                setResult(null);
                setError(null);
                setLatency(null);
              }}
            >
              Reset
            </Button>
            <Button
              leftSection={<IconPlayerPlay size={14} />}
              loading={running}
              onClick={run}
            >
              Transcribe
            </Button>
          </Group>
        </Stack>
      </Paper>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      {result && (
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600}>Transcript</Text>
              <Group gap="xs">
                {result.language && (
                  <Badge variant="light" color="blue">
                    {result.language}
                  </Badge>
                )}
                {result.duration !== undefined && (
                  <Badge variant="light" leftSection={<IconClock size={12} />}>
                    {formatTime(result.duration)}
                  </Badge>
                )}
                {latency !== null && (
                  <Badge variant="light" color="gray">
                    {latency.toFixed(0)} ms
                  </Badge>
                )}
              </Group>
            </Group>

            <Textarea
              autosize
              minRows={6}
              readOnly
              value={result.text}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace, monospace)' } }}
            />

            {Array.isArray(result.segments) && result.segments.length > 0 && (
              <Stack gap={6}>
                <Text size="sm" fw={500}>
                  Segments
                </Text>
                <Paper withBorder radius="sm" p="xs">
                  <Stack gap={4}>
                    {result.segments.map((segment, idx) => (
                      <Group key={idx} gap={8} align="flex-start" wrap="nowrap">
                        <Badge variant="light" size="sm" color="gray">
                          {formatTime(segment.start)}–{formatTime(segment.end)}
                        </Badge>
                        <Text size="sm" style={{ flex: 1 }}>
                          {segment.text}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                </Paper>
              </Stack>
            )}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
