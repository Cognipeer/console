'use client';

/**
 * Where the session's wall-clock time went: model vs tools vs retrieval vs
 * time no step accounts for, the slowest step, and a per-tool / per-model
 * table. Computed from leaf steps only, overlaps counted once, so parallel
 * work never pushes the shares past 100%.
 */

import { Badge, Box, Card, Group, Progress, SimpleGrid, Stack, Table, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { formatDuration, formatPercent } from '@/lib/utils/tracingUtils';
import type { BreakdownCategory, TimeBreakdown } from './sessionModel';
import { CATEGORY_DISPLAY } from './stepDisplay';

const SEGMENTS: Array<{ key: BreakdownCategory | 'overhead'; label: string; color: string; hint: string }> = [
  { key: 'model', label: 'Model', color: CATEGORY_DISPLAY.model.color, hint: 'Time a model call was in flight' },
  { key: 'tool', label: 'Tools', color: CATEGORY_DISPLAY.tool.color, hint: 'Time a tool was running' },
  { key: 'retrieval', label: 'Retrieval', color: CATEGORY_DISPLAY.retrieval.color, hint: 'Retrieval, embedding and rerank calls' },
  { key: 'waiting', label: 'Waiting on people', color: CATEGORY_DISPLAY.human.color, hint: 'Time the run was paused for a tool approval or an answer from the user' },
  { key: 'other', label: 'Other steps', color: 'gray', hint: 'Guardrails and other measured steps' },
  { key: 'overhead', label: 'Unaccounted', color: 'gray.4', hint: 'Wall-clock time no measured step covers: framework work, queueing, network between steps' },
];

const MAX_ROWS = 8;

export default function SessionTimeBreakdown({
  breakdown,
  onSelect,
}: {
  breakdown: TimeBreakdown;
  onSelect: (eventId: string) => void;
}) {
  const values: Record<string, number> = { ...breakdown.byCategory, overhead: breakdown.overheadMs };
  // Categories can overlap each other when steps run in parallel; scale to
  // their sum so the bar still reads as shares of the whole.
  const scale = Math.max(breakdown.wallMs, SEGMENTS.reduce((sum, s) => sum + values[s.key], 0)) || 1;
  const visible = SEGMENTS.filter((s) => values[s.key] > 0);
  const parallelMs = breakdown.sumMs - breakdown.busyMs;
  const slowest = breakdown.slowest;
  const slowestCategory = slowest ? CATEGORY_DISPLAY[slowest.node.category] : undefined;

  return (
    <Card withBorder p="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack gap={10}>
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Where time went · {formatDuration(breakdown.wallMs)}</Text>
          </Group>
          <Progress.Root size={14} radius="sm">
            {visible.map((segment) => (
              <Tooltip
                key={segment.key}
                label={`${segment.label}: ${formatDuration(values[segment.key])} — ${segment.hint}`}
                withArrow
                multiline
                maw={300}
              >
                <Progress.Section value={(values[segment.key] / scale) * 100} color={segment.color} />
              </Tooltip>
            ))}
          </Progress.Root>
          <Group gap="md">
            {visible.map((segment) => (
              <Group key={segment.key} gap={6} wrap="nowrap">
                <Box w={8} h={8} style={{ borderRadius: 2, background: `var(--mantine-color-${segment.color.replace('.', '-')}${segment.color.includes('.') ? '' : '-6'})` }} />
                <Text size="xs" c="dimmed">
                  {segment.label}{' '}
                  <Text span size="xs" fw={600} c="var(--mantine-color-text)">{formatDuration(values[segment.key])}</Text>
                  {' '}{formatPercent(breakdown.wallMs > 0 ? values[segment.key] / breakdown.wallMs : 0)}
                </Text>
              </Group>
            ))}
          </Group>
          {slowest?.node.event && slowestCategory ? (
            <Text size="xs" c="dimmed">
              Slowest step:{' '}
              <UnstyledButton onClick={() => onSelect(slowest.node.event!.id)} style={{ display: 'inline' }}>
                <Text span size="xs" fw={600} c="blue">
                  {slowestCategory.badge} · {slowest.node.label} #{slowest.node.event.sequence ?? '—'} · {formatDuration(slowest.ms)}
                </Text>
              </UnstyledButton>
            </Text>
          ) : null}
          <Group gap={6}>
            {parallelMs > 50 ? (
              <Badge size="xs" variant="light" color="gray">∥ {formatDuration(parallelMs)} of work ran in parallel</Badge>
            ) : null}
            {breakdown.estimatedCount > 0 ? (
              <Tooltip label="This SDK reports no step durations; these are the gaps between consecutive steps." multiline maw={280} withArrow>
                <Badge size="xs" variant="light" color="yellow">≈ {breakdown.estimatedCount} estimated</Badge>
              </Tooltip>
            ) : null}
            {breakdown.unknownCount > 0 ? (
              <Badge size="xs" variant="light" color="gray">{breakdown.unknownCount} without duration</Badge>
            ) : null}
          </Group>
        </Stack>

        <Box style={{ minWidth: 0, overflowX: 'auto' }}>
          <Table verticalSpacing={3} horizontalSpacing="xs" fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>By tool / model</Table.Th>
                <Table.Th ta="right">Calls</Table.Th>
                <Table.Th ta="right">Total</Table.Th>
                <Table.Th ta="right">Max</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {breakdown.rows.slice(0, MAX_ROWS).map((row) => {
                const display = row.category === 'other'
                  ? { badge: 'Step', color: 'gray' }
                  : row.category === 'waiting' ? CATEGORY_DISPLAY.human : CATEGORY_DISPLAY[row.category];
                return (
                  <Table.Tr key={row.key}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Badge size="xs" variant="light" color={display.color} style={{ flexShrink: 0 }}>{display.badge}</Badge>
                        <Text size="xs" lineClamp={1}>{row.name}{row.actor ? <Text span size="xs" c="dimmed"> · {row.actor}</Text> : null}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">{row.calls}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{formatDuration(row.totalMs)}</Table.Td>
                    <Table.Td ta="right" ff="monospace">{formatDuration(row.maxMs)}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
          {breakdown.rows.length > MAX_ROWS ? (
            <Text size="xs" c="dimmed" mt={4}>+{breakdown.rows.length - MAX_ROWS} more</Text>
          ) : null}
        </Box>
      </SimpleGrid>
    </Card>
  );
}
