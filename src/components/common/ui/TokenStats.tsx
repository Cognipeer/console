'use client';

import { Group, Stack, Text } from '@mantine/core';

export interface TokenStatsRow {
  label: string;
  value: number;
}

export interface TokenStatsProps {
  /** Bold headline number — usually input+output(+cached). */
  total?: number;
  input?: number;
  output?: number;
  /** Only shown when > 0 — a cache miss isn't worth a row. */
  cached?: number;
  /** Only shown when > 0 — a SUBSET of `output`, never additive. */
  reasoning?: number;
  /** Extra rows a specific surface has (e.g. Gateway's cache-creation tokens). */
  extra?: TokenStatsRow[];
  labels?: Partial<{ input: string; output: string; cached: string; reasoning: string }>;
}

/**
 * One line per metric, right-aligned, instead of a single "Input: X •
 * Output: Y • Cached: Z" sentence — that wraps mid-number in the narrow
 * Properties rail and reads as noise. Used everywhere a request/event's
 * token usage is shown (Model Hub, Agent Observability, AI App Gateway).
 */
export default function TokenStats({ total, input, output, cached, reasoning, extra, labels }: TokenStatsProps) {
  const rows: TokenStatsRow[] = [];
  if (input != null) rows.push({ label: labels?.input ?? 'Input', value: input });
  if (output != null) rows.push({ label: labels?.output ?? 'Output', value: output });
  if (cached != null && cached > 0) rows.push({ label: labels?.cached ?? 'Cached', value: cached });
  if (extra) rows.push(...extra);
  if (reasoning != null && reasoning > 0) rows.push({ label: labels?.reasoning ?? 'Reasoning', value: reasoning });

  return (
    <Stack gap={2} align="flex-end">
      {total != null ? (
        <Text size="sm" fw={600}>
          {total.toLocaleString()}
        </Text>
      ) : null}
      {rows.map((row) => (
        <Group key={row.label} gap={6} justify="flex-end" wrap="nowrap">
          <Text size="xs" c="dimmed">
            {row.label}
          </Text>
          <Text size="xs" c="dimmed" style={{ fontFamily: 'var(--mantine-font-family-monospace, monospace)' }}>
            {row.value.toLocaleString()}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
