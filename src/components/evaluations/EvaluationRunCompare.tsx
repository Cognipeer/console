'use client';

/**
 * Baseline comparison panel for an evaluation run. Pick an earlier completed run
 * of the same suite as the baseline; the panel diffs the two and shows which
 * items regressed (newly fail) or were fixed, plus pass-rate / score deltas —
 * the regression-testing view for "did this change break any cases?".
 */

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Group, Select, Stack, Table, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import type { EvalComparisonStatus, EvalComparisonView, EvalRunView } from './types';

const STATUS_COLOR: Record<EvalComparisonStatus, string> = {
  regressed: 'red',
  fixed: 'teal',
  added: 'blue',
  removed: 'gray',
  unchanged: 'gray',
};

function signedPct(v: number): string {
  const n = Math.round(v * 100);
  return n > 0 ? `+${n}pp` : `${n}pp`;
}

function signedUsd(v: number): string {
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}$${Math.abs(v).toFixed(4)}`;
}

function signedNum(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toLocaleString()}`;
}

function fmtDate(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
}

function passBadge(passed?: boolean) {
  if (passed === undefined) return <>—</>;
  return <Badge size="xs" color={passed ? 'teal' : 'red'} variant="light">{passed ? 'pass' : 'fail'}</Badge>;
}

interface Props {
  run: EvalRunView;
}

export default function EvaluationRunCompare({ run }: Props) {
  const [candidates, setCandidates] = useState<EvalRunView[]>([]);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<EvalComparisonView | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/evaluation/runs?suiteKey=${encodeURIComponent(run.suiteKey)}&limit=50`, { cache: 'no-store' });
        if (!res.ok) return;
        const runs: EvalRunView[] = (await res.json()).runs ?? [];
        setCandidates(runs.filter((r) => r.id !== run.id && r.status === 'completed' && r.aggregate));
      } catch (err) {
        console.error('Failed to load baseline candidates', err);
      }
    })();
  }, [run.suiteKey, run.id]);

  const options = useMemo(
    () => candidates.map((r) => ({ value: r.id, label: `${fmtDate(r.finishedAt ?? r.createdAt)} · ${Math.round((r.aggregate?.passRate ?? 0) * 100)}% pass` })),
    [candidates],
  );

  const runCompare = async () => {
    if (!baselineId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/evaluation/runs/${run.id}/compare?baseline=${encodeURIComponent(baselineId)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setComparison(data.comparison ?? null);
    } catch (err) {
      console.error('Compare failed', err);
    } finally {
      setLoading(false);
    }
  };

  // Cost / token deltas are computed purely from the two runs' aggregates (the
  // compare endpoint only returns pass-rate / score deltas). Both runs must
  // carry usage totals for the deltas to be meaningful.
  const costDeltas = useMemo(() => {
    if (!comparison) return null;
    const baseline = candidates.find((r) => r.id === comparison.baselineRunId)
      ?? candidates.find((r) => r.id === baselineId);
    const baseAgg = baseline?.aggregate;
    const curAgg = run.aggregate;
    if (!baseAgg || !curAgg) return null;
    // Each delta is independent: on-prem runs have no $ cost but token and
    // latency deltas are exactly the optimization currency there.
    const costDelta = baseAgg.totalCostUsd != null && curAgg.totalCostUsd != null
      ? curAgg.totalCostUsd - baseAgg.totalCostUsd
      : null;
    const latencyDelta = baseAgg.avgLatencyMs != null && curAgg.avgLatencyMs != null
      ? curAgg.avgLatencyMs - baseAgg.avgLatencyMs
      : null;
    const deltas = {
      costDelta,
      costDeltaPct: costDelta != null && (baseAgg.totalCostUsd ?? 0) > 0
        ? (costDelta / (baseAgg.totalCostUsd as number)) * 100
        : null,
      tokenDelta: baseAgg.totalTokens != null && curAgg.totalTokens != null
        ? curAgg.totalTokens - baseAgg.totalTokens
        : null,
      latencyDelta,
      latencyDeltaPct: latencyDelta != null && (baseAgg.avgLatencyMs ?? 0) > 0
        ? (latencyDelta / (baseAgg.avgLatencyMs as number)) * 100
        : null,
    };
    return deltas.costDelta != null || deltas.tokenDelta != null || deltas.latencyDelta != null
      ? deltas
      : null;
  }, [comparison, candidates, baselineId, run.aggregate]);

  if (run.status !== 'completed') return null;

  return (
    <Card withBorder padding="md" radius="md" mt="lg">
      <Group justify="space-between" align="flex-end" mb="sm">
        <div>
          <Text fw={600} size="sm">Baseline comparison</Text>
          <Text size="xs" c="dimmed">Diff this run against an earlier run of the same suite to catch regressions.</Text>
        </div>
        <Group gap="xs" align="flex-end">
          <Select
            placeholder={options.length ? 'Select a baseline run' : 'No earlier runs'}
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
              Pass rate:{' '}
              <Text span fw={600} c={comparison.deltas.passRate < 0 ? 'red' : comparison.deltas.passRate > 0 ? 'teal' : 'dimmed'}>
                {signedPct(comparison.deltas.passRate)}
              </Text>
            </Text>
            <Text size="sm">
              Avg score:{' '}
              <Text span fw={600} c={comparison.deltas.avgScore < 0 ? 'red' : comparison.deltas.avgScore > 0 ? 'teal' : 'dimmed'}>
                {signedPct(comparison.deltas.avgScore)}
              </Text>
            </Text>
            {costDeltas?.costDelta != null ? (
              <Text size="sm">
                Cost:{' '}
                <Text span fw={600} c={costDeltas.costDelta > 0 ? 'red' : costDeltas.costDelta < 0 ? 'teal' : 'dimmed'}>
                  {signedUsd(costDeltas.costDelta)}
                  {costDeltas.costDeltaPct != null ? ` (${costDeltas.costDeltaPct > 0 ? '+' : ''}${costDeltas.costDeltaPct.toFixed(1)}%)` : ''}
                </Text>
              </Text>
            ) : null}
            {costDeltas?.tokenDelta != null ? (
              <Text size="sm">
                Tokens:{' '}
                <Text span fw={600} c={costDeltas.tokenDelta > 0 ? 'red' : costDeltas.tokenDelta < 0 ? 'teal' : 'dimmed'}>
                  {signedNum(costDeltas.tokenDelta)}
                </Text>
              </Text>
            ) : null}
            {costDeltas?.latencyDelta != null ? (
              <Text size="sm">
                Latency:{' '}
                <Text span fw={600} c={costDeltas.latencyDelta > 0 ? 'red' : costDeltas.latencyDelta < 0 ? 'teal' : 'dimmed'}>
                  {`${costDeltas.latencyDelta > 0 ? '+' : ''}${Math.round(costDeltas.latencyDelta)}ms`}
                  {costDeltas.latencyDeltaPct != null ? ` (${costDeltas.latencyDeltaPct > 0 ? '+' : ''}${costDeltas.latencyDeltaPct.toFixed(1)}%)` : ''}
                </Text>
              </Text>
            ) : null}
          </Group>

          {comparison.changes.length === 0 ? (
            <Text size="sm" c="dimmed">No per-item changes between these runs.</Text>
          ) : (
            <div className="ds-tbl-wrap">
            <Table highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Item</Table.Th>
                  <Table.Th>Baseline</Table.Th>
                  <Table.Th></Table.Th>
                  <Table.Th>Current</Table.Th>
                  <Table.Th>Score Δ</Table.Th>
                  <Table.Th>Change</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {comparison.changes.map((c) => (
                  <Table.Tr key={c.itemId}>
                    <Table.Td><Text size="xs" className="ds-mono">{c.itemId}</Text></Table.Td>
                    <Table.Td>{passBadge(c.baselinePassed)}</Table.Td>
                    <Table.Td><IconArrowRight size={13} /></Table.Td>
                    <Table.Td>{passBadge(c.currentPassed)}</Table.Td>
                    <Table.Td>
                      {c.scoreDelta === undefined ? '—' : (
                        <Text size="xs" c={c.scoreDelta < 0 ? 'red' : c.scoreDelta > 0 ? 'teal' : 'dimmed'}>
                          {c.scoreDelta > 0 ? '+' : ''}{Math.round(c.scoreDelta * 100)}pp
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td><Badge size="xs" color={STATUS_COLOR[c.status]} variant="outline">{c.status}</Badge></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            </div>
          )}
        </Stack>
      ) : null}
    </Card>
  );
}
