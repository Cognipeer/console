'use client';

import { useState } from 'react';
import { Stack, Paper, Group, Textarea, NumberInput, Button, Table, Text, Badge } from '@mantine/core';
import { IconPlayerPlay, IconFlask } from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';

type ScoreResult = {
  sessionId: string;
  score: number;
  pass: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string; weight: number }>;
};

export default function TracingEvalRunsPage() {
  const [sessionIdsRaw, setSessionIdsRaw] = useState('');
  const [maxLatencyMs, setMaxLatencyMs] = useState(6000);
  const [maxToolErrorRate, setMaxToolErrorRate] = useState(0.2);
  const [minOutputTokens, setMinOutputTokens] = useState(16);
  const [passScore, setPassScore] = useState(0.75);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ScoreResult[]>([]);
  const [aggregate, setAggregate] = useState<{ avgScore: number; passRate: number } | null>(null);

  const runScore = async () => {
    try {
      setLoading(true);
      const sessionIds = sessionIdsRaw
        .split(/\n|,/) 
        .map((s) => s.trim())
        .filter(Boolean);

      const response = await fetch('/api/tracing/evals/runs/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionIds,
          thresholds: { maxLatencyMs, maxToolErrorRate, minOutputTokens },
          passScore,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Failed to score run');
      setResults(data?.results || []);
      setAggregate(data?.aggregate || null);
    } catch (e) {
      console.error(e);
      setResults([]);
      setAggregate(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconFlask size={18} />}
        title="Eval Runs"
        subtitle="Score existing tracing sessions with rule-based checks."
        actions={
          <Button loading={loading} leftSection={<IconPlayerPlay size={14} />} onClick={runScore}>
            Run Score
          </Button>
        }
      />

      <Paper withBorder radius="lg" p="md">
        <Stack>
          <Textarea
            label="Session IDs (comma or newline separated)"
            minRows={4}
            placeholder="sess_abc123\nsess_def456"
            value={sessionIdsRaw}
            onChange={(e) => setSessionIdsRaw(e.currentTarget.value)}
          />
          <Group grow>
            <NumberInput label="Max Latency (ms)" value={maxLatencyMs} onChange={(v) => setMaxLatencyMs(Number(v || 6000))} />
            <NumberInput label="Max Tool Error Rate" min={0} max={1} step={0.05} decimalScale={2} value={maxToolErrorRate} onChange={(v) => setMaxToolErrorRate(Number(v || 0.2))} />
            <NumberInput label="Min Output Tokens" min={0} value={minOutputTokens} onChange={(v) => setMinOutputTokens(Number(v || 16))} />
            <NumberInput label="Pass Score" min={0} max={1} step={0.05} decimalScale={2} value={passScore} onChange={(v) => setPassScore(Number(v || 0.75))} />
          </Group>
        </Stack>
      </Paper>

      <Paper withBorder radius="lg" p="md">
        {aggregate && (
          <Group mb="sm">
            <Badge variant="light">Avg Score: {aggregate.avgScore}</Badge>
            <Badge variant="light">Pass Rate: {aggregate.passRate}</Badge>
          </Group>
        )}
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Session</Table.Th>
              <Table.Th>Score</Table.Th>
              <Table.Th>Pass</Table.Th>
              <Table.Th>Checks</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {results.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={4}><Text c="dimmed">No run results yet.</Text></Table.Td>
              </Table.Tr>
            ) : (
              results.map((r) => (
                <Table.Tr key={r.sessionId}>
                  <Table.Td>{r.sessionId}</Table.Td>
                  <Table.Td>{r.score.toFixed(2)}</Table.Td>
                  <Table.Td>{r.pass ? 'PASS' : 'FAIL'}</Table.Td>
                  <Table.Td>
                    {(r.checks || []).map((c) => (
                      <Text key={`${r.sessionId}-${c.name}`} size="xs">
                        {c.pass ? '✅' : '❌'} {c.name} ({c.weight})
                      </Text>
                    ))}
                  </Table.Td>
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
}
