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
  Table,
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
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40}>#</Table.Th>
                  <Table.Th>Input</Table.Th>
                  <Table.Th w={90}>Dims</Table.Th>
                  <Table.Th w={90}>‖v‖</Table.Th>
                  <Table.Th>First 8 values</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {vectors.map((vector) => (
                  <Table.Tr key={vector.index}>
                    <Table.Td>{vector.index}</Table.Td>
                    <Table.Td>
                      <Text size="xs" lineClamp={2}>{vector.input}</Text>
                    </Table.Td>
                    <Table.Td>{vector.dimensions}</Table.Td>
                    <Table.Td>{vector.magnitude.toFixed(3)}</Table.Td>
                    <Table.Td>
                      <Code fz={10}>
                        [{vector.preview.map((value) => value.toFixed(4)).join(', ')}…]
                      </Code>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Paper>
      ) : null}

      {similarities.length > 0 ? (
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Text fw={600} size="sm">Cosine similarity</Text>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Pair</Table.Th>
                  <Table.Th w={120}>Score</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {similarities.map((pair) => (
                  <Table.Tr key={`${pair.a}-${pair.b}`}>
                    <Table.Td>
                      <Text size="xs">#{pair.a} ↔ #{pair.b}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={pair.score > 0.8 ? 'green' : pair.score > 0.5 ? 'yellow' : 'gray'}>
                        {pair.score.toFixed(4)}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
