'use client';

/**
 * Baseline comparison panel for a red-team scan. Pick an earlier completed scan
 * of the same campaign as the baseline; the panel diffs the two and shows which
 * attempts regressed (newly succeed) or were fixed, plus aggregate deltas — the
 * regression-testing view for "did this change make the target less safe?".
 */

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Group, Select, Stack, Table, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import type { ComparisonStatus, RedTeamComparisonView, RedTeamRunView } from './types';

const STATUS_COLOR: Record<ComparisonStatus, string> = {
  regressed: 'red',
  fixed: 'teal',
  added: 'blue',
  removed: 'gray',
  unchanged: 'gray',
};

const OUTCOME_COLOR: Record<string, string> = { safe: 'teal', vulnerable: 'red', needs_review: 'yellow' };

function signed(v: number, asPct = false): string {
  const n = asPct ? Math.round(v * 100) : v;
  const s = n > 0 ? `+${n}` : `${n}`;
  return asPct ? `${s}pp` : s;
}

function fmtDate(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
}

interface Props {
  run: RedTeamRunView;
}

export default function RedTeamRunCompare({ run }: Props) {
  const [candidates, setCandidates] = useState<RedTeamRunView[]>([]);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<RedTeamComparisonView | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/redteam/runs?campaignKey=${encodeURIComponent(run.campaignKey)}&limit=50`, { cache: 'no-store' });
        if (!res.ok) return;
        const runs: RedTeamRunView[] = (await res.json()).runs ?? [];
        setCandidates(runs.filter((r) => r.id !== run.id && r.status === 'completed' && r.aggregate));
      } catch (err) {
        console.error('Failed to load baseline candidates', err);
      }
    })();
  }, [run.campaignKey, run.id]);

  const options = useMemo(
    () => candidates.map((r) => ({ value: r.id, label: `${fmtDate(r.finishedAt ?? r.createdAt)} · ${Math.round((r.aggregate?.resilienceScore ?? 0) * 100)}% resilient` })),
    [candidates],
  );

  const runCompare = async () => {
    if (!baselineId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/redteam/runs/${run.id}/compare?baseline=${encodeURIComponent(baselineId)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setComparison(data.comparison ?? null);
    } catch (err) {
      console.error('Compare failed', err);
    } finally {
      setLoading(false);
    }
  };

  if (run.status !== 'completed') return null;

  return (
    <Card withBorder padding="md" radius="md" mt="lg">
      <Group justify="space-between" align="flex-end" mb="sm">
        <div>
          <Text fw={600} size="sm">Baseline comparison</Text>
          <Text size="xs" c="dimmed">Diff this scan against an earlier scan of the same campaign to catch regressions.</Text>
        </div>
        <Group gap="xs" align="flex-end">
          <Select
            placeholder={options.length ? 'Select a baseline scan' : 'No earlier scans'}
            data={options}
            value={baselineId}
            onChange={setBaselineId}
            disabled={!options.length}
            w={320}
            size="xs"
          />
          <Button size="xs" onClick={runCompare} loading={loading} disabled={!baselineId}>Compare</Button>
        </Group>
      </Group>

      {comparison ? (
        <Stack gap="md">
          <Group gap="lg">
            <Badge color="red" variant="light" size="lg">{comparison.summary.regressed} regressed</Badge>
            <Badge color="teal" variant="light" size="lg">{comparison.summary.fixed} fixed</Badge>
            <Badge color="gray" variant="light" size="lg">{comparison.summary.unchanged} unchanged</Badge>
            {comparison.summary.added ? <Badge color="blue" variant="light">{comparison.summary.added} new</Badge> : null}
            {comparison.summary.removed ? <Badge color="gray" variant="outline">{comparison.summary.removed} removed</Badge> : null}
          </Group>

          <Group gap="xl">
            <Text size="sm">
              Attack success:{' '}
              <Text span fw={600} c={comparison.deltas.attackSuccessRate > 0 ? 'red' : comparison.deltas.attackSuccessRate < 0 ? 'teal' : 'dimmed'}>
                {signed(comparison.deltas.attackSuccessRate, true)}
              </Text>
            </Text>
            <Text size="sm">
              Resilience:{' '}
              <Text span fw={600} c={comparison.deltas.resilienceScore < 0 ? 'red' : comparison.deltas.resilienceScore > 0 ? 'teal' : 'dimmed'}>
                {signed(comparison.deltas.resilienceScore, true)}
              </Text>
            </Text>
            <Text size="sm">
              Vulnerable:{' '}
              <Text span fw={600} c={comparison.deltas.vulnerable > 0 ? 'red' : comparison.deltas.vulnerable < 0 ? 'teal' : 'dimmed'}>
                {signed(comparison.deltas.vulnerable)}
              </Text>
            </Text>
          </Group>

          {comparison.changes.length === 0 ? (
            <Text size="sm" c="dimmed">No per-attempt changes between these scans.</Text>
          ) : (
            <Table highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Probe</Table.Th>
                  <Table.Th>Category</Table.Th>
                  <Table.Th>Baseline</Table.Th>
                  <Table.Th></Table.Th>
                  <Table.Th>Current</Table.Th>
                  <Table.Th>Change</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {comparison.changes.map((c) => (
                  <Table.Tr key={c.key}>
                    <Table.Td>
                      <Text size="sm" fw={500}>{c.probeKey}</Text>
                      <Text size="xs" c="dimmed" className="ds-mono">{c.attemptId}</Text>
                    </Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{c.category}</Text></Table.Td>
                    <Table.Td>{c.baseline ? <Badge size="xs" color={OUTCOME_COLOR[c.baseline]} variant="light">{c.baseline.replace('_', ' ')}</Badge> : '—'}</Table.Td>
                    <Table.Td><IconArrowRight size={13} /></Table.Td>
                    <Table.Td>{c.current ? <Badge size="xs" color={OUTCOME_COLOR[c.current]} variant="light">{c.current.replace('_', ' ')}</Badge> : '—'}</Table.Td>
                    <Table.Td><Badge size="xs" color={STATUS_COLOR[c.status]} variant="outline">{c.status}</Badge></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      ) : null}
    </Card>
  );
}
