'use client';

import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconRefresh,
  IconVectorBezier2,
} from '@tabler/icons-react';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';

interface EmbeddingPlaygroundProps {
  modelKey: string;
}

interface VectorSummary {
  index: number;
  input: string;
  dimensions: number;
  preview: number[];
  magnitude: number;
}

interface SimilarityPair {
  a: number;
  b: number;
  score: number;
}

const vectorColumns: DataGridColumn<VectorSummary>[] = [
  { key: 'index', label: '#', width: 40, render: (vector) => vector.index },
  {
    key: 'input',
    label: 'Input',
    render: (vector) => <Text size="xs" lineClamp={2}>{vector.input}</Text>,
  },
  { key: 'dims', label: 'Dims', width: 90, align: 'right', render: (vector) => vector.dimensions },
  { key: 'norm', label: '‖v‖', width: 90, align: 'right', render: (vector) => vector.magnitude.toFixed(3) },
  {
    key: 'preview',
    label: 'First 8 values',
    render: (vector) => (
      <Code fz={10}>
        [{vector.preview.map((value) => value.toFixed(4)).join(', ')}…]
      </Code>
    ),
  },
];

const similarityColumns: DataGridColumn<SimilarityPair>[] = [
  {
    key: 'pair',
    label: 'Pair',
    render: (pair) => <Text size="xs">#{pair.a} ↔ #{pair.b}</Text>,
  },
  {
    key: 'score',
    label: 'Score',
    width: 120,
    align: 'right',
    render: (pair) => (
      <Badge variant="light" color={pair.score > 0.8 ? 'green' : pair.score > 0.5 ? 'yellow' : 'gray'}>
        {pair.score.toFixed(4)}
      </Badge>
    ),
  },
];

const DEFAULT_INPUT = [
  'The cat sat on the mat.',
  'A feline rested on the rug.',
  'Quarterly revenue grew by twelve percent.',
].join('\n');

export default function EmbeddingPlayground({ modelKey }: EmbeddingPlaygroundProps) {
  const [text, setText] = useState(DEFAULT_INPUT);
  const [running, setRunning] = useState(false);
  const [vectors, setVectors] = useState<VectorSummary[]>([]);
  const [similarities, setSimilarities] = useState<SimilarityPair[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const inputs = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (inputs.length === 0) {
      notifications.show({
        color: 'orange',
        title: 'Enter text',
        message: 'Add at least one line to embed.',
      });
      return;
    }

    setRunning(true);
    setError(null);
    setVectors([]);
    setSimilarities([]);
    setLatency(null);
    setUsage(null);

    try {
      const response = await fetch('/api/dashboard/playground/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelKey, input: inputs }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      setVectors(payload.vectors ?? []);
      setSimilarities(payload.similarities ?? []);
      setLatency(typeof payload.latencyMs === 'number' ? payload.latencyMs : null);
      setUsage(payload.usage ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Embedding request failed';
      setError(message);
      notifications.show({ color: 'red', title: 'Embedding failed', message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group gap="xs">
            <IconVectorBezier2 size={18} />
            <Text fw={600}>Embeddings</Text>
          </Group>

          <Textarea
            label="Input — one text per line"
            description="Two or more lines also report pairwise cosine similarity, which is what the vector is usually being checked for."
            autosize
            minRows={4}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />

          <Group>
            <Button
              leftSection={running ? <IconRefresh size={14} /> : <IconPlayerPlay size={14} />}
              loading={running}
              onClick={run}
            >
              Embed
            </Button>
            {latency !== null ? <Badge variant="light">{Math.round(latency)} ms</Badge> : null}
            {vectors.length > 0 ? (
              <Badge variant="light">{vectors[0].dimensions} dimensions</Badge>
            ) : null}
            {usage?.total_tokens ? <Badge variant="light">{usage.total_tokens} tokens</Badge> : null}
          </Group>
        </Stack>
      </Paper>

      {error ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Embedding failed">
          {error}
        </Alert>
      ) : null}

      {vectors.length > 0 ? (
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Text fw={600} size="sm">Vectors</Text>
            <DataGrid<VectorSummary>
              records={vectors}
              rowKey={(vector) => String(vector.index)}
              columns={vectorColumns}
            />
          </Stack>
        </Paper>
      ) : null}

      {similarities.length > 0 ? (
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Text fw={600} size="sm">Cosine similarity</Text>
            <DataGrid<SimilarityPair>
              records={similarities}
              rowKey={(pair) => `${pair.a}-${pair.b}`}
              columns={similarityColumns}
            />
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
