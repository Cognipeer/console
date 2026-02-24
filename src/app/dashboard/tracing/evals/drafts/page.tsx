'use client';

import { useState } from 'react';
import { Stack, Group, Button, TextInput, Select, NumberInput, Paper, Table, Text, Badge } from '@mantine/core';
import { IconRefresh, IconSparkles } from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';

type DraftCase = {
  caseId: string;
  sessionId: string;
  agentName?: string;
  riskTags: string[];
  input: { latestUserMessage?: string };
  createdFrom: { status?: string; durationMs?: number; totalOutputTokens?: number };
};

export default function TracingEvalDraftsPage() {
  const [loading, setLoading] = useState(false);
  const [agent, setAgent] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [limit, setLimit] = useState<number>(30);
  const [rows, setRows] = useState<DraftCase[]>([]);

  const generate = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/tracing/evals/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agent || undefined,
          status: status || undefined,
          limit,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Failed to generate drafts');
      setRows(data?.cases || []);
    } catch (e) {
      console.error(e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconSparkles size={18} />}
        title="Eval Drafts"
        subtitle="Generate candidate eval cases from tracing sessions."
        actions={
          <Button loading={loading} leftSection={<IconRefresh size={14} />} onClick={generate}>
            Generate
          </Button>
        }
      />

      <Paper withBorder radius="lg" p="md">
        <Group grow>
          <TextInput label="Agent" placeholder="assistant" value={agent} onChange={(e) => setAgent(e.currentTarget.value)} />
          <Select
            label="Status"
            placeholder="Any"
            data={[
              { value: 'success', label: 'success' },
              { value: 'error', label: 'error' },
              { value: 'in_progress', label: 'in_progress' },
            ]}
            value={status}
            onChange={(v) => setStatus(v || '')}
            clearable
          />
          <NumberInput label="Limit" min={1} max={200} value={limit} onChange={(v) => setLimit(Number(v || 30))} />
        </Group>
      </Paper>

      <Paper withBorder radius="lg" p="md">
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Session</Table.Th>
              <Table.Th>Agent</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Latest User Message</Table.Th>
              <Table.Th>Risk Tags</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text c="dimmed">No draft cases yet. Click Generate.</Text>
                </Table.Td>
              </Table.Tr>
            ) : (
              rows.map((r) => (
                <Table.Tr key={r.caseId}>
                  <Table.Td>{r.sessionId}</Table.Td>
                  <Table.Td>{r.agentName || '—'}</Table.Td>
                  <Table.Td>{r.createdFrom?.status || '—'}</Table.Td>
                  <Table.Td>{r.input?.latestUserMessage || '—'}</Table.Td>
                  <Table.Td>
                    <Group gap={6}>
                      {(r.riskTags || []).map((tag) => (
                        <Badge key={tag} size="xs" variant="light">{tag}</Badge>
                      ))}
                    </Group>
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
